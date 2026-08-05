import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { buildVerifierMutationCorpus } from "../fixtures/verifier-mutation-corpus.js";
import {
  buildMutationCalibrationLedger,
  parseMutationCalibrationLedger,
  readMutationCalibrationLedger,
  runVerifierMutationCalibration,
  sha256Hex,
  summarizeMutationCalibration,
  validateMutationRegistry,
  writeMutationCalibrationLedger,
} from "../../src/index.js";

const schema_version = { major: 1 };

function definition({
  mutationId,
  taskId,
  fixtureKind,
  targetPath,
  baselineBytes,
  mutatedText,
  family,
  expected = "reject",
  verifier,
  baselineSha256 = sha256Hex(baselineBytes),
}) {
  const mutatedBytes = Buffer.from(mutatedText, "utf8");
  return {
    schema_version,
    mutation_id: mutationId,
    task_id: taskId,
    fixture_kind: fixtureKind,
    target_path: targetPath,
    baseline_sha256: baselineSha256,
    mutated_content_base64: mutatedBytes.toString("base64"),
    mutated_sha256: sha256Hex(mutatedBytes),
    family,
    expected_verifier_outcome: expected,
    verifier,
  };
}

test("bounded mutation calibration retains false accepts and exact corpus diversity", async () => {
  const root = await mkdtemp(join(tmpdir(), "mutation-calibration-"));
  const nodeRoot = join(root, "node-task");
  const springRoot = join(root, "spring-task");
  await mkdir(join(nodeRoot, "src"), { recursive: true });
  await mkdir(join(springRoot, "src"), { recursive: true });
  const nodeBaseline = Buffer.from("export const allowed = true;\n", "utf8");
  const springBaseline = Buffer.from("final class Policy { boolean allowed() { return true; } }\n", "utf8");
  await writeFile(join(nodeRoot, "src/policy.js"), nodeBaseline);
  await writeFile(join(springRoot, "src/Policy.java"), springBaseline);
  const nodeVerifier = {
    adapter_id: "command-verifier",
    command: "node",
    args: ["--test"],
    timeout_ms: 30_000,
    max_output_bytes: 1024,
  };
  const springVerifier = {
    adapter_id: "command-verifier",
    command: "./gradlew",
    args: ["test"],
    timeout_ms: 180_000,
    max_output_bytes: 1024,
  };
  const registry = validateMutationRegistry({
    schema_version,
    corpus_id: "deterministic-node-spring-v1",
    mutations: [
      definition({
        mutationId: "mutation-001-condition",
        taskId: "node-reservation-policy",
        fixtureKind: "node",
        targetPath: "src/policy.js",
        baselineBytes: nodeBaseline,
        mutatedText: "export const allowed = false;\n",
        family: "condition_inversion",
        verifier: nodeVerifier,
      }),
      definition({
        mutationId: "mutation-002-boundary",
        taskId: "node-reservation-policy",
        fixtureKind: "node",
        targetPath: "src/policy.js",
        baselineBytes: nodeBaseline,
        mutatedText: "export const allowed = 1;\n",
        family: "boundary_alteration",
        verifier: nodeVerifier,
      }),
      definition({
        mutationId: "mutation-003-guard",
        taskId: "spring-cancellation-policy",
        fixtureKind: "spring",
        targetPath: "src/Policy.java",
        baselineBytes: springBaseline,
        mutatedText: "final class Policy { boolean allowed() { return false; } }\n",
        family: "guard_or_exception_removal",
        verifier: springVerifier,
      }),
      definition({
        mutationId: "mutation-004-return",
        taskId: "spring-cancellation-policy",
        fixtureKind: "spring",
        targetPath: "src/Policy.java",
        baselineBytes: springBaseline,
        mutatedText: "final class Policy { boolean allowed() { return false; } }\n",
        family: "incorrect_return",
        expected: "undetermined",
        verifier: springVerifier,
      }),
      definition({
        mutationId: "mutation-005-invalid",
        taskId: "node-reservation-policy",
        fixtureKind: "node",
        targetPath: "src/policy.js",
        baselineBytes: nodeBaseline,
        baselineSha256: "f".repeat(64),
        mutatedText: "export const allowed = null;\n",
        family: "incorrect_return",
        verifier: nodeVerifier,
      }),
      definition({
        mutationId: "mutation-006-infra",
        taskId: "spring-cancellation-policy",
        fixtureKind: "spring",
        targetPath: "src/Policy.java",
        baselineBytes: springBaseline,
        mutatedText: "final class Policy { boolean allowed() { throw null; } }\n",
        family: "boundary_alteration",
        verifier: springVerifier,
      }),
    ],
  });
  const verifierCalls = [];
  const run = () => runVerifierMutationCalibration({
    registry,
    fixtureRoots: {
      "node-reservation-policy": nodeRoot,
      "spring-cancellation-policy": springRoot,
    },
    async verifier({ mutation, workspaceRoot }) {
      verifierCalls.push(mutation.mutation_id);
      const bytes = await readFile(join(workspaceRoot, mutation.target_path));
      assert.equal(sha256Hex(bytes), mutation.mutated_sha256);
      if (mutation.mutation_id === "mutation-001-condition") {
        return { status: "failed", code: "assertion_failed" };
      }
      if (mutation.mutation_id === "mutation-002-boundary") {
        return { status: "passed" };
      }
      if (mutation.mutation_id === "mutation-003-guard") {
        throw Object.assign(new Error("mutant rejected"), {
          code: "verification_failed",
          details: { result: { status: "failed" } },
        });
      }
      if (mutation.mutation_id === "mutation-006-infra") {
        throw new Error("verifier unavailable");
      }
      return { status: "passed" };
    },
  });

  const first = await run();
  const second = await run();
  assert.deepEqual(first.observations, second.observations);
  assert.deepEqual(first.summary, second.summary);
  assert.deepEqual(first.summary.outcome_counts, {
    killed: 2,
    survived: 1,
    invalid: 1,
    equivalent_or_undetermined: 1,
    infrastructure: 1,
  });
  assert.equal(first.summary.false_accept_count, 1);
  assert.equal(first.summary.mutation_score, 2 / 3);
  assert.deepEqual(first.summary.corpus_diversity, {
    task_count: 2,
    task_ids: ["node-reservation-policy", "spring-cancellation-policy"],
    fixture_kind_count: 2,
    fixture_kinds: ["node", "spring"],
    verifier_command_count: 2,
    verifier_command_sha256: first.summary.corpus_diversity.verifier_command_sha256,
    claim_scope: "descriptive_corpus_only",
  });
  assert.equal(verifierCalls.includes("mutation-005-invalid"), false);
  assert.deepEqual(await readFile(join(nodeRoot, "src/policy.js")), nodeBaseline);
  assert.deepEqual(await readFile(join(springRoot, "src/Policy.java")), springBaseline);
  const drifted = structuredClone(first.observations);
  drifted[0].registry_sha256 = "0".repeat(64);
  assert.throws(
    () => summarizeMutationCalibration(first.registry, drifted),
    /does not match its registered deterministic mutant/u,
  );

  const built = buildMutationCalibrationLedger({
    registry: first.registry,
    observations: first.observations,
  });
  const replayed = parseMutationCalibrationLedger(built.bytes);
  assert.equal(replayed.sha256, built.sha256);
  assert.deepEqual(replayed.summary, first.summary);
  const ledgerPath = join(root, "calibration.jsonl");
  await writeMutationCalibrationLedger({
    path: ledgerPath,
    registry: first.registry,
    observations: first.observations,
  });
  assert.equal((await readMutationCalibrationLedger(ledgerPath)).sha256, built.sha256);
  await writeFile(ledgerPath, Buffer.concat([built.bytes, Buffer.from(" ")]));
  await assert.rejects(
    readMutationCalibrationLedger(ledgerPath),
    /digest mismatch/u,
  );
});

test("registered corpus binds the independent Node and Spring fixtures", async () => {
  const { registry, fixtureRoots } = await buildVerifierMutationCorpus();
  const run = (noise) => runVerifierMutationCalibration({
    registry,
    fixtureRoots,
    async verifier({ mutation, workspaceRoot }) {
      const bytes = await readFile(join(workspaceRoot, mutation.target_path));
      assert.equal(sha256Hex(bytes), mutation.mutated_sha256);
      return {
        schema_version: { major: 1 },
        adapter_id: "command-verifier",
        argv: [mutation.verifier.command, ...mutation.verifier.args],
        status: "failed",
        exit_code: 1,
        signal: null,
        timed_out: false,
        output_truncated: false,
        stdout_sha256: sha256Hex(Buffer.from(`runtime-noise-${noise}`)),
        stderr_sha256: sha256Hex(Buffer.from(`diagnostic-noise-${noise}`)),
      };
    },
  });
  const completed = await run("first");
  const repeated = await run("second");
  const firstLedger = buildMutationCalibrationLedger({
    registry: completed.registry,
    observations: completed.observations,
  });
  const repeatedLedger = buildMutationCalibrationLedger({
    registry: repeated.registry,
    observations: repeated.observations,
  });

  assert.equal(completed.summary.registered_mutation_count, 8);
  assert.equal(completed.summary.outcome_counts.killed, 8);
  assert.equal(completed.summary.mutation_score, 1);
  assert.deepEqual(completed.summary.corpus_diversity.fixture_kinds, [
    "node",
    "spring",
  ]);
  assert.equal(completed.summary.corpus_diversity.task_count, 2);
  assert.equal(completed.summary.corpus_diversity.verifier_command_count, 2);
  assert.equal(repeatedLedger.sha256, firstLedger.sha256);
  assert.deepEqual(repeatedLedger.bytes, firstLedger.bytes);
  for (const family of [
    "condition_inversion",
    "boundary_alteration",
    "guard_or_exception_removal",
    "incorrect_return",
  ]) {
    assert.equal(completed.summary.family_outcome_counts[family].killed, 2);
  }
});

test("stored verifier calibration ledger is canonical and replayable", async () => {
  const stored = await readMutationCalibrationLedger(resolve(
    "benchmarks/calibration/verifier-mutation-corpus-v1/calibration.jsonl",
  ));
  assert.equal(
    stored.sha256,
    "33ad50cffc7081d263bb814958780ea3d65b39b8ab83c655722434702c739400",
  );
  assert.equal(stored.summary.registered_mutation_count, 8);
  assert.equal(stored.summary.outcome_counts.killed, 8);
  assert.equal(stored.summary.corpus_diversity.claim_scope, "descriptive_corpus_only");
});
