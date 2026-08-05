# Product boundary

## Primary promise

Run an agent-directed code change in isolation, enforce declared workflow gates,
produce tamper-evident evidence, and apply the change only after verification and
explicit approval.

## Source-project roles

| Inspiration | Selected strength | Product role |
| --- | --- | --- |
| current harness | isolation, source hashes, receipts, explicit apply, rollback | execution and evidence kernel |
| persona-harness | configuration, workflow lifecycle, completion blockers | workflow gate engine |
| skill-forge | narrow skill contracts and agent-target installation | policy authoring and selection |

The new product owns its contracts and architecture. Source projects are inputs,
not runtime dependencies or mandatory package boundaries.

## First vertical slice

The first proof uses one Java/Spring task through both a deterministic executor
and a bounded real-provider adapter:

1. load a versioned skill manifest;
2. compile an immutable workflow plan;
3. snapshot the source tree;
4. execute in an isolated workspace;
5. run the Spring verification adapter;
6. generate and verify an evidence receipt;
7. refuse stale source;
8. apply atomically after explicit approval.

Steps 1-8 are implemented for the deterministic and Codex executor paths. The
executor-neutral integration proof first uses a fake Codex process to make the
provider boundary repeatable in CI, then derives the candidate from actual
workspace bytes, binds JSONL event evidence, and preserves the original source
until receipt approval. An opt-in authenticated smoke repeats the boundary
repair through `codex exec` without making external credentials a CI dependency.

The deterministic integration
proof starts from an intentionally incorrect Roomescape deadline boundary,
restores the candidate in an isolated workspace, runs the fixture-owned Gradle
verifier, and produces a receipt-bound non-empty change set. The original
baseline remains unchanged until the separate approval/apply operation. The
process-level CLI proof then rejects an incorrect receipt approval, accepts the
bound receipt hash, reruns verification, and reaches `applied`.

The stable pre-release JSONL CLI exposes `init`, `run`, `status`, `receipt`, and
`apply`, with one canonical record per command outcome and documented exit
codes. Both executor kinds reuse the same state, receipt, explicit approval,
atomic apply, and resume contracts.

## Measurement layer

The paired benchmark layer compares a direct Codex working-copy edit with the
full harness intervention from identical baseline bytes. Both arms retain the
same task, provider configuration, sandbox, and verifier. The runner records
terminal failures instead of dropping them, then produces paired risk
differences, exact discordant-pair inference, task-cluster bootstrap intervals,
and paired token/time summaries with explicit missingness.

Every experiment, task, arm, pair, and aggregate is written to canonical JSONL.
Each row binds its own digest and the complete ledger has a SHA-256 sidecar;
reading the ledger regenerates the aggregate and refuses drift. The first
Roomescape execution exposed and preserves a protocol-invalid verifier-ordering
defect; a corrected protocol-valid pilot records a harness success together with
its higher token and latency cost. Both remain pilots until independent tasks
and a frozen analysis cut justify a stronger comparison.

## Core contracts

- `SkillManifest`
- `WorkflowPlan`
- `RunSpec`
- `RunState`
- `EvidenceReceipt`
- shared `ExecutorInput` and apply-compatible `ExecutorResult`

These contracts are language-neutral. Java/Spring behavior belongs only to the
reference adapter.

## Canonical Spring proof

`roomescape-cancel-booking-penalty` is a clean-room fixture derived from the
owner-provided `P3-M04` requirement at commit
`dc958f858882f10e11644326296690b8670ae7b5`. The referenced candidate did not
contain the requested policy implementation, so no application source was
copied.

The verifier runs the fixture-owned Gradle wrapper directly without a shell.
Fast tests use H2 in PostgreSQL compatibility mode; a required CI job repeats
the preservation proof against a digest-pinned PostgreSQL 17.5 service.
