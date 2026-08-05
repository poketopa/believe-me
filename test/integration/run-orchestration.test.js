import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  applyEvidenceBundle,
  canonicalJSONLine,
  createProjectSnapshot,
  deterministicRunDebugPaths,
  evidencePaths,
  infraError,
  readRunState,
  resumeHarness,
  resumeDeterministicHarness,
  runHarness,
  runDeterministicHarness,
  sha256Hex,
  usageError,
  writeEvidenceBundle,
} from "../../src/index.js";

const issuedAt = "2026-08-05T00:00:00.000Z";
const recordedAt = () => "2026-08-05T00:00:01.000Z";

function candidate(path, content) {
  const bytes = Buffer.from(content, "utf8");
  return {
    path,
    content_base64: bytes.toString("base64"),
    sha256: sha256Hex(bytes),
  };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function createRunSetup({
  runId = "run-1",
  change = candidate("src/app.txt", "candidate"),
  verifier,
} = {}) {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-run-project-"));
  const controlRoot = await mkdtemp(join(tmpdir(), "vah-run-control-"));
  await mkdir(join(projectRoot, "src"));
  await writeFile(join(projectRoot, "src", "app.txt"), "source");
  const manifestPath = join(controlRoot, "skill-manifest.json");
  const inputPath = join(controlRoot, "input.json");
  const manifest = {
    schema_version: { major: 1 },
    manifest_id: "deterministic-test",
    name: "Deterministic test policy",
    policy_id: "replace-one-file",
    executor_kinds: ["deterministic"],
    input_schema_ref: "deterministic-executor-input/v1",
    policy_rules: { max_changes: 1 },
  };
  if (verifier !== undefined) {
    manifest.verifier = verifier;
  }
  await writeJson(manifestPath, manifest);
  await writeJson(inputPath, { changes: [change] });
  const stateDir = join(projectRoot, ".harness");
  return {
    projectRoot,
    stateDir,
    runId,
    inputPath,
    change,
    runSpec: {
      schema_version: { major: 1 },
      project_path: projectRoot,
      state_dir: stateDir,
      skill_manifest_path: manifestPath,
      input_path: inputPath,
      executor_kind: "deterministic",
    },
  };
}

function passedVerifier() {
  return {
    schema_version: { major: 1 },
    adapter_id: "test-verifier",
    status: "passed",
  };
}

test("run reaches receipted with a non-empty apply-compatible candidate", async () => {
  const setup = await createRunSetup();
  const before = await createProjectSnapshot(setup.projectRoot);

  const completed = await runDeterministicHarness({
    runId: setup.runId,
    runSpec: setup.runSpec,
    verifier: async ({ workspaceRoot }) => {
      assert.equal(await readFile(join(workspaceRoot, "src", "app.txt"), "utf8"), "candidate");
      assert.equal(await readFile(join(setup.projectRoot, "src", "app.txt"), "utf8"), "source");
      return passedVerifier();
    },
    issuedAt,
    recordedAt,
  });

  assert.equal(completed.state.lifecycle_state, "receipted");
  assert.equal(completed.evidence.receipt_sha256, completed.state.receipt_sha256);
  assert.equal(completed.evidence.result.changes.length, 1);
  assert.equal((await createProjectSnapshot(setup.projectRoot)).sha256, before.sha256);
  assert.equal(await readFile(join(setup.projectRoot, "src", "app.txt"), "utf8"), "source");

  const applied = await applyEvidenceBundle({
    projectRoot: setup.projectRoot,
    stateDir: setup.stateDir,
    runId: setup.runId,
    approvalSha256: completed.state.receipt_sha256,
    verifier: () => true,
  });
  assert.equal(applied.state.lifecycle_state, "applied");
  assert.equal(await readFile(join(setup.projectRoot, "src", "app.txt"), "utf8"), "candidate");
});

test("verifier failure rejects the run, preserves source, and keeps failure evidence", async () => {
  const setup = await createRunSetup();
  const before = await createProjectSnapshot(setup.projectRoot);

  await assert.rejects(
    () => runDeterministicHarness({
      runId: setup.runId,
      runSpec: setup.runSpec,
      verifier: async () => ({
        schema_version: { major: 1 },
        adapter_id: "test-verifier",
        status: "failed",
      }),
      issuedAt,
      recordedAt,
    }),
    (error) => error.code === "verification_failed" && error.exitCode === 5,
  );

  const { state } = await readRunState(setup.stateDir, setup.runId);
  assert.equal(state.lifecycle_state, "rejected");
  assert.equal((await createProjectSnapshot(setup.projectRoot)).sha256, before.sha256);
  const paths = deterministicRunDebugPaths(setup.stateDir, setup.runId);
  assert.equal(JSON.parse(await readFile(join(paths.artifact_root, "result.jsonl"), "utf8")).changes.length, 1);
  assert.equal(JSON.parse(await readFile(join(paths.artifact_root, "verification.jsonl"), "utf8")).status, "failed");
  assert.equal(JSON.parse(await readFile(join(paths.artifact_root, "failure.jsonl"), "utf8")).phase, "verification");
  await assert.rejects(() => readFile(evidencePaths(paths.artifact_root).receipt));
});

test("executor failure rejects the run without creating success evidence", async () => {
  const setup = await createRunSetup();

  await assert.rejects(
    () => runDeterministicHarness({
      runId: setup.runId,
      runSpec: setup.runSpec,
      executor: async () => {
        throw infraError("executor unavailable");
      },
      verifier: async () => passedVerifier(),
      issuedAt,
      recordedAt,
    }),
    (error) => error.code === "infra_error" && error.exitCode === 10,
  );

  const { state } = await readRunState(setup.stateDir, setup.runId);
  assert.equal(state.lifecycle_state, "rejected");
  const paths = deterministicRunDebugPaths(setup.stateDir, setup.runId);
  assert.equal(JSON.parse(await readFile(join(paths.artifact_root, "failure.jsonl"), "utf8")).phase, "execution");
  await assert.rejects(() => readFile(evidencePaths(paths.artifact_root).receipt));
});

test("run refuses an executor result whose bytes were not written to the workspace", async () => {
  const setup = await createRunSetup();

  await assert.rejects(
    () => runDeterministicHarness({
      runId: setup.runId,
      runSpec: setup.runSpec,
      executor: async () => ({
        schema_version: { major: 1 },
        run_id: setup.runId,
        executor_kind: "deterministic",
        status: "completed",
        changes: [setup.change],
      }),
      verifier: async () => passedVerifier(),
      issuedAt,
      recordedAt,
    }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
  assert.equal((await readRunState(setup.stateDir, setup.runId)).state.lifecycle_state, "rejected");
  assert.equal(await readFile(join(setup.projectRoot, "src", "app.txt"), "utf8"), "source");
});

test("run refuses when the verifier mutates declared candidate bytes", async () => {
  const setup = await createRunSetup();

  await assert.rejects(
    () => runDeterministicHarness({
      runId: setup.runId,
      runSpec: setup.runSpec,
      verifier: async ({ workspaceRoot }) => {
        await writeFile(join(workspaceRoot, "src", "app.txt"), "mutated");
        return passedVerifier();
      },
      issuedAt,
      recordedAt,
    }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
  assert.equal((await readRunState(setup.stateDir, setup.runId)).state.lifecycle_state, "rejected");
  assert.equal(await readFile(join(setup.projectRoot, "src", "app.txt"), "utf8"), "source");
});

test("run refuses undeclared files created by the verifier", async () => {
  const setup = await createRunSetup();

  await assert.rejects(
    () => runDeterministicHarness({
      runId: setup.runId,
      runSpec: setup.runSpec,
      verifier: async ({ workspaceRoot }) => {
        await writeFile(join(workspaceRoot, "src", "undeclared.txt"), "extra");
        return passedVerifier();
      },
      issuedAt,
      recordedAt,
    }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
  assert.equal((await readRunState(setup.stateDir, setup.runId)).state.lifecycle_state, "rejected");
  assert.equal(await readFile(join(setup.projectRoot, "src", "app.txt"), "utf8"), "source");
});

test("resume revalidates frozen hashes and completes a verified interrupted run", async () => {
  const setup = await createRunSetup();
  await assert.rejects(
    () => runDeterministicHarness({
      runId: setup.runId,
      runSpec: setup.runSpec,
      verifier: async () => passedVerifier(),
      issuedAt,
      recordedAt,
      onCheckpoint({ state }) {
        if (state.lifecycle_state === "verified") {
          throw new Error("simulated process interruption");
        }
      },
    }),
    /simulated process interruption/,
  );
  assert.equal((await readRunState(setup.stateDir, setup.runId)).state.lifecycle_state, "verified");

  const resumed = await resumeDeterministicHarness({
    stateDir: setup.stateDir,
    runId: setup.runId,
    recordedAt,
  });
  assert.equal(resumed.state.lifecycle_state, "receipted");
  assert.equal(resumed.evidence.receipt_sha256, resumed.state.receipt_sha256);
});

test("resume restarts an interrupted executing run from the frozen input", async () => {
  const setup = await createRunSetup();
  await assert.rejects(
    () => runDeterministicHarness({
      runId: setup.runId,
      runSpec: setup.runSpec,
      verifier: async () => passedVerifier(),
      issuedAt,
      recordedAt,
      onCheckpoint({ state }) {
        if (state.lifecycle_state === "executing") {
          throw new Error("interrupt before execution");
        }
      },
    }),
    /interrupt before execution/,
  );
  assert.equal((await readRunState(setup.stateDir, setup.runId)).state.lifecycle_state, "executing");

  const resumed = await resumeDeterministicHarness({
    stateDir: setup.stateDir,
    runId: setup.runId,
    verifier: async () => passedVerifier(),
    issuedAt,
    recordedAt,
  });
  assert.equal(resumed.state.lifecycle_state, "receipted");
  assert.equal(await readFile(join(setup.projectRoot, "src", "app.txt"), "utf8"), "source");
});

test("resume resolves the command verifier from the frozen manifest", async () => {
  const setup = await createRunSetup({
    verifier: {
      schema_version: { major: 1 },
      adapter_id: "command-verifier",
      command: "node",
      args: [
        "--input-type=module",
        "--eval",
        "import { readFileSync } from 'node:fs'; if (readFileSync('src/app.txt', 'utf8') !== 'candidate') process.exit(7);",
      ],
      timeout_ms: 30_000,
      max_output_bytes: 1_048_576,
    },
  });
  await assert.rejects(
    () => runDeterministicHarness({
      runId: setup.runId,
      runSpec: setup.runSpec,
      issuedAt,
      recordedAt,
      onCheckpoint({ state }) {
        if (state.lifecycle_state === "executing") {
          throw new Error("interrupt before manifest-selected verification");
        }
      },
    }),
    /interrupt before manifest-selected verification/u,
  );

  const resumed = await resumeDeterministicHarness({
    stateDir: setup.stateDir,
    runId: setup.runId,
    issuedAt,
    recordedAt,
  });
  assert.equal(resumed.state.lifecycle_state, "receipted");
  assert.equal(resumed.evidence.verification.adapter_id, "command-verifier");
  assert.deepEqual(resumed.evidence.verification.argv.slice(0, 2), [
    "node",
    "--input-type=module",
  ]);
});

test("resume refuses complete evidence that was never bound by executing state", async () => {
  const setup = await createRunSetup();
  await assert.rejects(
    () => runDeterministicHarness({
      runId: setup.runId,
      runSpec: setup.runSpec,
      verifier: async () => passedVerifier(),
      issuedAt,
      recordedAt,
      onCheckpoint({ state }) {
        if (state.lifecycle_state === "executing") {
          throw new Error("interrupt before execution");
        }
      },
    }),
    /interrupt before execution/,
  );
  const { state } = await readRunState(setup.stateDir, setup.runId);
  await writeEvidenceBundle({
    artifactRoot: state.artifact_root,
    runState: state,
    verification: passedVerifier(),
    result: {
      schema_version: { major: 1 },
      run_id: setup.runId,
      executor_kind: "deterministic",
      status: "completed",
      changes: [candidate("src/app.txt", "fake-not-verified")],
    },
    issuedAt,
  });

  await assert.rejects(
    () => resumeDeterministicHarness({ stateDir: setup.stateDir, runId: setup.runId }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
  assert.equal((await readRunState(setup.stateDir, setup.runId)).state.lifecycle_state, "executing");
});

test("resume refuses a self-consistent receipt that differs from verified state binding", async () => {
  const setup = await createRunSetup();
  await assert.rejects(
    () => runDeterministicHarness({
      runId: setup.runId,
      runSpec: setup.runSpec,
      verifier: async () => passedVerifier(),
      issuedAt,
      recordedAt,
      onCheckpoint({ state }) {
        if (state.lifecycle_state === "verified") {
          throw new Error("interrupt after binding");
        }
      },
    }),
    /interrupt after binding/,
  );
  const { state } = await readRunState(setup.stateDir, setup.runId);
  assert.equal(state.lifecycle_state, "verified");
  assert.match(state.receipt_sha256, /^[a-f0-9]{64}$/);

  const paths = evidencePaths(state.artifact_root);
  const receipt = JSON.parse(await readFile(paths.receipt, "utf8"));
  const tamperedLine = canonicalJSONLine({
    ...receipt,
    issued_at: "2026-08-05T00:00:02.000Z",
  });
  await writeFile(paths.receipt, tamperedLine);
  await writeFile(paths.receiptDigest, `${sha256Hex(Buffer.from(tamperedLine))}\n`);

  await assert.rejects(
    () => resumeDeterministicHarness({ stateDir: setup.stateDir, runId: setup.runId }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
  assert.equal((await readRunState(setup.stateDir, setup.runId)).state.receipt_sha256, state.receipt_sha256);
});

test("resume refuses tampered frozen executor input", async () => {
  const setup = await createRunSetup();
  await assert.rejects(
    () => runDeterministicHarness({
      runId: setup.runId,
      runSpec: setup.runSpec,
      verifier: async () => passedVerifier(),
      issuedAt,
      recordedAt,
      onCheckpoint({ state }) {
        if (state.lifecycle_state === "verified") {
          throw new Error("interrupt");
        }
      },
    }),
    /interrupt/,
  );
  const paths = deterministicRunDebugPaths(setup.stateDir, setup.runId);
  const line = await readFile(paths.inputs.executorInput.body, "utf8");
  await writeFile(paths.inputs.executorInput.body, line.replace('"run-1"', '"run-2"'));

  await assert.rejects(
    () => resumeDeterministicHarness({ stateDir: setup.stateDir, runId: setup.runId }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
});

test("run rejects an empty candidate before creating a run", async () => {
  const setup = await createRunSetup();
  await writeJson(setup.inputPath, { changes: [] });

  await assert.rejects(
    () => runDeterministicHarness({ runId: setup.runId, runSpec: setup.runSpec }),
    (error) => error.code === "usage_error" && error.exitCode === 2,
  );
  await assert.rejects(
    () => readRunState(setup.stateDir, setup.runId),
    (error) => error.code === "ENOENT",
  );
});

test("generic codex run validates input before creating a run when adapter rejects it", async () => {
  const setup = await createRunSetup({ runId: "run-codex-preflight" });
  const manifestPath = join(dirname(setup.inputPath), "codex-skill-manifest.json");
  await writeJson(manifestPath, {
    schema_version: { major: 1 },
    manifest_id: "codex-test",
    name: "Codex test policy",
    policy_id: "codex-test",
    executor_kinds: ["codex"],
    input_schema_ref: "codex-task-input/v1",
    policy_rules: { max_changes: 1 },
  });
  const runSpec = {
    ...setup.runSpec,
    skill_manifest_path: manifestPath,
    executor_kind: "codex",
  };

  await assert.rejects(
    () => runHarness({
      runId: setup.runId,
      runSpec,
      executorInputValidator() {
        throw usageError("Codex task input is invalid.");
      },
    }),
    (error) => error.code === "usage_error" && error.exitCode === 2,
  );
  await assert.rejects(
    () => readRunState(setup.stateDir, setup.runId),
    (error) => error.code === "ENOENT",
  );
});

test("generic codex run requires an injected executor and rejects with typed infra error", async () => {
  const setup = await createRunSetup({ runId: "run-codex-missing-executor" });
  const manifestPath = join(dirname(setup.inputPath), "codex-skill-manifest.json");
  await writeJson(manifestPath, {
    schema_version: { major: 1 },
    manifest_id: "codex-test",
    name: "Codex test policy",
    policy_id: "codex-test",
    executor_kinds: ["codex"],
    input_schema_ref: "codex-task-input/v1",
    policy_rules: { max_changes: 1 },
  });

  await assert.rejects(
    () => runHarness({
      runId: setup.runId,
      runSpec: {
        ...setup.runSpec,
        skill_manifest_path: manifestPath,
        executor_kind: "codex",
      },
      verifier: async () => passedVerifier(),
      issuedAt,
      recordedAt,
    }),
    (error) =>
      error.code === "infra_error" &&
      error.exitCode === 10 &&
      error.details.executor_kind === "codex",
  );
  assert.equal(
    (await readRunState(setup.stateDir, setup.runId)).state.lifecycle_state,
    "rejected",
  );
  const failure = JSON.parse(
    await readFile(
      join(deterministicRunDebugPaths(setup.stateDir, setup.runId).artifact_root, "failure.jsonl"),
      "utf8",
    ),
  );
  assert.equal(failure.executor_kind, "codex");
});

test("generic codex run preserves executor evidence and resumes from frozen input", async () => {
  const setup = await createRunSetup({ runId: "run-codex-success" });
  const manifestPath = join(dirname(setup.inputPath), "codex-skill-manifest.json");
  await writeJson(manifestPath, {
    schema_version: { major: 1 },
    manifest_id: "codex-test",
    name: "Codex test policy",
    policy_id: "codex-test",
    executor_kinds: ["codex"],
    input_schema_ref: "codex-task-input/v1",
    policy_rules: { max_changes: 1 },
  });
  const result = {
    schema_version: { major: 1 },
    run_id: setup.runId,
    executor_kind: "codex",
    status: "completed",
    changes: [setup.change],
    executor_evidence: {
      event_log_sha256: "b".repeat(64),
      transcript_events: 3,
    },
  };
  let executorCalls = 0;

  await assert.rejects(
    () => runHarness({
      runId: setup.runId,
      runSpec: {
        ...setup.runSpec,
        skill_manifest_path: manifestPath,
        executor_kind: "codex",
      },
      executorInputValidator(rawInput) {
        return { ...rawInput, adapter: "codex" };
      },
      executor: async ({ workspaceRoot, input, plan }) => {
        executorCalls += 1;
        assert.equal(input.executor_kind, "codex");
        assert.equal(input.input.adapter, "codex");
        assert.equal(plan.executor_kind, "codex");
        await writeFile(join(workspaceRoot, setup.change.path), "candidate");
        return result;
      },
      verifier: async () => passedVerifier(),
      issuedAt,
      recordedAt,
      onCheckpoint({ state }) {
        if (state.lifecycle_state === "verified") {
          throw new Error("interrupt after codex verification");
        }
      },
    }),
    /interrupt after codex verification/,
  );

  const completed = await resumeHarness({
    stateDir: setup.stateDir,
    runId: setup.runId,
    recordedAt,
  });
  assert.equal(executorCalls, 1);
  assert.equal(completed.state.executor_kind, "codex");
  assert.equal(completed.evidence.result.executor_kind, "codex");
  assert.equal(
    completed.evidence.result.executor_evidence.event_log_sha256,
    "b".repeat(64),
  );
  assert.equal(completed.state.lifecycle_state, "receipted");
});

test("run id is exclusive and an existing run must use resume", async () => {
  const setup = await createRunSetup();
  await runDeterministicHarness({
    runId: setup.runId,
    runSpec: setup.runSpec,
    verifier: async () => passedVerifier(),
    issuedAt,
    recordedAt,
  });

  await assert.rejects(
    () => runDeterministicHarness({
      runId: setup.runId,
      runSpec: setup.runSpec,
      verifier: async () => passedVerifier(),
      issuedAt,
      recordedAt,
    }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
});

test("run refuses a symlinked runs directory before writing outside state", async () => {
  const setup = await createRunSetup();
  const outsideRoot = await mkdtemp(join(tmpdir(), "vah-run-outside-"));
  await mkdir(setup.stateDir);
  await symlink(outsideRoot, join(setup.stateDir, "runs"));

  await assert.rejects(
    () => runDeterministicHarness({
      runId: setup.runId,
      runSpec: setup.runSpec,
      verifier: async () => passedVerifier(),
      issuedAt,
      recordedAt,
    }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
  await assert.rejects(() => readFile(join(outsideRoot, setup.runId, "state.jsonl")));
});

test("canonical Spring fixture runs candidate in isolation and reaches receipted", async () => {
  const canonicalRoot = resolve("test/fixtures/roomescape-cancel-booking-penalty");
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-roomescape-run-"));
  const controlRoot = await mkdtemp(join(tmpdir(), "vah-roomescape-control-"));
  await cp(canonicalRoot, projectRoot, { recursive: true, force: true });

  const targetPath = "src/main/java/com/roomescape/booking/application/ReservationService.java";
  const candidateSource = await readFile(join(canonicalRoot, targetPath), "utf8");
  const baselineSource = candidateSource.replace(
    "if (!now.isBefore(deadline))",
    "if (now.isAfter(deadline))",
  );
  assert.notEqual(baselineSource, candidateSource);
  await writeFile(join(projectRoot, targetPath), baselineSource);

  const manifestPath = join(controlRoot, "skill-manifest.json");
  const inputPath = join(controlRoot, "input.json");
  await writeJson(manifestPath, {
    schema_version: { major: 1 },
    manifest_id: "roomescape-cancel-booking-penalty",
    name: "Roomescape cancellation deadline",
    policy_id: "roomescape-cancel-booking-penalty",
    executor_kinds: ["deterministic", "codex"],
    input_schema_ref: "deterministic-executor-input/v1",
    policy_rules: { cancellation_deadline_minutes: 30 },
  });
  await writeJson(inputPath, { changes: [candidate(targetPath, candidateSource)] });
  const stateDir = join(projectRoot, ".harness");
  const before = await createProjectSnapshot(projectRoot);

  const completed = await runDeterministicHarness({
    runId: "roomescape-run-1",
    runSpec: {
      schema_version: { major: 1 },
      project_path: projectRoot,
      state_dir: stateDir,
      skill_manifest_path: manifestPath,
      input_path: inputPath,
      executor_kind: "deterministic",
    },
    issuedAt,
    recordedAt,
  });

  assert.equal(completed.state.lifecycle_state, "receipted");
  assert.equal(completed.evidence.verification.adapter_id, "spring-verifier");
  assert.equal(completed.evidence.verification.status, "passed");
  assert.deepEqual(completed.evidence.result.changes.map((item) => item.path), [targetPath]);
  assert.equal((await createProjectSnapshot(projectRoot)).sha256, before.sha256);
  assert.equal(await readFile(join(projectRoot, targetPath), "utf8"), baselineSource);
  assert.equal(await readFile(join(completed.workspace_root, targetPath), "utf8"), candidateSource);
});
