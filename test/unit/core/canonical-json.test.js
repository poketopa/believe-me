import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalJSONBytes,
  canonicalJSONLine,
  canonicalJSONString,
} from "../../../src/index.js";

test("canonical JSON sorts object keys recursively and preserves array order", () => {
  const value = {
    z: 1,
    a: {
      d: 4,
      b: [{ y: 2, x: 1 }, "keep-order"],
    },
  };

  assert.equal(
    canonicalJSONString(value),
    '{"a":{"b":[{"x":1,"y":2},"keep-order"],"d":4},"z":1}',
  );
});

test("canonical JSON is compact UTF-8 and JSONL adds exactly one LF", () => {
  const value = { text: "한글", a: 1 };
  const string = canonicalJSONString(value);

  assert.equal(string, '{"a":1,"text":"한글"}');
  assert.deepEqual(canonicalJSONBytes(value), Buffer.from(string, "utf8"));
  assert.equal(canonicalJSONLine(value), `${string}\n`);
  assert.equal(canonicalJSONLine(value).endsWith("\n"), true);
  assert.equal(canonicalJSONLine(value).slice(0, -1).includes("\n"), false);
});

test("canonical JSON rejects undefined and non-finite numbers", () => {
  assert.throws(
    () => canonicalJSONString({ value: undefined }),
    /cannot encode undefined/,
  );
  assert.throws(() => canonicalJSONString([NaN]), /non-finite/);
  assert.throws(() => canonicalJSONString({ value: Infinity }), /non-finite/);
  assert.throws(() => canonicalJSONString({ value: -Infinity }), /non-finite/);
});
