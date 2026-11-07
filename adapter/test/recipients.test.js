import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/util.js";
import { harness, MCP_BEARER } from "./helpers.js";

const send = { to: "alice", text: "local test; no reply", hop: 0, clientId: "recipient-test-01" };
async function list(h) {
  const res = await h.adapter.fetch(new Request("https://worker.test/mcp", {
    method: "POST", headers: { authorization: `Bearer ${MCP_BEARER}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }));
  return (await res.json()).result.tools.find(t => t.name === "grok_send");
}

test("recipient config trims and deduplicates valid handles; unset/invalid/self fails closed", () => {
  assert.deepEqual(config({ SEND_ALLOWED_RECIPIENTS: " alice, bob ,alice " }).sendAllowedRecipients, ["alice", "bob"]);
  for (const value of [undefined, "", " ", "alice,", "alice,*", "Alice", "grok", "a".repeat(33), 42]) {
    assert.deepEqual(config({ SEND_ALLOWED_RECIPIENTS: value }).sendAllowedRecipients, []);
  }
  assert.deepEqual(config({ CCIM_HANDLE: "assistant", SEND_ALLOWED_RECIPIENTS: "alice,assistant" }).sendAllowedRecipients, []);
  assert.equal(config().dayOffsetMs, 0);
});

test("unset or invalid allowlist disables sends before touching the relay", async () => {
  for (const value of [undefined, "", "alice,*", "alice,grok"]) {
    const h = harness({ SEND_ALLOWED_RECIPIENTS: value });
    assert.equal((await h.mcp("grok_send", send)).structuredContent.reason, "recipient_not_allowed");
    assert.equal(h.relay.calls.length, 0);
    const tool = await list(h);
    assert.match(tool.description, /disabled/);
    assert.equal(tool.inputSchema.properties.to.enum, undefined);
  }
});

test("tools/list and enforcement use each adapter's configured recipients without global mutation", async () => {
  const a = harness({ SEND_ALLOWED_RECIPIENTS: "alice" });
  const b = harness({ SEND_ALLOWED_RECIPIENTS: "bob" });
  assert.deepEqual((await list(a)).inputSchema.properties.to.enum, ["alice"]);
  assert.deepEqual((await list(b)).inputSchema.properties.to.enum, ["bob"]);
  assert.equal((await a.mcp("grok_send", send)).structuredContent.outcome, "sent");
  assert.equal((await b.mcp("grok_send", send)).structuredContent.reason, "recipient_not_allowed");
  assert.deepEqual((await list(a)).inputSchema.properties.to.enum, ["alice"]);
});

test("custom member identity is used for proactive and source-linked hop tags", async () => {
  const h = harness({ CCIM_HANDLE: "assistant", SEND_ALLOWED_RECIPIENTS: "alice" });
  assert.equal((await h.mcp("grok_send", send)).structuredContent.outcome, "sent");
  const id = h.relay.deliver("alice", "assistant", "local request");
  assert.equal((await h.mcp("grok_send", { ...send, clientId: "recipient-test-02", source_message_id: id })).structuredContent.outcome, "sent");
  const messages = [...h.relay.queues.get("alice").values()];
  assert.equal(messages[0].from, "assistant");
  assert.match(messages[0].text, /\[ccim-auto from=assistant hop=1\]/);
  assert.match(messages[1].text, new RegExp(`from=assistant hop=1 re=#${id}`));
});
