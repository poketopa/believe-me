import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { readBenchmarkLedger } from "../../src/benchmark/ledger.js";

const ledgerPath = resolve(
  "benchmarks/pilots/roomescape-live-paired-pilot-v1/benchmark.jsonl",
);
const validLedgerPath = resolve(
  "benchmarks/pilots/roomescape-live-paired-pilot-v2/benchmark.jsonl",
);

test("stored Roomescape paired pilot replays without local-path leakage", async () => {
  const raw = await readFile(ledgerPath, "utf8");
  assert.doesNotMatch(raw, /\/Users\/|\/var\/folders\/|\blhs\b/u);

  const replayed = await readBenchmarkLedger(ledgerPath);
  assert.equal(
    replayed.sha256,
    "c8a3f870c1890622f5de99c818870102ea282abb8442b0500479208d2264897c",
  );
  assert.equal(replayed.records.length, 6);
  assert.equal(replayed.summary.evidence_label, "pilot");
  assert.equal(replayed.summary.scheduled_pair_count, 1);
  assert.equal(replayed.summary.protocol_invalid_pair_count, 1);
  assert.equal(replayed.summary.end_to_end_success.harness_minus_direct, 0);
  assert.equal(replayed.summary.end_to_end_success.mcnemar.p_value, 1);
  assert.equal(
    replayed.pairs[0].direct_codex.observation.terminal_status,
    "safety_refusal",
  );
  assert.equal(replayed.pairs[0].protocol_valid, false);
  assert.deepEqual(replayed.pairs[0].protocol_invalid_reasons, [
    "unsafe_control_verifier_executed",
  ]);
  assert.deepEqual(
    replayed.pairs[0].direct_codex.observation.changed_paths,
    ["build.gradle"],
  );
  assert.equal(replayed.pairs[0].harness.observation.verified_success, true);
  assert.equal(
    replayed.pairs[0].harness.observation.source_mutated_before_verification,
    false,
  );
});

test("stored Roomescape v2 pilot is protocol-valid and replayable", async () => {
  const raw = await readFile(validLedgerPath, "utf8");
  assert.doesNotMatch(raw, /\/Users\/|\/var\/folders\/|\blhs\b/u);

  const replayed = await readBenchmarkLedger(validLedgerPath);
  assert.equal(
    replayed.sha256,
    "511243529af072e1be05466e7f72c899521c4c4d2a78f7102dd3431352e2592b",
  );
  assert.equal(replayed.pairs[0].protocol_valid, true);
  assert.deepEqual(replayed.pairs[0].protocol_invalid_reasons, []);
  assert.equal(replayed.pairs[0].provider_configuration_equivalent, true);
  assert.equal(replayed.summary.protocol_invalid_pair_count, 0);
  assert.equal(replayed.summary.end_to_end_success.harness_minus_direct, 1);
  assert.equal(
    replayed.pairs[0].direct_codex.observation.verification_status,
    "not_run",
  );
  assert.deepEqual(
    replayed.pairs[0].direct_codex.observation.changed_paths,
    [],
  );
  assert.equal(replayed.pairs[0].harness.observation.verified_success, true);
  assert.deepEqual(replayed.pairs[0].harness.observation.changed_paths, [
    "src/main/java/com/roomescape/booking/application/ReservationService.java",
  ]);
  assert.equal(
    replayed.summary.continuous.total_tokens.median_harness_minus_direct,
    151237,
  );
  assert.equal(
    replayed.summary.continuous.wall_ms.median_harness_minus_direct,
    49697,
  );
});
