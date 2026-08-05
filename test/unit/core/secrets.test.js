import assert from "node:assert/strict";
import test from "node:test";
import { containsLikelyCredential } from "../../../src/core/secrets.js";

test("credential detector admits ordinary code and catches high-confidence tokens", () => {
  assert.equal(containsLikelyCredential("class App { String name = \"safe\"; }"), false);
  assert.equal(
    containsLikelyCredential("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"),
    true,
  );
  assert.equal(containsLikelyCredential(Buffer.from([0xff])), false);
});
