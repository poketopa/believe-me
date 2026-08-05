import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createCodexExecutor } from "../../src/adapters/codex-executor.js";
import { createCodexCliTransport } from "../../src/adapters/codex-transport.js";
import { validateExecutorResult } from "../../src/contracts/executor.js";
import { applyEvidenceBundle } from "../../src/core/apply.js";
import { readRunState } from "../../src/core/state-store.js";
import { runHarness } from "../../src/core/run-orchestrator.js";

function completedEvents() {
  return Buffer.from([
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "bounded change completed" },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 4,
        cached_input_tokens: 0,
        output_tokens: 2,
        reasoning_output_tokens: 0,
        total_tokens: 6,
      },
    }),
    "",
  ].join("\n"), "utf8");
}

function transportOutput() {
  return {
    command: ["codex", "exec", "--json"],
    events: completedEvents(),
    stderr: Buffer.alloc(0),
    exit_code: 0,
    signal: null,
    timed_out: false,
    output_overflowed: false,
    process_residue_count: 0,
    cleanup_error: null,
    error: null,
    configuration: {
      sandbox: "workspace-write",
      approval_policy: "never",
      web_search: "disabled",
    },
  };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function setup() {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-codex-project-"));
  const controlRoot = await mkdtemp(join(tmpdir(), "vah-codex-control-"));
  await mkdir(join(projectRoot, "src"));
  await writeFile(join(projectRoot, "src", "app.txt"), "source");
  const manifestPath = join(controlRoot, "skill.json");
  const inputPath = join(controlRoot, "input.json");
  await writeJson(manifestPath, {
    schema_version: { major: 1 },
    manifest_id: "codex-integration",
    name: "Codex integration",
    policy_id: "one-file",
    executor_kinds: ["codex"],
    input_schema_ref: "codex-executor-input/v1",
    policy_rules: { max_changes: 1 },
  });
  await writeJson(inputPath, {
    task: "Replace source with candidate.",
    allowed_paths: ["src/app.txt"],
  });
  return {
    projectRoot,
    stateDir: join(projectRoot, ".harness"),
    runSpec: {
      schema_version: { major: 1 },
      project_path: projectRoot,
      state_dir: join(projectRoot, ".harness"),
      skill_manifest_path: manifestPath,
      input_path: inputPath,
      executor_kind: "codex",
    },
  };
}

test("Codex adapter reaches receipt and applies only after explicit approval", async () => {
  const fixture = await setup();
  const executor = createCodexExecutor({
    validateResult: validateExecutorResult,
    async transport({ workspace }) {
      await writeFile(join(workspace, "src", "app.txt"), "candidate");
      return transportOutput();
    },
  });

  const completed = await runHarness({
    runId: "run-codex-1",
    runSpec: fixture.runSpec,
    executor,
    verifier: async () => true,
  });
  assert.equal(completed.state.executor_kind, "codex");
  assert.equal(completed.state.lifecycle_state, "receipted");
  assert.equal(completed.evidence.result.executor_kind, "codex");
  assert.equal(completed.evidence.result.executor_evidence.adapter_id, "codex-cli");
  assert.equal(
    await readFile(join(fixture.projectRoot, "src", "app.txt"), "utf8"),
    "source",
  );

  const applied = await applyEvidenceBundle({
    projectRoot: fixture.projectRoot,
    stateDir: fixture.stateDir,
    runId: "run-codex-1",
    approvalSha256: completed.state.receipt_sha256,
    verifier: async () => true,
  });
  assert.equal(applied.state.lifecycle_state, "applied");
  assert.equal(
    await readFile(join(fixture.projectRoot, "src", "app.txt"), "utf8"),
    "candidate",
  );
});

test("missing Codex auth becomes durable typed execution failure", async () => {
  const fixture = await setup();
  const emptyHome = await mkdtemp(join(tmpdir(), "vah-empty-codex-home-"));
  const executor = createCodexExecutor({
    transport: createCodexCliTransport({
      env: { PATH: process.env.PATH, CODEX_HOME: emptyHome },
    }),
  });

  await assert.rejects(
    () => runHarness({
      runId: "run-codex-no-auth",
      runSpec: fixture.runSpec,
      executor,
      verifier: async () => true,
    }),
    (error) => error.code === "infra_error" && error.exitCode === 10,
  );
  const { state } = await readRunState(fixture.stateDir, "run-codex-no-auth");
  assert.equal(state.lifecycle_state, "rejected");
  const failure = JSON.parse(await readFile(
    join(state.artifact_root, "failure.jsonl"),
    "utf8",
  ));
  assert.equal(failure.phase, "execution");
  assert.equal(failure.code, "infra_error");
  assert.equal(
    await readFile(join(fixture.projectRoot, "src", "app.txt"), "utf8"),
    "source",
  );
});

test("missing Codex executable becomes durable typed execution failure", async () => {
  const fixture = await setup();
  const authHome = await mkdtemp(join(tmpdir(), "vah-codex-auth-"));
  await writeFile(join(authHome, "auth.json"), '{"fixture":"auth"}\n');
  const executor = createCodexExecutor({
    transport: createCodexCliTransport({
      env: { PATH: process.env.PATH, CODEX_HOME: authHome },
      spawnImpl() {
        const error = new Error("ENOENT");
        error.code = "ENOENT";
        throw error;
      },
    }),
  });

  await assert.rejects(
    () => runHarness({
      runId: "run-codex-no-executable",
      runSpec: fixture.runSpec,
      executor,
      verifier: async () => true,
    }),
    (error) => error.code === "infra_error" && error.exitCode === 10,
  );
  const { state } = await readRunState(
    fixture.stateDir,
    "run-codex-no-executable",
  );
  assert.equal(state.lifecycle_state, "rejected");
  const failure = JSON.parse(await readFile(
    join(state.artifact_root, "failure.jsonl"),
    "utf8",
  ));
  assert.equal(failure.phase, "execution");
  assert.equal(failure.code, "infra_error");
  assert.equal(
    await readFile(join(fixture.projectRoot, "src", "app.txt"), "utf8"),
    "source",
  );
});
