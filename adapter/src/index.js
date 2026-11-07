// Worker entry and the single Durable Object that owns all adapter state.
//
// - scheduled (cron, every minute): asks the Durable Object to run one tick (src/core.js).
// - POST /mcp: the Bot's MCP endpoint (src/mcp.js), unless MCP_ENABLED = "off".
// - GET /health: liveness only, no state.
// Nothing else is routed, so the tick cannot be triggered from outside.
//
// The Durable Object uses the plain-class form (constructor(state, env)), which Cloudflare still accepts, so this
// file imports nothing from "cloudflare:workers" and the tests can load it under Node.

import { makeContext, tick } from "./core.js";
import { handleMcp } from "./mcp.js";
import { config, json } from "./util.js";

const stub = (env) => env.ADAPTER.get(env.ADAPTER.idFromName("grok"));

export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    if (path === "/health" && req.method === "GET") return json(200, { ok: true });
    if (path === "/mcp" && config(env).mcpEnabled) return stub(env).fetch(req);
    return json(404, { error: "not_found" });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(stub(env).fetch("https://adapter.internal/tick", { method: "POST" }));
  },
};

export class Adapter {
  constructor(state, env, deps = {}) {
    this.state = state;
    this.env = env;
    this.deps = deps; // tests inject fetch, now and log
  }

  ctx() {
    return makeContext({
      storage: this.state.storage,
      env: this.env,
      fetch: this.deps.fetch || ((...a) => fetch(...a)),
      now: this.deps.now,
      log: this.deps.log,
    });
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/tick" && url.hostname === "adapter.internal") return json(200, await tick(this.ctx()));
    if (url.pathname === "/mcp") return handleMcp(req, this.ctx());
    return json(404, { error: "not_found" });
  }
}
