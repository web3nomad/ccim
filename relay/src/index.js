import { DurableObject } from "cloudflare:workers";

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_TEXT = 16 * 1024;
const MAX_QUEUE = 200;
// Sends allowed in a channel since a human last typed in any joined session.
// Stops two agents from chatting forever with nobody watching.
const MAX_STREAK = 24;

// Close codes the CLI understands.
const TAKEN_OVER = 4001; // another session joined with this handle
const REPLACED = 4002; // same session opened a newer listener

export default {
  async fetch(req, env) {
    const m = new URL(req.url).pathname.match(/^\/c\/([^/]+)\/([a-z]+)$/);
    if (!m) return json(404, { error: "not_found" });
    if (!NAME.test(m[1])) return json(400, { error: "bad_channel_name" });
    return env.CHANNEL.get(env.CHANNEL.idFromName(m[1])).fetch(req);
  },
};

// One Durable Object per channel. Storage layout:
//   channel          -> { secretHash, createdAt }
//   seq, streak   -> counters
//   m:<handle>    -> { tokenHash, focus }
//   tok:<hash>    -> handle
//   q:<handle>:<id> -> message waiting for that handle
// Listeners are hibernating WebSockets tagged with their handle, so an idle channel costs nothing.
export class Channel extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req) {
    const op = new URL(req.url).pathname.split("/")[3];
    if (op === "join" && req.method === "POST") return this.join(req);

    const handle = await this.auth(req);
    if (!handle) return json(401, { error: "unauthorized" });

    if (op === "listen") return this.listen(req, handle);
    if (op === "who" && req.method === "GET") return json(200, { you: handle, members: await this.members() });
    if (op === "inbox" && req.method === "GET") {
      const all = new URL(req.url).searchParams.get("all") === "1";
      return json(200, { messages: await this.pending(handle, all) });
    }
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
    const body = await req.json().catch(() => ({}));
    if (op === "send") return this.send(handle, body);
    if (op === "ack") return json(200, { ok: await this.ack(handle, body.ids) });
    if (op === "human") return json(200, { ok: (await this.ctx.storage.put("streak", 0), true) });
    if (op === "focus") return this.focus(handle, !!body.on);
    if (op === "leave") return this.leave(handle);
    return json(404, { error: "not_found" });
  }

  async join(req) {
    const { handle } = await req.json().catch(() => ({}));
    const secret = req.headers.get("x-ccim-secret") || "";
    if (!NAME.test(handle || "")) return json(400, { error: "bad_handle" });

    let channel = await this.ctx.storage.get("channel");
    const created = !channel;
    if (!channel) {
      if (secret.length < 16) return json(400, { error: "secret_too_short" });
      channel = { secretHash: await sha256(secret), createdAt: Date.now() };
      await this.ctx.storage.put("channel", channel);
    } else if ((await sha256(secret)) !== channel.secretHash) {
      return json(403, { error: "wrong_secret" });
    }

    // The newest join owns the handle: that is how a handle stays bound to exactly one session.
    const old = await this.ctx.storage.get(`m:${handle}`);
    if (old) {
      await this.ctx.storage.delete(`tok:${old.tokenHash}`);
      this.closeSockets(handle, TAKEN_OVER, "taken_over");
    }
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    const tokenHash = await sha256(token);
    await this.ctx.storage.put(`m:${handle}`, { tokenHash, focus: false });
    await this.ctx.storage.put(`tok:${tokenHash}`, handle);
    return json(200, { token, created, members: await this.members() });
  }

  async auth(req) {
    let token = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
    // WebSocket clients cannot set headers, so the token rides in the subprotocol list.
    if (!token) token = (req.headers.get("sec-websocket-protocol") || "").split(",").map((s) => s.trim())[1] || "";
    if (!token) return null;
    return (await this.ctx.storage.get(`tok:${await sha256(token)}`)) || null;
  }

  async listen(req, handle) {
    if (req.headers.get("upgrade") !== "websocket") return json(426, { error: "websocket_required" });
    this.closeSockets(handle, REPLACED, "replaced");
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [handle]);
    for (const msg of await this.pending(handle, false)) pair[1].send(JSON.stringify(msg));
    return new Response(null, { status: 101, webSocket: pair[0], headers: { "sec-websocket-protocol": "ccim" } });
  }

  async send(from, { to, text, urgent }) {
    if (typeof text !== "string" || !text.trim()) return json(400, { error: "empty_text" });
    if (text.length > MAX_TEXT) return json(413, { error: "text_too_long", max: MAX_TEXT });
    const streak = (await this.ctx.storage.get("streak")) || 0;
    if (streak >= MAX_STREAK) return json(429, { error: "no_human_in_the_loop", max: MAX_STREAK });

    const members = await this.members();
    const targets = to === "*" ? members.map((m) => m.handle).filter((h) => h !== from) : [to];
    if (!targets.length) return json(404, { error: "nobody_else_here" });
    for (const t of targets) {
      if (!members.some((m) => m.handle === t)) return json(404, { error: "unknown_handle", members: members.map((m) => m.handle) });
      const queued = await this.ctx.storage.list({ prefix: `q:${t}:`, limit: MAX_QUEUE + 1 });
      if (queued.size >= MAX_QUEUE) return json(507, { error: "inbox_full", handle: t });
    }

    const id = ((await this.ctx.storage.get("seq")) || 0) + 1;
    const msg = { type: "msg", id, from, to, text, urgent: !!urgent, ts: Date.now() };
    const delivery = {};
    for (const t of targets) {
      await this.ctx.storage.put(`q:${t}:${pad(id)}`, msg);
      const member = members.find((m) => m.handle === t);
      const sockets = this.ctx.getWebSockets(t);
      if (!sockets.length) delivery[t] = "queued_offline";
      else if (member.focus && !msg.urgent) delivery[t] = "queued_focus";
      else {
        for (const ws of sockets) ws.send(JSON.stringify(msg));
        delivery[t] = "delivered";
      }
    }
    await this.ctx.storage.put({ seq: id, streak: streak + 1 });
    return json(200, { id, delivery });
  }

  async focus(handle, on) {
    const member = await this.ctx.storage.get(`m:${handle}`);
    await this.ctx.storage.put(`m:${handle}`, { ...member, focus: on });
    if (!on) {
      const backlog = await this.pending(handle, true);
      for (const ws of this.ctx.getWebSockets(handle)) for (const msg of backlog) ws.send(JSON.stringify(msg));
    }
    return json(200, { focus: on });
  }

  async leave(handle) {
    const member = await this.ctx.storage.get(`m:${handle}`);
    const queued = await this.ctx.storage.list({ prefix: `q:${handle}:` });
    await this.ctx.storage.delete([`m:${handle}`, `tok:${member.tokenHash}`, ...queued.keys()]);
    this.closeSockets(handle, TAKEN_OVER, "left");
    return json(200, { ok: true });
  }

  // Messages waiting for a handle. While it is in focus mode only urgent ones are deliverable, unless `all`.
  async pending(handle, all) {
    const member = await this.ctx.storage.get(`m:${handle}`);
    const queued = [...(await this.ctx.storage.list({ prefix: `q:${handle}:` })).values()];
    return all || !member.focus ? queued : queued.filter((m) => m.urgent);
  }

  async ack(handle, ids) {
    if (!Array.isArray(ids) || !ids.length) return false;
    await this.ctx.storage.delete(ids.slice(0, MAX_QUEUE).map((id) => `q:${handle}:${pad(id)}`));
    return true;
  }

  async members() {
    const out = [];
    for (const [key, m] of await this.ctx.storage.list({ prefix: "m:" })) {
      const handle = key.slice(2);
      out.push({ handle, online: this.ctx.getWebSockets(handle).length > 0, focus: m.focus });
    }
    return out;
  }

  closeSockets(handle, code, reason) {
    for (const ws of this.ctx.getWebSockets(handle)) {
      try { ws.close(code, reason); } catch {}
    }
  }

  async webSocketMessage(ws, data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === "ack") await this.ack(this.ctx.getTags(ws)[0], msg.ids);
  }

  webSocketClose(ws, code) {
    try { ws.close(code, "bye"); } catch {}
  }
}

const pad = (id) => String(id).padStart(12, "0");
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
