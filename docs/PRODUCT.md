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

## Core contracts

- `SkillManifest`
- `WorkflowPlan`
- `RunSpec`
- `RunState`
- `EvidenceReceipt`

These contracts are language-neutral. Java/Spring behavior belongs only to the
reference adapter.
