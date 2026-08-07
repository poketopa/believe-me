# Architecture

## System purpose

BelieveMe is a local-first trust layer between a change-producing executor and a
user's source project. It does not decide whether generated code is intelligent;
it decides whether declared bytes passed the declared verifier and may cross the
apply boundary.

```text
manifest + request
  -> frozen source snapshot and workflow plan
  -> isolated executor workspace
  -> manifest-selected verifier
  -> canonical result, verification, and receipt
  -> read-only review and optional portable verification
  -> exact receipt approval
  -> fresh candidate verification
  -> atomic apply or rollback
```

## Module boundaries

| Boundary | Primary modules | Responsibility |
| --- | --- | --- |
| CLI admission | `src/cli/args.js`, `src/cli/main.js` | Fixed command grammar and one canonical JSONL outcome |
| Run orchestration | `src/core/run-orchestrator.js` | Freeze inputs, isolate execution, verify, and publish evidence |
| Executors | `src/adapters/codex-executor.js`, deterministic contracts | Produce candidate bytes without source-project mutation |
| Verifiers | `src/adapters/command-verifier.js`, `src/adapters/spring-verifier.js` | Run exact bounded verifier authority selected by the frozen manifest |
| Evidence | `src/core/evidence.js`, `src/core/review-evidence.js`, `src/core/portable-evidence.js`, `src/core/bundle-attestation.js` | Bind canonical bytes and expose bounded review, transport, and optional detached signer-key summaries |
| Apply | `src/core/apply.js`, `src/core/rollback.js` | Recheck approval and freshness, verify a fresh candidate copy, then mutate atomically |
| Adaptive composition | `src/core/adaptive-session.js` | Compose immutable child runs without acquiring apply authority |

## Authority transitions

1. A manifest admits executor and verifier kinds; it does not grant apply.
2. A run freezes the request, source snapshot, plan, and executor input.
3. Only verifier-passed candidate bytes can produce a receipt.
4. Review, portable verification, and detached attestation verification are
   read-only evidence operations.
5. Approval must equal the exact stored receipt SHA-256.
6. Apply rejects source drift and reruns the frozen verifier on a fresh candidate
   copy before committing source and lifecycle state.
7. Rollback or an immutable recovery lock preserves evidence when apply cannot
   complete cleanly.

## Disposable demo path

`src/cli/demo.js` generates a private temporary Node project and composes the
same run, review, portable evidence, approval, and apply commands used for real
projects. The command accepts no project path or authority override, uses the
deterministic executor, and removes all generated project/state files before
returning. `test/package-install.test.js` invokes this path from an installed npm
tarball, so the proof cannot depend on repository-only fixtures.

## Architectural limits

- Portable evidence remains unsigned content integrity by default. An optional
  detached Ed25519 sidecar proves that a caller-trusted key signed the exact
  bundle bytes, not a human identity, freshness, revocation status, transparency,
  or trusted execution.
- Attestation creation and verification never provide import, approval, or apply
  authority.
- Direct command verification is bounded process execution, not a network
  sandbox. Hermetic backends are explicit and opt-in.
- Stored review does not rerun a verifier or establish current-source freshness.
- Adaptive routing and repair do not hold approval or apply authority.
- The demo proves lifecycle packaging only; it does not measure coding efficacy.

See [THREAT-MODEL.md](./THREAT-MODEL.md) for adversaries and non-goals and
[DESIGN-DECISIONS.md](./DESIGN-DECISIONS.md) for the decisions behind these
boundaries.
