// The adapter's state machine. Storage is the Durable Object storage API (get/put/delete/list), so the same code
// runs on Cloudflare and against the in-memory stand-in used by the tests.
//
// Storage layout (no message text is ever stored):
//   msg:<id12>        -> { id, from, to, ts, hop, auto, cls, stages:{recorded,woken,acked,replied,gone}, wake, replies }
//   open:<id12>       -> 1 while a direct message has not been acked or gone (keeps ticks cheap)
//   rate:<sender>     -> [timestamps of successful wakes that included this sender]
//   day:<YYYY-MM-DD>  -> number of successful wakes that day (day in DAY_TZ_OFFSET_MIN, default UTC)
//   poll              -> { at, ok, error, queued }
//
// Stages (see adapter documentation): recorded 送达 -> woken 已唤醒 -> acked 已处理 -> replied 已回复.

import { config, parseHop, dayKey, makeLogger } from "./util.js";
import { makeRelay } from "./relay.js";
import { scopedStorage } from "./storage.js";

export const STAGE_ORDER = ["recorded", "woken", "acked", "replied"];
export const STAGE_CN = { recorded: "送达", woken: "已唤醒", acked: "已处理", replied: "已回复", gone: "已被他处确认" };
// Minutes to wait before retrying a failed wake, by attempt number. Ticks are one minute apart.
const BACKOFF_MIN = [1, 2, 5, 10, 30];
const QUEUE_WARN = 150; // the relay refuses new messages for a member at 200 (relay/src/index.js:8, :162-163)

export const key = (id) => `msg:${String(id).padStart(12, "0")}`;
const openKey = (id) => `open:${String(id).padStart(12, "0")}`;

export function makeContext({ storage, env, fetch, now = () => Date.now(), log }) {
  const cfg = config(env);
  storage = scopedStorage(storage, env.STATE_NAMESPACE || "");
  return { storage, env, cfg, fetch, now, log: log || makeLogger(env), relay: makeRelay(cfg, env, { fetch, storage }) };
}

export function stageOf(meta) {
  let best = null;
  for (const s of STAGE_ORDER) if (meta.stages?.[s]) best = s;
  return best;
}

// Why a message does or does not wake the Bot. Order matters: own > broadcast > hop limit > direct.
export function classify(msg, cfg) {
  const { hop, auto } = parseHop(msg.text);
  let cls = "direct";
  if (msg.from === cfg.handle) cls = "own";
  else if (msg.to !== cfg.handle) cls = "broadcast"; // to:"*" (relay/src/index.js:158, :167)
  else if (hop >= cfg.maxHop) cls = "hop_limit";
  return { cls, hop, auto };
}

// Records messages not seen before. Returns the new metadata records. Text is used only to read the hop tag.
export async function ingest(ctx, messages) {
  const fresh = [];
  for (const m of messages) {
    if (!Number.isInteger(m.id) || m.id < 1) continue;
    if (await ctx.storage.get(key(m.id))) continue;
    const { cls, hop, auto } = classify(m, ctx.cfg);
    const meta = { id: m.id, from: m.from, to: m.to, ts: m.ts, urgent: !!m.urgent, hop, auto, cls, stages: { recorded: ctx.now() }, wake: { attempts: 0 }, replies: [] };
    const puts = { [key(m.id)]: meta };
    if (cls === "direct") puts[openKey(m.id)] = 1;
    await ctx.storage.put(puts);
    ctx.log("recorded", { id: m.id, from: m.from, cls, hop });
    fresh.push(meta);
  }
  return fresh;
}

async function openMetas(ctx) {
  const keys = [...(await ctx.storage.list({ prefix: "open:" })).keys()].map((k) => `msg:${k.slice(5)}`);
  if (!keys.length) return [];
  const got = await ctx.storage.get(keys);
  return keys.map((k) => got.get(k)).filter(Boolean);
}

async function senderAllowed(ctx, sender, now) {
  const stamps = ((await ctx.storage.get(`rate:${sender}`)) || []).filter((t) => now - t < ctx.cfg.senderWindowMs);
  return { allowed: stamps.length < ctx.cfg.senderLimit, stamps };
}

// One cron tick: peek, record, decide, wake at most once.
export async function tick(ctx) {
  const now = ctx.now();
  const peek = await ctx.relay.peek();
  if (!peek.ok) {
    await ctx.storage.put("poll", { at: now, ok: false, error: peek.error, status: peek.status });
    ctx.log("poll_failed", { status: peek.status, error: peek.error });
    return { polled: false, error: peek.error };
  }
  await ctx.storage.put("poll", { at: now, ok: true, queued: peek.messages.length });
  if (peek.messages.length >= QUEUE_WARN) ctx.log("queue_high", { queued: peek.messages.length });
  await ingest(ctx, peek.messages);

  // Open messages no longer in the relay queue were acked somewhere else: stop waking for them.
  const live = new Set(peek.messages.map((m) => m.id));
  const open = await openMetas(ctx);
  for (const meta of open) {
    if (!live.has(meta.id)) {
      meta.stages.gone = now;
      await ctx.storage.put(key(meta.id), meta);
      await ctx.storage.delete(openKey(meta.id));
    }
  }

  const candidates = open.filter((m) => !m.stages.gone && !m.stages.woken && !m.stages.acked && !m.wake.failed && (m.wake.nextAt || 0) <= now);
  if (!candidates.length) return { polled: true, woke: false };

  const day = `day:${dayKey(now, ctx.cfg.dayOffsetMs)}`;
  const today = (await ctx.storage.get(day)) || 0;
  if (today >= ctx.cfg.dailyCap) {
    for (const m of candidates) if (m.wake.deferred !== "daily_cap") await ctx.storage.put(key(m.id), { ...m, wake: { ...m.wake, deferred: "daily_cap" } });
    ctx.log("wake_deferred", { reason: "daily_cap", count: candidates.length });
    return { polled: true, woke: false, deferred: "daily_cap" };
  }

  const batch = [];
  const stamps = new Map();
  for (const m of candidates) {
    if (!stamps.has(m.from)) stamps.set(m.from, await senderAllowed(ctx, m.from, now));
    if (stamps.get(m.from).allowed) batch.push(m);
    else if (m.wake.deferred !== "rate_limit") await ctx.storage.put(key(m.id), { ...m, wake: { ...m.wake, deferred: "rate_limit" } });
  }
  if (!batch.length) {
    ctx.log("wake_deferred", { reason: "rate_limit", count: candidates.length });
    return { polled: true, woke: false, deferred: "rate_limit" };
  }

  const senders = [...new Set(batch.map((m) => m.from))];
  const result = await postWebhook(ctx, { channel: ctx.cfg.channel, message_ids: batch.map((m) => m.id), senders });
  if (result.ok) {
    for (const m of batch) {
      const wake = { ...m.wake, attempts: m.wake.attempts + 1, deferred: undefined, lastError: undefined, runUuid: result.runUuid };
      await ctx.storage.put(key(m.id), { ...m, stages: { ...m.stages, woken: now }, wake });
    }
    for (const s of senders) await ctx.storage.put(`rate:${s}`, [...stamps.get(s).stamps, now]);
    await ctx.storage.put(day, today + 1);
    ctx.log("woken", { ids: batch.map((m) => m.id), run: result.runUuid ? String(result.runUuid).slice(0, 8) : undefined });
    return { polled: true, woke: true, ids: batch.map((m) => m.id) };
  }

  for (const m of batch) {
    const attempts = m.wake.attempts + 1;
    const failed = attempts >= ctx.cfg.wakeMaxAttempts;
    const nextAt = now + BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)] * 60 * 1000;
    await ctx.storage.put(key(m.id), { ...m, wake: { ...m.wake, attempts, lastError: result.error, nextAt, failed, deferred: undefined } });
  }
  ctx.log("wake_failed", { ids: batch.map((m) => m.id), error: result.error, status: result.status });
  return { polled: true, woke: false, error: result.error };
}

// Body is ids and sender names only, never message text: the Bot reads the text through grok_inbox.
export async function postWebhook(ctx, body) {
  const { WEBHOOK_URL, WEBHOOK_KEY } = ctx.env;
  if (!WEBHOOK_URL || !WEBHOOK_KEY) return { ok: false, status: 0, error: "webhook_not_configured" };
  let res;
  try {
    res = await ctx.fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${WEBHOOK_KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { ok: false, status: 0, error: "network" };
  }
  const text = await res.text().catch(() => "");
  let data = {};
  try { data = JSON.parse(text); } catch {}
  // 200 {"success":true,"runUuid":...} means a run started (cursor.com/help/grok-bot/routines). Anything else did not.
  if (res.status === 200 && data.success !== false) return { ok: true, runUuid: data.runUuid };
  const error = /rate limit/i.test(text) ? "rate_limited" : `http_${res.status}`;
  return { ok: false, status: res.status, error };
}

export async function getMeta(ctx, id) {
  return (await ctx.storage.get(key(id))) || null;
}

export async function putMeta(ctx, meta) {
  await ctx.storage.put(key(meta.id), meta);
}

export async function markAcked(ctx, ids) {
  const now = ctx.now();
  for (const id of ids) {
    const meta = await getMeta(ctx, id);
    if (!meta) continue;
    meta.stages.acked ||= now;
    await putMeta(ctx, meta);
    await ctx.storage.delete(openKey(id));
  }
}

export async function summary(ctx) {
  const now = ctx.now();
  const day = dayKey(now, ctx.cfg.dayOffsetMs);
  return {
    channel: ctx.cfg.channel,
    handle: ctx.cfg.handle,
    relay_mode: ctx.cfg.relayMode,
    poll: (await ctx.storage.get("poll")) || null,
    open: (await ctx.storage.list({ prefix: "open:" })).size,
    wakes_today: (await ctx.storage.get(`day:${day}`)) || 0,
    daily_cap: ctx.cfg.dailyCap,
    sender_limit: `${ctx.cfg.senderLimit} per ${ctx.cfg.senderWindowMs / 60000} min`,
  };
}

export async function recentMetas(ctx, limit = 20) {
  const all = await ctx.storage.list({ prefix: "msg:", reverse: true, limit });
  return [...all.values()];
}
