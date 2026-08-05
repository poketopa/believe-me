import assert from "node:assert/strict";
import test from "node:test";
import {
  EXECUTOR_INPUT_REQUIRED_FIELDS,
  EXECUTOR_RESULT_REQUIRED_FIELDS,
  validateExecutorInput,
  validateExecutorResult,
} from "../../../src/contracts/executor.js";
import { sha256Hex } from "../../../src/core/hash.js";

const schema_version = { major: 1 };
const hash = "a".repeat(64);

function change(path, content) {
  const bytes = Buffer.from(content, "utf8");
  return {
    path,
    content_base64: bytes.toString("base64"),
    sha256: sha256Hex(bytes),
  };
}

test("generic executor field tables are explicit", () => {
  assert.deepEqual(EXECUTOR_INPUT_REQUIRED_FIELDS, [
    "schema_version",
    "run_id",
    "manifest_sha256",
    "source_snapshot_sha256",
    "executor_kind",
    "input",
  ]);
  assert.deepEqual(EXECUTOR_RESULT_REQUIRED_FIELDS, [
    "schema_version",
    "run_id",
    "executor_kind",
    "status",
    "changes",
  ]);
});

test("generic executor input accepts deterministic and codex kinds", () => {
  for (const executor_kind of ["deterministic", "codex"]) {
    const input = validateExecutorInput({
      schema_version,
      run_id: `run-${executor_kind}`,
      manifest_sha256: hash,
      source_snapshot_sha256: hash,
      executor_kind,
      input: { task: "patch" },
    });
    assert.equal(input.executor_kind, executor_kind);
    assert.equal(Object.isFrozen(input.input), true);
  }
});

test("generic executor result validates shared changes and preserves metadata", () => {
  const result = validateExecutorResult({
    schema_version,
    run_id: "run-codex",
    executor_kind: "codex",
    status: "completed",
    changes: [change("src/app.txt", "patched")],
    executor_evidence: {
      event_log_sha256: "b".repeat(64),
      model: "codex-test",
    },
  });

  assert.equal(result.executor_kind, "codex");
  assert.equal(result.executor_evidence.event_log_sha256, "b".repeat(64));
  assert.equal(Object.isFrozen(result.executor_evidence), true);
});

test("generic executor result rejects unsupported kind and invalid shared changes", () => {
  assert.throws(
    () => validateExecutorResult({
      schema_version,
      run_id: "run-1",
      executor_kind: "manual",
      status: "completed",
      changes: [change("a.txt", "a")],
    }),
    /unsupported value/,
  );
  assert.throws(
    () => validateExecutorResult({
      schema_version,
      run_id: "run-1",
      executor_kind: "codex",
      status: "completed",
      changes: [],
    }),
    /changes must be a non-empty array/,
  );
});
