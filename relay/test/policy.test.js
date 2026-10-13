import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCimd, redirectAllowed, grantedScope, serverMetadata } from "../src/policy.js";
import { settings } from "../src/util.js";
import { handleMcp } from "../src/mcp.js";

const prod = { issuer: "https://ccim.web3nomad.com", redirectHosts: ["chatgpt.com"] };
const KEY = Buffer.alloc(32, 7).toString("base64");

test("redirects: https on an allowed host only, exact strings", () => {
  assert.ok(redirectAllowed("https://chatgpt.com/connector_platform_oauth_redirect", prod));
  assert.ok(redirectAllowed("https://chatgpt.com/connector/oauth/abc123", prod));
  assert.ok(!redirectAllowed("http://chatgpt.com/connector_platform_oauth_redirect", prod));
  assert.ok(!redirectAllowed("https://chatgpt.com.evil.example/cb", prod));
  assert.ok(!redirectAllowed("https://evil.example/cb", prod));
  assert.ok(!redirectAllowed("https://user@chatgpt.com/cb", prod));
  assert.ok(!redirectAllowed("https://chatgpt.com/cb#frag", prod));
  assert.ok(!redirectAllowed("http://localhost:9/cb", { ...prod, redirectHosts: ["localhost"] }), "http localhost only when the relay itself is local");
  assert.ok(redirectAllowed("http://localhost:9/cb", { issuer: "http://localhost:8799", redirectHosts: ["localhost"] }));
});

test("client metadata documents", () => {
  const url = "https://chatgpt.com/oauth/cimd.json";
  const doc = { client_id: url, client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect", "https://evil.example/cb"], token_endpoint_auth_methods_supported: ["none", "private_key_jwt"] };
  assert.deepEqual(validateCimd(url, doc, prod).redirectUris, ["https://chatgpt.com/connector_platform_oauth_redirect"], "disallowed redirects are dropped");
  assert.equal(validateCimd(url, { ...doc, client_id: "https://other/x.json" }, prod), null);
  assert.equal(validateCimd(url, { ...doc, redirect_uris: ["https://evil.example/cb"] }, prod), null);
  assert.equal(validateCimd(url, { ...doc, token_endpoint_auth_methods_supported: ["private_key_jwt"] }, prod), null);
  assert.equal(validateCimd(url, { client_id: url, redirect_uris: doc.redirect_uris, token_endpoint_auth_method: "client_secret_basic" }, prod), null);
  assert.ok(validateCimd(url, { client_id: url, redirect_uris: doc.redirect_uris }, prod));
  assert.equal(validateCimd(url, null, prod), null);
});

test("scopes: unknown ones dropped, none means all", () => {
  assert.equal(grantedScope("ccim:read"), "ccim:read");
  assert.equal(grantedScope("openid ccim:write email"), "ccim:write");
  assert.equal(grantedScope(""), "ccim:read ccim:write");
  assert.equal(grantedScope("openid"), "ccim:read ccim:write");
});

test("settings: OAuth is off unless issuer, a 32-byte key, the AUTH binding and a binding are all present", () => {
  const env = { OAUTH_ISSUER: "https://ccim.web3nomad.com/", OAUTH_ENC_KEY: KEY, MCP_ALLOWED_BINDINGS: "xd-bridge/xd-dot", OAUTH_REDIRECT_HOSTS: "chatgpt.com", AUTH: {} };
  const s = settings(env);
  assert.equal(s.ready, true);
  assert.equal(s.issuer, "https://ccim.web3nomad.com");
  assert.deepEqual(s.resources, ["https://ccim.web3nomad.com", "https://ccim.web3nomad.com/mcp"]);
  assert.deepEqual(s.bindings, [{ channel: "xd-bridge", member: "xd-dot" }]);
  assert.equal(settings({ ...env, OAUTH_ENC_KEY: undefined }).ready, false);
  assert.equal(settings({ ...env, OAUTH_ENC_KEY: Buffer.alloc(16).toString("base64") }).ready, false);
  assert.equal(settings({ ...env, AUTH: undefined }).ready, false);
  assert.equal(settings({ ...env, MCP_ALLOWED_BINDINGS: "xd-bridge/xd-dot/x, Bad/Name" }).ready, false);
});

test("authorization server metadata matches what OpenAI's docs require", () => {
  const m = serverMetadata({ ...prod, cimd: true });
  assert.deepEqual(m.code_challenge_methods_supported, ["S256"]);
  assert.equal(m.client_id_metadata_document_supported, true);
  assert.equal(m.authorization_response_iss_parameter_supported, true);
  assert.equal(m.issuer, prod.issuer);
  assert.equal(m.registration_endpoint, `${prod.issuer}/oauth/register`);
});

test("CIMD is off unless OAUTH_CIMD=on, so ChatGPT falls back to DCR", () => {
  const env = { OAUTH_ISSUER: "https://ccim.web3nomad.com", OAUTH_ENC_KEY: KEY, MCP_ALLOWED_BINDINGS: "xd-bridge/xd-dot", OAUTH_REDIRECT_HOSTS: "chatgpt.com", AUTH: {} };
  assert.equal(serverMetadata(settings(env)).client_id_metadata_document_supported, false);
  assert.equal(serverMetadata(settings({ ...env, OAUTH_CIMD: "yes" })).client_id_metadata_document_supported, false);
  assert.equal(serverMetadata(settings({ ...env, OAUTH_CIMD: "on" })).client_id_metadata_document_supported, true);
});

test("ChatGPT's real client document (fetched 2026-10-14) passes; its redirect is kept exactly", () => {
  const url = "https://chatgpt.com/oauth/gp99i9jq8Tav/client.json";
  const doc = {
    client_id: url,
    client_uri: "https://chatgpt.com/",
    redirect_uris: ["https://chatgpt.com/connector/oauth/gp99i9jq8Tav"],
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: "ChatGPT",
    token_endpoint_auth_signing_alg: "RS256",
    jwks_uri: "https://chatgpt.com/oauth/jwks.json",
  };
  assert.deepEqual(validateCimd(url, doc, prod), { clientId: url, name: "ChatGPT", redirectUris: ["https://chatgpt.com/connector/oauth/gp99i9jq8Tav"] });
  assert.ok(!validateCimd(url, doc, prod).redirectUris.includes("https://chatgpt.com/connector/oauth/other"));
});

test("with OAuth off, the ccim_* tools are hidden and refuse, the probe still works", async () => {
  const env = { OAUTH_ISSUER: "https://ccim.web3nomad.com", MCP_ALLOWED_BINDINGS: "xd-bridge/xd-dot" };
  const post = async (body) => (await handleMcp(new Request("https://x/mcp", { method: "POST", body: JSON.stringify(body) }), env)).json();
  assert.deepEqual((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools.map((t) => t.name), ["ccim_probe"]);
  assert.equal((await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ccim_send", arguments: {} } })).error.code, -32602);
  assert.equal((await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ccim_probe", arguments: {} } })).result.structuredContent.ok, true);
});
