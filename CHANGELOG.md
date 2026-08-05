# Changelog

All notable changes are recorded here before they move into a versioned GitHub
Release.

## Unreleased

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

- Release governance now treats the public package name, repository visibility,
  npm account/package setup, GitHub environment, Trusted Publisher settings,
  `NPM_PUBLISH_ENABLED`, and `private:false` as owner-controlled activation
  steps outside the current milestone.

### Non-claims

- No npm package has been published from this repository.
- No GitHub Release, release tag, public repository conversion, npm Trusted
  Publisher, npm environment approval, or registry-backed end-to-end publication
  proof exists yet.
- Current paired benchmark evidence is pilot evidence only; it does not prove
  generalized harness superiority.
- Maximum current release claim: `dormant contract validated; publication
  blocked and unproven`.
