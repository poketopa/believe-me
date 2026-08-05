import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { sha256Hex } from "../../src/core/hash.js";

const cliPath = resolve("bin/believeme.js");

async function runCli(args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolveResult({ code, signal, stdout, stderr });
    });
  });
}

function parseOnlyJsonLine(output) {
  assert.equal(output.endsWith("\n"), true);
  assert.equal(output.slice(0, -1).includes("\n"), false);
  return JSON.parse(output);
}

function assertSuccess(result, command) {
  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const payload = parseOnlyJsonLine(result.stdout);
  assert.equal(payload.command, command);
  assert.equal(payload.status, "ok");
  return payload;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function candidate(path, content) {
  const bytes = Buffer.from(content, "utf8");
  return {
    path,
    content_base64: bytes.toString("base64"),
    sha256: sha256Hex(bytes),
  };
}

async function readTextArtifacts(paths) {
  const entries = await Promise.all(
    Object.entries(paths).map(async ([key, path]) => [key, await readFile(path, "utf8")]),
  );
  return Object.fromEntries(entries);
}

test("CLI process runs, receipts, and explicitly applies the Spring proof", async () => {
  const canonicalRoot = resolve(
    "test/fixtures/roomescape-cancel-booking-penalty",
  );
  const projectRoot = await mkdtemp(join(tmpdir(), "vah-cli-roomescape-"));
  const controlRoot = await mkdtemp(join(tmpdir(), "vah-cli-control-"));
  await cp(canonicalRoot, projectRoot, { recursive: true, force: true });

  const targetPath =
    "src/main/java/com/roomescape/booking/application/ReservationService.java";
  const candidateSource = await readFile(join(canonicalRoot, targetPath), "utf8");
  const baselineSource = candidateSource.replace(
    "if (!now.isBefore(deadline))",
    "if (now.isAfter(deadline))",
  );
  assert.notEqual(baselineSource, candidateSource);
  await writeFile(join(projectRoot, targetPath), baselineSource);

  const initialized = assertSuccess(await runCli([
    "init",
    "--project",
    projectRoot,
  ]), "init");
  assert.equal(initialized.data.created, true);
  assert.equal(initialized.data.state_dir, join(projectRoot, ".harness"));

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
  await writeJson(inputPath, {
    changes: [candidate(targetPath, candidateSource)],
  });

  const run = assertSuccess(await runCli([
    "run",
    "--project",
    projectRoot,
    "--skill",
    manifestPath,
    "--executor",
    "deterministic",
    "--input",
    inputPath,
  ]), "run");
  assert.equal(run.data.lifecycle_state, "receipted");
  assert.equal(await readFile(join(projectRoot, targetPath), "utf8"), baselineSource);

  const status = assertSuccess(await runCli([
    "status",
    run.data.run_id,
    "--project",
    projectRoot,
  ]), "status");
  assert.equal(status.data.state.lifecycle_state, "receipted");
  assert.equal(status.data.state.receipt_sha256, run.data.receipt_sha256);

  const receipt = assertSuccess(await runCli([
    "receipt",
    run.data.run_id,
    "--project",
    projectRoot,
  ]), "receipt");
  assert.equal(receipt.data.receipt_sha256, run.data.receipt_sha256);

  const artifactRoot = join(initialized.data.state_dir, "runs", run.data.run_id, "artifacts");
  const beforeReviewArtifacts = await readTextArtifacts({
    state: join(initialized.data.state_dir, "runs", run.data.run_id, "state.jsonl"),
    stateDigest: join(initialized.data.state_dir, "runs", run.data.run_id, "state.sha256"),
    receipt: join(artifactRoot, "receipt.jsonl"),
    receiptDigest: join(artifactRoot, "receipt.sha256"),
    verification: join(artifactRoot, "verification.jsonl"),
    result: join(artifactRoot, "result.jsonl"),
  });
  const review = assertSuccess(await runCli([
    "review",
    run.data.run_id,
    "--project",
    projectRoot,
  ]), "review");
  assert.equal(review.data.review_status, "verified");
  assert.equal(review.data.lifecycle_state, "receipted");
  assert.equal(review.data.approval.receipt_sha256, run.data.receipt_sha256);
  assert.deepEqual(review.data.changes, [{
    path: targetPath,
    sha256: sha256Hex(Buffer.from(candidateSource, "utf8")),
  }]);
  const afterReviewArtifacts = await readTextArtifacts({
    state: join(initialized.data.state_dir, "runs", run.data.run_id, "state.jsonl"),
    stateDigest: join(initialized.data.state_dir, "runs", run.data.run_id, "state.sha256"),
    receipt: join(artifactRoot, "receipt.jsonl"),
    receiptDigest: join(artifactRoot, "receipt.sha256"),
    verification: join(artifactRoot, "verification.jsonl"),
    result: join(artifactRoot, "result.jsonl"),
  });
  assert.deepEqual(afterReviewArtifacts, beforeReviewArtifacts);

  const refused = await runCli([
    "apply",
    run.data.run_id,
    "--approve",
    "0".repeat(64),
    "--project",
    projectRoot,
  ]);
  assert.equal(refused.code, 3);
  assert.equal(refused.stdout, "");
  const refusal = parseOnlyJsonLine(refused.stderr);
  assert.equal(refusal.command, "apply");
  assert.equal(refusal.status, "error");
  assert.equal(refusal.error.code, "safety_refusal");
  assert.equal(await readFile(join(projectRoot, targetPath), "utf8"), baselineSource);

  const applied = assertSuccess(await runCli([
    "apply",
    run.data.run_id,
    "--approve",
    run.data.receipt_sha256,
    "--project",
    projectRoot,
  ]), "apply");
  assert.equal(applied.data.lifecycle_state, "applied");
  assert.deepEqual(applied.data.changed_paths, [targetPath]);
  assert.equal(await readFile(join(projectRoot, targetPath), "utf8"), candidateSource);

  const appliedReview = assertSuccess(await runCli([
    "review",
    run.data.run_id,
    "--project",
    projectRoot,
  ]), "review");
  assert.equal(appliedReview.data.lifecycle_state, "applied");
  assert.equal(appliedReview.data.review_status, "verified");
  assert.deepEqual(appliedReview.data.approval, review.data.approval);
  assert.deepEqual(appliedReview.data.bindings, review.data.bindings);
});
