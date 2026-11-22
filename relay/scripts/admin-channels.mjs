#!/usr/bin/env node
// Lists every channel on the relay with its members: for the operator only.
//
//   node relay/scripts/admin-channels.mjs [--json]
//
// Needs two credentials, neither of which is ever printed:
// - the relay's ADMIN_TOKEN, read from ~/.ccim/admin.json ({ "relay": "...", "token": "..." }) or CCIM_ADMIN_TOKEN;
// - a Cloudflare login (`wrangler login`), used only to list the relay's Durable Object ids.
// Channels that nobody has reached by name since names were recorded show their id instead of a name,
// unless this machine's ~/.ccim/config.json knows them.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = join(RELAY_DIR, "node_modules", ".bin", "wrangler");
const SCRIPT = "ccim-relay";
const HOME = process.env.CCIM_HOME || join(homedir(), ".ccim");
const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } };
const die = (msg) => { console.error(msg); process.exit(1); };

const admin = readJson(join(HOME, "admin.json"));
const relay = (process.env.CCIM_RELAY || admin.relay || "https://ccim-relay.web3nomad-eth.workers.dev").replace(/\/$/, "");
const adminToken = process.env.CCIM_ADMIN_TOKEN || admin.token;
if (!adminToken) die(`no admin token: put { "token": "..." } in ${join(HOME, "admin.json")} or set CCIM_ADMIN_TOKEN`);

const wrangler = (args) => execFileSync(WRANGLER, args, { cwd: RELAY_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
let cf;
try { cf = JSON.parse(wrangler(["auth", "token", "--json"])); } catch { die("no Cloudflare login: run `npx wrangler login` in relay/"); }
const cfToken = cf.token;
if (!cfToken) die("this Cloudflare login is an API key, not a token; use `wrangler login` or CLOUDFLARE_API_TOKEN");

async function cfApi(path) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: { authorization: `Bearer ${cfToken}` } });
  const body = await res.json().catch(() => ({}));
  if (!body.success) die(`Cloudflare API ${path.split("?")[0]}: ${res.status} ${(body.errors || []).map((e) => e.message).join("; ")}`);
  return body;
}

const accounts = (await cfApi("/accounts?per_page=50")).result;
let namespace, accountId;
for (const a of accounts) {
  const list = (await cfApi(`/accounts/${a.id}/workers/durable_objects/namespaces?per_page=1000`)).result;
  namespace = list.find((n) => n.script === SCRIPT && n.class === "Channel");
  if (namespace) { accountId = a.id; break; }
}
if (!namespace) die(`no Channel namespace for the ${SCRIPT} Worker in this Cloudflare login`);

const ids = [];
for (let cursor = ""; ; ) {
  const page = await cfApi(`/accounts/${accountId}/workers/durable_objects/namespaces/${namespace.id}/objects?limit=10000${cursor && `&cursor=${encodeURIComponent(cursor)}`}`);
  for (const o of page.result) if (o.hasStoredData) ids.push(o.id);
  cursor = page.result_info?.cursor || page.result_info?.cursors?.after || "";
  if (!cursor || !page.result.length) break;
}
const names = Object.keys(readJson(join(HOME, "config.json")).channels || {});

const channels = [];
for (let i = 0; i < Math.max(ids.length, 1); i += 500) {
  const res = await fetch(`${relay}/admin/channels`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ ids: ids.slice(i, i + 500), names: i === 0 ? names : [] }),
  });
  if (res.status === 404) die("the relay refused the admin token (or ADMIN_TOKEN is not set on it)");
  if (!res.ok) die(`relay: ${res.status}`);
  channels.push(...(await res.json()).channels);
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(channels, null, 2));
} else {
  const when = (t) => (t ? new Date(t).toISOString().slice(0, 16).replace("T", " ") : "-");
  channels.sort((x, y) => (y.lastAt || y.createdAt || 0) - (x.lastAt || x.createdAt || 0));
  for (const c of channels) {
    if (c.error) { console.log(`${c.id.slice(0, 12)}…  error: ${c.error}`); continue; }
    const label = c.name || `(unnamed ${c.id.slice(0, 12)}…)`;
    console.log(`${label}  created ${when(c.createdAt)}  last ${when(c.lastAt)}  ${c.messages} messages`);
    for (const m of c.members) console.log(`    ${m.handle}${m.online ? "  online" : ""}${m.focus ? "  focus" : ""}${m.unread ? `  ${m.unread} unread` : ""}`);
  }
  const people = channels.reduce((n, c) => n + (c.members?.length || 0), 0);
  console.log(`\n${channels.length} channels, ${people} members (Cloudflare reports ${ids.length} channels with data)`);
}
