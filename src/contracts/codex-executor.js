import {
  assertObject,
  assertSha256Hex,
  assertString,
  deepFreeze,
  validateContractBase,
} from "./common.js";
import { usageError } from "./errors.js";
import { sha256Hex } from "../core/hash.js";

const normalizedPathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\/\/)[^\\\0]+$/u;
const CODEX_EVIDENCE_REQUIRED_FIELDS = Object.freeze([
  "schema_version",
  "adapter_id",
  "raw_events_sha256",
  "raw_events_base64",
  "stderr_sha256",
  "final_message_sha256",
  "command_sha256",
  "usage",
  "configuration",
]);

function assertAllowedPaths(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw usageError("allowed_paths must be a non-empty string array.", {
      field: "allowed_paths",
    });
  }
  const seen = new Set();
  for (const path of value) {
    assertString(path, "allowed_paths");
    if (
      path.length > 512 ||
      path.endsWith("/") ||
      !normalizedPathPattern.test(path)
    ) {
      throw usageError("allowed_paths entries must be normalized relative POSIX paths.", {
        path,
      });
    }
    if (seen.has(path)) {
      throw usageError("allowed_paths must not contain duplicates.", { path });
    }
    seen.add(path);
  }
}

export function validateCodexTaskInput(value) {
  assertObject(value, "Codex task input");
  assertString(value.task, "task");
  if (
    value.task.trim() === "" ||
    value.task.length > 50_000 ||
    value.task.includes("\0")
  ) {
    throw usageError("task exceeds the admitted Codex prompt boundary.");
  }
  assertAllowedPaths(value.allowed_paths);
  return deepFreeze(structuredClone(value));
}

export function validateCodexExecutorResultEvidence(value) {
  validateContractBase(
    value,
    CODEX_EVIDENCE_REQUIRED_FIELDS,
    "Codex executor evidence",
    {},
  );
  if (value.adapter_id !== "codex-cli") {
    throw usageError("Codex executor evidence adapter_id must be 'codex-cli'.");
  }
  assertSha256Hex(value.raw_events_sha256, "raw_events_sha256");
  assertString(value.raw_events_base64, "raw_events_base64");
  const rawEvents = Buffer.from(value.raw_events_base64, "base64");
  if (
    rawEvents.toString("base64") !== value.raw_events_base64 ||
    sha256Hex(rawEvents) !== value.raw_events_sha256
  ) {
    throw usageError("Codex raw event evidence digest mismatch.");
  }
  assertSha256Hex(value.stderr_sha256, "stderr_sha256");
  assertSha256Hex(value.final_message_sha256, "final_message_sha256");
  assertSha256Hex(value.command_sha256, "command_sha256");
  assertObject(value.usage, "Codex usage evidence");
  for (const field of [
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ]) {
    if (!Number.isSafeInteger(value.usage[field]) || value.usage[field] < 0) {
      throw usageError("Codex usage evidence contains an invalid token count.", {
        field,
      });
    }
  }
  if (
    value.usage.cached_input_tokens > value.usage.input_tokens ||
    value.usage.reasoning_output_tokens > value.usage.output_tokens ||
    value.usage.total_tokens !==
      value.usage.input_tokens + value.usage.output_tokens
  ) {
    throw usageError("Codex usage evidence is internally inconsistent.");
  }
  assertObject(value.configuration, "Codex execution configuration");
  return deepFreeze(structuredClone(value));
}
