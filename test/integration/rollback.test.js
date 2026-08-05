import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  applyEvidenceBundle,
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

async function fixture(changes) {
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-rollback-project-"));
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
  });
  await writeRunState(stateDir, {
    ...baseState,
    receipt_sha256: bundle.receipt_sha256,
  });
  return { projectRoot, stateDir, receiptSha256: bundle.receipt_sha256 };
}

test("verifier false rolls back originals and marks run rolled_back", async () => {
  const setup = await fixture([candidateChange("src/one.txt", "candidate")]);

  await assert.rejects(
    () =>
      applyEvidenceBundle({
        projectRoot: setup.projectRoot,
        stateDir: setup.stateDir,
        runId: "run-1",
        approvalSha256: setup.receiptSha256,
        verifier: () => false,
      }),
    (error) => error.code === "verification_failed" && error.exitCode === 5,
  );

  assert.equal(await readFile(join(setup.projectRoot, "src", "one.txt"), "utf8"), "one");
  const { state } = await readRunState(setup.stateDir, "run-1");
  assert.equal(state.lifecycle_state, "rolled_back");
});

test("rollback restores original target mode", async () => {
  const setup = await fixture([candidateChange("src/one.txt", "candidate")]);
  await chmod(join(setup.projectRoot, "src", "one.txt"), 0o755);

  await assert.rejects(
    () =>
      applyEvidenceBundle({
        projectRoot: setup.projectRoot,
        stateDir: setup.stateDir,
        runId: "run-1",
        approvalSha256: setup.receiptSha256,
        verifier: () => false,
      }),
    (error) => error.code === "verification_failed" && error.exitCode === 5,
  );

  assert.equal((await stat(join(setup.projectRoot, "src", "one.txt"))).mode & 0o777, 0o755);
});

test("verifier throw rolls back originals and marks run rolled_back", async () => {
  const setup = await fixture([candidateChange("src/one.txt", "candidate")]);

  await assert.rejects(
    () =>
      applyEvidenceBundle({
        projectRoot: setup.projectRoot,
        stateDir: setup.stateDir,
        runId: "run-1",
        approvalSha256: setup.receiptSha256,
        verifier: () => {
          throw new Error("boom");
        },
      }),
    (error) => error.code === "verification_failed" && error.exitCode === 5,
  );

  assert.equal(await readFile(join(setup.projectRoot, "src", "one.txt"), "utf8"), "one");
  const { state } = await readRunState(setup.stateDir, "run-1");
  assert.equal(state.lifecycle_state, "rolled_back");
});

test("verifier source drift stays isolated and rolls back the candidate", async () => {
  const setup = await fixture([candidateChange("src/one.txt", "candidate")]);
  let verifierRoot;

  await assert.rejects(
    () =>
      applyEvidenceBundle({
        projectRoot: setup.projectRoot,
        stateDir: setup.stateDir,
        runId: "run-1",
        approvalSha256: setup.receiptSha256,
        verifier: async ({ projectRoot }) => {
          verifierRoot = projectRoot;
          assert.notEqual(projectRoot, setup.projectRoot);
          await writeFile(join(projectRoot, "src", "two.txt"), "verifier drift");
          return true;
        },
      }),
    (error) =>
      error.code === "verification_failed" &&
      error.exitCode === 5 &&
      /mutated or invalidated/u.test(error.message),
  );

  assert.equal(await readFile(join(setup.projectRoot, "src", "one.txt"), "utf8"), "one");
  assert.equal(await readFile(join(setup.projectRoot, "src", "two.txt"), "utf8"), "two");
  await assert.rejects(
    () => stat(verifierRoot),
    (error) => error.code === "ENOENT",
  );
  const { state } = await readRunState(setup.stateDir, "run-1");
  assert.equal(state.lifecycle_state, "rolled_back");
});

test("multi-file apply leaves no partial candidate bytes after verifier failure", async () => {
  const setup = await fixture([
    candidateChange("src/one.txt", "candidate-one"),
    candidateChange("src/two.txt", "candidate-two"),
  ]);

  await assert.rejects(
    () =>
      applyEvidenceBundle({
        projectRoot: setup.projectRoot,
        stateDir: setup.stateDir,
        runId: "run-1",
        approvalSha256: setup.receiptSha256,
        verifier: () => false,
      }),
    (error) => error.code === "verification_failed" && error.exitCode === 5,
  );

  assert.equal(await readFile(join(setup.projectRoot, "src", "one.txt"), "utf8"), "one");
  assert.equal(await readFile(join(setup.projectRoot, "src", "two.txt"), "utf8"), "two");
});

test("rollback removes newly-created files after verifier failure", async () => {
  const setup = await fixture([candidateChange("src/new.txt", "candidate-new")]);

  await assert.rejects(
    () =>
      applyEvidenceBundle({
        projectRoot: setup.projectRoot,
        stateDir: setup.stateDir,
        runId: "run-1",
        approvalSha256: setup.receiptSha256,
        verifier: () => false,
      }),
    (error) => error.code === "verification_failed" && error.exitCode === 5,
  );

  await assert.rejects(
    () => stat(join(setup.projectRoot, "src", "new.txt")),
    (error) => error.code === "ENOENT",
  );
});
