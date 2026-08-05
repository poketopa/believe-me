import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  canonicalJSONLineBytes,
  sha256CanonicalJSONLine,
  sha256Hex,
} from "../../../src/index.js";

test("sha256Hex hashes exact bytes", () => {
  const bytes = Buffer.from("abc\n", "utf8");
  assert.equal(
    sha256Hex(bytes),
    "edeaaff3f1774ad2888673770c6d64097e391bc362d7d6fb34982ddf0efd18cb",
  );
});

test("canonical JSONL SHA-256 binds the exact emitted UTF-8 line", () => {
  const value = { b: 2, a: 1 };
  const bytes = canonicalJSONLineBytes(value);
  const expected = createHash("sha256").update(bytes).digest("hex");

  assert.equal(bytes.toString("utf8"), '{"a":1,"b":2}\n');
  assert.equal(sha256CanonicalJSONLine(value), expected);
});
