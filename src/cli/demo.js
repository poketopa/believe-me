import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TARGET_PATH = "src/reservation-policy.js";
const BASELINE_SOURCE = `export function canReserve(remainingSeats, requestedSeats) {
  return Number.isInteger(remainingSeats) &&
    Number.isInteger(requestedSeats) &&
    requestedSeats > 0 &&
    remainingSeats > requestedSeats;
}
`;
const CANDIDATE_SOURCE = BASELINE_SOURCE.replace(
  "remainingSeats > requestedSeats",
  "remainingSeats >= requestedSeats",
);
const TEST_SOURCE = `import assert from "node:assert/strict";
import test from "node:test";
import { canReserve } from "../src/reservation-policy.js";

test("reservation admits the exact remaining capacity boundary", () => {
  assert.equal(canReserve(2, 2), true);
});

test("reservation refuses invalid requests", () => {
  assert.equal(canReserve(2, 3), false);
  assert.equal(canReserve(2, 0), false);
});
`;

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function createDemoFiles(root) {
  const projectRoot = join(root, "project");
  const controlRoot = join(root, "control");
  await Promise.all([
    mkdir(join(projectRoot, "src"), { recursive: true, mode: 0o700 }),
    mkdir(join(projectRoot, "test"), { recursive: true, mode: 0o700 }),
    mkdir(controlRoot, { recursive: true, mode: 0o700 }),
  ]);

  await Promise.all([
    writeJson(join(projectRoot, "package.json"), {
      name: "believeme-disposable-demo",
      private: true,
      version: "0.0.0",
      type: "module",
    }),
    writeFile(join(projectRoot, TARGET_PATH), BASELINE_SOURCE, "utf8"),
    writeFile(join(projectRoot, "test/reservation-policy.test.js"), TEST_SOURCE, "utf8"),
  ]);

  const manifestPath = join(controlRoot, "skill-manifest.json");
  const inputPath = join(controlRoot, "candidate-changes.json");
  const candidateBytes = Buffer.from(CANDIDATE_SOURCE, "utf8");
  await Promise.all([
    writeJson(manifestPath, {
      schema_version: { major: 1 },
      manifest_id: "believeme-disposable-demo",
      name: "Reservation capacity boundary demo",
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
    }),
    writeJson(inputPath, {
      changes: [{
        path: TARGET_PATH,
        content_base64: candidateBytes.toString("base64"),
        sha256: sha256Hex(candidateBytes),
      }],
    }),
  ]);

  return { projectRoot, controlRoot, manifestPath, inputPath };
}

export async function runDisposableDemo({ executeCommand }) {
  if (typeof executeCommand !== "function") {
    throw new TypeError("executeCommand must be a function.");
  }

  const root = await realpath(await mkdtemp(join(tmpdir(), "believeme-demo-")));
  let summary;
  try {
    const { projectRoot, controlRoot, manifestPath, inputPath } =
      await createDemoFiles(root);
    const cwd = root;

    await executeCommand({ command: "init", project: projectRoot }, { cwd });
    const run = await executeCommand({
      command: "run",
      project: projectRoot,
      skill: manifestPath,
      executor: "deterministic",
      input: inputPath,
    }, { cwd });
    const receipt = await executeCommand({
      command: "receipt",
      runId: run.run_id,
      project: projectRoot,
    }, { cwd });
    const review = await executeCommand({
      command: "review",
      runId: run.run_id,
      project: projectRoot,
    }, { cwd });
    const bundlePath = join(controlRoot, "run-evidence.jsonl");
    const exported = await executeCommand({
      command: "export-bundle",
      runId: run.run_id,
      output: bundlePath,
      project: projectRoot,
    }, { cwd });
    const verified = await executeCommand({
      command: "verify-bundle",
      bundle: bundlePath,
    }, { cwd });
    const applied = await executeCommand({
      command: "apply",
      runId: run.run_id,
      approve: receipt.receipt_sha256,
      project: projectRoot,
    }, { cwd });

    const appliedSource = await readFile(join(projectRoot, TARGET_PATH), "utf8");
    if (appliedSource !== CANDIDATE_SOURCE) {
      throw new Error("Disposable demo applied unexpected source bytes.");
    }

    summary = {
      demo_status: "completed",
      project_scope: "disposable_temp_directory",
      provider_credentials_used: false,
      network_required: false,
      receipt_sha256: receipt.receipt_sha256,
      bundle_sha256: exported.bundle_sha256,
      stages: [
        { stage: "receipt", lifecycle_state: run.lifecycle_state },
        { stage: "review", review_status: review.review_status },
        {
          stage: "export_verify",
          verification_status: verified.verification_status,
        },
        {
          stage: "approve_apply",
          approval_scope: "disposable_demo_project",
          lifecycle_state: applied.lifecycle_state,
        },
      ],
      changed_paths: applied.changed_paths,
      claim_boundary: "Demonstrates the trust lifecycle; does not measure efficacy.",
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  return Object.freeze({ ...summary, cleanup_status: "removed" });
}
