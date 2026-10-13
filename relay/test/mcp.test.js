import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMcp } from "../src/mcp.js";

const call = async (body, method = "POST") => {
  const res = await handleMcp(new Request("https://relay.test/mcp", { method, headers: { "content-type": "application/json" }, body: method === "POST" ? JSON.stringify(body) : undefined }));
  return { status: res.status, body: res.status === 200 || res.status === 400 ? await res.json() : null };
};

test("initialize echoes a supported protocol version and falls back otherwise", async () => {
  const a = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(a.body.result.protocolVersion, "2025-06-18");
  assert.deepEqual(a.body.result.capabilities, { tools: { listChanged: false } });
  const b = await call({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal(b.body.result.protocolVersion, "2026-07-28");
});

test("tools/list exposes only the read-only probe", async () => {
  const { body } = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(body.result.tools.map((t) => t.name), ["ccim_probe"]);
  const t = body.result.tools[0];
  assert.equal(t.annotations.readOnlyHint, true);
  assert.equal(t.annotations.destructiveHint, false);
  assert.deepEqual(t.securitySchemes, [{ type: "noauth" }]);
});

test("tools/call returns the marker and no channel data", async () => {
  const { body } = await call({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "ccim_probe", arguments: {} } });
  assert.equal(body.id, 7);
  assert.match(body.result.content[0].text, /^ccim-probe-ok nonce=[0-9a-f-]{36} at /);
  assert.deepEqual(Object.keys(body.result.structuredContent).sort(), ["mark", "nonce", "ok", "serverTime"]);
  const again = await call({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "ccim_probe", arguments: {} } });
  assert.notEqual(again.body.result.structuredContent.nonce, body.result.structuredContent.nonce);
});

test("unknown tool and method are JSON-RPC errors", async () => {
  assert.equal((await call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ccim_send" } })).body.error.code, -32602);
  assert.equal((await call({ jsonrpc: "2.0", id: 1, method: "resources/list" })).body.error.code, -32601);
});

test("notifications get 202, GET gets 405, bad JSON gets 400", async () => {
  assert.equal((await call({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  assert.equal((await call(null, "GET")).status, 405);
  const res = await handleMcp(new Request("https://relay.test/mcp", { method: "POST", body: "{" }));
  assert.equal(res.status, 400);
});
