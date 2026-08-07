# Changelog

All notable changes are recorded here before they move into a versioned GitHub
Release.

## [Unreleased]

### Added

- Optional detached Ed25519 attestations for portable evidence through
  `attest-bundle` and `verify-attestation`. Existing unsigned bundles remain
  byte-identical and supported; verification proves only that the caller-trusted
  key signed the exact bundle bytes, without freshness, revocation, transparency,
  approval, import, or apply authority.

## [0.3.0] - 2026-08-07

### Added

- A public `believeme demo` command that exercises the receipt, stored review,
  portable export/verification, receipt-hash approval, and atomic apply lifecycle
  against a disposable dependency-free Node fixture without credentials, network,
  Java, or changes to the caller's working directory.
- A read-only `review` CLI command that re-validates stored receipt-bound
  evidence and returns a bounded approval summary without re-running the
  verifier or exposing candidate bytes. The explicit
  `stored_evidence_verified` status does not claim signed provenance or current
  source freshness.
- Deterministic `export-bundle` and state-independent `verify-bundle` CLI
  commands for one bounded canonical JSONL evidence file. The explicit
  `portable_evidence_verified` status proves internal content/hash bindings only;
  the unsigned file contains candidate bytes and is not import or apply input.
- Read-only `status-session` and `review-session` CLI commands for validated
  adaptive-session state, ordered attempt bindings, and winning-child receipt
  review without execution, resume, apply, or filesystem repair.
- An internal, canonical `AdaptiveSessionLaunch` authority and fixed
  `codex-cli` route composition boundary that freeze launch inputs and exact
  model/reasoning selection for CLI session execution.
- Opt-in `run-session` and `resume-session` commands that compose the frozen
  launch authority with isolated routed child runs, preserve claimed child
  identity on resume, and leave explicit winner apply as a separate command.
- A frozen `HermeticBoundary` authority plus opt-in Linux bubblewrap execution
  for command verifiers and rootless Podman OCI execution for the Spring
  verifier. Unsupported or drifted runtimes fail closed without a direct-execution
  fallback.

### Fixed

- Gradle-backed integration tests use an independent `GRADLE_USER_HOME` per test
  file, preventing concurrent daemon-registry corruption without serializing the
  test suite or changing verifier semantics.

## [0.2.0] - 2026-08-06

### Added

- Provider-neutral frozen execution-policy and adaptive-session evidence contracts
  with ordered child-run bindings, route reasons, usage/timing, and nullable cost.
- A parallel comparison-v2 contract, canonical ledger, and descriptive summary for
  named control/treatment ablations while preserving benchmark-v1 readers and files.
- A deterministic, budgeted ContextPack contract and localizer with hash-bound
  excerpts, explicit fallback/truncation evidence, canonical artifact persistence,
  and opt-in Codex prompt context.
- Deterministic one-attempt route selection over bounded observable features, with
  injected provider-neutral adapter/model aliases and frozen route evidence.
- Verifier-directed adaptive sessions that retain immutable child attempts, enforce
  retry and aggregate budgets, bind bounded repair context, resume without replaying
  checkpointed children, and apply only one verified winner.
- Deterministic verifier mutation calibration with canonical evidence, retained
  false-accept cases, and exact Node/Spring corpus-diversity reporting.
- A frozen adaptive-execution decision report that retains missing ablations and
  unavailable cost/attempt evidence, keeps adaptive behavior opt-in, and defers
  live-provider and public-release activation to explicit owner decisions.

## [0.1.0] - 2026-08-05

### Added

- Product kernel for policy-bound, isolated agent execution with evidence
  receipts, explicit approval, and atomic apply or rollback.
- Deterministic and Codex executor paths that preserve source state until a
  verified receipt can be approved.
- Language-neutral `command-verifier` support with exact argv execution,
  timeout, bounded output, reduced environment, POSIX process-group cleanup,
  and manifest-bound reuse across run, resume, receipt, and apply.
- Java/Spring Roomescape reference fixture that proves the owner cancellation
  policy, manager exemption, unchanged not-found behavior, waiting promotion,
  transactional rollback, and PostgreSQL preservation.
- Paired benchmark protocol that compares direct Codex and harness-mediated
  execution from identical baselines while reporting success, unsafe edits,
  source mutation, tokens, latency, missingness, and protocol defects.
- Dormant npm Trusted Publishing workflow contract plus release validator that
  bind tag, package metadata, lock metadata, runtime identity, required files,
  and packed artifact allowlist before any future publish step.
- Durable owner-source redistribution evidence for the three adapted harness
  components, bound to exact source hashes and the rights-holder confirmation
  in BelieveMe Issue #22.

### Changed

- Activated the public package metadata and guarded GitHub Release publication
  contract for the first `@poketopa/believe-me` release.

### Known limitations

- Current paired benchmark evidence is pilot evidence only; it does not prove
  generalized harness superiority.
