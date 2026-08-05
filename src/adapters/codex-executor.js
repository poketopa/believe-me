import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  validateCodexExecutorResultEvidence,
  validateCodexTaskInput,
} from "../contracts/codex-executor.js";
import { validateExecutorResult } from "../contracts/executor.js";
import { infraError, safetyRefusal, usageError } from "../contracts/errors.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { sha256Hex } from "../core/hash.js";
import {
  compareCodeUnit,
  isExcludedRelativePath,
  normalizeRelativePath,
  readRegularFileNoFollow,
} from "../core/snapshot.js";
import { inspectCodexEvents } from "./codex-events.js";
import { createCodexCliTransport } from "./codex-transport.js";

async function inventoryWorkspace(root) {
  const files = new Map();
  const directories = new Set();

  async function walk(directory, relativeDirectory) {
    const names = await readdir(directory);
    for (const name of names.sort(compareCodeUnit)) {
      const relativePath = relativeDirectory === ""
        ? name
        : `${relativeDirectory}/${name}`;
      const absolutePath = join(directory, name);
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        throw safetyRefusal("Codex workspace contains a symlink.", {
          path: relativePath,
        });
      }
      if (stats.isDirectory()) {
        directories.add(relativePath);
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!stats.isFile()) {
        throw safetyRefusal("Codex workspace contains a non-regular entry.", {
          path: relativePath,
        });
      }
      const { bytes } = await readRegularFileNoFollow(absolutePath, relativePath);
      files.set(relativePath, Object.freeze({
        bytes,
        sha256: sha256Hex(bytes),
      }));
    }
  }

  await walk(root, "");
  return { files, directories };
}

function createPrompt(taskInput) {
  return [
    "You are executing one bounded code-change task inside an isolated workspace.",
    "Use file-edit operations only. Do not run shell commands, use network tools, or invoke other agents.",
    "Modify at least one file and modify only the exact allowed paths listed below.",
    "Do not delete files, create symlinks, or add generated/build artifacts.",
    "The harness will ignore prose and derive the result from workspace bytes.",
    "",
    "Allowed paths:",
    ...taskInput.allowed_paths.map((path) => `- ${path}`),
    "",
    "Task:",
    taskInput.task,
  ].join("\n");
}

function assertTransportCompleted(output) {
  if (output.timed_out) {
    throw infraError("Codex execution timed out.");
  }
  if (output.output_overflowed) {
    throw infraError("Codex output exceeded the configured byte limit.");
  }
  if (output.process_residue_count !== 0 || output.cleanup_error !== null) {
    throw infraError("Codex process cleanup could not be verified.", {
      process_residue_count: output.process_residue_count,
      cleanup_error: output.cleanup_error,
    });
  }
  if (output.error !== null || output.exit_code !== 0 || output.signal !== null) {
    throw infraError("Codex process did not complete successfully.", {
      exit_code: output.exit_code,
      signal: output.signal,
      cause: output.error,
    });
  }
}

function normalizedAllowedPaths(workspaceRoot, taskInput) {
  const paths = new Set();
  for (const path of taskInput.allowed_paths) {
    const normalized = normalizeRelativePath(workspaceRoot, path);
    if (isExcludedRelativePath(normalized)) {
      throw safetyRefusal("Codex allowed path is excluded from harness scope.", {
        path: normalized,
      });
    }
    paths.add(normalized);
  }
  return paths;
}

function assertNoUnboundDirectories(before, after, changedPaths) {
  for (const directory of after.directories) {
    if (before.directories.has(directory)) {
      continue;
    }
    const bindsChange = changedPaths.some((path) => path.startsWith(`${directory}/`));
    if (!bindsChange) {
      throw safetyRefusal("Codex created an undeclared directory.", {
        path: directory,
      });
    }
  }
}

function deriveChanges(before, after, allowedPaths) {
  for (const path of before.files.keys()) {
    if (!after.files.has(path)) {
      throw safetyRefusal("Codex deleted a source file.", { path });
    }
  }

  const changedPaths = [...after.files.entries()]
    .filter(([path, entry]) => before.files.get(path)?.sha256 !== entry.sha256)
    .map(([path]) => path)
    .sort(compareCodeUnit);
  if (changedPaths.length === 0) {
    throw usageError("Codex produced no candidate file changes.");
  }
  for (const path of changedPaths) {
    if (!allowedPaths.has(path)) {
      throw safetyRefusal("Codex changed a path outside the declared allowlist.", {
        path,
      });
    }
    if (isExcludedRelativePath(path)) {
      throw safetyRefusal("Codex changed an excluded harness path.", { path });
    }
  }
  assertNoUnboundDirectories(before, after, changedPaths);
  return changedPaths.map((path) => {
    const entry = after.files.get(path);
    return Object.freeze({
      path,
      content_base64: entry.bytes.toString("base64"),
      sha256: entry.sha256,
    });
  });
}

export function createCodexExecutor({
  transport = createCodexCliTransport(),
  validateResult = validateExecutorResult,
} = {}) {
  if (typeof transport !== "function" || typeof validateResult !== "function") {
    throw usageError("Codex executor dependencies must be functions.");
  }

  return async function executeCodex({ workspaceRoot, input }) {
    if (input?.executor_kind !== "codex") {
      throw usageError("Codex executor requires executor_kind 'codex'.");
    }
    const root = resolve(workspaceRoot);
    const taskInput = validateCodexTaskInput(input.input);
    const allowedPaths = normalizedAllowedPaths(root, taskInput);
    const before = await inventoryWorkspace(root);
    const output = await transport({
      prompt: createPrompt(taskInput),
      workspace: root,
    });
    assertTransportCompleted(output);
    const eventEvidence = inspectCodexEvents(output.events, {
      workspace: root,
      stderr: output.stderr,
    });
    const after = await inventoryWorkspace(root);
    const changes = deriveChanges(before, after, allowedPaths);
    const executorEvidence = validateCodexExecutorResultEvidence({
      schema_version: { major: 1 },
      adapter_id: "codex-cli",
      raw_events_sha256: eventEvidence.raw_events_sha256,
      raw_events_base64: output.events.toString("base64"),
      stderr_sha256: eventEvidence.stderr_sha256,
      final_message_sha256: eventEvidence.final_message_sha256,
      command_sha256: sha256Hex(canonicalJSONBytes(output.command)),
      event_count: eventEvidence.event_count,
      file_change_event_count: eventEvidence.file_change_event_count,
      usage: eventEvidence.usage,
      configuration: output.configuration,
    });
    return validateResult({
      schema_version: { major: 1 },
      run_id: input.run_id,
      executor_kind: "codex",
      status: "completed",
      changes,
      executor_evidence: executorEvidence,
    });
  };
}
