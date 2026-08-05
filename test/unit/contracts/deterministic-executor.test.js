import assert from "node:assert/strict";
import test from "node:test";
import {
  DETERMINISTIC_EXECUTOR_INPUT_REQUIRED_FIELDS,
  DETERMINISTIC_EXECUTOR_RESULT_REQUIRED_FIELDS,
  validateDeterministicExecutorInput,
  validateDeterministicExecutorResult,
} from "../../../src/contracts/deterministic-executor.js";
import { sha256Hex } from "../../../src/core/hash.js";

const schema_version = { major: 1 };
const hash = "a".repeat(64);

function assertFrozenTree(value) {
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") {
      assertFrozenTree(child);
    }
  }
}

function change(path, content) {
  const bytes = Buffer.from(content, "utf8");
  return {
    path,
    content_base64: bytes.toString("base64"),
    sha256: sha256Hex(bytes),
  };
}

test("deterministic executor field tables are explicit", () => {
  assert.deepEqual(DETERMINISTIC_EXECUTOR_INPUT_REQUIRED_FIELDS, [
    "schema_version",
    "run_id",
    "manifest_sha256",
    "source_snapshot_sha256",
    "executor_kind",
    "input",
  ]);
  assert.deepEqual(DETERMINISTIC_EXECUTOR_RESULT_REQUIRED_FIELDS, [
    "schema_version",
    "run_id",
    "executor_kind",
    "status",
    "changes",
  ]);
});

test("deterministic executor input validates and freezes", () => {
  const input = validateDeterministicExecutorInput({
    schema_version,
    run_id: "run-1",
    manifest_sha256: hash,
    source_snapshot_sha256: hash,
    executor_kind: "deterministic",
    input: { fixture: "roomescape" },
  });

  assertFrozenTree(input);
  assert.equal(input.executor_kind, "deterministic");
});

test("deterministic executor result is apply-compatible and frozen", () => {
  const result = validateDeterministicExecutorResult({
    schema_version,
    run_id: "run-1",
    executor_kind: "deterministic",
    status: "completed",
    changes: [change("src/main/java/Reservation.java", "patched")],
  });

  assertFrozenTree(result);
  assert.deepEqual(Object.keys(result.changes[0]), [
    "path",
    "content_base64",
    "sha256",
  ]);
});

test("result rejects non-completed or non-deterministic outcomes", () => {
  assert.throws(
    () =>
      validateDeterministicExecutorResult({
        schema_version,
        run_id: "run-1",
        executor_kind: "codex",
        status: "completed",
        changes: [change("a.txt", "a")],
      }),
    /executor_kind must be deterministic/,
  );
  assert.throws(
    () =>
      validateDeterministicExecutorResult({
        schema_version,
        run_id: "run-1",
        executor_kind: "deterministic",
        status: "failed",
        changes: [change("a.txt", "a")],
      }),
    /status must be completed/,
  );
});

test("result rejects empty, duplicate, unsafe, or non-normalized paths", () => {
  assert.throws(
    () =>
      validateDeterministicExecutorResult({
        schema_version,
        run_id: "run-1",
        executor_kind: "deterministic",
        status: "completed",
        changes: [],
      }),
    /changes must be a non-empty array/,
  );
  assert.throws(
    () =>
      validateDeterministicExecutorResult({
        schema_version,
        run_id: "run-1",
        executor_kind: "deterministic",
        status: "completed",
        changes: [change("a.txt", "a"), change("a.txt", "b")],
      }),
    /duplicate paths/,
  );

  for (const path of [
    "/absolute.txt",
    "src\\Main.java",
    "./relative.txt",
    "src/../escape.txt",
    "src//Main.java",
    "src/",
  ]) {
    assert.throws(
      () =>
        validateDeterministicExecutorResult({
          schema_version,
          run_id: "run-1",
          executor_kind: "deterministic",
          status: "completed",
          changes: [change(path, "x")],
        }),
      /normalized relative POSIX path|dot or empty segments/,
      path,
    );
  }
});

test("result rejects non-canonical base64 and digest mismatches", () => {
  assert.throws(
    () =>
      validateDeterministicExecutorResult({
        schema_version,
        run_id: "run-1",
        executor_kind: "deterministic",
        status: "completed",
        changes: [
          {
            path: "a.txt",
            content_base64: "YQ",
            sha256: sha256Hex(Buffer.from("a")),
          },
        ],
      }),
    /canonical base64/,
  );
  assert.throws(
    () =>
      validateDeterministicExecutorResult({
        schema_version,
        run_id: "run-1",
        executor_kind: "deterministic",
        status: "completed",
        changes: [
          {
            path: "a.txt",
            content_base64: Buffer.from("a").toString("base64"),
            sha256: "b".repeat(64),
          },
        ],
      }),
    /sha256 must match content_base64/,
  );
});
