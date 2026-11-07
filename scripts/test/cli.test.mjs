import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../plugin/bin/ccim", import.meta.url));
async function fixture(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccim-cli-test-"));
  const requests = [];
  let status = 200;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, secret: req.headers["x-ccim-secret"], body: body ? JSON.parse(body) : null });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(status === 200 ? { token: "test-only-member-token", created: true, members: [] } : { error: "handle_taken" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const relay = `http://127.0.0.1:${server.address().port}`;
  const command = (args, extra = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, CCIM_HOME: home, CCIM_SESSION: "isolated-test", CCIM_HOST: "codex", CCIM_RELAY: "", ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => stdout += d);
    child.stderr.on("data", d => stderr += d);
    child.on("error", reject);
    child.on("exit", code => resolve({ code, stdout, stderr, output: stdout + stderr }));
  });
  try { await run({ home, relay, requests, command, rejectJoin: () => { status = 409; } }); }
  finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(home, { recursive: true, force: true }); }
}

test("CLI guarded join reads a private secret file, persists privately and never echoes credentials", () => fixture(async ({ home, relay, requests, command }) => {
  const secret = "test-only-channel-secret";
  const file = path.join(home, "channel-secret");
  fs.writeFileSync(file, secret, { mode: 0o600 });
  const result = await command(["join", "example/member", "--relay", relay, "--secret-file", file, "--if-absent", "--must-exist"], { CCIM_RELAY: "https://unused.example.invalid" });
  assert.equal(result.code, 0);
  assert.equal(requests[0].secret, secret);
  assert.deepEqual(requests[0].body, { handle: "member", ifAbsent: true, mustExist: true });
  assert.ok(!result.output.includes(secret) && !result.output.includes("test-only-member-token"));
  for (const file of ["config.json", "sessions/isolated-test.json"]) assert.equal(fs.statSync(path.join(home, file)).mode & 0o777, 0o600);
}));

test("CLI environment relay overrides saved default; refused join preserves prior session", () => fixture(async ({ home, relay, requests, command, rejectJoin }) => {
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ relay: "https://unused.example.invalid", channels: { example: { secret: "test-only-channel-secret" } } }));
  fs.mkdirSync(path.join(home, "sessions"));
  const sessionPath = path.join(home, "sessions/isolated-test.json");
  const before = JSON.stringify({ handle: "original", token: "test-only-old-token" });
  fs.writeFileSync(sessionPath, before);
  rejectJoin();
  const result = await command(["join", "example/member", "--if-absent", "--must-exist"], { CCIM_RELAY: relay });
  assert.equal(result.code, 1);
  assert.equal(requests.length, 1);
  assert.equal(fs.readFileSync(sessionPath, "utf8"), before);
}));


test("CLI help advertises private secret files for join and delete", () => fixture(async ({ command }) => {
  const result = await command([]);
  assert.equal(result.code, 0);
  assert.equal((result.output.match(/--secret-file/g) || []).length, 2);
  assert.doesNotMatch(result.output, /--secret\s/);
}));

test("CLI delete accepts a secret file without echoing it (isolated mock only)", () => fixture(async ({ home, relay, requests, command }) => {
  const file = path.join(home, "channel-secret");
  const secret = "test-only-delete-secret";
  fs.writeFileSync(file, secret, { mode: 0o600 });
  const result = await command(["delete", "example", "--secret-file", file], { CCIM_RELAY: relay });
  assert.equal(result.code, 0);
  assert.equal(requests[0].url, "/c/example/delete");
  assert.equal(requests[0].secret, secret);
  assert.ok(!result.output.includes(secret));
}));


for (const operation of ["join", "delete"]) {
  test(`CLI ${operation} refuses a missing, unreadable or empty secret file before network`, () => fixture(async ({ home, relay, requests, command }) => {
    const file = path.join(home, "empty-secret");
    fs.writeFileSync(file, "\n", { mode: 0o600 });
    for (const value of [[], ["--if-absent"], [file], [path.join(home, "missing")]]) {
      const target = operation === "join" ? "example/member" : "example";
      const result = await command([operation, target, "--secret-file", ...value], { CCIM_RELAY: relay });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /secret-file/);
    }
    assert.equal(requests.length, 0);
  }));

  test(`CLI ${operation} warns on legacy secret arguments without exposing credentials`, () => fixture(async ({ relay, requests, command }) => {
    const secret = "test-only-legacy-secret";
    const target = operation === "join" ? "example/member" : "example";
    const result = await command([operation, target, "--secret", secret], { CCIM_RELAY: relay });
    assert.equal(result.code, 0);
    assert.equal(requests[0].secret, secret);
    assert.match(result.stderr, /--secret is deprecated/);
    assert.match(result.stderr, /--secret-file/);
    assert.doesNotMatch(result.stdout, /deprecated/);
    assert.ok(!result.output.includes(secret));
  }));
}
