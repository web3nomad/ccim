import { test } from "node:test";
import assert from "node:assert/strict";
import { loopGuardMax } from "../src/loop-guard.js";

test("loop guard defaults safely, supports zero and exact nonnegative integers", () => {
  for (const value of [undefined, null, "", "off", "-1", "1.5", "12junk", "Infinity", "9007199254740992"])
    assert.equal(loopGuardMax(value), 256);
  for (const max of [0, 1, 10, 256, 512]) assert.equal(loopGuardMax(String(max)), max);
});
