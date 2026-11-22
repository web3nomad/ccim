// The operator's channel listing: hidden without the admin token, metadata only with it. Real relay
// (wrangler dev --local). The admin token and channel secrets are generated here.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 23000 + Math.floor(Math.random() * 500);
const INSPECTOR = 9900 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}`;
const ADMIN = randomBytes(32).toString("base64url");
const SECRET = randomBytes(24).toString("base64url");
const work = mkdtempSync(join(tmpdir(), "ccim-admin-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let relay, relayLog = "";
before(async () => {
  relay = spawn(join(RELAY_DIR, "node_modules", ".bin", "wrangler"), ["dev", "--local", "--port", String(PORT), "--inspector-port", String(INSPECTOR), "--persist-to", join(work, "state"), "--var", `ADMIN_TOKEN:${ADMIN}`, "--show-interactive-dev-session=false"], { cwd: RELAY_DIR, stdio: ["ignore", "pipe", "pipe"] });
  relay.stdout.on("data", (d) => (relayLog += d));
  relay.stderr.on("data", (d) => (relayLog += d));
  for (let i = 0; i < 120 && !/Ready on/.test(relayLog); i++) await sleep(500);
  assert.match(relayLog, /Ready on/, relayLog);
});
after(() => {
  relay?.kill();
  rmSync(work, { recursive: true, force: true });
});

async function http(method, path, { body, token, secret } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }), ...(secret && { "x-ccim-secret": secret }) },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, text, data };
}
const admin = (body, token = ADMIN) => http("POST", "/admin/channels", { body, token });

const tokens = {};
test("set up two channels", async () => {
  for (const [ch, h] of [["alpha", "ann"], ["alpha", "bob"], ["beta", "cat"]]) {
    const r = await http("POST", `/c/${ch}/join`, { body: { handle: h }, secret: SECRET });
    assert.equal(r.status, 200, r.text);
    tokens[h] = r.data.token;
  }
  for (const text of ["one", "two"]) assert.equal((await http("POST", "/c/alpha/send", { body: { to: "bob", text }, token: tokens.ann })).status, 200);
});

test("without the right token it looks like any unknown path", async () => {
  const unknown = await http("POST", "/admin/nothing", { body: {} });
  for (const r of [await admin({ names: ["alpha"] }, ""), await admin({ names: ["alpha"] }, "x".repeat(43)), await admin({ names: ["alpha"] }, tokens.ann), await http("GET", "/admin/channels", { token: ADMIN })]) {
    assert.equal(r.status, 404);
    assert.equal(r.text, unknown.text);
  }
});

let alphaId;
test("by name: members, online, unread, counts and times, and nothing secret", async () => {
  const before = Date.now();
  const r = await admin({ names: ["alpha", "beta", "never-made"] });
  assert.equal(r.status, 200, r.text);
  const byName = Object.fromEntries(r.data.channels.map((c) => [c.name, c]));
  assert.deepEqual(Object.keys(byName).sort(), ["alpha", "beta"], "a channel with no data is not listed");
  const alpha = byName.alpha;
  alphaId = alpha.id;
  assert.match(alpha.id, /^[0-9a-f]{64}$/);
  assert.equal(alpha.messages, 2);
  assert.deepEqual(alpha.members.map((m) => [m.handle, m.unread, m.online]).sort(), [["ann", 0, false], ["bob", 2, false]]);
  assert.ok(alpha.createdAt <= before && alpha.lastAt >= alpha.createdAt);
  for (const leak of [SECRET, ADMIN, ...Object.values(tokens), "secretHash", "tokenHash", "one", "two"]) assert.ok(!r.text.includes(leak), `response contains ${leak}`);
});

test("by id alone: the same channel, with the name it recorded", async () => {
  const r = await admin({ ids: [alphaId] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.channels.length, 1);
  assert.equal(r.data.channels[0].name, "alpha");
  assert.equal(r.data.channels[0].messages, 2);
});

test("a malformed or foreign id is reported, not a 500", async () => {
  const r = await admin({ ids: ["0".repeat(64), "not-hex"] });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.data.channels.every((c) => c.id === "0".repeat(64)), "the non-hex id is ignored");
  assert.ok(r.data.channels.length <= 1);
  assert.equal((await admin({ ids: Array(1001).fill("0".repeat(64)) })).status, 400);
});

test("ordinary use is unchanged after an admin listing", async () => {
  assert.equal((await http("POST", "/c/alpha/send", { body: { to: "ann", text: "three" }, token: tokens.bob })).status, 200);
  const inbox = await http("GET", "/c/alpha/inbox?all=1", { token: tokens.bob });
  assert.deepEqual(inbox.data.messages.map((m) => m.text), ["one", "two"]);
});
