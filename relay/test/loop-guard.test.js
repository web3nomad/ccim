// Local Worker regression: the same persisted channel can switch the optional guard on and off.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "ccim-loop-guard-"));
const port = 22000 + Math.floor(Math.random() * 1000);
const base = `http://localhost:${port}`;
const secret = randomBytes(24).toString("base64url");
const config = join(work, "wrangler.toml");
writeFileSync(config, readFileSync(join(ROOT, "wrangler.example.toml"), "utf8")
  .replace('main = "src/index.js"', `main = ${JSON.stringify(join(ROOT, "src/index.js"))}`)
  .replace(/^LOOP_GUARD_MAX = .*$/m, ""));
let worker, alice, bob;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stop() {
  if (!worker || worker.exitCode !== null) return;
  const exited = new Promise((resolve) => worker.once("exit", resolve));
  worker.kill("SIGINT");
  const timer = setTimeout(() => worker.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
}

async function start(mode) {
  await stop();
  let ready = false;
  worker = spawn(join(ROOT, "node_modules", ".bin", "wrangler"), [
    "dev", "--local", "--config", config, "--port", String(port),
    "--persist-to", join(work, "state"), "--show-interactive-dev-session=false",
    ...(mode ? ["--var", `LOOP_GUARD_MAX:${mode}`] : []),
  ], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  worker.stdout.on("data", (data) => { if (/Ready on/.test(data)) ready = true; });
  worker.stderr.resume();
  for (let i = 0; i < 120 && !ready && worker.exitCode === null; i++) await sleep(500);
  assert.ok(ready, "local relay starts");
}

async function call(op, body, token) {
  const res = await fetch(`${base}/c/guard-test/${op}`, {
    method: body ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : { "x-ccim-secret": secret }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}
const send = (clientId) => call("send", { to: "bob", text: "local test; no reply", clientId }, alice);

after(async () => {
  await stop();
  rmSync(work, { recursive: true, force: true });
});

test("LOOP_GUARD_MAX=0 accepts more than the default 256 sends; deduplication still applies", async () => {
  await start("0");
  alice = (await call("join", { handle: "alice", ifAbsent: true })).data.token;
  bob = (await call("join", { handle: "bob", ifAbsent: true, mustExist: true })).data.token;
  assert.ok(alice && bob);
  for (let i = 0; i < 260; i++) {
    const id = `guard-test-${i}`;
    const sent = await send(id);
    assert.equal(sent.status, 200);
    const duplicate = await send(id);
    assert.equal(duplicate.data.id, sent.data.id);
    assert.equal(duplicate.data.duplicate, true);
    if (i === 199) await call("ack", { ids: (await call("inbox", undefined, bob)).data.messages.map(m => m.id) }, bob);
  }
  assert.equal((await call("inbox", undefined, bob)).data.messages.length, 60);
});

test("LOOP_GUARD_MAX=1 enforces the retained streak and human reset", async () => {
  await start("1");
  const blocked = await send("guard-blocked");
  assert.equal(blocked.status, 429);
  assert.equal(blocked.data.error, "no_human_in_the_loop");
  assert.equal(blocked.data.max, 1);
  assert.equal((await send("guard-test-259")).data.duplicate, true);
  await call("human", {}, alice);
  for (let i = 0; i < 1; i++) assert.equal((await send(`enabled-test-${i}`)).status, 200);
  assert.equal((await send("enabled-blocked")).status, 429);
});

test("LOOP_GUARD_MAX=0 accepts another send without resetting the channel", async () => {
  await start("0");
  const sent = await send("disabled-again");
  assert.equal(sent.status, 200);
  assert.equal(sent.data.delivery.bob, "queued_offline");
  assert.equal((await call("inbox", undefined, bob)).data.messages.length, 62);
  assert.equal((await call("send", { to: "bob", text: "changed", clientId: "disabled-again" }, alice)).status, 409);
});
