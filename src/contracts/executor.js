import {
  EXECUTOR_KINDS,
  assertEnum,
  assertObject,
  assertSha256Hex,
  assertString,
  deepFreeze,
  validateContractBase,
} from "./common.js";
import { usageError } from "./errors.js";
import { sha256Hex } from "../core/hash.js";

export const EXECUTOR_INPUT_REQUIRED_FIELDS = Object.freeze([
  "schema_version",
  "run_id",
  "manifest_sha256",
  "source_snapshot_sha256",
  "executor_kind",
  "input",
]);

export const EXECUTOR_RESULT_REQUIRED_FIELDS = Object.freeze([
  "schema_version",
  "run_id",
  "executor_kind",
  "status",
  "changes",
]);

function assertCompletedStatus(value) {
  if (value !== "completed") {
    throw usageError("status must be completed.", {
      field: "status",
      expected: "completed",
      actual: value,
    });
  }
}

function assertCanonicalBase64(value, field, details = {}) {
  if (typeof value !== "string") {
    throw usageError(`${field} must be a base64 string.`, {
      field,
      ...details,
    });
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw usageError(`${field} must be canonical base64.`, {
      field,
      ...details,
    });
  }
  return bytes;
}

function assertNormalizedRelativePosixPath(path) {
  assertString(path, "change.path");
  if (
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.endsWith("/")
  ) {
    throw usageError("change.path must be a normalized relative POSIX path.", {
      path,
    });
  }

  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw usageError("change.path must not contain dot or empty segments.", {
        path,
      });
    }
  }
}

function validateChange(change, seenPaths) {
  assertObject(change, "ExecutorResult change");
  assertNormalizedRelativePosixPath(change.path);
  if (seenPaths.has(change.path)) {
    throw usageError("changes must not contain duplicate paths.", {
      path: change.path,
    });
  }
  seenPaths.add(change.path);

  const bytes = assertCanonicalBase64(change.content_base64, "content_base64", {
    path: change.path,
  });
  assertSha256Hex(change.sha256, "sha256");
  const actualSha256 = sha256Hex(bytes);
  if (change.sha256 !== actualSha256) {
    throw usageError("change sha256 must match content_base64.", {
      path: change.path,
      expected_sha256: change.sha256,
      actual_sha256: actualSha256,
    });
  }
}

export function validateExecutorInput(value, options = {}) {
  validateContractBase(value, EXECUTOR_INPUT_REQUIRED_FIELDS, "ExecutorInput", options);
  assertString(value.run_id, "run_id");
  assertSha256Hex(value.manifest_sha256, "manifest_sha256");
  assertSha256Hex(value.source_snapshot_sha256, "source_snapshot_sha256");
  assertEnum(value.executor_kind, "executor_kind", EXECUTOR_KINDS);
  assertObject(value.input, "input");
  return deepFreeze(structuredClone(value));
}

export function validateExecutorResult(value, options = {}) {
  validateContractBase(value, EXECUTOR_RESULT_REQUIRED_FIELDS, "ExecutorResult", options);
  assertString(value.run_id, "run_id");
  assertEnum(value.executor_kind, "executor_kind", EXECUTOR_KINDS);
  assertCompletedStatus(value.status);
  if (!Array.isArray(value.changes) || value.changes.length === 0) {
    throw usageError("changes must be a non-empty array.", {
      field: "changes",
    });
  }

  const seenPaths = new Set();
  for (const change of value.changes) {
    validateChange(change, seenPaths);
  }

  return deepFreeze(structuredClone(value));
}

export const freezeExecutorInput = validateExecutorInput;
export const freezeExecutorResult = validateExecutorResult;
