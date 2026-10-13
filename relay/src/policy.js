// OAuth policy with no Durable Object dependencies, so it can be unit tested in plain Node.

import { SCOPES } from "./util.js";

export const resourceMetadata = (cfg, resource) => ({
  resource,
  authorization_servers: [cfg.issuer],
  scopes_supported: SCOPES,
  bearer_methods_supported: ["header"],
  resource_name: "CCIM",
});

export const serverMetadata = (cfg) => ({
  issuer: cfg.issuer,
  authorization_endpoint: `${cfg.issuer}/oauth/authorize`,
  token_endpoint: `${cfg.issuer}/oauth/token`,
  registration_endpoint: `${cfg.issuer}/oauth/register`,
  revocation_endpoint: `${cfg.issuer}/oauth/revoke`,
  response_types_supported: ["code"],
  response_modes_supported: ["query"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  revocation_endpoint_auth_methods_supported: ["none"],
  scopes_supported: SCOPES,
  client_id_metadata_document_supported: !!cfg.cimd,
  authorization_response_iss_parameter_supported: true,
});

export function validateCimd(url, doc, cfg) {
  if (!doc || typeof doc !== "object" || doc.client_id !== url) return null;
  const uris = doc.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || !uris.every((u) => typeof u === "string")) return null;
  const methods = Array.isArray(doc.token_endpoint_auth_methods_supported) ? doc.token_endpoint_auth_methods_supported : null;
  const publicOk = methods ? methods.includes("none") : !doc.token_endpoint_auth_method || doc.token_endpoint_auth_method === "none";
  if (!publicOk) return null;
  const allowed = uris.filter((u) => redirectAllowed(u, cfg));
  if (!allowed.length) return null;
  return { clientId: url, name: typeof doc.client_name === "string" ? doc.client_name.slice(0, 100) : "", redirectUris: allowed };
}

// Redirects must be https on an allowlisted host, so a client registered by a stranger cannot collect codes.
export function redirectAllowed(raw, cfg) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.hash || u.username || u.password) return false;
  const hostOk = cfg.redirectHosts.includes(u.hostname.toLowerCase());
  if (u.protocol === "https:") return hostOk;
  return u.protocol === "http:" && hostOk && isLocal(cfg.issuer) && isLocal(raw);
}

export function grantedScope(requested) {
  const asked = (requested || "").split(" ").filter((s) => SCOPES.includes(s));
  return (asked.length ? SCOPES.filter((s) => asked.includes(s)) : SCOPES).join(" ");
}

export const isLocal = (raw) => { try { return ["localhost", "127.0.0.1"].includes(new URL(raw).hostname); } catch { return false; } };
export const isIpLiteral = (host) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
