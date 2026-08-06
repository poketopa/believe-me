import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createTerminalAdaptiveSession } from "./helpers/adaptive-session-fixture.js";

function run(command, args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      ...options,
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

function parseSuccessfulJsonl(result, command) {
  assert.equal(result.signal, null);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.endsWith("\n"), true);
  assert.equal(result.stdout.slice(0, -1).includes("\n"), false);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.command, command);
  assert.equal(payload.status, "ok");
  return payload.data;
}

function candidate(path, content) {
  const bytes = Buffer.from(content, "utf8");
  return {
    path,
    content_base64: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

test("npm tarball installs with a working executable", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "vah-package-"));
  const installRoot = await mkdtemp(join(tmpdir(), "vah-install-"));
  await writeFile(join(installRoot, "package.json"), `${JSON.stringify({
    name: "believe-me-install-smoke",
    private: true,
    version: "0.0.0",
  })}\n`);

  const packed = await run(
    "npm",
    ["pack", "--json", "--pack-destination", packageRoot],
    { cwd: process.cwd(), env: process.env },
  );
  assert.equal(packed.signal, null);
  assert.equal(packed.code, 0, packed.stderr);
  const [{ filename }] = JSON.parse(packed.stdout);
  const tarball = resolve(packageRoot, filename);

  const installed = await run(
    "npm",
    ["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: installRoot, env: process.env },
  );
  assert.equal(installed.signal, null);
  assert.equal(installed.code, 0, installed.stderr);

  const executable = join(
    installRoot,
    "node_modules",
    ".bin",
    "believeme",
  );
  await mkdir(join(installRoot, "project"));
  const version = await run(executable, ["--version"], {
    cwd: join(installRoot, "project"),
    env: process.env,
  });
  assert.equal(version.signal, null);
  assert.equal(version.code, 0, version.stderr);
  assert.equal(version.stderr, "");
  assert.equal(version.stdout, "0.2.0\n");
  const help = await run(executable, ["--help"], {
    cwd: join(installRoot, "project"),
    env: process.env,
  });
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /believeme export-bundle/);
  assert.match(help.stdout, /believeme verify-bundle/);
  assert.match(help.stdout, /believeme status-session/);
  assert.match(help.stdout, /believeme review-session/);

  const installedProject = join(installRoot, "project");
  const installedState = join(installedProject, ".harness");
  const sessionId = "installed-session-read";
  const completedSession = await createTerminalAdaptiveSession(
    installedState,
    sessionId,
  );
  const statusSession = parseSuccessfulJsonl(await run(executable, [
    "status-session",
    sessionId,
    "--project",
    installedProject,
  ], { cwd: installRoot, env: process.env }), "status-session");
  assert.equal(statusSession.session_status, "completed");
  assert.equal(
    statusSession.session_receipt_sha256,
    completedSession.session_receipt_sha256,
  );
  const reviewSession = parseSuccessfulJsonl(await run(executable, [
    "review-session",
    sessionId,
    "--project",
    installedProject,
  ], { cwd: installRoot, env: process.env }), "review-session");
  assert.equal(reviewSession.review_status, "adaptive_session_verified");
  assert.equal(reviewSession.terminal_reason, "terminal_failure");
  assert.equal(reviewSession.winner, null);

  const benchmarkApi = await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { summarizeBenchmarkPairs, runPairedBenchmark, validateExecutionPolicy, validateAdaptiveSession, summarizeComparisonV2Pairs, buildContextPack, validateContextPack, selectExecutionRoute, runOneAttemptRoutedHarness, runAdaptiveSession, resumeAdaptiveSession, validateMutationRegistry, runVerifierMutationCalibration, summarizeMutationCalibration, buildMutationCalibrationLedger } from '@poketopa/believe-me'; console.log(typeof summarizeBenchmarkPairs, typeof runPairedBenchmark, typeof validateExecutionPolicy, typeof validateAdaptiveSession, typeof summarizeComparisonV2Pairs, typeof buildContextPack, typeof validateContextPack, typeof selectExecutionRoute, typeof runOneAttemptRoutedHarness, typeof runAdaptiveSession, typeof resumeAdaptiveSession, typeof validateMutationRegistry, typeof runVerifierMutationCalibration, typeof summarizeMutationCalibration, typeof buildMutationCalibrationLedger);",
    ],
    { cwd: installRoot, env: process.env },
  );
  assert.equal(benchmarkApi.signal, null);
  assert.equal(benchmarkApi.code, 0, benchmarkApi.stderr);
  assert.equal(benchmarkApi.stderr, "");
  assert.equal(
    benchmarkApi.stdout,
    "function function function function function function function function function function function function function function function\n",
  );
  const internalBoundary = await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import * as api from '@poketopa/believe-me'; console.log(Object.hasOwn(api, 'buildPortableEvidenceBundle'), Object.hasOwn(api, 'readPortableEvidenceBundle'), Object.hasOwn(api, 'validateAdaptiveSessionLaunch'), Object.hasOwn(api, 'readAdaptiveSessionLaunch'), Object.hasOwn(api, 'createAdaptiveCodexRegistry'));",
    ],
    { cwd: installRoot, env: process.env },
  );
  assert.equal(internalBoundary.code, 0, internalBoundary.stderr);
  assert.equal(internalBoundary.stdout, "false false false false false\n");

  const fixtureRoot = resolve("test/fixtures/node-reservation-policy");
  const projectRoot = join(installRoot, "node-reservation-policy");
  const controlRoot = await mkdtemp(join(tmpdir(), "vah-install-control-"));
  await cp(fixtureRoot, projectRoot, { recursive: true, force: true });
  const targetPath = "src/reservation-policy.js";
  const candidateSource = await readFile(join(projectRoot, targetPath), "utf8");
  const baselineSource = candidateSource.replace(
    "remainingSeats >= requestedSeats",
    "remainingSeats > requestedSeats",
  );
  assert.notEqual(baselineSource, candidateSource);
  await writeFile(join(projectRoot, targetPath), baselineSource);

  const manifestPath = join(controlRoot, "skill-manifest.json");
  const inputPath = join(controlRoot, "input.json");
  await writeFile(manifestPath, `${JSON.stringify({
    schema_version: { major: 1 },
    manifest_id: "node-reservation-capacity",
    name: "Node reservation capacity",
    policy_id: "reservation-capacity-boundary",
    executor_kinds: ["deterministic"],
    input_schema_ref: "deterministic-executor-input/v1",
    policy_rules: { exact_remaining_capacity_is_admitted: true },
    verifier: {
      schema_version: { major: 1 },
      adapter_id: "command-verifier",
      command: "node",
      args: ["--test"],
      timeout_ms: 30_000,
      max_output_bytes: 1_048_576,
    },
  }, null, 2)}\n`);
  await writeFile(inputPath, `${JSON.stringify({
    changes: [candidate(targetPath, candidateSource)],
  }, null, 2)}\n`);

  parseSuccessfulJsonl(await run(executable, [
    "init",
    "--project",
    projectRoot,
  ], { cwd: installRoot, env: process.env }), "init");
  const completed = parseSuccessfulJsonl(await run(executable, [
    "run",
    "--project",
    projectRoot,
    "--skill",
    manifestPath,
    "--executor",
    "deterministic",
    "--input",
    inputPath,
  ], { cwd: installRoot, env: process.env }), "run");
  assert.equal(completed.lifecycle_state, "receipted");
  assert.equal(await readFile(join(projectRoot, targetPath), "utf8"), baselineSource);

  const portableRoot = await realpath(controlRoot);
  const bundlePath = join(portableRoot, "installed-run.jsonl");
  const exported = parseSuccessfulJsonl(await run(executable, [
    "export-bundle",
    completed.run_id,
    "--output",
    bundlePath,
    "--project",
    projectRoot,
  ], { cwd: installRoot, env: process.env }), "export-bundle");
  assert.equal(exported.receipt_sha256, completed.receipt_sha256);
  const portable = parseSuccessfulJsonl(await run(executable, [
    "verify-bundle",
    "--bundle",
    "installed-run.jsonl",
  ], { cwd: portableRoot, env: process.env }), "verify-bundle");
  assert.equal(portable.verification_status, "portable_evidence_verified");
  assert.equal(portable.run_id, completed.run_id);

  await writeFile(manifestPath, `${JSON.stringify({
    schema_version: { major: 1 },
    manifest_id: "mutated-live-manifest",
    name: "This live manifest must not affect apply",
    policy_id: "mutated-after-run",
    executor_kinds: ["deterministic"],
    input_schema_ref: "deterministic-executor-input/v1",
    policy_rules: {},
    verifier: {
      schema_version: { major: 1 },
      adapter_id: "command-verifier",
      command: "node",
      args: ["--eval", "process.exit(9)"],
      timeout_ms: 30_000,
      max_output_bytes: 1_048_576,
    },
  }, null, 2)}\n`);

  const applied = parseSuccessfulJsonl(await run(executable, [
    "apply",
    completed.run_id,
    "--approve",
    completed.receipt_sha256,
    "--project",
    projectRoot,
  ], { cwd: installRoot, env: process.env }), "apply");
  assert.equal(applied.lifecycle_state, "applied");
  assert.deepEqual(applied.changed_paths, [targetPath]);
  assert.equal(await readFile(join(projectRoot, targetPath), "utf8"), candidateSource);
});
