import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
  chmod,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  applyEvidenceBundle,
  canonicalJSONLine,
  createProjectSnapshot,
  readRunState,
  sha256Hex,
  writeEvidenceBundle,
  writeRunState,
} from "../../src/index.js";

const hash = "a".repeat(64);

function candidateChange(path, content) {
  const bytes = Buffer.from(content, "utf8");
  return {
    path,
    content_base64: bytes.toString("base64"),
    sha256: sha256Hex(bytes),
  };
}

async function writeStaleLockAndJournal(setup, journal) {
  const runDir = join(setup.stateDir, "runs", "run-1");
  const lock = {
    schema_version: { major: 1 },
    operation: "apply",
    run_id: "run-1",
    pid: 999999,
    owner_token: "stale-owner",
    created_at: "2000-01-01T00:00:00.000Z",
  };
  await writeFile(join(runDir, "apply.lock.jsonl"), canonicalJSONLine(lock), {
    mode: 0o600,
  });
  const journalLine = canonicalJSONLine(journal);
  await writeFile(join(runDir, "apply-journal.jsonl"), journalLine, {
    mode: 0o600,
  });
  await writeFile(
    join(runDir, "apply-journal.sha256"),
    `${sha256Hex(Buffer.from(journalLine, "utf8"))}\n`,
    { mode: 0o600 },
  );
}

async function writeRecoveryLock(
  setup,
  { pid = process.pid, createdAt = new Date().toISOString() } = {},
) {
  const runDir = join(setup.stateDir, "runs", "run-1");
  await writeFile(
    join(runDir, "apply.recovery.lock.jsonl"),
    canonicalJSONLine({
      schema_version: { major: 1 },
      operation: "apply_recovery",
      run_id: "run-1",
      pid,
      owner_token: "recovery-owner",
      created_at: createdAt,
    }),
    { mode: 0o600 },
  );
}

async function journalFor(setup, candidate, originalContent = "one") {
  const originalBytes = Buffer.from(originalContent, "utf8");
  const originalStat = await stat(join(setup.projectRoot, candidate.path));
  return {
    schema_version: { major: 1 },
    operation: "apply",
    run_id: "run-1",
    project_path: setup.projectRoot,
    receipt_sha256: setup.receiptSha256,
    targets: [candidate.path],
    candidates: [{ path: candidate.path, sha256: candidate.sha256 }],
    originals: [
      {
        path: candidate.path,
        existed: true,
        mode: 0o644,
        dev: originalStat.dev,
        ino: originalStat.ino,
        sha256: sha256Hex(originalBytes),
        content_base64: originalBytes.toString("base64"),
      },
    ],
  };
}

async function fixture(changes) {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-apply-project-"));
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await writeFile(join(projectRoot, "src", "one.txt"), "one");
  await writeFile(join(projectRoot, "src", "two.txt"), "two");
  const stateDir = join(projectRoot, ".harness");
  const artifactRoot = join(stateDir, "runs", "run-1", "artifacts");
  const snapshot = await createProjectSnapshot(projectRoot);
  const baseState = {
    schema_version: { major: 1 },
    run_id: "run-1",
    lifecycle_state: "receipted",
    manifest_sha256: hash,
    workflow_plan_sha256: hash,
    source_snapshot_sha256: snapshot.sha256,
    executor_kind: "deterministic",
    artifact_root: artifactRoot,
  };
  const bundle = await writeEvidenceBundle({
    artifactRoot,
    runState: baseState,
    verification: { schema_version: { major: 1 }, ok: true },
    result: { schema_version: { major: 1 }, changes },
    issuedAt: "2026-08-05T00:00:00.000Z",
  });
  await writeRunState(stateDir, {
    ...baseState,
    receipt_sha256: bundle.receipt_sha256,
  });
  return { projectRoot, stateDir, artifactRoot, receiptSha256: bundle.receipt_sha256 };
}

test("apply verifies approval, source snapshot, candidate hashes, and advances lifecycle", async () => {
  const setup = await fixture([candidateChange("src/one.txt", "candidate")]);

  const result = await applyEvidenceBundle({
    projectRoot: setup.projectRoot,
    stateDir: setup.stateDir,
    runId: "run-1",
    approvalSha256: setup.receiptSha256,
    verifier: () => true,
  });

  assert.deepEqual(result.changed_paths, ["src/one.txt"]);
  assert.equal(await readFile(join(setup.projectRoot, "src", "one.txt"), "utf8"), "candidate");
  const { state } = await readRunState(setup.stateDir, "run-1");
  assert.equal(state.lifecycle_state, "applied");
});

test("apply accepts canonical empty base64 and verifies empty-file digest", async () => {
  const setup = await fixture([candidateChange("src/one.txt", "")]);

  await applyEvidenceBundle({
    projectRoot: setup.projectRoot,
    stateDir: setup.stateDir,
    runId: "run-1",
    approvalSha256: setup.receiptSha256,
    verifier: () => true,
  });

  const bytes = await readFile(join(setup.projectRoot, "src", "one.txt"));
  assert.equal(bytes.byteLength, 0);
  assert.equal(sha256Hex(bytes), candidateChange("src/one.txt", "").sha256);
});

test("successful apply preserves existing target mode", async () => {
  const setup = await fixture([candidateChange("src/one.txt", "candidate")]);
  await chmod(join(setup.projectRoot, "src", "one.txt"), 0o755);

  await applyEvidenceBundle({
    projectRoot: setup.projectRoot,
    stateDir: setup.stateDir,
    runId: "run-1",
    approvalSha256: setup.receiptSha256,
    verifier: () => true,
  });

  assert.equal((await stat(join(setup.projectRoot, "src", "one.txt"))).mode & 0o777, 0o755);
});

test("successful apply creates new files with mode 0644", async () => {
  const setup = await fixture([candidateChange("src/new.txt", "candidate")]);

  await applyEvidenceBundle({
    projectRoot: setup.projectRoot,
    stateDir: setup.stateDir,
    runId: "run-1",
    approvalSha256: setup.receiptSha256,
    verifier: () => true,
  });

  assert.equal((await stat(join(setup.projectRoot, "src", "new.txt"))).mode & 0o777, 0o644);
});

test("apply refuses missing or wrong approval before mutation", async () => {
  const setup = await fixture([candidateChange("src/one.txt", "candidate")]);

  await assert.rejects(
    () =>
      applyEvidenceBundle({
        projectRoot: setup.projectRoot,
        stateDir: setup.stateDir,
        runId: "run-1",
        approvalSha256: "b".repeat(64),
        verifier: () => true,
      }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
  assert.equal(await readFile(join(setup.projectRoot, "src", "one.txt"), "utf8"), "one");
});

test("apply refuses stale source before mutation", async () => {
  const setup = await fixture([candidateChange("src/one.txt", "candidate")]);
  await writeFile(join(setup.projectRoot, "src", "two.txt"), "stale");

  await assert.rejects(
    () =>
      applyEvidenceBundle({
        projectRoot: setup.projectRoot,
        stateDir: setup.stateDir,
        runId: "run-1",
        approvalSha256: setup.receiptSha256,
        verifier: () => true,
      }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
  assert.equal(await readFile(join(setup.projectRoot, "src", "one.txt"), "utf8"), "one");
});

test("apply refuses path escape and symlink targets", async () => {
  const escape = await fixture([candidateChange("../escape.txt", "candidate")]);
  await assert.rejects(
    () =>
      applyEvidenceBundle({
        projectRoot: escape.projectRoot,
        stateDir: escape.stateDir,
        runId: "run-1",
        approvalSha256: escape.receiptSha256,
        verifier: () => true,
      }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );

  const symlinkCase = await fixture([candidateChange("src/link.txt", "candidate")]);
  await writeFile(join(symlinkCase.projectRoot, "src", "target.txt"), "target");
  await symlink(
    join(symlinkCase.projectRoot, "src", "target.txt"),
    join(symlinkCase.projectRoot, "src", "link.txt"),
  );
  await assert.rejects(
    () =>
      applyEvidenceBundle({
        projectRoot: symlinkCase.projectRoot,
        stateDir: symlinkCase.stateDir,
        runId: "run-1",
        approvalSha256: symlinkCase.receiptSha256,
        verifier: () => true,
      }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
});

test("apply refuses external artifact_root and symlinked artifact root", async () => {
  const external = await mkdtemp(join(tmpdir(), "vah-external-artifacts-"));
  const externalCase = await fixture([candidateChange("src/one.txt", "candidate")]);
  await writeRunState(externalCase.stateDir, {
    schema_version: { major: 1 },
    run_id: "run-1",
    lifecycle_state: "receipted",
    manifest_sha256: hash,
    workflow_plan_sha256: hash,
    source_snapshot_sha256: (await createProjectSnapshot(externalCase.projectRoot)).sha256,
    executor_kind: "deterministic",
    artifact_root: external,
    receipt_sha256: externalCase.receiptSha256,
  });

  await assert.rejects(
    () =>
      applyEvidenceBundle({
        projectRoot: externalCase.projectRoot,
        stateDir: externalCase.stateDir,
        runId: "run-1",
        approvalSha256: externalCase.receiptSha256,
        verifier: () => true,
      }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );

  const symlinkCase = await fixture([candidateChange("src/one.txt", "candidate")]);
  const realArtifacts = await mkdtemp(join(tmpdir(), "vah-real-artifacts-"));
  await rm(symlinkCase.artifactRoot, { recursive: true, force: true });
  await symlink(realArtifacts, symlinkCase.artifactRoot);

  await assert.rejects(
    () =>
      applyEvidenceBundle({
        projectRoot: symlinkCase.projectRoot,
        stateDir: symlinkCase.stateDir,
        runId: "run-1",
        approvalSha256: symlinkCase.receiptSha256,
        verifier: () => true,
      }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
});

test("apply refuses symlink stateDir root", async () => {
  const setup = await fixture([candidateChange("src/one.txt", "candidate")]);
  const symlinkStateDir = join(setup.projectRoot, "state-link");
  await symlink(setup.stateDir, symlinkStateDir);

  await assert.rejects(
    () =>
      applyEvidenceBundle({
        projectRoot: setup.projectRoot,
        stateDir: symlinkStateDir,
        runId: "run-1",
        approvalSha256: setup.receiptSha256,
        verifier: () => true,
      }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
});

test("concurrent applies cannot leave state and disk in disagreement", async () => {
  const setup = await fixture([candidateChange("src/one.txt", "candidate")]);
  let releaseFirst;
  const firstMutation = new Promise((resolveMutation) => {
    releaseFirst = resolveMutation;
  });
  let sawFirstMutation;
  const firstSawMutation = new Promise((resolveMutation) => {
    sawFirstMutation = resolveMutation;
  });

  const first = applyEvidenceBundle({
    projectRoot: setup.projectRoot,
    stateDir: setup.stateDir,
    runId: "run-1",
    approvalSha256: setup.receiptSha256,
    verifier: () => true,
    onAfterMutation: async () => {
      sawFirstMutation();
      await firstMutation;
    },
  });
  await firstSawMutation;

  const second = applyEvidenceBundle({
    projectRoot: setup.projectRoot,
    stateDir: setup.stateDir,
    runId: "run-1",
    approvalSha256: setup.receiptSha256,
    verifier: () => true,
  });
  releaseFirst();
  const outcomes = await Promise.allSettled([first, second]);

  assert.equal(outcomes.some((outcome) => outcome.status === "fulfilled"), true);
  assert.equal(
    outcomes.some(
      (outcome) =>
        outcome.status === "rejected" &&
        outcome.reason.code === "safety_refusal" &&
        outcome.reason.exitCode === 3,
    ),
    true,
  );
  const { state } = await readRunState(setup.stateDir, "run-1");
  assert.equal(state.lifecycle_state, "applied");
  assert.equal(await readFile(join(setup.projectRoot, "src", "one.txt"), "utf8"), "candidate");
});

test("apply release refuses owner token mismatch and preserves lock evidence", async () => {
  const setup = await fixture([candidateChange("src/one.txt", "candidate")]);
  const lockPath = join(setup.stateDir, "runs", "run-1", "apply.lock.jsonl");

  await assert.rejects(
    () =>
      applyEvidenceBundle({
        projectRoot: setup.projectRoot,
        stateDir: setup.stateDir,
        runId: "run-1",
        approvalSha256: setup.receiptSha256,
        verifier: () => true,
        onAfterMutation: async () => {
          const current = JSON.parse(await readFile(lockPath, "utf8"));
          await writeFile(
            lockPath,
            canonicalJSONLine({ ...current, owner_token: "foreign-owner" }),
            { mode: 0o600 },
          );
        },
      }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );

  assert.equal(await readFile(join(setup.projectRoot, "src", "one.txt"), "utf8"), "candidate");
  const { state } = await readRunState(setup.stateDir, "run-1");
  assert.equal(state.lifecycle_state, "applied");
  const preserved = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(preserved.owner_token, "foreign-owner");
});

test("stale lock recovery restores after child crash following first mutation", async () => {
  const setup = await fixture([
    candidateChange("src/one.txt", "candidate-one"),
    candidateChange("src/two.txt", "candidate-two"),
  ]);
  const script = `
    import { applyEvidenceBundle } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "src/index.js")).href)};
    await applyEvidenceBundle({
      projectRoot: ${JSON.stringify(setup.projectRoot)},
      stateDir: ${JSON.stringify(setup.stateDir)},
      runId: "run-1",
      approvalSha256: ${JSON.stringify(setup.receiptSha256)},
      verifier: () => true,
      onAfterMutation: ({ mutationIndex }) => {
        if (mutationIndex === 1) process.exit(99);
      },
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    stdio: "ignore",
  });
  const exitCode = await new Promise((resolveExit) => {
    child.on("exit", resolveExit);
  });
  assert.equal(exitCode, 99);
  assert.equal(await readFile(join(setup.projectRoot, "src", "one.txt"), "utf8"), "candidate-one");
  assert.equal(await readFile(join(setup.projectRoot, "src", "two.txt"), "utf8"), "two");

  await assert.rejects(
    () =>
      applyEvidenceBundle({
        projectRoot: setup.projectRoot,
        stateDir: setup.stateDir,
        runId: "run-1",
        approvalSha256: setup.receiptSha256,
        verifier: () => true,
      }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );

  assert.equal(await readFile(join(setup.projectRoot, "src", "one.txt"), "utf8"), "one");
  assert.equal(await readFile(join(setup.projectRoot, "src", "two.txt"), "utf8"), "two");
  const { state } = await readRunState(setup.stateDir, "run-1");
  assert.equal(state.lifecycle_state, "rolled_back");
});

test("applied-state stale recovery refuses candidate mismatch without rewriting disk", async () => {
  const candidate = candidateChange("src/one.txt", "candidate");
  const setup = await fixture([candidate]);
  await writeFile(join(setup.projectRoot, "src", "one.txt"), "manual-change");
  await writeRunState(setup.stateDir, {
    schema_version: { major: 1 },
    run_id: "run-1",
    lifecycle_state: "applied",
    manifest_sha256: hash,
    workflow_plan_sha256: hash,
    source_snapshot_sha256: (await createProjectSnapshot(setup.projectRoot, {
      paths: ["src/two.txt"],
    })).sha256,
    executor_kind: "deterministic",
    artifact_root: setup.artifactRoot,
    receipt_sha256: setup.receiptSha256,
    approval_sha256: setup.receiptSha256,
  });
  await writeStaleLockAndJournal(setup, await journalFor(setup, candidate));

  await assert.rejects(
    () =>
      applyEvidenceBundle({
        projectRoot: setup.projectRoot,
        stateDir: setup.stateDir,
        runId: "run-1",
        approvalSha256: setup.receiptSha256,
        verifier: () => true,
      }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );

  assert.equal(await readFile(join(setup.projectRoot, "src", "one.txt"), "utf8"), "manual-change");
  const { state } = await readRunState(setup.stateDir, "run-1");
  assert.equal(state.lifecycle_state, "applied");
  assert.equal((await stat(join(setup.stateDir, "runs", "run-1", "apply.lock.jsonl"))).isFile(), true);
  assert.equal((await stat(join(setup.stateDir, "runs", "run-1", "apply-journal.jsonl"))).isFile(), true);
});

test("applied-state stale recovery with matching candidates cleans artifacts idempotently", async () => {
  const candidate = candidateChange("src/one.txt", "candidate");
  const setup = await fixture([candidate]);
  await writeFile(join(setup.projectRoot, "src", "one.txt"), "candidate");
  await writeRunState(setup.stateDir, {
    schema_version: { major: 1 },
    run_id: "run-1",
    lifecycle_state: "applied",
    manifest_sha256: hash,
    workflow_plan_sha256: hash,
    source_snapshot_sha256: (await createProjectSnapshot(setup.projectRoot, {
      paths: ["src/two.txt"],
    })).sha256,
    executor_kind: "deterministic",
    artifact_root: setup.artifactRoot,
    receipt_sha256: setup.receiptSha256,
    approval_sha256: setup.receiptSha256,
  });
  await writeStaleLockAndJournal(setup, await journalFor(setup, candidate));

  await assert.rejects(
    () =>
      applyEvidenceBundle({
        projectRoot: setup.projectRoot,
        stateDir: setup.stateDir,
        runId: "run-1",
        approvalSha256: setup.receiptSha256,
        verifier: () => true,
      }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );

  assert.equal(await readFile(join(setup.projectRoot, "src", "one.txt"), "utf8"), "candidate");
  const { state } = await readRunState(setup.stateDir, "run-1");
  assert.equal(state.lifecycle_state, "applied");
  await assert.rejects(
    () => stat(join(setup.stateDir, "runs", "run-1", "apply.lock.jsonl")),
    (error) => error.code === "ENOENT",
  );
  await assert.rejects(
    () => stat(join(setup.stateDir, "runs", "run-1", "apply-journal.jsonl")),
    (error) => error.code === "ENOENT",
  );
});

test("malformed stale journal fails closed without deleting lock or journal", async () => {
  const candidate = candidateChange("src/one.txt", "candidate");
  const setup = await fixture([candidate]);
  await writeRunState(setup.stateDir, {
    schema_version: { major: 1 },
    run_id: "run-1",
    lifecycle_state: "approved",
    manifest_sha256: hash,
    workflow_plan_sha256: hash,
    source_snapshot_sha256: (await createProjectSnapshot(setup.projectRoot)).sha256,
    executor_kind: "deterministic",
    artifact_root: setup.artifactRoot,
    receipt_sha256: setup.receiptSha256,
    approval_sha256: setup.receiptSha256,
  });
  const badJournal = { ...(await journalFor(setup, candidate)), run_id: "wrong-run" };
  await writeStaleLockAndJournal(setup, badJournal);

  await assert.rejects(
    () =>
      applyEvidenceBundle({
        projectRoot: setup.projectRoot,
        stateDir: setup.stateDir,
        runId: "run-1",
        approvalSha256: setup.receiptSha256,
        verifier: () => true,
      }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );

  assert.equal((await stat(join(setup.stateDir, "runs", "run-1", "apply.lock.jsonl"))).isFile(), true);
  assert.equal((await stat(join(setup.stateDir, "runs", "run-1", "apply-journal.jsonl"))).isFile(), true);
});

test("partial mutation with journal body only fails closed and preserves lock and body", async () => {
  const setup = await fixture([
    candidateChange("src/one.txt", "candidate-one"),
    candidateChange("src/two.txt", "candidate-two"),
  ]);
  const childScript = `
    import { applyEvidenceBundle } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "src/index.js")).href)};
    await applyEvidenceBundle({
      projectRoot: ${JSON.stringify(setup.projectRoot)},
      stateDir: ${JSON.stringify(setup.stateDir)},
      runId: "run-1",
      approvalSha256: ${JSON.stringify(setup.receiptSha256)},
      verifier: () => true,
      onAfterMutation: ({ mutationIndex }) => {
        if (mutationIndex === 1) process.exit(98);
      },
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
    cwd: process.cwd(),
    stdio: "ignore",
  });
  assert.equal(await new Promise((resolveExit) => child.on("exit", resolveExit)), 98);
  await rm(join(setup.stateDir, "runs", "run-1", "apply-journal.sha256"));

  await assert.rejects(
    () =>
      applyEvidenceBundle({
        projectRoot: setup.projectRoot,
        stateDir: setup.stateDir,
        runId: "run-1",
        approvalSha256: setup.receiptSha256,
        verifier: () => true,
      }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
  assert.equal(await readFile(join(setup.projectRoot, "src", "one.txt"), "utf8"), "candidate-one");
  assert.equal((await stat(join(setup.stateDir, "runs", "run-1", "apply.lock.jsonl"))).isFile(), true);
  assert.equal((await stat(join(setup.stateDir, "runs", "run-1", "apply-journal.jsonl"))).isFile(), true);
});

test("stale journal duplicate missing or extra path sets fail closed", async () => {
  const candidate = candidateChange("src/one.txt", "candidate");
  for (const mutate of [
    (journal) => ({
      ...journal,
      candidates: [...journal.candidates, journal.candidates[0]],
    }),
    (journal) => ({
      ...journal,
      originals: [],
    }),
    (journal) => ({
      ...journal,
      originals: [
        ...journal.originals,
        { ...journal.originals[0], path: "src/two.txt" },
      ],
      targets: [...journal.targets, "src/two.txt"],
    }),
  ]) {
    const setup = await fixture([candidate]);
    await writeRunState(setup.stateDir, {
      schema_version: { major: 1 },
      run_id: "run-1",
      lifecycle_state: "approved",
      manifest_sha256: hash,
      workflow_plan_sha256: hash,
      source_snapshot_sha256: (await createProjectSnapshot(setup.projectRoot)).sha256,
      executor_kind: "deterministic",
      artifact_root: setup.artifactRoot,
      receipt_sha256: setup.receiptSha256,
      approval_sha256: setup.receiptSha256,
    });
    await writeStaleLockAndJournal(setup, mutate(await journalFor(setup, candidate)));

    await assert.rejects(
      () =>
        applyEvidenceBundle({
          projectRoot: setup.projectRoot,
          stateDir: setup.stateDir,
          runId: "run-1",
          approvalSha256: setup.receiptSha256,
          verifier: () => true,
        }),
      (error) => error.code === "safety_refusal" && error.exitCode === 3,
    );
    assert.equal((await stat(join(setup.stateDir, "runs", "run-1", "apply.lock.jsonl"))).isFile(), true);
    assert.equal((await stat(join(setup.stateDir, "runs", "run-1", "apply-journal.jsonl"))).isFile(), true);
  }
});

test("malformed journal mode fails closed preserving file state and artifacts", async () => {
  const candidate = candidateChange("src/one.txt", "candidate");
  const setup = await fixture([candidate]);
  await writeRunState(setup.stateDir, {
    schema_version: { major: 1 },
    run_id: "run-1",
    lifecycle_state: "approved",
    manifest_sha256: hash,
    workflow_plan_sha256: hash,
    source_snapshot_sha256: (await createProjectSnapshot(setup.projectRoot)).sha256,
    executor_kind: "deterministic",
    artifact_root: setup.artifactRoot,
    receipt_sha256: setup.receiptSha256,
    approval_sha256: setup.receiptSha256,
  });
  const badJournal = await journalFor(setup, candidate);
  badJournal.originals[0].mode = 0o1000;
  await writeStaleLockAndJournal(setup, badJournal);

  await assert.rejects(
    () =>
      applyEvidenceBundle({
        projectRoot: setup.projectRoot,
        stateDir: setup.stateDir,
        runId: "run-1",
        approvalSha256: setup.receiptSha256,
        verifier: () => true,
      }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
  assert.equal(await readFile(join(setup.projectRoot, "src", "one.txt"), "utf8"), "one");
  const { state } = await readRunState(setup.stateDir, "run-1");
  assert.equal(state.lifecycle_state, "approved");
  assert.equal((await stat(join(setup.stateDir, "runs", "run-1", "apply.lock.jsonl"))).isFile(), true);
  assert.equal((await stat(join(setup.stateDir, "runs", "run-1", "apply-journal.jsonl"))).isFile(), true);
});

test("incomplete lock artifact fails closed without mutation", async () => {
  const setup = await fixture([candidateChange("src/one.txt", "candidate")]);
  await writeFile(join(setup.stateDir, "runs", "run-1", "apply.lock.jsonl"), "{");

  await assert.rejects(
    () =>
      applyEvidenceBundle({
        projectRoot: setup.projectRoot,
        stateDir: setup.stateDir,
        runId: "run-1",
        approvalSha256: setup.receiptSha256,
        verifier: () => true,
      }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
  assert.equal(await readFile(join(setup.projectRoot, "src", "one.txt"), "utf8"), "one");
});

test("lock artifact with retired heartbeat metadata fails closed", async () => {
  const setup = await fixture([candidateChange("src/one.txt", "candidate")]);
  await writeFile(
    join(setup.stateDir, "runs", "run-1", "apply.lock.jsonl"),
    canonicalJSONLine({
      schema_version: { major: 1 },
      operation: "apply",
      run_id: "run-1",
      pid: 999999,
      owner_token: "legacy-owner",
      created_at: "2000-01-01T00:00:00.000Z",
      heartbeat_at: "2000-01-01T00:00:00.000Z",
    }),
    { mode: 0o600 },
  );

  await assert.rejects(
    () =>
      applyEvidenceBundle({
        projectRoot: setup.projectRoot,
        stateDir: setup.stateDir,
        runId: "run-1",
        approvalSha256: setup.receiptSha256,
        verifier: () => true,
      }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
  assert.equal(await readFile(join(setup.projectRoot, "src", "one.txt"), "utf8"), "one");
  assert.equal((await stat(join(setup.stateDir, "runs", "run-1", "apply.lock.jsonl"))).isFile(), true);
});

test("fresh recovery lock blocks new apply before mutation", async () => {
  const setup = await fixture([candidateChange("src/one.txt", "candidate")]);
  await writeRecoveryLock(setup);

  await assert.rejects(
    () =>
      applyEvidenceBundle({
        projectRoot: setup.projectRoot,
        stateDir: setup.stateDir,
        runId: "run-1",
        approvalSha256: setup.receiptSha256,
        verifier: () => true,
      }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
  assert.equal(await readFile(join(setup.projectRoot, "src", "one.txt"), "utf8"), "one");
  assert.equal((await stat(join(setup.stateDir, "runs", "run-1", "apply.recovery.lock.jsonl"))).isFile(), true);
});

test("dead recovery lock blocks new apply and is not stolen", async () => {
  const setup = await fixture([candidateChange("src/one.txt", "candidate")]);
  await writeRecoveryLock(setup, {
    pid: 999999,
    createdAt: "2000-01-01T00:00:00.000Z",
  });

  await assert.rejects(
    () =>
      applyEvidenceBundle({
        projectRoot: setup.projectRoot,
        stateDir: setup.stateDir,
        runId: "run-1",
        approvalSha256: setup.receiptSha256,
        verifier: () => true,
      }),
    (error) => error.code === "safety_refusal" && error.exitCode === 3,
  );
  assert.equal(await readFile(join(setup.projectRoot, "src", "one.txt"), "utf8"), "one");
  assert.equal((await stat(join(setup.stateDir, "runs", "run-1", "apply.recovery.lock.jsonl"))).isFile(), true);
});

test("apply rejects removed heartbeat lease options before mutation", async () => {
  for (const unsupportedOption of [
    { staleLockMs: 1 },
    { heartbeatIntervalMs: 1 },
  ]) {
    const setup = await fixture([candidateChange("src/one.txt", "candidate")]);

    await assert.rejects(
      () =>
        applyEvidenceBundle({
          projectRoot: setup.projectRoot,
          stateDir: setup.stateDir,
          runId: "run-1",
          approvalSha256: setup.receiptSha256,
          verifier: () => true,
          ...unsupportedOption,
        }),
      (error) => error.code === "usage_error" && error.exitCode === 2,
    );
    assert.equal(await readFile(join(setup.projectRoot, "src", "one.txt"), "utf8"), "one");
    await assert.rejects(
      () => stat(join(setup.stateDir, "runs", "run-1", "apply.lock.jsonl")),
      (error) => error.code === "ENOENT",
    );
  }
});

test("target content change after original capture fails before candidate rename", async () => {
  const setup = await fixture([candidateChange("src/one.txt", "candidate")]);

  await assert.rejects(
    () =>
      applyEvidenceBundle({
        projectRoot: setup.projectRoot,
        stateDir: setup.stateDir,
        runId: "run-1",
        approvalSha256: setup.receiptSha256,
        verifier: () => true,
        onAfterCapture: async () => {
          await writeFile(join(setup.projectRoot, "src", "one.txt"), "changed");
        },
      }),
    (error) => error.code === "verification_failed" && error.exitCode === 5,
  );
  assert.equal(await readFile(join(setup.projectRoot, "src", "one.txt"), "utf8"), "one");
  const { state } = await readRunState(setup.stateDir, "run-1");
  assert.equal(state.lifecycle_state, "rolled_back");
  await assert.rejects(
    () => stat(join(setup.stateDir, "runs", "run-1", "apply.lock.jsonl")),
    (error) => error.code === "ENOENT",
  );
});
