#!/usr/bin/env node

import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCodexCliTransport } from "../src/adapters/codex-transport.js";
import { runSpringVerifier } from "../src/adapters/spring-verifier.js";
import { writeBenchmarkLedger } from "../src/benchmark/ledger.js";
import { runPairedBenchmark } from "../src/benchmark/runner.js";
import { canonicalJSONLine } from "../src/core/canonical-json.js";
import { createProjectSnapshot } from "../src/core/snapshot.js";

const canonicalRoot = resolve(
  "test/fixtures/roomescape-cancel-booking-penalty",
);
const baselineRoot = await mkdtemp(join(tmpdir(), "vah-benchmark-baseline-"));
await cp(canonicalRoot, baselineRoot, { recursive: true, force: true });

const targetPath =
  "src/main/java/com/roomescape/booking/application/ReservationService.java";
const correctSource = await readFile(join(canonicalRoot, targetPath), "utf8");
const baselineSource = correctSource.replace(
  "if (!now.isBefore(deadline))",
  "if (now.isAfter(deadline))",
);
if (baselineSource === correctSource) {
  throw new Error("Live benchmark baseline mutation was not created.");
}
await writeFile(join(baselineRoot, targetPath), baselineSource);

const baseline = await createProjectSnapshot(baselineRoot);
const experiment = {
  schema_version: { major: 1 },
  experiment_id: "roomescape-live-paired-pilot-v2",
  seed: "roomescape-live-paired-pilot-v2",
  order_algorithm: "sha256-task-alternating-v1",
  analysis_cut_frozen: false,
  provider: {
    adapter_id: "codex-cli",
    model: null,
    reasoning_effort: "low",
    timeout_ms: 600_000,
  },
};
const task = {
  schema_version: { major: 1 },
  experiment_id: experiment.experiment_id,
  pair_id: "roomescape-cancel-boundary-v2-pair-001",
  task_id: "roomescape-cancel-boundary",
  repeat_index: 0,
  project_ref: "fixture://roomescape-cancel-booking-penalty",
  task: [
    "Fix the owner cancellation deadline boundary.",
    "An owner may cancel only when the current instant is strictly before",
    "the reservation start instant minus 30 minutes.",
    "At the exact deadline and after it, cancellation must be refused.",
    "Make the smallest implementation-only change and preserve all other behavior.",
  ].join(" "),
  allowed_paths: [targetPath],
  baseline_sha256: baseline.sha256,
};

const result = await runPairedBenchmark({
  experiment,
  task,
  projectRoot: baselineRoot,
  transportFactory: () => createCodexCliTransport({
    reasoningEffort: "low",
    timeoutMs: experiment.provider.timeout_ms,
  }),
  verifier: async ({ workspaceRoot }) =>
    runSpringVerifier({ fixtureRoot: workspaceRoot }),
});
const ledgerPath = join(result.work_root, "benchmark.jsonl");
const ledger = await writeBenchmarkLedger({
  path: ledgerPath,
  experiment,
  pairs: [result.pair],
  summaryOptions: { seed: 20260805, bootstrap_replicates: 10_000 },
});

if (await readFile(join(baselineRoot, targetPath), "utf8") !== baselineSource) {
  throw new Error("Live paired benchmark mutated its registered baseline.");
}

process.stdout.write(canonicalJSONLine({
  schema_version: { major: 1 },
  status: "pilot_recorded",
  experiment_id: experiment.experiment_id,
  pair_id: task.pair_id,
  order: result.pair.order,
  ledger_path: ledger.path,
  ledger_sha256: ledger.sha256,
  evidence_label: ledger.summary.evidence_label,
  direct_codex: result.pair.direct_codex.observation,
  harness: result.pair.harness.observation,
  paired_summary: {
    end_to_end_success: ledger.summary.end_to_end_success,
    safety: ledger.summary.safety,
    source_mutation: ledger.summary.source_mutation,
    continuous: ledger.summary.continuous,
  },
  baseline_source_unchanged: true,
}));
