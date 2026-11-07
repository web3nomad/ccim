import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { exportChannelSecret } from "../export-channel-secret.mjs";

test("secret export CLI reads CCIM_HOME and creates a private file without echoing its value", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccim-export-test-"));
  const secret = "test-only-channel-secret";
  try {
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ channels: { example: { secret } } }));
    const output = path.join(home, "private", "channel-secret");
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../export-channel-secret.mjs", import.meta.url)), "example", output], { encoding: "utf8", env: { ...process.env, CCIM_HOME: home } });
    assert.equal(result.status, 0);
    assert.ok(!(result.stdout + result.stderr).includes(secret));
    assert.equal(fs.readFileSync(output, "utf8"), secret + "\n");
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(output)).mode & 0o777, 0o700);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("secret export refuses missing channels, existing files and symlink destinations", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccim-export-test-"));
  try {
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ channels: { example: { secret: "test-only-channel-secret" } } }));
    const output = path.join(home, "target");
    assert.throws(() => exportChannelSecret({ home, channel: "missing", output }));
    assert.ok(!fs.existsSync(output));
    fs.writeFileSync(output, "keep original");
    assert.throws(() => exportChannelSecret({ home, channel: "example", output }));
    fs.symlinkSync(output, path.join(home, "link"));
    assert.throws(() => exportChannelSecret({ home, channel: "example", output: path.join(home, "link") }));
    assert.equal(fs.readFileSync(output, "utf8"), "keep original");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
