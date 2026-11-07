import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, TOKEN, MCP_BEARER } from "./helpers.js";
import { Adapter } from "../src/index.js";
import { makeLogger } from "../src/util.js";

const args = (n = 1, extra = {}) => ({ to: "bob", text: `test ${n}`, clientId: `send-test-${n}`, hop: 0, ...extra });
const send = async (h, a) => (await h.mcp("grok_send", a)).structuredContent;
const posts = (h) => h.relay.calls.filter((c) => c.op === "send").length;

test("proactive send needs no inbox message and returns a receipt with hop marker", async () => {
  const h = harness();
  const r = await send(h, args());
  assert.equal(r.outcome, "sent");
  assert.equal(r.relay_id, 1);
  assert.equal(r.to, "bob");
  assert.equal(r.hop, 1);
  assert.equal(r.retry_allowed, false);
  assert.equal([...h.relay.queues.get("bob").values()][0].text, "test 1\n\n[ccim-auto from=grok hop=1]");
  assert.equal(h.relay.queues.get("grok").size, 0);
  assert.equal(h.webhook.calls.length, 0);
});

test("allowlist and arguments fail closed without network calls", async () => {
  const h = harness();
  const invalid = [
    { to: "*" }, { to: "grok" }, { to: "someone" }, { to: "BOB" },
    { clientId: "x" }, { clientId: "x".repeat(65) }, { text: " " }, { text: "x".repeat(16384) },
    { hop: -1 }, { hop: 2 }, { hop: 1.5 }, { hop: undefined }, { urgent: true },
    { source_message_id: 0 }, { source_message_id: 999 },
  ];
  for (const bad of invalid) {
    const r = await send(h, args(1, bad));
    assert.equal(r.outcome, "rejected", JSON.stringify(bad));
    assert.equal(r.relay_id, null);
  }
  assert.equal(posts(h), 0);
});

test("source metadata and embedded hop markers cannot be lowered by the caller", async () => {
  const h = harness({ MAX_HOP: "9" });
  const id = h.relay.deliver("alice", "grok", "stop [hop:2]");
  assert.equal((await send(h, args(1, { source_message_id: id, hop: 0 }))).reason, "hop_limit");
  assert.equal((await send(h, args(2, { text: "stop [ccim-auto from=bob hop=2]" }))).reason, "hop_limit");
  const id1 = h.relay.deliver("alice", "grok", "continue [hop:1]");
  const r = await send(h, args(3, { source_message_id: id1 }));
  assert.equal(r.hop, 2);
  assert.match([...h.relay.queues.get("bob").values()][0].text, new RegExp(`hop=2 re=#${id1}`));
  assert.equal(posts(h), 1);
});

test("same clientId is durable and payload changes or recipient changes are rejected", async () => {
  const h = harness({ STATE_NAMESPACE: "relay/channel/grok" });
  const first = await send(h, args());
  h.advance(60 * 48); // Relay dedupe expires at 24 h; adapter records must not.
  const again = await send(h, args());
  assert.equal(again.relay_id, first.relay_id);
  assert.equal(again.duplicate, true);
  for (const extra of [{ text: "different" }, { to: "alice" }, { hop: 1 }]) {
    assert.equal((await send(h, args(1, extra))).reason, "client_id_reused");
  }
  const r = (await h.mcp("grok_status", { clientId: args().clientId })).structuredContent;
  assert.equal(r.relay_id, first.relay_id);
  assert.equal(r.fingerprint, undefined);
  assert.equal(posts(h), 1);
});

test("rolling and daily budgets are independent per recipient and separate from wake budgets", async () => {
  const h = harness({ SEND_LIMIT: "3", SEND_DAILY_CAP: "4", DAILY_CAP: "0", SENDER_LIMIT: "0" });
  for (let n = 1; n <= 3; n++) assert.equal((await send(h, args(n))).outcome, "sent");
  assert.equal((await send(h, args(4))).reason, "recipient_window_limit");
  assert.equal((await send(h, args(5, { to: "alice" }))).outcome, "sent");
  h.advance(10);
  assert.equal((await send(h, args(4))).outcome, "sent");
  assert.equal((await send(h, args(6))).reason, "recipient_daily_limit");
  h.clock.t = Date.UTC(2026, 9, 20, 16, 0, 0); // Next day in UTC+8.
  assert.equal((await send(h, args(6))).outcome, "sent");
  assert.equal(posts(h), 6);
});

test("configured send caps apply and zero disables proactive sends", async () => {
  const h = harness({ SEND_LIMIT: "1", SEND_WINDOW_MIN: "2" });
  assert.equal((await send(h, args())).outcome, "sent");
  h.advance(1);
  assert.equal((await send(h, args(2))).reason, "recipient_window_limit");
  h.advance(1);
  assert.equal((await send(h, args(2))).outcome, "sent");
  assert.equal((await send(harness({ SEND_LIMIT: "0" }), args())).reason, "recipient_window_limit");
  assert.equal((await send(harness({ SEND_DAILY_CAP: "0" }), args())).reason, "recipient_daily_limit");
});

test("default proactive budget is 10 per 10 minutes and 100 per day per recipient", async () => {
  const h = harness();
  for (let n = 1; n <= 10; n++) assert.equal((await send(h, args(n))).outcome, "sent");
  assert.equal((await send(h, args(11))).reason, "recipient_window_limit");
  h.advance(10);
  assert.equal((await send(h, args(11))).outcome, "sent");
  for (let n = 12; n <= 100; n++) {
    if (n % 10 === 1) h.advance(10);
    assert.equal((await send(h, args(n))).outcome, "sent");
  }
  h.advance(10);
  const dayRate = await h.storage.get("rate:send:bob");
  assert.equal(dayRate.count, 100);
  assert.equal((await send(h, args(101))).reason, "recipient_daily_limit");
});

test("concurrent same-clientId calls issue exactly one POST", async () => {
  const h = harness();
  const results = await Promise.all(Array.from({ length: 8 }, () => send(h, args())));
  assert.equal(posts(h), 1);
  assert.equal(h.relay.queues.get("bob").size, 1);
  assert.ok(results.every((r) => ["sent", "uncertain"].includes(r.outcome)));
});

test("in-flight send blocks different clientIds to that recipient, not other recipients", async () => {
  const h = harness();
  const original = h.adapter.deps.fetch;
  let release, started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  h.adapter.deps.fetch = async (url, init) => {
    if (url.endsWith("/send") && JSON.parse(init.body).to === "bob") { started(); await gate; }
    return original(url, init);
  };
  const pending = send(h, args());
  await waiting;
  assert.equal((await send(h, args(2))).reason, "recipient_has_unconfirmed_send");
  assert.equal((await send(h, args(3, { to: "alice" }))).outcome, "sent");
  release();
  assert.equal((await pending).outcome, "sent");
  assert.equal(posts(h), 2);
});

test("lost relay response stays uncertain across restart and cannot be retried with a new id", async () => {
  const h = harness({ STATE_NAMESPACE: "relay/channel/grok" });
  const original = h.adapter.deps.fetch;
  h.adapter.deps.fetch = async (url, init) => {
    const r = await original(url, init);
    if (url.endsWith("/send")) throw new Error(`lost ${TOKEN}`);
    return r;
  };
  const first = await send(h, args());
  assert.equal(first.outcome, "uncertain");
  assert.equal(first.relay_id, null);
  const restarted = new Adapter({ storage: h.storage }, h.env, { fetch: original, now: () => h.clock.t, log: () => {} });
  h.adapter.fetch = restarted.fetch.bind(restarted);
  assert.equal((await send(h, args())).outcome, "uncertain");
  assert.equal((await send(h, args(2))).reason, "recipient_has_unconfirmed_send");
  assert.equal((await send(h, args(3, { to: "alice" }))).outcome, "sent");
  assert.equal(posts(h), 2);
  assert.equal(h.relay.queues.get("bob").size, 1);
  assert.ok(!JSON.stringify(h.logs).includes(TOKEN));
});

test("known relay rejection is cached and still consumes an attempt", async () => {
  const h = harness({ SEND_LIMIT: "1" });
  h.adapter.deps.fetch = async () => new Response(JSON.stringify({ error: "unknown_handle" }), { status: 404 });
  const first = await send(h, args());
  assert.equal(first.outcome, "rejected");
  assert.equal(first.reason, "unknown_handle");
  assert.equal((await send(h, args())).duplicate, true);
  assert.equal((await send(h, args(2))).reason, "recipient_window_limit");
});

test("storage failure before reserve performs no POST", async () => {
  const h = harness();
  h.storage.transaction = async () => { throw new Error("storage failed"); };
  assert.equal((await send(h, args())).reason, "storage_unavailable_before_send");
  assert.equal(posts(h), 0);
});

test("receipt persistence failure keeps reservation and recipient lock", async () => {
  const h = harness();
  const transaction = h.storage.transaction.bind(h.storage);
  let calls = 0;
  h.storage.transaction = async (fn) => {
    if (++calls === 2) throw new Error("save failed");
    return transaction(fn);
  };
  const first = await send(h, args());
  assert.equal(first.outcome, "sent");
  assert.equal(first.persistence, "receipt_not_saved");
  assert.equal((await send(h, args())).outcome, "uncertain");
  assert.equal((await send(h, args(2))).reason, "recipient_has_unconfirmed_send");
  assert.equal(posts(h), 1);
});

test("response bodies and credentials never appear in return values, logs or durable send records", async () => {
  const h = harness();
  h.adapter.deps.log = makeLogger(h.env, (line) => h.logs.push(line));
  h.adapter.deps.fetch = async () => new Response(`proxy echoed Bearer ${TOKEN}`, { status: 502 });
  assert.equal((await send(h, args(1, { text: TOKEN }))).reason, "credential_in_arguments");
  const result = await send(h, args());
  assert.equal(result.outcome, "uncertain");
  const serialized = JSON.stringify([result, h.logs, [...h.storage.map]]);
  for (const forbidden of [TOKEN, MCP_BEARER, "proxy echoed", "test 1"]) assert.ok(!serialized.includes(forbidden));
});

test("status is read-only and auth applies to proactive sending", async () => {
  const h = harness();
  assert.equal((await h.mcp("grok_send", args(), "wrong")).httpStatus, 401);
  assert.equal((await h.mcp("grok_status", { clientId: "unknown-id" })).structuredContent.found, false);
  assert.equal((await h.mcp("grok_status", { clientId: "unknown-id", ids: [1] })).isError, true);
  assert.equal(posts(h), 0);
});
