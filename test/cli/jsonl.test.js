import assert from "node:assert/strict";
import test from "node:test";

import { usageError } from "../../src/contracts/errors.js";
import { formatJsonlError, formatJsonlSuccess } from "../../src/cli/jsonl.js";

test("formats canonical success JSONL as exactly one line", () => {
  const formatted = formatJsonlSuccess("status", { z: 1, a: "ok" });

  assert.equal(formatted.exitCode, 0);
  assert.equal(
    formatted.line,
    '{"command":"status","data":{"a":"ok","z":1},"schema_version":{"major":1},"status":"ok"}\n',
  );
});

test("sanitizes success values that canonical JSON cannot encode", () => {
  const formatted = formatJsonlSuccess("run", {
    finite: 1,
    fn() {},
    missing: undefined,
    nested: [1, undefined, Number.POSITIVE_INFINITY, 2],
  });

  assert.equal(
    formatted.line,
    '{"command":"run","data":{"finite":1,"nested":[1,2]},"schema_version":{"major":1},"status":"ok"}\n',
  );
});

test("preserves harness error code details message and exit code", () => {
  const formatted = formatJsonlError(
    "run",
    usageError("Bad input.", {
      flag: "project",
      missing: undefined,
      nested: { finite: 1, infinity: Number.POSITIVE_INFINITY },
    }),
  );

  assert.equal(formatted.exitCode, 2);
  assert.equal(
    formatted.line,
    '{"command":"run","error":{"code":"usage_error","details":{"flag":"project","nested":{"finite":1}},"message":"Bad input."},"schema_version":{"major":1},"status":"error"}\n',
  );
});

test("preserves harness-like errors without requiring class identity", () => {
  const formatted = formatJsonlError("receipt", {
    code: "verification_failed",
    details: { run_id: "run-1" },
    exitCode: 5,
    message: "Verifier failed.",
  });

  assert.equal(formatted.exitCode, 5);
  assert.equal(
    formatted.line,
    '{"command":"receipt","error":{"code":"verification_failed","details":{"run_id":"run-1"},"message":"Verifier failed."},"schema_version":{"major":1},"status":"error"}\n',
  );
});

test("sanitizes unknown errors to infra_error exit 10", () => {
  for (const error of [
    new Error("secret"),
    "bad",
    null,
    { code: "custom", details: {}, exitCode: 99, message: "invalid" },
    { code: "usage_error", details: {}, exitCode: 10, message: "mismatch" },
  ]) {
    const formatted = formatJsonlError("apply", error);

    assert.equal(formatted.exitCode, 10);
    assert.equal(
      formatted.line,
      '{"command":"apply","error":{"code":"infra_error","details":{},"message":"Unexpected harness error."},"schema_version":{"major":1},"status":"error"}\n',
    );
  }
});
