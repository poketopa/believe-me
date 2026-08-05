import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCodexExecutor } from "../../../src/adapters/codex-executor.js";
import { validateExecutorResult } from "../../../src/contracts/executor.js";
import { buildContextPack, createProjectSnapshot } from "../../../src/index.js";

function events() {
  return Buffer.from([
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "done" },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 2,
        cached_input_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 0,
        total_tokens: 3,
      },
    }),
    "",
  ].join("\n"), "utf8");
}

function completedOutput(overrides = {}) {
  return {
    command: ["codex", "exec", "--json"],
    events: events(),
    stderr: Buffer.alloc(0),
    exit_code: 0,
    signal: null,
    timed_out: false,
    output_overflowed: false,
    process_residue_count: 0,
    cleanup_error: null,
    error: null,
    configuration: { sandbox: "workspace-write" },
    ...overrides,
  };
}

function executorInput() {
  return {
    run_id: "run-codex",
    executor_kind: "codex",
    input: {
      task: "Replace source with candidate.",
      allowed_paths: ["src/app.txt"],
    },
  };
}

test("Codex executor derives an apply-compatible result from workspace bytes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vah-codex-workspace-"));
  await mkdir(join(workspace, "src"));
  await writeFile(join(workspace, "src", "app.txt"), "source");
  let prompt;
  const executor = createCodexExecutor({
    validateResult: validateExecutorResult,
    async transport(request) {
      prompt = request.prompt;
      await writeFile(join(workspace, "src", "app.txt"), "candidate");
      return completedOutput();
    },
  });

  const result = await executor({
    workspaceRoot: workspace,
    input: executorInput(),
  });
  assert.equal(result.executor_kind, "codex");
  assert.deepEqual(result.changes.map((change) => change.path), ["src/app.txt"]);
  assert.equal(
    Buffer.from(result.changes[0].content_base64, "base64").toString("utf8"),
    "candidate",
  );
  assert.match(prompt, /Allowed paths:\n- src\/app\.txt/u);
  assert.equal(result.executor_evidence.adapter_id, "codex-cli");
  assert.equal(
    Buffer.from(result.executor_evidence.raw_events_base64, "base64").equals(events()),
    true,
  );
});

test("Codex executor refuses outside-allowlist edits, deletion, and empty changes", async () => {
  for (const mutation of [
    async (workspace) => writeFile(join(workspace, "other.txt"), "outside"),
    async (workspace) => rm(join(workspace, "src", "app.txt")),
    async () => {},
  ]) {
    const workspace = await mkdtemp(join(tmpdir(), "vah-codex-workspace-"));
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", "app.txt"), "source");
    const executor = createCodexExecutor({
      validateResult: validateExecutorResult,
      async transport() {
        await mutation(workspace);
        return completedOutput();
      },
    });
    await assert.rejects(
      () => executor({ workspaceRoot: workspace, input: executorInput() }),
      (error) => ["safety_refusal", "usage_error"].includes(error.code),
    );
  }
});

test("Codex executor maps unavailable and unsafe transport outcomes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vah-codex-workspace-"));
  await mkdir(join(workspace, "src"));
  await writeFile(join(workspace, "src", "app.txt"), "source");
  for (const output of [
    completedOutput({ exit_code: null, error: "ENOENT" }),
    completedOutput({ timed_out: true }),
    completedOutput({ output_overflowed: true }),
    completedOutput({ process_residue_count: 1 }),
  ]) {
    const executor = createCodexExecutor({ transport: async () => output });
    await assert.rejects(
      () => executor({ workspaceRoot: workspace, input: executorInput() }),
      (error) => error.code === "infra_error" && error.exitCode === 10,
    );
  }
  assert.equal(await readFile(join(workspace, "src", "app.txt"), "utf8"), "source");
});

test("Codex executor includes an opt-in ContextPack without weakening allowed paths", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vah-codex-context-"));
  await mkdir(join(workspace, "src"));
  await writeFile(join(workspace, "src", "app.txt"), "source reservation boundary\n");
  const sourceSnapshot = await createProjectSnapshot(workspace);
  const contextPack = await buildContextPack({
    projectRoot: workspace,
    sourceSnapshot,
    task: "reservation boundary",
  });
  let prompt;
  const executor = createCodexExecutor({
    validateResult: validateExecutorResult,
    async transport(request) {
      prompt = request.prompt;
      await writeFile(join(workspace, "src", "app.txt"), "candidate\n");
      return completedOutput();
    },
  });
  const input = executorInput();
  input.source_snapshot_sha256 = sourceSnapshot.sha256;
  input.input.context_pack = contextPack;
  await executor({ workspaceRoot: workspace, input });
  assert.match(prompt, /Deterministic ContextPack/u);
  assert.match(prompt, /source reservation boundary/u);
  assert.match(prompt, /Source SHA-256/u);
  assert.match(prompt, /allowed paths remain authoritative/u);
  assert.doesNotMatch(prompt, /other\.txt/u);
});

test("Codex executor refuses a ContextPack from a different frozen snapshot", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vah-codex-context-mismatch-"));
  await mkdir(join(workspace, "src"));
  await writeFile(join(workspace, "src", "app.txt"), "reservation boundary\n");
  const sourceSnapshot = await createProjectSnapshot(workspace);
  const contextPack = await buildContextPack({
    projectRoot: workspace,
    sourceSnapshot,
    task: "reservation boundary",
  });
  const input = executorInput();
  input.source_snapshot_sha256 = "0".repeat(64);
  input.input.context_pack = contextPack;
  let transportCalled = false;
  const executor = createCodexExecutor({
    async transport() {
      transportCalled = true;
      return completedOutput();
    },
  });
  await assert.rejects(
    () => executor({ workspaceRoot: workspace, input }),
    (error) => error.code === "safety_refusal",
  );
  assert.equal(transportCalled, false);
});
