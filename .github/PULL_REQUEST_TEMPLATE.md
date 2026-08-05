## Summary

- What behavior changes?
- Which issue does this close?

## Verification

- [ ] Tests cover the behavior or the test gap is explicit.
- [ ] `npm test` passes.
- [ ] `npm run check` passes.
- [ ] `npm run pack:check` passes.
- [ ] `npm run release:check` passes, or release impact is not applicable.

## Contract and risk review

- [ ] Lifecycle/state-machine impact considered.
- [ ] Evidence/receipt schema impact considered.
- [ ] Compatibility and migration impact considered.
- [ ] Security/trust-boundary impact considered.
- [ ] Rollback path described.
- [ ] Reused source and provenance recorded.

## Release impact

- [ ] Changelog impact considered.
- [ ] Package metadata, packed-file allowlist, and generated release notes
      considered.
- [ ] Release workflow permissions and gates remain dormant unless this is an
      approved release-activation PR.
- [ ] Public-release activation preserves immutable `v*` tag rules and checks
      out the release event commit rather than a mutable tag ref.
- [ ] `THIRD_PARTY_NOTICES.md` licensing status supports the release claim, or
      publication remains blocked.
- [ ] Public claim does not exceed `dormant contract validated; publication
      blocked and unproven`.
