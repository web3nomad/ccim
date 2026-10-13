// Helpers shared by the MCP endpoint and the OAuth layer.

export const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const SCOPES = ["ccim:read", "ccim:write"];

export const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
export const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const digest = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
export const sha256 = async (s) => hex(await digest(s));
export const pkceChallenge = async (verifier) => b64url(await digest(verifier));
export const randomId = () => hex(crypto.getRandomValues(new Uint8Array(16)));
export const randomToken = (prefix) => prefix + b64url(crypto.getRandomValues(new Uint8Array(32)));

export const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

// Deployment settings. OAuth stays off (and the MCP tools other than the probe refuse) until all of them are present.
export function settings(env) {
  const issuer = (env.OAUTH_ISSUER || "").replace(/\/$/, "");
  const bindings = (env.MCP_ALLOWED_BINDINGS || "")
    .split(",")
    .map((s) => s.trim().split("/"))
    .filter(([channel, member, extra]) => NAME.test(channel || "") && NAME.test(member || "") && extra === undefined)
    .map(([channel, member]) => ({ channel, member }));
  const redirectHosts = (env.OAUTH_REDIRECT_HOSTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  let keyOk = false;
  try { keyOk = unb64(env.OAUTH_ENC_KEY || "").length === 32; } catch {}
  return {
    issuer,
    // The canonical resource is the origin (what OpenAI's docs show); the /mcp form is accepted too.
    resources: [issuer, `${issuer}/mcp`],
    bindings,
    redirectHosts,
    ready: !!issuer && keyOk && !!env.AUTH && bindings.length > 0,
  };
}

export const authStore = (env) => env.AUTH.get(env.AUTH.idFromName("auth"));

// Calls the channel's existing API inside the Worker, the same requests the CLI makes over HTTPS.
export async function channelApi(env, channel, method, op, body, { token, secret } = {}) {
  const stub = env.CHANNEL.get(env.CHANNEL.idFromName(channel));
  const res = await stub.fetch(new Request(`https://ccim.internal/c/${channel}/${op}`, {
    method,
    headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }), ...(secret && { "x-ccim-secret": secret }) },
    body: body ? JSON.stringify(body) : undefined,
  }));
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}

// CCIM member tokens are kept encrypted at rest; the channel/member pair is bound in as associated data.
async function encKey(env) {
  return crypto.subtle.importKey("raw", unb64(env.OAUTH_ENC_KEY), "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function seal(env, aad, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, await encKey(env), new TextEncoder().encode(text));
  return `${b64(iv)}.${b64(new Uint8Array(ct))}`;
}
export async function unseal(env, aad, sealed) {
  const [iv, ct] = sealed.split(".").map(unb64);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, await encKey(env), ct);
  return new TextDecoder().decode(pt);
}

// Events only: never tokens, secrets, form fields or message text.
export const log = (event, fields = {}) => console.log(JSON.stringify({ event, ...fields }));
