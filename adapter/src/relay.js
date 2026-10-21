// Two ways to reach grok's queue on the ccim relay. Both expose the same small interface:
//   peek()                      -> { ok, messages: [{ id, from, to, text, urgent, ts }] } (never acks)
//   ack(ids)                    -> { ok }
//   send({ to, text, clientId }) -> { outcome:"sent", id, delivery } | { outcome:"rejected"|"uncertain" }
//
// Relay API shapes, checked against web3nomad/ccim at 588fb7be011df62f001284d9346d57108ffcf4a2:
//   - Routes are /c/<channel>/<op>; member calls use "Authorization: Bearer <member token>".
//     relay/src/index.js:26-29 (routing), :124-130 (auth).
//   - GET  inbox?all=1 -> { messages:[{type,id,from,to,text,urgent,ts}] }, read-only, focus-held ones included.
//     relay/src/index.js:58-61, :219-223. Message shape: :166-167. Broadcasts keep to:"*": :158, :167.
//   - POST ack { ids } -> { ok }, deletes those queue entries. relay/src/index.js:65, :225-229.
//   - POST send { to, text, urgent, clientId } -> { id, delivery } or { ..., duplicate:true } on a same-clientId
//     retry within 24 h; 409 client_id_reused, 429 no_human_in_the_loop, 404 unknown_handle, 507 inbox_full,
//     413 text_too_long, 400 bad_client_id. clientId must match /^[A-Za-z0-9_-]{8,64}$/.
//     relay/src/index.js:12-14, :141-189.
//   - 401 unauthorized when the member token is no longer valid (someone else joined as grok, or it left).
//     relay/src/index.js:53-54, :90-96.

import { sha256 } from "./util.js";

export function makeRelay(cfg, env, deps) {
  return cfg.relayMode === "author-mcp" ? new AuthorMcpRelay(cfg, env, deps) : new DirectRelay(cfg, env, deps);
}

export class DirectRelay {
  constructor(cfg, env, { fetch }) {
    this.cfg = cfg;
    this.env = env;
    this.fetch = fetch;
  }

  async call(method, op, body) {
    let res;
    try {
      res = await this.fetch(`${this.cfg.relay}/c/${this.cfg.channel}/${op}`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${this.env.CCIM_TOKEN || ""}` },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      return { ok: false, status: 0, error: "network", diagnostic: { http_status: null, response_kind: "fetch_error" } };
    }
    const response = await readRelayResponse(res);
    // The response payload must never override the transport status or parse result.
    return { ...response.data, ok: res.status === 200 && response.valid, status: res.status, diagnostic: response.diagnostic };
  }

  async peek() {
    const r = await this.call("GET", "inbox?all=1");
    if (!r.ok) return { ok: false, status: r.status, error: r.error || `http_${r.status}` };
    return { ok: true, messages: (r.messages || []).map(pick) };
  }

  async ack(ids) {
    const r = await this.call("POST", "ack", { ids });
    return r.ok ? { ok: true } : { ok: false, status: r.status, error: r.error || `http_${r.status}` };
  }

  async send({ to, text, clientId }) {
    const r = await this.call("POST", "send", { to, text, urgent: false, clientId });
    return sendOutcome(r, to);
  }
}

const REJECTIONS = {
  400: ["bad_client_id", "empty_text"],
  401: ["unauthorized"],
  403: ["forbidden"],
  404: ["unknown_handle"],
  409: ["client_id_reused"],
  413: ["text_too_long"],
  429: ["no_human_in_the_loop"],
  507: ["inbox_full"],
};
const DELIVERY_STATES = new Set(["delivered", "queued_offline", "queued_focus"]);

// A receipt proves acceptance even if an upstream wrapper uses an erroneous HTTP status.
// Neither an id alone nor a successful HTTP status is sufficient proof.
export function sendOutcome(r, to) {
  const receipt = Number.isSafeInteger(r.id) && r.id > 0 && !r.error
    && DELIVERY_STATES.has(r.delivery?.[to]);
  if (receipt) return {
    ok: true, outcome: "sent", id: r.id, delivery: { [to]: r.delivery[to] },
    duplicate: r.duplicate === true, diagnostic: r.diagnostic,
  };
  const rejected = REJECTIONS[r.status]?.includes(r.error);
  return {
    ok: false, outcome: rejected ? "rejected" : "uncertain", status: r.status,
    error: rejected ? r.error : "delivery_unconfirmed", diagnostic: r.diagnostic,
  };
}

async function readRelayResponse(res) {
  const contentType = res.headers.get("content-type") || "";
  const diagnostic = {
    http_status: res.status,
    content_type: /^application\/json\b/i.test(contentType) ? "json"
      : /^text\//i.test(contentType) ? "text" : "other",
  };
  const ray = res.headers.get("cf-ray");
  if (ray && /^[a-f0-9]{16,32}(?:-[A-Z]{3})?$/i.test(ray)) diagnostic.cf_ray = ray;
  let raw;
  try {
    raw = await res.text(); // Consume once; parse the saved string, never read the body twice.
  } catch {
    return { valid: false, diagnostic: { ...diagnostic, response_kind: "body_read_error" } };
  }
  diagnostic.response_bytes = new TextEncoder().encode(raw).length;
  diagnostic.response_sha256 = await sha256(raw);
  try {
    const data = JSON.parse(raw);
    const valid = !!data && typeof data === "object" && !Array.isArray(data);
    return { data: valid ? data : {}, valid, diagnostic: { ...diagnostic, response_kind: valid ? "json_object" : "invalid_json_shape" } };
  } catch {
    // Never log raw error bodies: proxies may echo credentials or the message text.
    return { valid: false, diagnostic: { ...diagnostic, response_kind: "non_json" } };
  }
}

// Optional mode for when the relay author enables example-channel/grok on his remote MCP AND lets this adapter hold
// that grant (an OAuth client whose redirect is on OAUTH_REDIRECT_HOSTS). Only one grant per member exists
// (relay/src/oauth.js:205-206), so the adapter and the Bot cannot both hold one: in this mode the Bot keeps using
// this Worker's /mcp and the adapter talks to the author's MCP on its behalf.
//   - MCP: POST <relay>/mcp, stateless JSON-RPC (relay/src/mcp.js:85-107).
//   - Tools: ccim_inbox {after_id, limit<=200} -> structuredContent { messages, more, next_after_id } (mcp.js:160-180);
//     ccim_ack {ids} (mcp.js:182-189); ccim_send {to, text, urgent, client_msg_id} -> { id, delivery, duplicate }
//     (mcp.js:191-211). Tool failures come back as result.isError with a text explanation.
//   - Expired/invalid access token -> HTTP 401 (mcp.js:95-102). Refresh: POST /oauth/token form
//     grant_type=refresh_token, refresh_token, client_id, resource; refresh tokens rotate and reuse kills the grant
//     (relay/src/oauth.js refresh(), issue()), so the newest refresh token is persisted before it is used again.
export class AuthorMcpRelay {
  constructor(cfg, env, { fetch, storage }) {
    this.cfg = cfg;
    this.env = env;
    this.fetch = fetch;
    this.storage = storage;
    this.seq = 0;
  }

  async tokens() {
    return (await this.storage.get("oauth")) || { access: null, refresh: this.env.OAUTH_REFRESH_TOKEN || null };
  }

  async refresh() {
    const t = await this.tokens();
    if (!t.refresh || !this.env.OAUTH_CLIENT_ID) return false;
    let res;
    try {
      res = await this.fetch(`${this.cfg.relay}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh, client_id: this.env.OAUTH_CLIENT_ID, resource: `${this.cfg.relay}/mcp` }).toString(),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      return false;
    }
    if (res.status !== 200) return false;
    const body = await res.json().catch(() => ({}));
    if (!body.access_token || !body.refresh_token) return false;
    await this.storage.put("oauth", { access: body.access_token, refresh: body.refresh_token, exp: Date.now() + (body.expires_in || 3600) * 1000 });
    return true;
  }

  async tool(name, args, retried = false) {
    const t = await this.tokens();
    if (!t.access && !retried) return (await this.refresh()) ? this.tool(name, args, true) : { ok: false, status: 401, error: "oauth_unavailable" };
    let res;
    try {
      res = await this.fetch(`${this.cfg.relay}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${t.access}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.seq, method: "tools/call", params: { name, arguments: args } }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      return { ok: false, status: 0, error: "network" };
    }
    if (res.status === 401 && !retried) return (await this.refresh()) ? this.tool(name, args, true) : { ok: false, status: 401, error: "oauth_unavailable" };
    if (res.status !== 200) return { ok: false, status: res.status, error: `http_${res.status}` };
    const body = await res.json().catch(() => ({}));
    if (body.error) return { ok: false, status: 200, error: body.error.message || "rpc_error" };
    const r = body.result || {};
    if (r.isError) return { ok: false, status: r.structuredContent?.status || 200, error: r.structuredContent?.error || (r.content?.[0]?.text || "tool_error").slice(0, 200) };
    return { ok: true, data: r.structuredContent || {} };
  }

  async peek() {
    const messages = [];
    let after = 0;
    for (let page = 0; page < 5; page++) {
      const r = await this.tool("ccim_inbox", { after_id: after, limit: 200 });
      if (!r.ok) return r;
      messages.push(...(r.data.messages || []).map(pick));
      if (!r.data.more) break;
      after = r.data.next_after_id;
    }
    return { ok: true, messages };
  }

  async ack(ids) {
    const r = await this.tool("ccim_ack", { ids });
    return r.ok ? { ok: true } : r;
  }

  async send({ to, text, clientId }) {
    const r = await this.tool("ccim_send", { to, text, urgent: false, client_msg_id: clientId });
    return sendOutcome(r.ok ? { ...r.data, status: 200 } : r, to);
  }
}

const pick = ({ id, from, to, text, urgent, ts }) => ({ id, from, to, text, urgent: !!urgent, ts });
