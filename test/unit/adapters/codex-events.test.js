import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectCodexEvents,
  parseCodexJsonl,
} from "../../../src/adapters/codex-events.js";

function completedEvents(extraEvents = []) {
  return [
    ...extraEvents,
    {
      type: "item.completed",
      item: {
        type: "agent_message",
        role: "assistant",
        status: "completed",
        text: "done",
      },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 10,
        cached_input_tokens: 2,
        output_tokens: 4,
        reasoning_output_tokens: 1,
        total_tokens: 14,
      },
    },
    "",
  ].map((event) => typeof event === "string" ? event : JSON.stringify(event)).join("\n");
}

test("Codex JSONL inspection binds completed events and usage", () => {
  const raw = completedEvents([{
    type: "item.completed",
    item: {
      type: "file_change",
      changes: [{ path: "/tmp/workspace/src/app.js", kind: "update" }],
    },
  }]);
  const inspected = inspectCodexEvents(raw, { workspace: "/tmp/workspace" });
  assert.equal(inspected.event_count, 3);
  assert.equal(inspected.file_change_event_count, 1);
  assert.equal(inspected.usage.total_tokens, 14);
  assert.match(inspected.raw_events_sha256, /^[a-f0-9]{64}$/u);
});

test("Codex JSONL rejects malformed terminal and prohibited tool events", () => {
  assert.throws(
    () => parseCodexJsonl('{"type":"thread.started"}\n\n'),
    (error) => error.code === "infra_error",
  );
  assert.throws(
    () => inspectCodexEvents(completedEvents([{
      type: "item.completed",
      item: { type: "command_execution", command: "npm test" },
    }]), { workspace: "/tmp/workspace" }),
    (error) => error.code === "safety_refusal",
  );
  assert.throws(
    () => inspectCodexEvents(completedEvents([{
      type: "item.completed",
      item: {
        type: "file_change",
        changes: [{ path: "/tmp/outside.txt" }],
      },
    }]), { workspace: "/tmp/workspace" }),
    /outside the workspace/,
  );
  assert.throws(
    () => inspectCodexEvents(
      `${JSON.stringify({ type: "turn.completed", usage: {} })}\n`,
      { workspace: "/tmp/workspace" },
    ),
    /final agent message/,
  );
});

test("Codex JSONL maps explicit terminal failure events to infra errors", () => {
  for (const type of ["turn.failed", "error"]) {
    assert.throws(
      () => inspectCodexEvents(completedEvents([{ type }]), {
        workspace: "/tmp/workspace",
      }),
      (error) =>
        error.code === "infra_error" &&
        error.message === "Codex reported a failed turn.",
    );
  }
});

test("Codex output credential detection fails closed before persistence", () => {
  const raw = completedEvents([{
    type: "item.completed",
    item: {
      type: "agent_message",
      text: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    },
  }]);
  assert.throws(
    () => inspectCodexEvents(raw, { workspace: "/tmp/workspace" }),
    (error) => error.code === "safety_refusal",
  );
});
