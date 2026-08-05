## Summary

- Closes #
- Principal intervention:
- Behavior or documentation changed:
- Follow-up issues (or `none`):

## Verification

- [ ] Tests cover the behavior or the test gap is explicit.
- [ ] `npm test` passes.
- [ ] `npm run check` passes.
- [ ] `npm run pack:check` passes.
- [ ] `npm run release:check` passes, or release impact is not applicable.

## Benchmark and ablation evidence

- Applicability: <!-- applicable / not applicable, with reason -->
- Frozen control and treatment:
- Evidence or canonical ledger/report links:
- Observed regressions, unfavorable outcomes, and missing data:

## Claim boundary

<!-- State exactly what this PR's evidence supports and what it does not support. -->

## Contract and risk review

- [ ] Lifecycle/state-machine impact considered.
- [ ] Evidence/receipt schema impact considered.
- [ ] Compatibility and migration impact considered.
- [ ] Security/trust-boundary impact considered.

### Risk and rollback

<!-- Describe the material risks and the disable, revert, or migration path. -->

### Provenance

<!-- Record reused source, generated artifacts, experiment inputs, and relevant SHAs. -->

## Release impact

- Release type (select one):
  - [ ] `none`
  - [ ] `patch`
  - [ ] `minor`
  - [ ] `breaking`
- [ ] Changelog impact considered.
- [ ] Package metadata, packed-file allowlist, and generated release notes
      considered.
- [ ] Release workflow permissions and gates remain unchanged unless this is an
      approved release-activation PR.
- [ ] Public-release activation preserves immutable `v*` tag rules and checks
      out the release event commit rather than a mutable tag ref.
- [ ] `THIRD_PARTY_NOTICES.md` licensing status supports the release claim, or
      publication remains blocked.
- [ ] Public claims are supported by repository, registry, workflow, and
      benchmark evidence as applicable.
