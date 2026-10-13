// OAuth 2.1 authorization server for the remote MCP endpoint.
//
// CCIM has no accounts. The authorization page asks for a channel, a member name and the channel secret,
// checks the secret against the channel, and binds the grant to that one member. The channel secret is
// only ever in that form post: it is not stored, logged, put in a URL, or returned.
//
// Two layers of credentials:
//   - OAuth access/refresh tokens, held by the MCP client (ChatGPT). They only reach the four MCP tools.
//   - The CCIM member token for the bound member, held here, encrypted, and used only server side.
//
// All state lives in one Durable Object (Auth). Storage layout:
//   client:<client_id>          -> DCR-registered client
//   cimd:<url>                  -> cached client metadata document
//   req:<id>                    -> authorization request waiting for the form post
//   code:<hash>                 -> authorization code (60 s, single use)
//   grant:<id>                  -> { channel, member, clientId, resource, scope, revoked }
//   gb:<channel>/<member>:<id>  -> grant id, to find a binding's grants
//   at:<hash>, rt:<hash>        -> access token (1 h), refresh token (30 d, rotated on use)
//   member:<channel>/<member>   -> { sealed } CCIM member token this layer joined with
//   x:<ts>:<key>                -> expiry index, swept by the alarm

import { DurableObject } from "cloudflare:workers";
import { NAME, settings, sha256, pkceChallenge, randomId, randomToken, json, channelApi, seal, unseal, log } from "./util.js";
import { resourceMetadata, serverMetadata, validateCimd, redirectAllowed, grantedScope, isLocal, isIpLiteral } from "./policy.js";

const CODE_TTL = 60 * 1000;
const REQUEST_TTL = 10 * 60 * 1000;
const ACCESS_TTL = 60 * 60 * 1000;
const REFRESH_TTL = 30 * 24 * 60 * 60 * 1000;
const CIMD_TTL = 10 * 60 * 1000;
const MAX_CLIENTS = 100;
const MAX_ATTEMPTS = 5;
const SWEEP_EVERY = 6 * 60 * 60 * 1000;

const tsKey = (ts) => String(ts).padStart(15, "0");
const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

export async function handleOAuth(req, env) {
  const cfg = settings(env);
  const path = new URL(req.url).pathname;
  if (!cfg.ready) return json(503, { error: "temporarily_unavailable", error_description: "OAuth is not configured on this relay" });

  if (req.method === "GET" && path === "/.well-known/oauth-protected-resource") return json(200, resourceMetadata(cfg, cfg.issuer));
  if (req.method === "GET" && path === "/.well-known/oauth-protected-resource/mcp") return json(200, resourceMetadata(cfg, `${cfg.issuer}/mcp`));
  if (req.method === "GET" && path === "/.well-known/oauth-authorization-server") return json(200, serverMetadata(cfg));
  if (["/oauth/authorize", "/oauth/token", "/oauth/register", "/oauth/revoke", "/oauth/manage"].includes(path)) return authStoreFetch(env, req);
  return json(404, { error: "not_found" });
}

const authStoreFetch = (env, req) => env.AUTH.get(env.AUTH.idFromName("auth")).fetch(req);

export class Auth extends DurableObject {
  async fetch(req) {
    this.cfg = settings(this.env);
    const path = new URL(req.url).pathname;
    try {
      if (path === "/oauth/authorize" && req.method === "GET") return await this.authorizeGet(req);
      if (path === "/oauth/authorize" && req.method === "POST") return await this.authorizePost(req);
      if (path === "/oauth/token" && req.method === "POST") return await this.token(req);
      if (path === "/oauth/register" && req.method === "POST") return await this.register(req);
      if (path === "/oauth/revoke" && req.method === "POST") return await this.revoke(req);
      if (path === "/oauth/manage") return await this.manage(req);
      return json(405, { error: "method_not_allowed" });
    } catch (e) {
      log("oauth_error", { path, message: String(e?.message || e).slice(0, 200) });
      return json(500, { error: "server_error" });
    }
  }

  // ---- clients -------------------------------------------------------------------------------

  // A client is either a CIMD URL (fetched and validated) or an id issued by /oauth/register.
  async client(clientId) {
    if (typeof clientId !== "string" || !clientId) return null;
    if (/^https?:\/\//.test(clientId)) return this.cimdClient(clientId);
    return (await this.ctx.storage.get(`client:${clientId}`)) || null;
  }

  async cimdClient(url) {
    // Each refusal is logged with the document's host and a reason, so a failed connection can be diagnosed.
    const refuse = (reason, extra = {}) => (log("oauth_cimd_refused", { host: hostOf(url), reason, ...extra }), null);
    if (!this.cfg.cimd) return refuse("cimd_disabled");
    if (!this.cimdUrlAllowed(url)) return refuse("url_not_allowed");
    const cached = await this.ctx.storage.get(`cimd:${url}`);
    if (cached && Date.now() - cached.fetchedAt < CIMD_TTL) return cached.client;
    let doc;
    try {
      const res = await fetch(url, { redirect: "manual", headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
      if (res.status !== 200) return refuse("fetch_status", { status: res.status });
      const text = await res.text();
      if (text.length > 64 * 1024) return refuse("too_large");
      doc = JSON.parse(text);
    } catch (e) {
      return refuse("fetch_failed", { error: String(e?.name || e).slice(0, 60) });
    }
    const client = validateCimd(url, doc, this.cfg);
    if (!client) return refuse("invalid_document");
    await this.ctx.storage.put(`cimd:${url}`, { client, fetchedAt: Date.now() });
    return client;
  }

  cimdUrlAllowed(raw) {
    let u;
    try { u = new URL(raw); } catch { return false; }
    if (u.username || u.password || u.hash || u.pathname === "/") return false;
    if (u.protocol === "https:") return !isIpLiteral(u.hostname);
    // Plain http only for a relay running on localhost, which is how the local tests stand in for ChatGPT.
    return u.protocol === "http:" && isLocal(this.cfg.issuer) && isLocal(raw);
  }

  async register(req) {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return json(400, { error: "invalid_client_metadata" });
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u) => redirectAllowed(u, this.cfg))) {
      return json(400, { error: "invalid_redirect_uri", error_description: "redirect_uris must be https URLs on an allowed host" });
    }
    if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none") {
      return json(400, { error: "invalid_client_metadata", error_description: "only public clients (token_endpoint_auth_method none) are supported" });
    }
    const existing = await this.ctx.storage.list({ prefix: "client:", limit: MAX_CLIENTS + 1 });
    if (existing.size >= MAX_CLIENTS) return json(400, { error: "invalid_client_metadata", error_description: "too many registered clients" });

    const clientId = `dcr_${randomId()}`;
    const name = typeof body.client_name === "string" ? body.client_name.slice(0, 100) : "";
    const client = { clientId, name, redirectUris: uris, createdAt: Date.now() };
    await this.ctx.storage.put(`client:${clientId}`, client);
    log("oauth_register", { client: clientId.slice(0, 12) });
    return json(201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(client.createdAt / 1000),
      client_name: name || undefined,
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }, NO_STORE);
  }

  // ---- authorization endpoint ----------------------------------------------------------------

  async authorizeGet(req) {
    const p = new URL(req.url).searchParams;
    const client = await this.client(p.get("client_id"));
    const redirectUri = p.get("redirect_uri") || "";
    // Without a known client and an exact redirect match there is nowhere safe to send the user back to.
    if (!client) return page(400, "Unknown client", "<p>This application is not recognised.</p>", this.cfg);
    if (!client.redirectUris.includes(redirectUri) || !redirectAllowed(redirectUri, this.cfg)) {
      return page(400, "Invalid redirect", "<p>The return address does not match this application.</p>", this.cfg);
    }

    const state = p.get("state");
    const back = (error, description) => this.redirect(redirectUri, { error, error_description: description, state });
    if (p.get("response_type") !== "code") return back("unsupported_response_type", "only response_type=code is supported");
    const challenge = p.get("code_challenge") || "";
    if (p.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return back("invalid_request", "PKCE with S256 is required");
    const resource = p.has("resource") ? p.get("resource") : this.cfg.issuer;
    if (!this.cfg.resources.includes(resource)) return back("invalid_target", "unknown resource");
    const scope = grantedScope(p.get("scope"));

    const id = randomId();
    const request = { clientId: client.clientId, clientName: client.name, redirectUri, state, challenge, resource, scope, exp: Date.now() + REQUEST_TTL, attempts: 0 };
    await this.putExpiring(`req:${id}`, request, request.exp);
    return this.consentPage(id, request);
  }

  async authorizePost(req) {
    const form = await req.formData().catch(() => null);
    const id = String(form?.get("request") || "");
    const request = /^[0-9a-f]{32}$/.test(id) ? await this.ctx.storage.get(`req:${id}`) : null;
    if (!request || request.exp < Date.now()) return page(400, "Request expired", "<p>Start the connection again from the application.</p>", this.cfg);
    if (request.busy) return page(409, "Already in progress", "<p>This request is already being handled.</p>", this.cfg);
    const back = (params) => this.redirect(request.redirectUri, { ...params, state: request.state });

    if (form.get("action") !== "allow") {
      await this.ctx.storage.delete(`req:${id}`);
      log("oauth_denied", { client: request.clientId.slice(0, 12) });
      return back({ error: "access_denied", error_description: "the user denied the request" });
    }

    const channel = String(form.get("channel") || "");
    const member = String(form.get("member") || "");
    const secret = String(form.get("secret") || "");
    await this.ctx.storage.put(`req:${id}`, { ...request, busy: true });
    let outcome;
    try {
      outcome = await this.bindMember(channel, member, secret);
    } catch (e) {
      await this.ctx.storage.put(`req:${id}`, { ...request, busy: false });
      throw e;
    }
    if (outcome.error) {
      const attempts = request.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await this.ctx.storage.delete(`req:${id}`);
        log("oauth_bind_failed", { reason: outcome.reason, final: true });
        return back({ error: "access_denied", error_description: "too many failed attempts" });
      }
      await this.ctx.storage.put(`req:${id}`, { ...request, attempts, busy: false });
      log("oauth_bind_failed", { reason: outcome.reason });
      return this.consentPage(id, request, { channel, member, error: outcome.error });
    }
    await this.ctx.storage.delete(`req:${id}`);

    // One live grant per member: authorizing again replaces the previous grant.
    await this.revokeBinding(channel, member);
    const grantId = randomId();
    const grant = { channel, member, clientId: request.clientId, resource: request.resource, scope: request.scope, createdAt: Date.now(), revoked: false };
    await this.ctx.storage.put({ [`grant:${grantId}`]: grant, [`gb:${channel}/${member}:${grantId}`]: grantId });

    const code = randomToken("cc_");
    const exp = Date.now() + CODE_TTL;
    await this.putExpiring(`code:${await sha256(code)}`, { grantId, clientId: request.clientId, redirectUri: request.redirectUri, challenge: request.challenge, resource: request.resource, exp, used: false }, exp);
    log("oauth_granted", { grant: grantId.slice(0, 8), member: `${channel}/${member}`, reused: outcome.reused });
    return back({ code });
  }

  // Checks the secret and gets this layer a CCIM member token without ever taking over someone else's handle.
  async bindMember(channel, member, secret) {
    if (!this.cfg.bindings.some((b) => b.channel === channel && b.member === member)) {
      return { error: "This channel and member are not enabled for this connection.", reason: "binding_not_allowed" };
    }
    const verified = await channelApi(this.env, channel, "POST", "verify", null, { secret });
    if (verified.status === 404) return { error: "No such channel.", reason: "no_channel" };
    if (verified.status !== 200) return { error: "Wrong channel secret.", reason: "wrong_secret" };

    const key = `member:${channel}/${member}`;
    const stored = await this.ctx.storage.get(key);
    if (stored) {
      const token = await this.memberToken(key, stored);
      const who = token ? await channelApi(this.env, channel, "GET", "who", null, { token }) : {};
      if (who.status === 200 && who.you === member) return { reused: true };
      // Someone else joined with this name (or it left); that token is dead. Do not take the name back.
      await this.ctx.storage.delete(key);
    }
    const joined = await channelApi(this.env, channel, "POST", "join", { handle: member, ifAbsent: true, mustExist: true }, { secret });
    if (joined.status === 409) return { error: `"${member}" is already used by another session in this channel. Have it leave first, or use another name.`, reason: "handle_taken" };
    if (joined.status !== 200) return { error: "Could not join the channel.", reason: `join_${joined.status}` };
    await this.ctx.storage.put(key, { sealed: await seal(this.env, key, joined.token), createdAt: Date.now() });
    return { reused: false };
  }

  consentPage(id, request, { channel, member, error } = {}) {
    const only = this.cfg.bindings.length === 1 ? this.cfg.bindings[0] : null;
    const host = new URL(request.redirectUri).host;
    const scopes = request.scope.split(" ").map((s) => `<li>${s === "ccim:read" ? "Read your inbox and the member list" : "Send messages and mark messages as handled"}</li>`).join("");
    const body = `
<p><b>${esc(request.clientName || request.clientId)}</b> wants to use CCIM as one channel member.<br>It will return to <b>${esc(host)}</b>.</p>
<ul>${scopes}</ul>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/oauth/authorize" autocomplete="off">
  <input type="hidden" name="request" value="${id}">
  <label>Channel <input name="channel" required pattern="[a-z0-9][a-z0-9_-]{0,31}" value="${esc(channel ?? only?.channel ?? "")}"></label>
  <label>Member name <input name="member" required pattern="[a-z0-9][a-z0-9_-]{0,31}" value="${esc(member ?? only?.member ?? "")}"></label>
  <label>Channel secret <input name="secret" type="password" required></label>
  <p class="note">The secret is checked here and not kept. The application never sees it.</p>
  <button name="action" value="allow">Allow</button> <button name="action" value="deny" formnovalidate>Deny</button>
</form>`;
    return page(200, "Connect to CCIM", body, this.cfg, request.redirectUri);
  }

  redirect(redirectUri, params) {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries({ ...params, iss: this.cfg.issuer })) if (v !== undefined && v !== null) u.searchParams.set(k, v);
    return new Response(null, { status: 302, headers: { location: u.toString(), ...NO_STORE, "referrer-policy": "no-referrer" } });
  }

  // ---- token endpoint ------------------------------------------------------------------------

  async token(req) {
    const form = await req.formData().catch(() => null);
    if (!form) return tokenError(400, "invalid_request", "form body required");
    const clientId = String(form.get("client_id") || "");
    if (form.get("grant_type") === "authorization_code") return this.exchangeCode(form, clientId);
    if (form.get("grant_type") === "refresh_token") return this.refresh(form, clientId);
    return tokenError(400, "unsupported_grant_type", "use authorization_code or refresh_token");
  }

  async exchangeCode(form, clientId) {
    const key = `code:${await sha256(String(form.get("code") || ""))}`;
    const code = await this.ctx.storage.get(key);
    if (!code) return tokenError(400, "invalid_grant", "unknown code");
    if (code.used) {
      // A code presented twice may have been stolen: kill everything it produced.
      await this.revokeGrant(code.grantId, "code_reuse");
      return tokenError(400, "invalid_grant", "code already used");
    }
    await this.ctx.storage.put(key, { ...code, used: true });
    if (code.exp < Date.now()) return tokenError(400, "invalid_grant", "code expired");
    if (code.clientId !== clientId) return tokenError(400, "invalid_grant", "code was issued to another client");
    if (code.redirectUri !== form.get("redirect_uri")) return tokenError(400, "invalid_grant", "redirect_uri mismatch");
    const verifier = String(form.get("code_verifier") || "");
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || (await pkceChallenge(verifier)) !== code.challenge) return tokenError(400, "invalid_grant", "PKCE verification failed");
    if (form.has("resource") && form.get("resource") !== code.resource) return tokenError(400, "invalid_target", "resource mismatch");

    const grant = await this.ctx.storage.get(`grant:${code.grantId}`);
    if (!grant || grant.revoked) return tokenError(400, "invalid_grant", "grant revoked");
    return this.issue(code.grantId, grant, grant.scope);
  }

  async refresh(form, clientId) {
    const key = `rt:${await sha256(String(form.get("refresh_token") || ""))}`;
    const rt = await this.ctx.storage.get(key);
    if (!rt) return tokenError(400, "invalid_grant", "unknown refresh token");
    if (rt.used) {
      await this.revokeGrant(rt.grantId, "refresh_reuse");
      return tokenError(400, "invalid_grant", "refresh token already used");
    }
    const grant = await this.ctx.storage.get(`grant:${rt.grantId}`);
    if (!grant || grant.revoked || rt.exp < Date.now()) return tokenError(400, "invalid_grant", "refresh token expired or revoked");
    if (grant.clientId !== clientId) return tokenError(400, "invalid_grant", "refresh token was issued to another client");
    if (form.has("resource") && form.get("resource") !== grant.resource) return tokenError(400, "invalid_target", "resource mismatch");
    let scope = grant.scope;
    if (form.get("scope")) {
      const asked = String(form.get("scope")).split(" ").filter(Boolean);
      if (!asked.every((s) => grant.scope.split(" ").includes(s))) return tokenError(400, "invalid_scope", "cannot widen scope on refresh");
      scope = asked.join(" ");
    }
    await this.ctx.storage.put(key, { ...rt, used: true });
    return this.issue(rt.grantId, grant, scope);
  }

  async issue(grantId, grant, scope) {
    const now = Date.now();
    const access = randomToken("cca_");
    const refresh = randomToken("ccr_");
    await this.putExpiring(`at:${await sha256(access)}`, { grantId, scope, resource: grant.resource, exp: now + ACCESS_TTL }, now + ACCESS_TTL);
    await this.putExpiring(`rt:${await sha256(refresh)}`, { grantId, exp: now + REFRESH_TTL, used: false }, now + REFRESH_TTL);
    log("oauth_token", { grant: grantId.slice(0, 8) });
    return json(200, { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope }, NO_STORE);
  }

  // RFC 7009. Revoking either token ends the whole grant. Always 200, so it says nothing about what exists.
  async revoke(req) {
    const form = await req.formData().catch(() => null);
    const token = String(form?.get("token") || "");
    const clientId = String(form?.get("client_id") || "");
    const hash = await sha256(token);
    const record = (await this.ctx.storage.get(`at:${hash}`)) || (await this.ctx.storage.get(`rt:${hash}`));
    if (record) {
      const grant = await this.ctx.storage.get(`grant:${record.grantId}`);
      if (grant && grant.clientId === clientId) await this.revokeGrant(record.grantId, "client_revoke");
    }
    return new Response(null, { status: 200, headers: NO_STORE });
  }

  // ---- used by the MCP endpoint --------------------------------------------------------------

  // Resolves an access token to its member. The CCIM member token is returned to the Worker only, never to the client.
  async authenticate(token) {
    const cfg = (this.cfg = settings(this.env));
    const at = await this.ctx.storage.get(`at:${await sha256(token || "")}`);
    if (!at || at.exp < Date.now()) return { error: "invalid_token", description: "the access token is unknown or expired" };
    if (!cfg.resources.includes(at.resource)) return { error: "invalid_token", description: "the access token was issued for another resource" };
    const grant = await this.ctx.storage.get(`grant:${at.grantId}`);
    if (!grant || grant.revoked) return { error: "invalid_token", description: "the authorization was revoked" };
    if (!cfg.bindings.some((b) => b.channel === grant.channel && b.member === grant.member)) return { error: "invalid_token", description: "this member is no longer enabled" };
    const key = `member:${grant.channel}/${grant.member}`;
    const stored = await this.ctx.storage.get(key);
    const memberToken = stored && (await this.memberToken(key, stored));
    if (!memberToken) {
      await this.revokeBinding(grant.channel, grant.member, stored ? "member_token_unreadable" : "member_gone");
      return { error: "invalid_token", description: "the channel membership is gone; connect again" };
    }
    return { grant: at.grantId, channel: grant.channel, member: grant.member, scopes: at.scope.split(" "), memberToken };
  }

  // A stored member token that no longer decrypts (OAUTH_ENC_KEY was replaced) is dropped: it can never be used again.
  async memberToken(key, stored) {
    try {
      return await unseal(this.env, key, stored.sealed);
    } catch {
      await this.ctx.storage.delete(key);
      log("oauth_member_token_unreadable", { member: key.slice("member:".length) });
      return null;
    }
  }

  // The channel no longer accepts the member token (someone else took the name, or it left).
  async memberLost(channel, member) {
    this.cfg = settings(this.env);
    await this.ctx.storage.delete(`member:${channel}/${member}`);
    await this.revokeBinding(channel, member, "member_lost");
  }

  // ---- revocation and the manage page --------------------------------------------------------

  async revokeGrant(grantId, reason) {
    const grant = await this.ctx.storage.get(`grant:${grantId}`);
    if (!grant || grant.revoked) return;
    await this.ctx.storage.put(`grant:${grantId}`, { ...grant, revoked: true, revokedAt: Date.now(), reason });
    await this.ctx.storage.delete(`gb:${grant.channel}/${grant.member}:${grantId}`);
    log("oauth_revoked", { grant: grantId.slice(0, 8), reason });
  }

  async revokeBinding(channel, member, reason = "replaced") {
    for (const grantId of (await this.ctx.storage.list({ prefix: `gb:${channel}/${member}:` })).values()) await this.revokeGrant(grantId, reason);
  }

  // GET shows a form. POST with the channel secret lists the channel's OAuth members and can revoke them.
  async manage(req) {
    const csp = this.cfg;
    const ask = (error = "") => page(200, "Manage CCIM connections", `
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/oauth/manage" autocomplete="off">
  <label>Channel <input name="channel" required pattern="[a-z0-9][a-z0-9_-]{0,31}"></label>
  <label>Channel secret <input name="secret" type="password" required></label>
  <button name="action" value="list">Show connections</button>
</form>`, csp);
    if (req.method === "GET") return ask();
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

    const form = await req.formData().catch(() => null);
    const channel = String(form?.get("channel") || "");
    const secret = String(form?.get("secret") || "");
    if (!NAME.test(channel)) return ask("Bad channel name.");
    const verified = await channelApi(this.env, channel, "POST", "verify", null, { secret });
    if (verified.status !== 200) return ask("Wrong channel or secret.");

    const action = String(form.get("action") || "list");
    let note = "";
    if (action === "revoke" || action === "revoke_leave") {
      const member = String(form.get("member") || "");
      if (NAME.test(member)) {
        await this.revokeBinding(channel, member, "manage_revoke");
        const key = `member:${channel}/${member}`;
        const stored = await this.ctx.storage.get(key);
        if (action === "revoke_leave" && stored) {
          const token = await this.memberToken(key, stored);
          const who = token ? await channelApi(this.env, channel, "GET", "who", null, { token }) : {};
          if (who.status === 200 && who.you === member) await channelApi(this.env, channel, "POST", "leave", {}, { token });
          await this.ctx.storage.delete(key);
        }
        note = action === "revoke_leave" ? `Revoked ${member} and removed it from the channel.` : `Revoked ${member}. It stays a channel member; connecting again reuses it.`;
      }
    }

    const rows = [];
    for (const [key] of await this.ctx.storage.list({ prefix: `member:${channel}/` })) {
      const member = key.slice(`member:${channel}/`.length);
      const live = (await this.ctx.storage.list({ prefix: `gb:${channel}/${member}:` })).size;
      rows.push(`<li><b>${esc(member)}</b>: ${live ? "connected" : "no active connection"}
<form method="post" action="/oauth/manage" class="inline"><input type="hidden" name="channel" value="${esc(channel)}"><input type="hidden" name="member" value="${esc(member)}">
<input type="password" name="secret" placeholder="channel secret" required>
<button name="action" value="revoke">Revoke</button> <button name="action" value="revoke_leave">Revoke and leave channel</button></form></li>`);
    }
    return page(200, "Manage CCIM connections", `${note ? `<p>${esc(note)}</p>` : ""}<p>Members of <b>${esc(channel)}</b> created through OAuth:</p><ul>${rows.join("") || "<li>none</li>"}</ul>`, csp);
  }

  // ---- housekeeping --------------------------------------------------------------------------

  async putExpiring(key, value, exp) {
    await this.ctx.storage.put({ [key]: value, [`x:${tsKey(exp)}:${key}`]: 1 });
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + SWEEP_EVERY);
  }

  async alarm() {
    const expired = await this.ctx.storage.list({ prefix: "x:", end: `x:${tsKey(Date.now())}`, limit: 500 });
    const keys = [...expired.keys()];
    await this.ctx.storage.delete([...keys, ...keys.map((k) => k.slice(2 + 15 + 1))]);
    const more = (await this.ctx.storage.list({ prefix: "x:", limit: 1 })).size;
    if (more) await this.ctx.storage.setAlarm(Date.now() + (keys.length === 500 ? 1000 : SWEEP_EVERY));
  }
}

const hostOf = (raw) => { try { return new URL(raw).host; } catch { return ""; } };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const tokenError = (status, error, description) => json(status, { error, error_description: description }, NO_STORE);

function page(status, title, body, cfg, redirectUri) {
  // form-action must also allow the client's redirect: browsers apply it to the redirect after a form post.
  const target = redirectUri ? ` ${new URL(redirectUri).origin}` : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem}label{display:block;margin:.6rem 0}input{display:block;width:100%;padding:.4rem;box-sizing:border-box}button{padding:.4rem 1rem;margin-top:.6rem}.err{color:#b00020}.note{color:#555;font-size:.9em}form.inline input{display:inline;width:auto}</style></head>
<body><h1>${esc(title)}</h1>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...NO_STORE,
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${target}; frame-ancestors 'none'; base-uri 'none'`,
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}
