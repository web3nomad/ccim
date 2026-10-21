import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, WEBHOOK_KEY, TOKEN, MCP_BEARER } from "./helpers.js";

const status = async (h, ids) => (await h.mcp("grok_status", ids ? { ids } : {})).structuredContent;

test("direct message wakes once; webhook carries ids, senders, channel and bearer, never text", async () => {
  const h = harness();
  const id = h.relay.deliver("alice", "grok", "ping-001 secret-ish text");
  const r = await h.tick();
  assert.equal(r.woke, true);
  assert.equal(h.webhook.calls.length, 1);
  const call = h.webhook.calls[0];
  assert.equal(call.headers.authorization, `Bearer ${WEBHOOK_KEY}`);
  const body = JSON.parse(call.body);
  assert.deepEqual(body, { channel: "example-channel", message_ids: [id], senders: ["alice"] });
  assert.ok(!call.body.includes("ping-001"));
  assert.deepEqual(Object.keys(body).sort(), ["channel", "message_ids", "senders"]);
  // peek only: the message is still queued on the relay
  assert.equal(h.relay.queues.get("grok").size, 1);
  assert.ok(!h.relay.calls.some((c) => c.op === "ack"));
});

test("dedupe: the same message never wakes twice across ticks", async () => {
  const h = harness();
  h.relay.deliver("alice", "grok", "ping-001");
  await h.tick();
  h.advance(1); await h.tick();
  h.advance(30); await h.tick();
  assert.equal(h.webhook.calls.length, 1);
});

test("broadcasts and own messages do not wake", async () => {
  const h = harness();
  const b = h.relay.deliver("alice", "*", "hello all");
  h.relay.queues.get("grok").set(99, { type: "msg", id: 99, from: "grok", to: "grok", text: "self", urgent: false, ts: 1 });
  const r = await h.tick();
  assert.equal(r.woke, false);
  assert.equal(h.webhook.calls.length, 0);
  const s = await status(h, [b, 99]);
  assert.deepEqual(s.messages.map((m) => [m.id, m.class]), [[b, "broadcast"], [99, "own"]]);
});

test("hop limit: messages tagged hop>=2 are recorded but do not wake; hop 1 still wakes", async () => {
  const h = harness();
  const hi = h.relay.deliver("alice", "grok", "ok thanks\n\n[ccim-auto from=alice hop=2 re=#5]");
  const hi2 = h.relay.deliver("bob", "grok", "noted [hop:3]");
  const lo = h.relay.deliver("bob", "grok", "question [hop:1]");
  await h.tick();
  assert.equal(h.webhook.calls.length, 1);
  assert.deepEqual(JSON.parse(h.webhook.calls[0].body).message_ids, [lo]);
  const s = await status(h, [hi, hi2]);
  assert.deepEqual(s.messages.map((m) => m.class), ["hop_limit", "hop_limit"]);
});

test("rate limit: at most 3 wakes per sender per 10 minutes, the rest deferred then woken later", async () => {
  const h = harness();
  const ids = [];
  for (let i = 0; i < 5; i++) {
    ids.push(h.relay.deliver("alice", "grok", `m${i}`));
    await h.tick();
    h.advance(1);
  }
  assert.equal(h.webhook.calls.length, 3);
  const s = await status(h, ids.slice(3));
  assert.ok(s.messages.every((m) => m.stage === "recorded" && m.wake.deferred === "rate_limit"));
  // another sender is not affected
  h.relay.deliver("bob", "grok", "c1");
  await h.tick();
  assert.equal(h.webhook.calls.length, 4);
  assert.deepEqual(JSON.parse(h.webhook.calls[3].body).senders, ["bob"]);
  // after the window, the deferred alice messages wake together in one call
  h.advance(10);
  await h.tick();
  assert.equal(h.webhook.calls.length, 5);
  assert.deepEqual(JSON.parse(h.webhook.calls[4].body).message_ids, ids.slice(3));
});

test("daily cap stops wakes for the day and resumes the next day (UTC+8 day boundary)", async () => {
  const h = harness({ DAILY_CAP: "2", SENDER_LIMIT: "100" });
  for (let i = 0; i < 3; i++) { h.relay.deliver("alice", "grok", `m${i}`); await h.tick(); h.advance(1); }
  assert.equal(h.webhook.calls.length, 2);
  const s = await status(h);
  assert.equal(s.summary.wakes_today, 2);
  assert.ok(s.messages.some((m) => m.wake.deferred === "daily_cap"));
  h.advance(24 * 60);
  await h.tick();
  assert.equal(h.webhook.calls.length, 3);
});

test("webhook failures (rate limit text, 500, network) retry on later ticks with backoff, bounded", async () => {
  const h = harness({ WAKE_MAX_ATTEMPTS: "3" });
  h.webhook.next([429, '{"success":false,"error":"Automation run rate limit exceeded"}'], [500, "oops"], [400, '{"success":false,"error":"Automation is disabled"}']);
  const id = h.relay.deliver("alice", "grok", "ping");
  await h.tick();
  let m = (await status(h, [id])).messages[0];
  assert.equal(m.wake.attempts, 1);
  assert.equal(m.wake.lastError, "rate_limited");
  await h.tick(); // backoff 1 min not elapsed yet
  assert.equal(h.webhook.calls.length, 1);
  h.advance(1); await h.tick();
  assert.equal(h.webhook.calls.length, 2);
  h.advance(2); await h.tick();
  assert.equal(h.webhook.calls.length, 3);
  m = (await status(h, [id])).messages[0];
  assert.equal(m.wake.failed, true);
  assert.equal(m.stage, "recorded");
  h.advance(60); await h.tick();
  assert.equal(h.webhook.calls.length, 3, "no more attempts after the bound");
});

test("a failed wake followed by success marks woken; 200 with success:false counts as failure", async () => {
  const h = harness();
  h.webhook.next([200, '{"success":false}']);
  const id = h.relay.deliver("alice", "grok", "ping");
  await h.tick();
  assert.equal((await status(h, [id])).messages[0].stage, "recorded");
  h.advance(1); await h.tick();
  const m = (await status(h, [id])).messages[0];
  assert.equal(m.stage, "woken");
  assert.equal(m.wake.runUuid, "run-2");
});

test("relay down: poll failure is recorded, nothing woken, recovers next tick", async () => {
  const h = harness();
  h.relay.deliver("alice", "grok", "ping");
  h.relay.down = true;
  const r = await h.tick();
  assert.equal(r.polled, false);
  assert.equal(h.webhook.calls.length, 0);
  h.relay.down = false;
  h.advance(1);
  assert.equal((await h.tick()).woke, true);
});

test("message acked elsewhere before waking is marked gone and never woken", async () => {
  const h = harness();
  h.webhook.next([500, "x"]);
  const id = h.relay.deliver("alice", "grok", "ping");
  await h.tick();
  h.relay.queues.get("grok").delete(id);
  h.advance(5); await h.tick();
  assert.equal(h.webhook.calls.length, 1);
  assert.equal((await status(h, [id])).messages[0].gone, true);
});

test("logs carry no message text and no secrets", async () => {
  const h = harness();
  h.relay.deliver("alice", "grok", "TOPSECRET-TEXT ping");
  await h.tick();
  await h.mcp("grok_inbox");
  await h.mcp("grok_reply", { reply_to_id: 1, text: "TOPSECRET-REPLY pong" });
  const all = h.logs.join("\n");
  for (const s of ["TOPSECRET", WEBHOOK_KEY, TOKEN, MCP_BEARER, "hooks.test"]) assert.ok(!all.includes(s), `log leaked ${s}`);
});
