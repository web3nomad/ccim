// Test doubles: Durable Object storage in memory, a fake ccim relay that follows the real Channel semantics
// (relay/src/index.js at 588fb7b), and a fake routine webhook. Nothing here touches the network.

import { Adapter } from "../src/index.js";

export class MemoryStorage {
  constructor() { this.map = new Map(); }
  async get(k) {
    if (Array.isArray(k)) return new Map(k.filter((x) => this.map.has(x)).map((x) => [x, structuredClone(this.map.get(x))]));
    return this.map.has(k) ? structuredClone(this.map.get(k)) : undefined;
  }
  async put(k, v) {
    if (typeof k === "object") for (const [a, b] of Object.entries(k)) this.map.set(a, structuredClone(b));
    else this.map.set(k, structuredClone(v));
  }
  async delete(k) { for (const x of [].concat(k)) this.map.delete(x); }
  async list({ prefix = "", reverse = false, limit = Infinity } = {}) {
    let keys = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
    if (reverse) keys.reverse();
    return new Map(keys.slice(0, limit).map((k) => [k, structuredClone(this.map.get(k))]));
  }
  async transaction(callback) {
    const previous = this.pending || Promise.resolve();
    let release;
    this.pending = new Promise((resolve) => { release = resolve; });
    await previous;
    const snapshot = structuredClone(this.map);
    try { return await callback(this); }
    catch (error) { this.map = snapshot; throw error; }
    finally { release(); }
  }
}

export const TOKEN = "test-member-token-0123456789";
export const WEBHOOK_URL = "https://hooks.test/automations/webhook/r1";
export const WEBHOOK_KEY = "crsr_testkey0123456789"; // gitleaks:allow -- synthetic key used only by local redaction tests
export const MCP_BEARER = "test-mcp-bearer-abcdefghijklmnop";

export function makeEnv(extra = {}) {
  return { CCIM_RELAY: "https://relay.test", CCIM_CHANNEL: "example-channel", CCIM_HANDLE: "grok", CCIM_TOKEN: TOKEN, WEBHOOK_URL, WEBHOOK_KEY, MCP_BEARER, SEND_ALLOWED_RECIPIENTS: "alice,bob", DAY_TZ_OFFSET_MIN: "480", ...extra };
}

// Minimal ccim Channel: queues per handle, inbox peek, ack, send with clientId dedupe (index.js:141-189).
export class FakeRelay {
  constructor(members = ["grok", "alice", "bob"], me = "grok") {
    this.me = me;
    this.members = members;
    this.queues = new Map(members.map((m) => [m, new Map()]));
    this.seq = 0;
    this.cids = new Map();
    this.down = false;
    this.calls = [];
  }
  deliver(from, to, text) {
    const id = ++this.seq;
    const targets = to === "*" ? this.members.filter((m) => m !== from) : [to];
    const msg = { type: "msg", id, from, to, text, urgent: false, ts: 1700000000000 + id };
    for (const t of targets) this.queues.get(t).set(id, msg);
    return id;
  }
  handle(method, op, body, auth) {
    if (auth !== `Bearer ${TOKEN}`) return [401, { error: "unauthorized" }];
    const me = this.me;
    if (op === "inbox?all=1" && method === "GET") return [200, { messages: [...this.queues.get(me).values()].sort((a, b) => a.id - b.id) }];
    if (op === "ack" && method === "POST") { for (const id of body.ids) this.queues.get(me).delete(id); return [200, { ok: true }]; }
    if (op === "send" && method === "POST") {
      const { to, text, clientId } = body;
      if (clientId !== undefined && !/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) return [400, { error: "bad_client_id" }];
      const ck = `${me}:${clientId}`;
      const sig = JSON.stringify([to, text, !!body.urgent]);
      if (clientId && this.cids.has(ck)) {
        const prev = this.cids.get(ck);
        if (prev.sig !== sig) return [409, { error: "client_id_reused" }];
        return [200, { ...prev.result, duplicate: true }];
      }
      if (!this.members.includes(to)) return [404, { error: "unknown_handle", members: this.members }];
      const id = this.deliver(me, to, text);
      const result = { id, delivery: { [to]: "queued_offline" } };
      if (clientId) this.cids.set(ck, { sig, result });
      return [200, result];
    }
    return [404, { error: "not_found" }];
  }
}

export class FakeWebhook {
  constructor() { this.calls = []; this.responses = []; }
  // Queue responses: [status, bodyText]. Default is a successful start.
  next(...r) { this.responses.push(...r); }
  respond(init) {
    this.calls.push({ headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body });
    const [status, text] = this.responses.shift() || [200, JSON.stringify({ success: true, runUuid: `run-${this.calls.length}` })];
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  }
}

export function makeFetch(relay, webhook) {
  return async (url, init = {}) => {
    const u = new URL(url);
    if (url === WEBHOOK_URL) return webhook.respond(init);
    if (u.host === "relay.test") {
      if (relay.down) throw new TypeError("fetch failed");
      const op = u.pathname.split("/")[3] + u.search;
      relay.calls.push({ method: init.method, op });
      const [status, body] = relay.handle(init.method || "GET", op, init.body ? JSON.parse(init.body) : null, new Headers(init.headers).get("authorization"));
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
}

export function harness(envExtra = {}) {
  const handle = envExtra.CCIM_HANDLE || "grok";
  const relay = new FakeRelay([handle, "alice", "bob"], handle);
  const webhook = new FakeWebhook();
  const storage = new MemoryStorage();
  const logs = [];
  const clock = { t: Date.UTC(2026, 9, 20, 4, 0, 0) };
  const env = makeEnv(envExtra);
  const adapter = new Adapter({ storage }, env, { fetch: makeFetch(relay, webhook), now: () => clock.t, log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })) });
  const tick = async () => (await adapter.fetch(new Request("https://adapter.internal/tick", { method: "POST" }))).json();
  let rpcId = 0;
  const mcp = async (name, args = {}, bearer = MCP_BEARER) => {
    const res = await adapter.fetch(new Request("https://worker.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
    }));
    if (res.status !== 200) return { httpStatus: res.status };
    return (await res.json()).result;
  };
  const advance = (min) => { clock.t += min * 60 * 1000; };
  return { relay, webhook, storage, logs, clock, env, adapter, tick, mcp, advance };
}
