// Shared helpers. No Cloudflare imports, so everything here runs under plain Node for the tests.

export const SECRET_NAMES = ["CCIM_TOKEN", "WEBHOOK_URL", "WEBHOOK_KEY", "MCP_BEARER", "OAUTH_REFRESH_TOKEN", "OAUTH_CLIENT_ID"];

export function config(env = {}) {
  const int = (name, dflt) => {
    const n = Number.parseInt(env[name] ?? "", 10);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  return {
    relay: String(env.CCIM_RELAY || "https://relay.example.invalid").replace(/\/$/, ""),
    channel: env.CCIM_CHANNEL || "example-channel",
    handle: env.CCIM_HANDLE || "grok",
    relayMode: env.RELAY_MODE === "author-mcp" ? "author-mcp" : "direct",
    mcpEnabled: env.MCP_ENABLED !== "off",
    maxHop: int("MAX_HOP", 2),
    senderLimit: int("SENDER_LIMIT", 3),
    senderWindowMs: int("SENDER_WINDOW_MIN", 10) * 60 * 1000,
    dailyCap: int("DAILY_CAP", 30),
    sendAllowedRecipients: allowedRecipients(env.SEND_ALLOWED_RECIPIENTS, env.CCIM_HANDLE || "grok"),
    sendLimit: int("SEND_LIMIT", 10),
    sendWindowMs: Math.max(1, int("SEND_WINDOW_MIN", 10)) * 60 * 1000,
    sendDailyCap: int("SEND_DAILY_CAP", 100),
    wakeMaxAttempts: int("WAKE_MAX_ATTEMPTS", 5),
    dayOffsetMs: int("DAY_TZ_OFFSET_MIN", 0) * 60 * 1000,
  };
}

// Replaces every configured secret value (and anything that looks like a bearer key) in a string.
export function redact(value, env = {}) {
  let s = typeof value === "string" ? value : JSON.stringify(value);
  if (s === undefined) return s;
  for (const name of SECRET_NAMES) {
    const v = env[name];
    if (typeof v === "string" && v.length >= 6) s = s.split(v).join("[REDACTED]");
  }
  return s
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bcrsr_[A-Za-z0-9]+/g, "crsr_[REDACTED]")
    .replace(/\bcc[ar]_[A-Za-z0-9_-]+/g, "cc_[REDACTED]");
}

// Events only. Never message text, tokens, keys or webhook URLs. Fields still pass through redact() as a backstop.
export function makeLogger(env, sink = console.log) {
  return (event, fields = {}) => sink(redact(JSON.stringify({ event, ...fields }), env));
}

// Auto-reply marker added by grok_reply, e.g. "[ccim-auto from=grok hop=1 re=#41]".
// "[hop:n]" is accepted too, so another bot can tag its replies with the shorter form.
const AUTO_TAG = /\[ccim-auto\b[^\]]*?\bhop=(\d+)[^\]]*\]/g;
const SHORT_TAG = /\[hop:(\d+)\]/g;

export function parseHop(text) {
  let hop = 0;
  let auto = false;
  for (const re of [AUTO_TAG, SHORT_TAG]) {
    for (const m of String(text || "").matchAll(re)) {
      auto = true;
      hop = Math.max(hop, Number(m[1]));
    }
  }
  return { hop, auto };
}

export const autoTag = (handle, hop, replyToId) => `[ccim-auto from=${handle} hop=${hop} re=#${replyToId}]`;

export function dayKey(now, offsetMs) {
  return new Date(now + offsetMs).toISOString().slice(0, 10);
}

// Constant-time comparison of two strings.
export async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(s))))));
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0 && typeof a === "string" && typeof b === "string" && a.length > 0;
}

export const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export async function sha256(text) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

// One invalid entry disables all proactive recipients rather than widening access.
export function allowedRecipients(value, self) {
  if (typeof value !== "string" || !value.trim()) return [];
  const names = value.split(",").map(name => name.trim());
  if (names.some(name => !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name) || name === self)) return [];
  return [...new Set(names)];
}
