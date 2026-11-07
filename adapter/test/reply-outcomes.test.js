import { test } from "node:test";
import assert from "node:assert/strict";
import { DirectRelay } from "../src/relay.js";
import { config } from "../src/util.js";
import { harness, makeEnv } from "./helpers.js";
import { Adapter } from "../src/index.js";

const receipt = { id: 14, delivery: { "alice": "delivered" } };
const send = (fetch) => new DirectRelay(config(makeEnv()), makeEnv(), { fetch })
  .send({ to: "alice", text: "test 无需回复", clientId: "grok-re-12-p2" });

for (const status of [200, 201, 500]) {
  test(`valid acceptance receipt returns message id even with HTTP ${status}`, async () => {
    const r = await send(async () => new Response(JSON.stringify(receipt), { status }));
    assert.equal(r.outcome, "sent");
    assert.equal(r.id, 14);
    assert.equal(r.diagnostic.http_status, status);
  });
}

test("payload status cannot overwrite HTTP status; body is consumed once", async () => {
  let reads = 0;
  const r = await send(async () => ({
    status: 200, headers: new Headers(),
    text: async () => { assert.equal(++reads, 1); return JSON.stringify({ ...receipt, status: 500, ok: false }); },
    json: () => { throw Error("Do not read body twice"); },
  }));
  assert.equal(r.id, 14);
  assert.equal(r.diagnostic.http_status, 200);
});

for (const [status, body, kind] of [
  [500, "Internal Server Error", "non_json"],
  [200, "<html>proxy error</html>", "non_json"],
  [200, '{"id":14}', "json_object"],
  [200, "null", "invalid_json_shape"],
  [200, "[]", "invalid_json_shape"],
  [200, '{"id":14,"delivery":{"bob":"delivered"}}', "json_object"],
  [200, '{"id":14,"delivery":{"alice":"failed"}}', "json_object"],
]) {
  test(`ambiguous HTTP ${status} ${body} never claims success or rejection`, async () => {
    const r = await send(async () => new Response(body, { status }));
    assert.equal(r.outcome, "uncertain");
    assert.equal(r.id, undefined);
    assert.equal(r.diagnostic.http_status, status);
    assert.equal(r.diagnostic.response_kind, kind);
  });
}

test("body read timeout and fetch failure are distinguishable and uncertain", async () => {
  const body = await send(async () => ({
    status: 200, headers: new Headers(), text: async () => { throw Error("body timed out"); },
  }));
  assert.equal(body.outcome, "uncertain");
  assert.equal(body.diagnostic.response_kind, "body_read_error");
  const network = await send(async () => { throw Error("network"); });
  assert.equal(network.outcome, "uncertain");
  assert.equal(network.diagnostic.response_kind, "fetch_error");
});

for (const [status, error] of [[409, "client_id_reused"], [429, "no_human_in_the_loop"], [507, "inbox_full"], [401, "unauthorized"]]) {
  test(`explicit relay rejection ${status}/${error} remains an error`, async () => {
    const r = await send(async () => new Response(JSON.stringify({ error }), { status }));
    assert.equal(r.outcome, "rejected");
    assert.equal(r.error, error);
  });
}

function interceptSend(h, responder) {
  const original = h.adapter.deps.fetch;
  let sends = 0;
  h.adapter.deps.fetch = async (url, init) => {
    if (!url.endsWith("/send")) return original(url, init);
    sends++;
    return responder(original, url, init);
  };
  return () => sends;
}

test("delivered then plain 500 is uncertain; same/different part retries never POST again, including after restart", async () => {
  const h = harness();
  const id = h.relay.deliver("alice", "grok", "test");
  const count = interceptSend(h, async (original, url, init) => {
    await original(url, init); // The receiver really got the message before the relay failed.
    return new Response("Internal Server Error", { status: 500 });
  });
  const first = await h.mcp("grok_reply", { reply_to_id: id, part: 2, text: "无需回复" });
  assert.equal(first.isError, undefined);
  assert.equal(first.structuredContent.outcome, "uncertain");
  assert.equal(first.structuredContent.retry_allowed, false);
  assert.match(first.content[0].text, /不要重发/);
  assert.equal(h.relay.queues.get("alice").size, 1);
  const status = (await h.mcp("grok_status", { ids: [id] })).structuredContent.messages[0];
  assert.equal(status.reply_uncertain, true);
  assert.equal(status.reply_attempts[0].clientId, `grok-re-${id}-p2`);
  assert.equal(status.reply_attempts[0].diagnostic.http_status, 500);
  assert.equal(status.stages.replied, undefined);
  const restarted = new Adapter({ storage: h.storage }, h.env, h.adapter.deps);
  for (const part of [2, 3]) {
    const response = await restarted.fetch(new Request("https://worker.test/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${h.env.MCP_BEARER}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: part, method: "tools/call",
        params: { name: "grok_reply", arguments: { reply_to_id: id, part, text: "changed text" } } }),
    }));
    const r = (await response.json()).result;
    assert.equal(r.structuredContent.outcome, "uncertain");
  }
  assert.equal(count(), 1);
});

test("successful receipt survives duplicate and changed-text calls without a second POST", async () => {
  const h = harness();
  const id = h.relay.deliver("alice", "grok", "test");
  const count = interceptSend(h, (original, url, init) => original(url, init));
  const args = { reply_to_id: id, text: "无需回复", part: 2 };
  const first = await h.mcp("grok_reply", args);
  const again = await h.mcp("grok_reply", args);
  assert.equal(again.structuredContent.id, first.structuredContent.id);
  assert.equal(again.structuredContent.duplicate, true);
  assert.equal((await h.mcp("grok_reply", { ...args, text: "different" })).isError, true);
  assert.equal(count(), 1);
  await h.mcp("grok_ack", { ids: [id] });
  const status = (await h.mcp("grok_status", { ids: [id] })).structuredContent.messages[0];
  assert.equal(status.replies[0].relay_id, first.structuredContent.id);
  assert.ok(status.stages.acked && status.stages.replied);
});

test("concurrent calls reserve only one send before awaiting the relay", async () => {
  const h = harness();
  const id = h.relay.deliver("alice", "grok", "test");
  await h.mcp("grok_inbox");
  let release, entered;
  const started = new Promise((r) => { entered = r; });
  const pending = new Promise((r) => { release = r; });
  const count = interceptSend(h, async (original, url, init) => { entered(); await pending; return original(url, init); });
  const args = { reply_to_id: id, text: "无需回复" };
  const first = h.mcp("grok_reply", args);
  await started;
  const second = await h.mcp("grok_reply", args);
  assert.equal(second.structuredContent.outcome, "uncertain");
  release();
  assert.equal((await first).structuredContent.outcome, "sent");
  assert.equal(count(), 1);
});

test("receipt save failure keeps success response and durable resend guard", async () => {
  const h = harness();
  const id = h.relay.deliver("alice", "grok", "test");
  const put = h.storage.put.bind(h.storage);
  h.storage.put = async (key, value) => {
    if (String(key).startsWith("reply:") && value.outcome === "sent") throw Error("disk failure");
    return put(key, value);
  };
  const count = interceptSend(h, (original, url, init) => original(url, init));
  const args = { reply_to_id: id, text: "无需回复" };
  const first = await h.mcp("grok_reply", args);
  assert.equal(first.structuredContent.outcome, "sent");
  assert.equal(first.structuredContent.persistence, "receipt_not_saved");
  assert.equal((await h.mcp("grok_reply", args)).structuredContent.outcome, "uncertain");
  assert.equal(count(), 1);
});

test("500 with an actual relay receipt returns success, the delivered id, and a queryable part 2 record", async () => {
  const h = harness();
  const id = h.relay.deliver("alice", "grok", "test");
  interceptSend(h, async (original, url, init) => {
    const accepted = await original(url, init);
    return new Response(await accepted.text(), { status: 500 });
  });
  const r = await h.mcp("grok_reply", { reply_to_id: id, part: 2, text: "无需回复" });
  assert.equal(r.structuredContent.outcome, "sent");
  assert.ok(h.relay.queues.get("alice").has(r.structuredContent.id));
  const status = (await h.mcp("grok_status", { ids: [id] })).structuredContent.messages[0];
  assert.equal(status.replies[0].part, 2);
  assert.equal(status.replies[0].relay_id, r.structuredContent.id);
  assert.equal(status.reply_attempts[0].diagnostic.http_status, 500);
});

test("part 1 success does not conceal part 2 uncertainty", async () => {
  const h = harness();
  const id = h.relay.deliver("alice", "grok", "test");
  await h.mcp("grok_reply", { reply_to_id: id, part: 1, text: "无需回复" });
  interceptSend(h, async () => new Response("Internal Server Error", { status: 500 }));
  await h.mcp("grok_reply", { reply_to_id: id, part: 2, text: "无需回复" });
  const status = await h.mcp("grok_status", { ids: [id] });
  assert.equal(status.structuredContent.messages[0].stage, "replied");
  assert.equal(status.structuredContent.messages[0].reply_uncertain, true);
  assert.match(status.content[0].text, /回复状态不确定/);
});

test("failed pre-send reservation causes no relay send", async () => {
  const h = harness();
  const id = h.relay.deliver("alice", "grok", "test");
  const count = interceptSend(h, (original, url, init) => original(url, init));
  h.storage.transaction = async () => { throw Error("storage unavailable"); };
  const r = await h.mcp("grok_reply", { reply_to_id: id, text: "无需回复" });
  assert.equal(r.structuredContent.outcome, "rejected");
  assert.equal(r.structuredContent.reason, "storage_unavailable_before_send");
  assert.equal(count(), 0);
});

test("raw error bodies, headers, exception text and message text never reach logs/status/storage", async () => {
  const h = harness();
  const id = h.relay.deliver("alice", "grok", "test");
  const sensitive = "PRIVATE_BODY_MARKER_456";
  interceptSend(h, async () => new Response(`${sensitive} Bearer ${h.env.CCIM_TOKEN}`, { status: 500 }));
  const result = await h.mcp("grok_reply", { reply_to_id: id, text: sensitive });
  const status = await h.mcp("grok_status", { ids: [id] });
  const serialized = JSON.stringify([result, status, h.logs, [...h.storage.map]]);
  for (const s of [sensitive, ...Object.values(h.env).filter(v => typeof v === "string" && /test.*(token|bearer)|crsr_/.test(v))]) {
    assert.equal(serialized.includes(s), false);
  }
});
