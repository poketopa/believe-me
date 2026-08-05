# Verifiable Agent Harness

A local-first execution harness that turns AI code changes into a verifiable
workflow: select policy, execute in isolation, verify evidence, approve, and
apply atomically.

> [!NOTE]
> This repository is private and pre-release. The repository and package names
> are working names until the public npm identity is selected.

## Product promise

The harness does not assume an AI agent is trustworthy. It binds a requested
change to a policy, workflow gates, an isolated source snapshot, verification
results, and an evidence receipt before the user may apply it.

```text
skill / policy
  -> workflow gates
  -> isolated execution
  -> verification
  -> evidence receipt
  -> explicit approval
  -> atomic apply or rollback
```

## v0.1 scope

- one npm CLI package;
- one Codex execution adapter;
- one Java/Spring verification adapter;
- one Spring use-case policy;
- one Roomescape development fixture;
- deterministic stale-source, tamper, crash, resume, and rollback tests.

The first CLI surface will be `init`, `run`, `status`, `receipt`, and `apply`.

## Current proof

The repository now includes the deterministic run orchestrator, the
contract/evidence/apply kernel, and the first real verifier adapter. A run
freezes its manifest, run spec, source snapshot, workflow plan, and executor
input before creating an isolated workspace. Only a non-empty candidate that
passes verification can reach `receipted`; executor and verifier failures keep
typed evidence while leaving the source project unchanged.

The canonical Roomescape Spring fixture proves the strict owner cancellation
boundary, manager exemption, unchanged not-found behavior, first-waiting
promotion, transactional rollback, and PostgreSQL row preservation. Its
deterministic baseline-to-candidate run now reaches `receipted` without manual
state editing, and the resulting change set is directly compatible with the
atomic apply contract exercised by the core tests.

The fixture is verified through its pinned Gradle wrapper with a direct argv
spawn (`shell: false`). Gradle distribution and dependency versions are locked;
GitHub Actions also runs the preservation test against a digest-pinned
PostgreSQL service.

## Development

Node.js 24 LTS or later is required.

Apply locks are immutable owner-token files. If an `apply.recovery.lock.jsonl`
file remains after an interrupted recovery attempt, the harness preserves it as
evidence and refuses further apply attempts until a manual investigation removes
or archives that recovery lock.

Interrupted deterministic runs resume only after revalidating the frozen input,
plan, manifest, source-tree, and evidence hashes. A verified run with a complete
receipt can finish its lifecycle without executing the candidate again.

```bash
npm ci
npm test
npm run check
npm run pack:check
```

## npm publication

Publication is intentionally disabled with `private: true`. Before the first
public release, the project will choose its final package name, create an npm
account/package, remove the private flag, and connect GitHub Actions through npm
Trusted Publishing rather than storing a long-lived publish token.

## Provenance

The product selectively learns from the current harness project,
`jyt6640/persona-harness`, and `bhoon716/skill-forge`. Reused source and adapted
contracts must be recorded in `THIRD_PARTY_NOTICES.md` before publication.

## License

Apache-2.0. See [LICENSE](LICENSE).
