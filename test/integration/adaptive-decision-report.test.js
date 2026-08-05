import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { canonicalJSONLine, sha256Hex } from "../../src/index.js";

const execFileAsync = promisify(execFile);
const reportPath = resolve(
  "benchmarks/reports/adaptive-execution-v0.2/decision.jsonl",
);
const expectedSha256 =
  "19434728e19e2887b0ea62989d13986b10e38f7a88c56135450ec837a5fce89f";

async function readReport(path = reportPath) {
  const bytes = await readFile(path);
  const sidecar = await readFile(`${path}.sha256`, "utf8");
  const report = JSON.parse(bytes.toString("utf8"));
  assert.equal(bytes.toString("utf8"), canonicalJSONLine(report));
  assert.equal(sidecar, `${sha256Hex(bytes)}\n`);
  return { bytes, report, sha256: sha256Hex(bytes) };
}

test("frozen adaptive decision report binds only available compatible evidence", async () => {
  const { bytes, report, sha256 } = await readReport();
  assert.equal(sha256, expectedSha256);
  assert.doesNotMatch(bytes.toString("utf8"), /\/Users\/|\/home\/|workspace_root/u);
  assert.equal(report.evidence_cut.source_commit,
    "cb9eed317713c28e9dba14733868d858b65f7968");
  assert.deepEqual(
    report.evidence_cut.inputs.map((input) => input.sha256),
    [
      "c8a3f870c1890622f5de99c818870102ea282abb8442b0500479208d2264897c",
      "511243529af072e1be05466e7f72c899521c4c4d2a78f7102dd3431352e2592b",
      "33ad50cffc7081d263bb814958780ea3d65b39b8ab83c655722434702c739400",
    ],
  );
  assert.deepEqual(report.excluded_protocol_evidence.protocol_invalid_reasons, [
    "unsafe_control_verifier_executed",
  ]);
  assert.equal(
    report.excluded_protocol_evidence.direct_source_mutated_before_verification,
    true,
  );
  assert.equal(
    report.excluded_protocol_evidence.observed_harness_success_excluded,
    true,
  );

  const [pilot, ...missing] = report.comparisons;
  assert.equal(pilot.status, "available_pilot");
  assert.deepEqual(pilot.metrics.verified_success, {
    ci95_harness_minus_direct: { lower: 1, upper: 1 },
    direct: 0,
    harness: 1,
    harness_minus_direct: 1,
    mcnemar_p_value: 1,
  });
  assert.equal(pilot.metrics.total_tokens.harness_minus_direct, 151_237);
  assert.deepEqual(pilot.metrics.total_tokens.ci95_harness_minus_direct, {
    lower: 151_237,
    upper: 151_237,
  });
  assert.equal(pilot.metrics.total_tokens.missing_pair_count, 0);
  assert.equal(pilot.metrics.wall_ms.harness_minus_direct, 49_697);
  assert.equal(pilot.metrics.verification_ms.missing_pair_count, 1);
  assert.deepEqual(pilot.metrics.verification_ms.missing_reasons, {
    direct_codex: { verification_not_run: 1 },
    harness: {},
  });
  assert.equal(
    pilot.metrics.attempt_count.missing_reasons.direct_codex
      .benchmark_v1_does_not_record_attempt_count,
    1,
  );
  assert.equal(
    pilot.metrics.billed_cost.missing_reasons.harness.provider_cost_not_reported,
    1,
  );
  assert.equal(missing.length, 3);
  assert.equal(missing.every((comparison) =>
    comparison.status === "missing_frozen_ledger"), true);

  assert.equal(report.verifier_calibration.registered_mutation_count, 8);
  assert.equal(report.verifier_calibration.outcome_counts.killed, 8);
  assert.equal(report.verifier_calibration.false_accept_count, 0);
  assert.equal(report.decision.adaptive_efficacy,
    "insufficient_comparative_evidence");
  assert.equal(report.decision.adaptive_default, "opt_in");
  assert.equal(report.decision.release_activation, "owner_decision_required");
  assert.equal(report.release_preparation.version_changed, false);
  assert.equal(report.release_preparation.npm_published, false);
});

test("decision report generator reproduces byte-identical report and sidecar", async () => {
  const root = await mkdtemp(join(tmpdir(), "adaptive-decision-report-"));
  const generatedPath = join(root, "decision.jsonl");
  await execFileAsync(process.execPath, [
    resolve("scripts/build-adaptive-decision-report.js"),
    generatedPath,
  ]);
  const stored = await readReport();
  const generated = await readReport(generatedPath);
  assert.deepEqual(generated.bytes, stored.bytes);
  assert.equal(generated.sha256, stored.sha256);
});
