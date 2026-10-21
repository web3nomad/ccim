import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectAdapter } from "../check-adapter-mcp.mjs";
import { harness, MCP_BEARER } from "../../adapter/test/helpers.js";

const options = { url: "https://adapter.example.invalid/mcp", bearer: MCP_BEARER };

test("MCP diagnostic interoperates with the adapter and does not read, ack, send or wake", async () => {
  const h = harness();
  await h.tick();
  h.relay.calls.length = 0;
  const methods = [];
  const result = await inspectAdapter({ ...options, request: async (url, init) => {
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.authorization, `Bearer ${MCP_BEARER}`);
    const body = JSON.parse(init.body);
    methods.push(body.method === "tools/call" ? body.params.name : body.method);
    return h.adapter.fetch(new Request(url, init));
  } });
  assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/list", "grok_status"]);
  assert.equal(result.server_version, "0.2.0");
  assert.equal(result.tools.length, 5);
  assert.deepEqual(result.poll, { at: h.clock.t, ok: true, queued: 0 });
  assert.equal(h.relay.calls.length, 0);
  assert.equal(h.webhook.calls.length, 0);
  assert.ok(!JSON.stringify(result).includes(MCP_BEARER));
});

test("MCP diagnostic refuses unsafe endpoint or missing credential before network", async () => {
  let calls = 0;
  const request = async () => { calls++; };
  for (const url of ["http://adapter.example.invalid/mcp", "https://user:password@adapter.example.invalid/mcp", "https://adapter.example.invalid/mcp?key=value"]) {
    await assert.rejects(inspectAdapter({ ...options, url, request }), /invalid_mcp_url/);
  }
  await assert.rejects(inspectAdapter({ ...options, bearer: "", request }), /missing_or_invalid_bearer/);
  assert.equal(calls, 0);
});

test("MCP diagnostic does not expose error bodies or retry failed requests", async () => {
  let calls = 0;
  await assert.rejects(inspectAdapter({ ...options, request: async () => {
    calls++;
    return new Response(MCP_BEARER, { status: 401 });
  } }), error => error.message === "http_401");
  assert.equal(calls, 1);
  await assert.rejects(inspectAdapter({ ...options, request: async () => new Response("not JSON") }), /invalid_json_response/);
});

test("MCP CLI never prints environment credentials on configuration errors", () => {
  const script = fileURLToPath(new URL("../check-adapter-mcp.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CCIM_ADAPTER_MCP_URL: MCP_BEARER, CCIM_ADAPTER_MCP_BEARER: MCP_BEARER } });
  assert.equal(result.status, 1);
  assert.ok(!(result.stdout + result.stderr).includes(MCP_BEARER));
  assert.equal(JSON.parse(result.stderr).error, "invalid_mcp_url");
});
