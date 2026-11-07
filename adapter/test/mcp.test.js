import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./helpers.js";
import worker from "../src/index.js";

test("MCP rejects a missing or wrong bearer", async () => {
  const h = harness();
  assert.equal((await h.mcp("grok_status", {}, "wrong")).httpStatus, 401);
  assert.equal((await h.mcp("grok_status", {}, "")).httpStatus, 401);
});

test("tools/list exposes the five scoped grok tools", async () => {
  const h = harness();
  const res = await h.adapter.fetch(new Request("https://w/mcp", { method: "POST", headers: { authorization: `Bearer ${h.env.MCP_BEARER}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
  const names = (await res.json()).result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["grok_ack", "grok_inbox", "grok_reply", "grok_send", "grok_status"]);
  const reply = (await h.mcp("grok_reply", { reply_to_id: 1, text: "x", to: "bob" }));
  assert.equal(reply.isError, true);
  assert.match(reply.content[0].text, /unexpected argument/);
});

test("grok_inbox peeks without acking; shows direct by default, skipped on request, by id", async () => {
  const h = harness();
  const d = h.relay.deliver("alice", "grok", "ping-001");
  const b = h.relay.deliver("bob", "*", "broadcast");
  const r1 = await h.mcp("grok_inbox");
  assert.deepEqual(r1.structuredContent.messages.map((m) => m.id), [d]);
  assert.match(r1.content[0].text, /not from your user/);
  const r2 = await h.mcp("grok_inbox", { include_skipped: true });
  assert.deepEqual(r2.structuredContent.messages.map((m) => m.id), [d, b]);
  const r3 = await h.mcp("grok_inbox", { ids: [b, 999] });
  assert.deepEqual(r3.structuredContent.messages.map((m) => m.id), [b]);
  assert.deepEqual(r3.structuredContent.missing, [999]);
  assert.equal(h.relay.queues.get("grok").size, 2);
});

test("grok_reply goes only to the original sender, with hop tag and deterministic clientId; retry dedupes", async () => {
  const h = harness();
  const id = h.relay.deliver("alice", "grok", "ping-001");
  await h.tick();
  const r = await h.mcp("grok_reply", { reply_to_id: id, text: "pong-001" });
  assert.equal(r.isError, undefined);
  assert.equal(r.structuredContent.to, "alice");
  assert.equal(r.structuredContent.hop, 1);
  const got = [...h.relay.queues.get("alice").values()];
  assert.equal(got.length, 1);
  assert.equal(got[0].from, "grok");
  assert.equal(got[0].text, `pong-001\n\n[ccim-auto from=grok hop=1 re=#${id}]`);
  const again = await h.mcp("grok_reply", { reply_to_id: id, text: "pong-001" });
  assert.equal(again.structuredContent.duplicate, true);
  assert.equal(h.relay.queues.get("alice").size, 1, "retry must not deliver twice");
  const different = await h.mcp("grok_reply", { reply_to_id: id, text: "something else" });
  assert.equal(different.isError, true);
  assert.match(different.content[0].text, /part 2/);
  assert.equal(h.relay.queues.get("bob").size, 0);
});

test("grok_reply refuses unknown ids, own messages and hop-limited messages", async () => {
  const h = harness();
  assert.equal((await h.mcp("grok_reply", { reply_to_id: 42, text: "x" })).isError, true);
  h.relay.queues.get("grok").set(7, { type: "msg", id: 7, from: "grok", to: "grok", text: "self", urgent: false, ts: 1 });
  const hopId = h.relay.deliver("bob", "grok", "fine [ccim-auto from=bob hop=2 re=#3]");
  await h.tick();
  assert.match((await h.mcp("grok_reply", { reply_to_id: 7, text: "x" })).content[0].text, /own message/);
  assert.match((await h.mcp("grok_reply", { reply_to_id: hopId, text: "x" })).content[0].text, /hop 2/);
  assert.equal(h.relay.queues.get("bob").size, 0);
});

test("a failed relay lookup is not reported as a missing message or a submitted reply", async () => {
  const h = harness();
  h.relay.down = true;
  const reply = await h.mcp("grok_reply", { reply_to_id: 27, text: "completed result" });
  assert.equal(reply.isError, true);
  assert.equal(reply.structuredContent.error, "relay_lookup_failed");
  assert.equal(reply.structuredContent.reply_submitted, false);
  assert.equal(reply.structuredContent.retry_allowed, false);
  assert.doesNotMatch(reply.content[0].text, /never received|not found/);
  assert.equal(h.relay.calls.filter((call) => call.op === "send").length, 0);
  assert.equal(h.relay.queues.get("alice").size, 0);
});

test("reply to a hop-1 message is tagged hop 2, which the other side's adapter would skip", async () => {
  const h = harness();
  const id = h.relay.deliver("bob", "grok", "answer this [hop:1]");
  await h.tick();
  const r = await h.mcp("grok_reply", { reply_to_id: id, text: "done" });
  assert.equal(r.structuredContent.hop, 2);
  assert.match([...h.relay.queues.get("bob").values()][0].text, /hop=2/);
});

test("four stages: 送达 -> 已唤醒 -> 已处理 -> 已回复", async () => {
  const h = harness();
  const id = h.relay.deliver("alice", "grok", "ping-001");
  await h.mcp("grok_inbox"); // records without waking
  const st = async () => (await h.mcp("grok_status", { ids: [id] })).structuredContent.messages[0];
  assert.equal((await st()).stage_cn, "送达");
  await h.tick();
  assert.equal((await st()).stage_cn, "已唤醒");
  await h.mcp("grok_ack", { ids: [id] });
  assert.equal((await st()).stage_cn, "已处理");
  assert.equal(h.relay.queues.get("grok").size, 0);
  await h.mcp("grok_reply", { reply_to_id: id, text: "pong-001" });
  const final = await st();
  assert.equal(final.stage_cn, "已回复");
  assert.ok(final.stages.recorded && final.stages.woken && final.stages.acked && final.stages.replied);
  assert.equal(final.replies[0].to, "alice");
});

test("acked message is not woken even if the wake had failed before", async () => {
  const h = harness();
  h.webhook.next([500, "x"]);
  const id = h.relay.deliver("alice", "grok", "ping");
  await h.tick();
  await h.mcp("grok_ack", { ids: [id] });
  h.advance(10); await h.tick();
  assert.equal(h.webhook.calls.length, 1);
});

test("worker routing: /mcp forwarded only when enabled; tick not reachable from outside; cron calls the DO", async () => {
  const seen = [];
  const env = (extra = {}) => ({ ...extra, ADAPTER: { idFromName: (n) => n, get: () => ({ fetch: async (r) => { seen.push(typeof r === "string" ? r : r.url); return new Response("{}"); } }) } });
  assert.equal((await worker.fetch(new Request("https://w/tick", { method: "POST" }), env())).status, 404);
  assert.equal((await worker.fetch(new Request("https://w/mcp", { method: "POST" }), env({ MCP_ENABLED: "off" }))).status, 404);
  assert.equal((await worker.fetch(new Request("https://w/health"), env())).status, 200);
  await worker.fetch(new Request("https://w/mcp", { method: "POST" }), env());
  let waited;
  await worker.scheduled({}, env(), { waitUntil: (p) => (waited = p) });
  await waited;
  assert.deepEqual(seen, ["https://w/mcp", "https://adapter.internal/tick"]);
});
