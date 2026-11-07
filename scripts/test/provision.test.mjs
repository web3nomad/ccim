import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { provision } from "../provision-member.mjs";

test("provision uses guarded join, saves privately, never overwrites or retries", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccim-provision-test-"));
  try {
    const output = path.join(dir, "token");
    let calls = 0;
    const opts = { relay: "https://relay.example.invalid", channel: "example", handle: "assistant", secret: "test-only-channel-secret", output,
      request: async (url, init) => {
        calls++;
        assert.equal(init.redirect, "error");
        assert.deepEqual(JSON.parse(init.body), { handle: "assistant", ifAbsent: true, mustExist: true });
        return Response.json({ token: "test-only-member-token" });
      } };
    await provision(opts);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(output, "utf8"), "test-only-member-token\n");
    await assert.rejects(provision(opts));
    assert.equal(calls, 1);
    await assert.rejects(provision({ ...opts, output: path.join(dir, "failed"), request: async () => { calls++; throw Error("timeout"); } }));
    assert.equal(calls, 2);
    assert.equal(fs.readFileSync(path.join(dir, "failed"), "utf8"), "");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
