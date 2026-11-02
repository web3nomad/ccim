// A message must never fail with a 500 because a listener socket is closing. Real relay (wrangler dev --local),
// raw WebSocket upgrades. Channel secrets are generated here.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 22000 + Math.floor(Math.random() * 500);
const INSPECTOR = 9400 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
const SECRET = randomBytes(24).toString("base64url");
const work = mkdtempSync(join(tmpdir(), "ccim-sock-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let relay, relayLog = "";
const open = [];

before(async () => {
  relay = spawn(join(RELAY_DIR, "node_modules", ".bin", "wrangler"), ["dev", "--local", "--port", String(PORT), "--inspector-port", String(INSPECTOR), "--persist-to", join(work, "state"), "--show-interactive-dev-session=false"], { cwd: RELAY_DIR, stdio: ["ignore", "pipe", "pipe"] });
  relay.stdout.on("data", (d) => (relayLog += d));
  relay.stderr.on("data", (d) => (relayLog += d));
  for (let i = 0; i < 120 && !/Ready on/.test(relayLog); i++) await sleep(500);
  assert.match(relayLog, /Ready on/, relayLog);
});

after(() => {
  for (const s of open) s.destroy();
  relay?.kill();
  rmSync(work, { recursive: true, force: true });
});

async function api(path, { token, body, secret } = {}) {
  const r = await fetch(`${BASE}/c/sock${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }), ...(secret && { "x-ccim-secret": secret }) },
    body: body && JSON.stringify(body),
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}

// Opens a listener for a member over a bare TCP connection and returns the socket once the upgrade is accepted.
async function listen(token) {
  const sock = net.connect(PORT, "localhost");
  sock.on("error", () => {});
  await new Promise((r) => sock.once("connect", r));
  const key = randomBytes(16).toString("base64");
  sock.write(`GET /c/sock/listen HTTP/1.1\r\nHost: localhost:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: ccim, ${token}\r\n\r\n`);
  await new Promise((r) => sock.once("data", r));
  open.push(sock);
  return sock;
}

let a, b;

test("two members join", async () => {
  const ja = await api("/join", { body: { handle: "a" }, secret: SECRET });
  const jb = await api("/join", { body: { handle: "b" }, secret: SECRET });
  assert.equal(ja.status, 200);
  assert.equal(jb.status, 200);
  a = ja.token;
  b = jb.token;
});

test("sending while the receiver keeps re-listening never returns 500 and ids keep rising", async () => {
  await listen(b);
  const ids = [];
  for (let i = 0; i < 40; i++) {
    // The old listener of "b" is closed by the new one at the same moment a message is sent.
    const [, sent] = await Promise.all([listen(b), api("/send", { token: a, body: { to: "b", text: `m${i}` } })]);
    assert.equal(sent.status, 200, `send ${i}: ${JSON.stringify(sent)}`);
    assert.match(sent.delivery.b, /^(delivered|queued_offline)$/);
    ids.push(sent.id);
  }
  assert.deepEqual(ids, Array.from({ length: 40 }, (_, i) => ids[0] + i), "every send gets its own id");
});

test("every message sent is in the receiver's queue, whatever the push did", async () => {
  const inbox = await api("/inbox?all=1", { token: b });
  assert.equal(inbox.status, 200);
  assert.deepEqual(inbox.messages.map((m) => m.text), Array.from({ length: 40 }, (_, i) => `m${i}`));
});

test("a send with a client id is recorded once even when the push fails", async () => {
  await listen(b);
  const body = { to: "b", text: "with id", clientId: "sock-retry-0001" };
  const [, first] = await Promise.all([listen(b), api("/send", { token: a, body })]);
  assert.equal(first.status, 200, JSON.stringify(first));
  const again = await api("/send", { token: a, body });
  assert.equal(again.status, 200);
  assert.equal(again.duplicate, true);
  assert.equal(again.id, first.id);
});
