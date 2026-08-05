import { isAbsolute, relative, resolve, sep } from "node:path";
import { infraError, safetyRefusal } from "../contracts/errors.js";
import { containsLikelyCredential } from "../core/secrets.js";
import { sha256Hex } from "../core/hash.js";

const usageFields = Object.freeze([
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
]);
const prohibitedItemTypes = new Set([
  "command_execution",
  "mcp_tool_call",
  "web_search",
  "computer_use",
]);

function asBuffer(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (typeof value === "string") {
    return Buffer.from(value, "utf8");
  }
  throw infraError("Codex events must be UTF-8 bytes or text.");
}

function assertNonNegativeToken(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw infraError("Codex usage contains an invalid token count.", { field });
  }
  return value;
}

function isFinalAgentMessage(item) {
  return (
    item !== null &&
    typeof item === "object" &&
    !Array.isArray(item) &&
    ["agent_message", "assistant_message", "message"].includes(item.type) &&
    [undefined, null, "assistant"].includes(item.role) &&
    [undefined, null, "completed"].includes(item.status) &&
    typeof item.text === "string" &&
    item.text.length > 0
  );
}

function isOutsideWorkspace(workspace, path) {
  if (typeof path !== "string" || path.length === 0) {
    return true;
  }
  const root = resolve(workspace);
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const candidate = relative(root, absolute);
  return (
    candidate === "" ||
    candidate === ".." ||
    candidate.startsWith(`..${sep}`) ||
    isAbsolute(candidate)
  );
}

export function parseCodexJsonl(rawEvents) {
  const bytes = asBuffer(rawEvents);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw infraError("Codex emitted invalid UTF-8 JSONL.");
  }
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    throw infraError("Codex emitted no JSONL events.");
  }
  return lines.map((line, index) => {
    if (line.trim() === "") {
      throw infraError("Codex emitted a blank JSONL record.", {
        line: index + 1,
      });
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw infraError("Codex emitted malformed JSONL.", { line: index + 1 });
    }
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      throw infraError("Codex JSONL records must be objects.", {
        line: index + 1,
      });
    }
    return event;
  });
}

export function inspectCodexEvents(rawEvents, { workspace, stderr = "" }) {
  const bytes = asBuffer(rawEvents);
  const stderrBytes = asBuffer(stderr);
  if (containsLikelyCredential(bytes) || containsLikelyCredential(stderrBytes)) {
    throw safetyRefusal("Codex output contained likely credential material.");
  }
  const events = parseCodexJsonl(bytes);
  const completedTurns = events.filter((event) => event.type === "turn.completed");
  if (completedTurns.length !== 1) {
    throw infraError("Codex must emit exactly one completed turn.", {
      completed_turns: completedTurns.length,
    });
  }
  if (events.some((event) => event.type === "turn.failed" || event.type === "error")) {
    throw infraError("Codex reported a failed turn.");
  }

  const completedItems = events
    .filter((event) => event.type === "item.completed")
    .map((event) => event.item)
    .filter((item) => item !== null && typeof item === "object");
  const finalMessages = completedItems.filter(isFinalAgentMessage);
  if (finalMessages.length === 0) {
    throw infraError("Codex completed without a final agent message.");
  }
  const prohibited = completedItems.filter((item) =>
    prohibitedItemTypes.has(item.type)
  );
  if (prohibited.length > 0) {
    throw safetyRefusal("Codex used a prohibited tool during bounded execution.", {
      item_types: [...new Set(prohibited.map((item) => item.type))].sort(),
    });
  }

  let fileChangeCount = 0;
  for (const item of completedItems.filter((entry) => entry.type === "file_change")) {
    for (const change of Array.isArray(item.changes) ? item.changes : []) {
      fileChangeCount += 1;
      if (isOutsideWorkspace(workspace, change?.path)) {
        throw safetyRefusal("Codex reported a file change outside the workspace.", {
          path: change?.path ?? null,
        });
      }
    }
  }

  const rawUsage = completedTurns[0].usage;
  if (rawUsage === null || typeof rawUsage !== "object" || Array.isArray(rawUsage)) {
    throw infraError("Codex completed without usage metadata.");
  }
  const usage = Object.fromEntries(usageFields.map((field) => [
    field,
    assertNonNegativeToken(rawUsage[field], field),
  ]));
  if (
    usage.cached_input_tokens > usage.input_tokens ||
    usage.reasoning_output_tokens > usage.output_tokens
  ) {
    throw infraError("Codex usage subcounts exceed parent counts.");
  }
  usage.total_tokens = usage.input_tokens + usage.output_tokens;
  if (
    rawUsage.total_tokens !== undefined &&
    rawUsage.total_tokens !== usage.total_tokens
  ) {
    throw infraError("Codex total token usage is inconsistent.");
  }

  return Object.freeze({
    raw_events_sha256: sha256Hex(bytes),
    stderr_sha256: sha256Hex(stderrBytes),
    event_count: events.length,
    file_change_event_count: fileChangeCount,
    final_message_sha256: sha256Hex(Buffer.from(
      String(finalMessages.at(-1).text ?? ""),
      "utf8",
    )),
    usage: Object.freeze(usage),
  });
}
