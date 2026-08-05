import assert from "node:assert/strict";
import test from "node:test";
import {
  validateCodexExecutorResultEvidence,
  validateCodexTaskInput,
} from "../../../src/contracts/codex-executor.js";
import { sha256Hex } from "../../../src/core/hash.js";

const hash = "a".repeat(64);

test("Codex task input requires a bounded task and normalized allowlist", () => {
  const input = validateCodexTaskInput({
    task: "Fix the cancellation boundary.",
    allowed_paths: ["src/ReservationService.java"],
  });
  assert.equal(Object.isFrozen(input), true);
  assert.equal(input.allowed_paths[0], "src/ReservationService.java");

  for (const allowedPaths of [[], ["../escape"], ["/absolute"], ["a\\b"]]) {
    assert.throws(
      () => validateCodexTaskInput({ task: "fix", allowed_paths: allowedPaths }),
      (error) => error.code === "usage_error",
    );
  }
});

test("Codex result evidence binds canonical raw events", () => {
  const rawEvents = Buffer.from('{"type":"turn.completed"}\n', "utf8");
  const evidence = validateCodexExecutorResultEvidence({
    schema_version: { major: 1 },
    adapter_id: "codex-cli",
    raw_events_sha256: sha256Hex(rawEvents),
    raw_events_base64: rawEvents.toString("base64"),
    stderr_sha256: hash,
    final_message_sha256: hash,
    command_sha256: hash,
    usage: {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
      total_tokens: 2,
    },
    configuration: { sandbox: "workspace-write" },
  });
  assert.equal(Object.isFrozen(evidence), true);

  assert.throws(
    () => validateCodexExecutorResultEvidence({
      ...evidence,
      raw_events_sha256: hash,
    }),
    /digest mismatch/,
  );
});
