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

The first proof uses one Java/Spring task and a deterministic executor before a
real AI provider is admitted:

1. load a versioned skill manifest;
2. compile an immutable workflow plan;
3. snapshot the source tree;
4. execute in an isolated workspace;
5. run the Spring verification adapter;
6. generate and verify an evidence receipt;
7. refuse stale source;
8. apply atomically after explicit approval.

Steps 1-8 are now implemented for the deterministic executor. The integration
proof starts from an intentionally incorrect Roomescape deadline boundary,
restores the candidate in an isolated workspace, runs the fixture-owned Gradle
verifier, and produces a receipt-bound non-empty change set. The original
baseline remains unchanged until the separate approval/apply operation. The
process-level CLI proof then rejects an incorrect receipt approval, accepts the
bound receipt hash, reruns verification, and reaches `applied`.

The stable pre-release JSONL CLI now exposes `init`, `run`, `status`, `receipt`,
and `apply`, with one canonical record per command outcome and documented exit
codes. The Codex executor remains a separate follow-up milestone and currently
returns a typed unavailable-adapter failure without changing the deterministic
proof.

## Core contracts

- `SkillManifest`
- `WorkflowPlan`
- `RunSpec`
- `RunState`
- `EvidenceReceipt`

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
