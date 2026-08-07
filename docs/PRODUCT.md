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

The JSONL CLI exposes `demo`, `init`, `run`, `status`, `receipt`, `review`,
`run-session`, `resume-session`, `status-session`, `review-session`,
`export-bundle`, `verify-bundle`, and `apply`, with one canonical record per
command outcome and documented exit codes. Both executor kinds reuse the same
state, receipt, explicit approval, atomic apply, and resume contracts.

`demo` composes the existing deterministic, command-verifier, stored-review,
portable-evidence, and apply boundaries against a generated dependency-free Node
fixture. The invocation authorizes receipt-hash apply only inside that disposable
fixture; it does not approve or inspect the caller's project. The fixture and its
state are removed before the single canonical JSONL result is returned. This is a
packaging and first-use proof, not an efficacy benchmark or provenance claim.

`review` is the read-only approval companion to `receipt`: it checks the stored
receipt binding again and surfaces only the validated evidence summary, not raw
candidate bytes or verifier streams. `stored_evidence_verified` deliberately
means stored content integrity and state binding, not authenticated identity,
current-source freshness, or a fresh verifier execution.

`export-bundle` normalizes one validated stored run into a deterministic,
unsigned canonical JSONL transport file with a 64 MiB cap and fail-closed
no-overwrite publication. `verify-bundle` validates that file independently of
project and state directories and returns the bounded
`portable_evidence_verified` summary. The file includes candidate source bytes;
it is content-integrity evidence, not identity, provenance, freshness, import,
approval, or apply authority.

`status-session` and `review-session` expose the already-existing opt-in
adaptive-session evidence without adding execution authority. Both are
structurally read-only: missing paths remain missing, and neither command takes
a lock, resumes a child, applies a winner, or invokes a verifier. Status covers
in-progress, completed, and terminal parent-failure artifacts. Review requires
a completed session, validates its input/attempt/final bindings, and validates
the winning child receipt when present. The result is stored evidence review,
not provider identity, freshness, attestation, or independent re-execution.

`AdaptiveSessionLaunch` is an internal canonical JSONL/digest record that binds
the project and state paths, skill manifest, Codex input, execution policy,
ContextPack, risk tier, retry allowlist, and the fixed `codex-cli` adapter before
derived adaptive input or child claims can exist. Its policy is also the sole
source of admitted model and reasoning aliases for Codex transport composition.
`run-session` publishes that authority before execution and never applies a
candidate. `resume-session` accepts no authority overrides and uses the frozen
launch for both claimed-child resume and any authorized later retry. Legacy
library sessions remain readable and applicable but are not CLI-resumable.

## Verifier selection

`SkillManifest.verifier` is an optional versioned descriptor. New manifests can
select either the canonical `spring-verifier` or a bounded `command-verifier`.
The latter freezes exact command argv, timeout, and output limits, then executes
with no shell, a reduced environment, fixed cwd, bounded capture, and forced
cleanup. POSIX executions use a dedicated process group, fail closed on
uncleanable residue, and reject project-relative verifier executables that
traverse symlinks. Existing major-v1 manifests without the descriptor retain an
explicit Spring compatibility route rather than becoming unreadable.

The manifest is already digest-bound into the workflow plan, run state, frozen
inputs, and receipt. Run/resume and apply therefore resolve the same verifier
from the same frozen bytes. Apply performs its final verification in a fresh
copy of the applied candidate and refuses verifier-created source drift before
committing lifecycle state. A dependency-free Node reservation fixture exercises
the installed npm tarball through run, receipt approval, and apply, proving the
CLI boundary beyond Spring.

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

## Adaptive execution decision status

The development branch now has deterministic ContextPack localization,
provider-neutral one-attempt routing, and verifier-directed bounded repair over
immutable child runs. These additions preserve the verified run kernel and are
covered by deterministic Node and Spring tests, but implementation evidence is not
the same as provider-effect evidence.

The frozen v0.2 decision cut contains one protocol-valid live pair for direct Codex
versus the current harness and no compatible live comparison-v2 ledgers for
ContextPack-only, routing-only, or routing-plus-repair. In the available pair, the
harness produced the only verified success, with a harness-minus-direct difference of
151,237 total tokens and 49,697 ms wall time. One task and one pair cannot support a
population claim; provider cost and attempt-count evidence are absent from benchmark-v1.

Verifier calibration is separate: eight deterministic mutants across independent Node
and Spring tasks were all killed by two verifier commands. That result describes the
registered corpus only. The product decision is therefore to keep adaptive behavior
opt-in and make no adaptive efficiency or generalized superiority claim. Live paid
ablations and v0.2.0 release activation remain explicit owner decisions.

## Core contracts

- `SkillManifest`
- `VerifierSpec`
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
