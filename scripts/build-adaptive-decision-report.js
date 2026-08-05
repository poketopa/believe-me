import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJSONLine,
  readBenchmarkLedger,
  readMutationCalibrationLedger,
  sha256Hex,
} from "../src/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(process.argv[2] ?? resolve(
  repositoryRoot,
  "benchmarks/reports/adaptive-execution-v0.2/decision.jsonl",
));
const inputs = Object.freeze({
  invalidPilot: {
    path: "benchmarks/pilots/roomescape-live-paired-pilot-v1/benchmark.jsonl",
    sha256: "c8a3f870c1890622f5de99c818870102ea282abb8442b0500479208d2264897c",
  },
  validPilot: {
    path: "benchmarks/pilots/roomescape-live-paired-pilot-v2/benchmark.jsonl",
    sha256: "511243529af072e1be05466e7f72c899521c4c4d2a78f7102dd3431352e2592b",
  },
  calibration: {
    path: "benchmarks/calibration/verifier-mutation-corpus-v1/calibration.jsonl",
    sha256: "33ad50cffc7081d263bb814958780ea3d65b39b8ab83c655722434702c739400",
  },
});

async function readFrozenInput(input, reader) {
  const replayed = await reader(resolve(repositoryRoot, input.path));
  if (replayed.sha256 !== input.sha256) {
    throw new Error(`Frozen evidence digest changed: ${input.path}`);
  }
  return replayed;
}

function unavailableComparison(comparisonId, control, treatment) {
  return {
    comparison_id: comparisonId,
    control,
    treatment,
    protocol: "comparison-v2",
    status: "missing_frozen_ledger",
    reason: "no_owner_authorized_live_comparison_was_run",
    metrics: null,
  };
}

const [invalidPilot, validPilot, calibration] = await Promise.all([
  readFrozenInput(inputs.invalidPilot, readBenchmarkLedger),
  readFrozenInput(inputs.validPilot, readBenchmarkLedger),
  readFrozenInput(inputs.calibration, readMutationCalibrationLedger),
]);
if (
  invalidPilot.summary.protocol_invalid_pair_count !== 1 ||
  validPilot.pairs.length !== 1 ||
  !validPilot.pairs[0].protocol_valid
) {
  throw new Error("Frozen pilot protocol status no longer matches the decision cut.");
}

const pair = validPilot.pairs[0];
const directObservation = pair.direct_codex.observation;
const harnessObservation = pair.harness.observation;
const continuous = validPilot.summary.continuous;
const report = {
  schema_version: { major: 1 },
  report_id: "adaptive-execution-v0.2-decision",
  evidence_cut: {
    source_commit: "cb9eed317713c28e9dba14733868d858b65f7968",
    source_commit_role: "last_prerequisite_merge",
    evidence_label: "pilot",
    live_provider_rerun_performed: false,
    inputs: [
      {
        kind: "benchmark_v1_protocol_invalid",
        ...inputs.invalidPilot,
        disposition: "retained_but_excluded_from_effect_claim",
      },
      {
        kind: "benchmark_v1_protocol_valid",
        ...inputs.validPilot,
        disposition: "descriptive_single_pair",
      },
      {
        kind: "verifier_mutation_calibration_v1",
        ...inputs.calibration,
        disposition: "descriptive_two_task_corpus",
      },
    ],
  },
  excluded_protocol_evidence: {
    input_sha256: invalidPilot.sha256,
    pair_count: invalidPilot.pairs.length,
    protocol_invalid_reasons:
      invalidPilot.pairs[0].protocol_invalid_reasons,
    direct_terminal_status:
      invalidPilot.pairs[0].direct_codex.observation.terminal_status,
    direct_unsafe_or_out_of_scope:
      invalidPilot.pairs[0].direct_codex.observation.unsafe_or_out_of_scope,
    direct_source_mutated_before_verification: invalidPilot.pairs[0]
      .direct_codex.observation.source_mutated_before_verification,
    observed_harness_success_excluded:
      invalidPilot.pairs[0].harness.observation.verified_success,
    disposition: "retained_but_zero_itt_success_and_no_effect_claim",
  },
  comparisons: [
    {
      comparison_id: "direct-vs-current-harness",
      control: "direct_codex",
      treatment: "current_harness",
      protocol: "benchmark-v1",
      status: "available_pilot",
      task_count: 1,
      pair_count: 1,
      metrics: {
        verified_success: {
          direct: Number(directObservation.verified_success),
          harness: Number(harnessObservation.verified_success),
          harness_minus_direct:
            validPilot.summary.end_to_end_success.harness_minus_direct,
          mcnemar_p_value:
            validPilot.summary.end_to_end_success.mcnemar.p_value,
          ci95_harness_minus_direct:
            validPilot.summary.end_to_end_success.ci95_harness_minus_direct,
        },
        unsafe_or_out_of_scope: {
          direct: Number(directObservation.unsafe_or_out_of_scope),
          harness: Number(harnessObservation.unsafe_or_out_of_scope),
          harness_minus_direct:
            validPilot.summary.safety.unsafe_or_out_of_scope.harness_minus_direct,
          ci95_harness_minus_direct: validPilot.summary.safety
            .unsafe_or_out_of_scope.ci95_harness_minus_direct,
        },
        source_mutated_before_verification: {
          direct: Number(
            directObservation.source_mutated_before_verification,
          ),
          harness: Number(
            harnessObservation.source_mutated_before_verification,
          ),
          harness_minus_direct: validPilot.summary.source_mutation
            .source_mutated_before_verification.harness_minus_direct,
          ci95_harness_minus_direct: validPilot.summary.source_mutation
            .source_mutated_before_verification.ci95_harness_minus_direct,
        },
        total_tokens: {
          direct: directObservation.usage.total_tokens,
          harness: harnessObservation.usage.total_tokens,
          harness_minus_direct:
            continuous.total_tokens.median_harness_minus_direct,
          ci95_harness_minus_direct:
            continuous.total_tokens.ci95_median_harness_minus_direct,
          paired_complete_count: continuous.total_tokens.paired_complete_count,
          missing_pair_count: continuous.total_tokens.missing_pair_count,
          missing_by_arm: continuous.total_tokens.missing_by_arm,
          missing_reasons: continuous.total_tokens.missing_reasons,
        },
        wall_ms: {
          direct: directObservation.timing.wall_ms,
          harness: harnessObservation.timing.wall_ms,
          harness_minus_direct:
            continuous.wall_ms.median_harness_minus_direct,
          ci95_harness_minus_direct:
            continuous.wall_ms.ci95_median_harness_minus_direct,
          paired_complete_count: continuous.wall_ms.paired_complete_count,
          missing_pair_count: continuous.wall_ms.missing_pair_count,
          missing_by_arm: continuous.wall_ms.missing_by_arm,
          missing_reasons: continuous.wall_ms.missing_reasons,
        },
        codex_child_ms: {
          direct: directObservation.timing.codex_child_ms,
          harness: harnessObservation.timing.codex_child_ms,
          harness_minus_direct:
            continuous.codex_child_ms.median_harness_minus_direct,
          ci95_harness_minus_direct:
            continuous.codex_child_ms.ci95_median_harness_minus_direct,
          paired_complete_count: continuous.codex_child_ms.paired_complete_count,
          missing_pair_count: continuous.codex_child_ms.missing_pair_count,
          missing_by_arm: continuous.codex_child_ms.missing_by_arm,
          missing_reasons: continuous.codex_child_ms.missing_reasons,
        },
        verification_ms: {
          direct: directObservation.timing.verification_ms,
          harness: harnessObservation.timing.verification_ms,
          harness_minus_direct: null,
          ci95_harness_minus_direct:
            continuous.verification_ms.ci95_median_harness_minus_direct,
          paired_complete_count: continuous.verification_ms.paired_complete_count,
          missing_pair_count: continuous.verification_ms.missing_pair_count,
          missing_by_arm: continuous.verification_ms.missing_by_arm,
          missing_reasons: continuous.verification_ms.missing_reasons,
        },
        orchestration_ms: {
          direct: directObservation.timing.orchestration_ms,
          harness: harnessObservation.timing.orchestration_ms,
          harness_minus_direct: null,
          ci95_harness_minus_direct:
            continuous.orchestration_ms.ci95_median_harness_minus_direct,
          paired_complete_count: continuous.orchestration_ms.paired_complete_count,
          missing_pair_count: continuous.orchestration_ms.missing_pair_count,
          missing_by_arm: continuous.orchestration_ms.missing_by_arm,
          missing_reasons: continuous.orchestration_ms.missing_reasons,
        },
        attempt_count: {
          direct: null,
          harness: null,
          harness_minus_direct: null,
          ci95_harness_minus_direct: { lower: null, upper: null },
          paired_complete_count: 0,
          missing_pair_count: 1,
          missing_by_arm: { direct_codex: 1, harness: 1 },
          missing_reasons: {
            direct_codex: { benchmark_v1_does_not_record_attempt_count: 1 },
            harness: { benchmark_v1_does_not_record_attempt_count: 1 },
          },
        },
        billed_cost: {
          currency: null,
          direct: null,
          harness: null,
          harness_minus_direct: null,
          ci95_harness_minus_direct: { lower: null, upper: null },
          paired_complete_count: 0,
          missing_pair_count: 1,
          missing_by_arm: { direct_codex: 1, harness: 1 },
          missing_reasons: {
            direct_codex: { provider_cost_not_reported: 1 },
            harness: { provider_cost_not_reported: 1 },
          },
        },
        cost_per_verified_success: {
          currency: null,
          direct: null,
          harness: null,
          missing_by_arm: { direct_codex: 1, harness: 1 },
          missing_reasons: {
            direct_codex: { provider_cost_not_reported: 1 },
            harness: { provider_cost_not_reported: 1 },
          },
        },
      },
      inference: {
        bootstrap_cluster: validPilot.summary.bootstrap.cluster,
        independent_task_count: 1,
        population_claim_supported: false,
        reason: "one_pair_one_task_and_mcnemar_p_value_1",
      },
    },
    unavailableComparison(
      "current-harness-vs-context-only",
      "current_harness",
      "context_only",
    ),
    unavailableComparison(
      "context-only-vs-routing-only",
      "context_only",
      "routing_only",
    ),
    unavailableComparison(
      "routing-only-vs-routing-plus-repair",
      "routing_only",
      "routing_plus_repair",
    ),
  ],
  verifier_calibration: {
    corpus_id: calibration.summary.corpus_id,
    registry_sha256: calibration.summary.registry_sha256,
    registered_mutation_count: calibration.summary.registered_mutation_count,
    outcome_counts: calibration.summary.outcome_counts,
    mutation_score: calibration.summary.mutation_score,
    false_accept_count: calibration.summary.false_accept_count,
    corpus_diversity: calibration.summary.corpus_diversity,
    population_claim_supported: false,
  },
  decision: {
    adaptive_efficacy: "insufficient_comparative_evidence",
    adaptive_default: "opt_in",
    release_activation: "owner_decision_required",
    reasons: [
      "only_one_protocol_valid_live_pair_exists",
      "context_routing_and_repair_ablation_ledgers_are_missing",
      "provider_cost_and_attempt_count_are_missing_from_benchmark_v1",
      "mutation_calibration_is_descriptive_for_two_tasks",
    ],
    prohibited_claims: [
      "generalized_harness_superiority",
      "adaptive_token_or_cost_reduction",
      "population_level_verifier_quality",
    ],
  },
  release_preparation: {
    semver_intent: "minor",
    current_package_version: "0.1.0",
    version_changed: false,
    tag_created: false,
    github_release_created: false,
    npm_published: false,
    ci_or_publish_workflow_changed: false,
    owner_choices_required: [
      "whether_to_run_paid_live_comparison_v2_ablations",
      "whether_to_prepare_and_activate_v0.2.0_release",
    ],
  },
};

const bytes = Buffer.from(canonicalJSONLine(report), "utf8");
const digest = sha256Hex(bytes);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, bytes, { flag: "wx", mode: 0o644 });
await writeFile(`${outputPath}.sha256`, `${digest}\n`, {
  flag: "wx",
  mode: 0o644,
});
process.stdout.write(canonicalJSONLine({
  status: "ok",
  path: outputPath,
  sha256: digest,
  decision: report.decision,
}));
