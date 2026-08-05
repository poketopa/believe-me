# Paired A/B benchmark

## Question

For the same code task, baseline, provider configuration, and verifier, what
changes when Codex runs through the verifiable harness instead of editing a
working copy directly?

The benchmark is portfolio evidence, not a claim that one Spring fixture
represents all backend work. It reports observed benefits, regressions,
operational failures, cost, and uncertainty together.

## Arms

Each pair starts from two byte-identical copies of one baseline. The registered
`sha256-task-alternating-v1` algorithm derives the first order from the frozen
experiment seed and task ID, then alternates it by repeat index. Repeats of one
task are therefore exactly counterbalanced while remaining reproducible.

| Arm | Provider boundary | Change boundary |
| --- | --- | --- |
| `direct_codex` | same non-interactive Codex CLI, model settings, timeout, workspace-write sandbox, and disabled web/tool surface | Codex edits the benchmark working copy before independent verification; the benchmark observes but does not prevent out-of-allowlist changes |
| `harness` | same provider settings | Codex edits an isolated run workspace; allowlist, verification, receipt, approval, and apply contracts remain enforced, so the source copy stays unchanged before receipt |

Both arms receive the same task text and use the same verifier. The harness arm
also receives its declared allowed paths because that policy delivery is part of
the intervention being measured. Both arms run only in benchmark-owned temporary
copies; the control does not risk the developer's real project.

## Outcomes

The primary intention-to-treat outcome is end-to-end verified success. An arm is
a success only when it terminalizes as completed with a non-empty, safe candidate
that passes the independent verifier. Timeout, infrastructure error, safety
refusal, and verification failure remain zero-valued primary outcomes; their
typed terminal reasons remain visible.

Secondary binary outcomes are:

- unsafe or out-of-allowlist behavior;
- source mutation before verification;
- completion and infrastructure-failure rates.

Secondary continuous outcomes are paired differences in:

- trusted total token usage;
- total wall time;
- Codex child time;
- verifier time;
- harness orchestration time.

Missing usage or component timing is never imputed as zero. Reports state the
eligible pair count and exact missing reasons for every continuous metric.

## Statistics

Binary metrics report both arm rates, the paired risk difference, the four
paired cells, and the exact two-sided McNemar/binomial p-value for discordant
pairs. Fixed-seed task-cluster bootstrap percentiles provide 95% intervals for
paired risk differences.

Continuous metrics report the median paired difference and its fixed-seed
task-cluster bootstrap 95% interval. These are descriptive when the analysis
cut is open. The report does not turn a non-significant result into a claim of
equivalence.

The task, rather than an individual retry, is the bootstrap cluster. Repeats of
one task therefore do not masquerade as independent task diversity.

## Verifier mutation calibration

Verifier strength is reported separately from ordinary task success. The deterministic
registry binds each mutant to its task, fixture kind, target path, baseline and mutated
content hashes, mutation family, expected verifier outcome, and exact verifier command.
The same digest-bound descriptor fixes the verifier timeout and combined-output limit.
Calibration runs one changed target per isolated fixture copy and classifies every row as
`killed`, `survived`, `invalid`, `equivalent_or_undetermined`, or `infrastructure`.
Survived rows are retained as false-accept evidence.
Observation digests retain stable process outcomes while excluding runtime-noisy verifier
output hashes, so the same corpus and verifier decisions reproduce byte-identical ledgers.

The checked calibration corpus contains eight mutants across two independent tasks:
`node-reservation-policy` and `roomescape-cancel-booking-penalty`. It covers Node and
Spring, two distinct verifier commands, and two examples each of condition inversion,
boundary alteration, guard/exception removal, and incorrect return behavior. Run it
without provider credentials using:

```console
node scripts/run-verifier-calibration.js /tmp/calibration.jsonl
```

The frozen repository ledger is
`benchmarks/calibration/verifier-mutation-corpus-v1/calibration.jsonl`, with SHA-256
`33ad50cffc7081d263bb814958780ea3d65b39b8ab83c655722434702c739400`.
All eight registered mutants were killed in this deterministic run; survived, invalid,
equivalent/undetermined, and infrastructure counts were zero. That is a descriptive
result for exactly two tasks and two verifier commands, not a population-level claim
about verifier quality. Mutation execution is not a provider benchmark and makes no
token, cost, or adaptive-performance claim.

## Frozen v0.2 decision cut

The canonical decision report is
`benchmarks/reports/adaptive-execution-v0.2/decision.jsonl`, with SHA-256
`19434728e19e2887b0ea62989d13986b10e38f7a88c56135450ec837a5fce89f`.
It binds the two existing benchmark-v1 pilot ledgers and the verifier-calibration
ledger at prerequisite commit `cb9eed317713c28e9dba14733868d858b65f7968`.
No new live or paid provider run was performed for this cut.

| Comparison | Frozen evidence | Decision-cut status |
| --- | --- | --- |
| direct Codex vs current harness | one protocol-valid Roomescape benchmark-v1 pair | pilot only |
| current harness vs ContextPack-only | none | missing frozen comparison-v2 ledger |
| ContextPack-only vs routing-only | none | missing frozen comparison-v2 ledger |
| routing-only vs routing-plus-repair | none | missing frozen comparison-v2 ledger |

In the valid pair, direct Codex recorded zero verified successes and the harness one.
Neither arm made an unsafe or pre-verification source change. The harness-minus-direct
differences were `+151,237` total tokens, `+49,697 ms` wall time, and `+39,863 ms`
Codex child time. Direct verification and orchestration timing were missing because
the direct arm produced no change and did not run verification. Benchmark-v1 did not
record attempt count or provider billed cost, so attempt difference, cost difference,
and cost per verified success remain null rather than being inferred.

The report preserves the source summary's 95% intervals and per-arm missingness.
Because the bootstrap has only one independent task cluster, the available success,
token, wall, and child-time intervals collapse to their single observed differences;
these degenerate intervals describe the pilot and do not increase its generalizability.

This single task/pair has an exact McNemar p-value of `1.0` and cannot support a
population claim. The separate two-task verifier corpus killed all eight registered
mutants, but also remains descriptive. The decision cut therefore reports
`insufficient_comparative_evidence`, keeps adaptive behavior opt-in, and prohibits
claims of generalized harness superiority or adaptive token/cost reduction.

## Sequential reporting without a success gate

There is no sample upper bound and no outcome threshold that blocks report
generation. A living experiment may add preregistered pairs, but each report
shows all scheduled rows and remains descriptive until a separate analysis cut
is frozen. Evidence labels describe maturity rather than product success:

- `pilot`: fewer than 10 pairs;
- `exploratory`: at least 10 pairs with an open analysis cut;
- `frozen_comparative`: the report is generated from a declared frozen cut.

These labels do not mean that the harness won. A frozen comparison can be
positive, negative, mixed, or inconclusive. A safety improvement accompanied by
higher latency or token use is reported as a trade-off, not collapsed into one
score.

## Interpretation boundary

One or several Roomescape pairs can prove that the runner, evidence, and
statistics are real and reproducible. They cannot prove population-level Spring
or general software-engineering superiority. A stronger claim requires more
independent tasks and verifiers, a frozen analysis cut, narrow enough intervals
for a declared practical effect, and ideally reproduction by another operator.

The benchmark deliberately avoids the previous project's failure mode: protocol
violations can invalidate a row's integrity, but weak or unfavorable performance
never invalidates the experiment. Negative results are still results.

## Experiment intake and ablation evidence

Register an experiment issue before live provider execution. The issue freezes one
principal intervention and its immediate control, primary and secondary metrics,
source and task digests, provider/model/reasoning configuration, verifier, policy,
corpus, seed and order, protocol-invalid conditions, scope, non-goals, and expected
release impact as applicable.

Each optimization pull request links that issue and reports its principal ablation.
Attach the canonical ledger and report digests, or explain why a benchmark is not
applicable. Report observed regressions, missing usage/cost/timing with typed reasons,
and all scheduled negative, timeout, infrastructure, safety, or inconclusive outcomes.
Only integrity failures declared in advance can make a row protocol-invalid; an
unfavorable result cannot.

Live provider benchmarks run only after deterministic checks pass and are not
credentialed CI merge gates. The pull request claim is limited to its frozen evidence
and maturity label. Findings that require another intervention, corpus, protocol, or
public claim become follow-up issues rather than hidden scope in the current pull
request.

## First authenticated development pilot

The repository preserves the first real paired smoke at
`benchmarks/pilots/roomescape-live-paired-pilot-v1/benchmark.jsonl`. Its ledger
SHA-256 is
`c8a3f870c1890622f5de99c818870102ea282abb8442b0500479208d2264897c`.

The run found a protocol defect: after the direct arm changed `build.gradle`
outside the declared path, the first runner still invoked the verifier. The raw
arm observations remain preserved, but the pair is now explicitly marked
`protocol_valid: false` with reason `unsafe_control_verifier_executed`. It
therefore contributes zero success to both arms in the intention-to-treat
summary and cannot support a product-effect claim.

The defect is protected by a regression test: an unsafe direct edit terminalizes
without verifier execution. Keeping this invalid pilot demonstrates that the
evidence system records unfavorable protocol facts instead of silently deleting
or reclassifying them.

## First protocol-valid pilot

The corrected runner produced
`benchmarks/pilots/roomescape-live-paired-pilot-v2/benchmark.jsonl`, bound by
SHA-256
`511243529af072e1be05466e7f72c899521c4c4d2a78f7102dd3431352e2592b`.
The observed provider configuration matched across arms and the registered
baseline remained unchanged, so the pair is protocol-valid.

The direct arm spent 73,411 tokens but made no source change, so it terminalized
as `verification_failed` without running the verifier. The harness arm changed
only `ReservationService.java`, passed the Spring verifier, produced a receipt,
and left the registered source untouched. The raw harness-minus-direct
differences are therefore `+1.0` verified success, `+151,237` total tokens, and
`+49,697 ms` wall time. Neither arm made an unsafe change in this run.

This is still one pilot pair: its exact McNemar p-value is `1.0`, and its
single-cluster bootstrap interval cannot justify a population claim. It proves
that the corrected protocol can capture a real success/cost trade-off without a
pass gate; it does not prove generalized harness superiority.
