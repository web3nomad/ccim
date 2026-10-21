import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHop, redact, makeLogger, dayKey, safeEqual } from "../src/util.js";
import { AuthorMcpRelay } from "../src/relay.js";
import { config } from "../src/util.js";
import { MemoryStorage } from "./helpers.js";

test("parseHop reads both tag forms and takes the highest", () => {
  assert.deepEqual(parseHop("hello"), { hop: 0, auto: false });
  assert.deepEqual(parseHop("x\n\n[ccim-auto from=grok hop=1 re=#4]"), { hop: 1, auto: true });
  assert.deepEqual(parseHop("[hop:3] and [ccim-auto hop=2]"), { hop: 3, auto: true });
});

test("redact removes configured secrets and bearer-looking strings", () => {
  const env = { WEBHOOK_KEY: "crsr_abcdefgh123", CCIM_TOKEN: "tok-1234567890", WEBHOOK_URL: "https://api2.example/automations/webhook/xyz" }; // gitleaks:allow -- synthetic key used only by local redaction tests
  const out = redact("a crsr_abcdefgh123 b tok-1234567890 c https://api2.example/automations/webhook/xyz Bearer zzz cca_qqq", env);
  for (const s of ["abcdefgh123", "tok-1234567890", "webhook/xyz", "zzz", "cca_qqq"]) assert.ok(!out.includes(s), s);
  const lines = [];
  makeLogger(env, (l) => lines.push(l))("x", { leak: "tok-1234567890" });
  assert.ok(!lines[0].includes("tok-1234567890"));
});

test("dayKey supports a configured UTC offset", () => {
  assert.equal(dayKey(Date.UTC(2026, 9, 20, 15, 59), 480 * 60000), "2026-10-20");
  assert.equal(dayKey(Date.UTC(2026, 9, 20, 16, 0), 480 * 60000), "2026-10-21");
});

test("safeEqual", async () => {
  assert.equal(await safeEqual("abc", "abc"), true);
  assert.equal(await safeEqual("abc", "abd"), false);
  assert.equal(await safeEqual("", ""), false);
});

test("author-mcp relay: refreshes on 401, persists the rotated refresh token, maps ccim_* tools", async () => {
  const storage = new MemoryStorage();
  const env = { CCIM_RELAY: "https://relay.test", RELAY_MODE: "author-mcp", OAUTH_CLIENT_ID: "dcr_x", OAUTH_REFRESH_TOKEN: "ccr_first" };
  const calls = [];
  let n = 0;
  const fetch = async (url, init) => {
    calls.push(url);
    if (url.endsWith("/oauth/token")) {
      const f = new URLSearchParams(init.body);
      assert.equal(f.get("grant_type"), "refresh_token");
      assert.equal(f.get("resource"), "https://relay.test/mcp");
      n++;
      return new Response(JSON.stringify({ access_token: `cca_${n}`, refresh_token: `ccr_${n + 1}`, expires_in: 3600 }), { status: 200 });
    }
    const auth = new Headers(init.headers).get("authorization");
    if (auth === "Bearer cca_1" && calls.filter((u) => u.endsWith("/mcp")).length === 2) return new Response("{}", { status: 401 });
    const { params } = JSON.parse(init.body);
    const sc = params.name === "ccim_inbox" ? { messages: [{ id: 3, from: "alice", to: "grok", text: "hi", urgent: false, ts: 1 }], more: false }
      : params.name === "ccim_send" ? { id: 9, delivery: { "alice": "delivered" }, duplicate: false } : { acked: params.arguments.ids };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: sc, content: [] } }), { status: 200 });
  };
  const relay = new AuthorMcpRelay(config(env), env, { fetch, storage });
  const p = await relay.peek();
  assert.equal(p.messages[0].id, 3);
  const s = await relay.send({ to: "alice", text: "x", clientId: "grok-re-3-p1" });
  assert.equal(s.id, 9);
  assert.equal((await storage.get("oauth")).refresh, "ccr_3", "rotated refresh token persisted");
  assert.deepEqual(await relay.ack([3]), { ok: true });
});
