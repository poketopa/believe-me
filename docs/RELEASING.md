# Releasing

BelieveMe publishes reviewed releases through a release-only GitHub Actions
workflow and npm Trusted Publishing. The first public release is
`@poketopa/believe-me@0.1.0`.

## Manual Minor Release Policy

The `v0.2 — adaptive execution`, `v0.3 — verifiable review`, and `v0.4 — offline
attestations` milestones preserve this manual, reviewed release procedure. They do
not add Changesets, Release Please, experimental release tags, or a second
publication path. Existing publish triggers, permissions, the protected `npm`
environment, immutable `v*` rules, OIDC Trusted Publishing, and owner approval
remain unchanged.

Every pull request declares `none`, `patch`, `minor`, or `breaking` release impact.
User-visible behavior adds an `Unreleased` changelog entry; governance-only or internal
measurement changes may declare `none`. These declarations inform a later dedicated
release issue and metadata pull request and never authorize version changes, tags,
GitHub Releases, or npm publication inside an ordinary feature or experiment pull
request. Release automation requires a separate owner decision and is not part of a
feature or metadata pull request.

## Current State

- `package.json`, `package-lock.json`, and the runtime product identity agree on
  `@poketopa/believe-me@0.4.0`, with `private: false`.
- `.github/workflows/publish.yml` listens only for a published GitHub Release,
  and the job skips unless `vars.NPM_PUBLISH_ENABLED == 'true'`.
- The workflow publishes only after the protected `npm` environment authorizes
  deployment and npm accepts the GitHub OIDC identity configured as the package
  Trusted Publisher.
- The public repository protects `main` with required pull requests and checks,
  and protects `v*` tags against updates and deletion.
- `THIRD_PARTY_NOTICES.md` records the durable owner-source redistribution grant
  for the three adapted components through
  [Issue #22](https://github.com/poketopa/believe-me/issues/22#issuecomment-5189562788).

## v0.2 Owner Decision Gate

The frozen adaptive decision report is
`benchmarks/reports/adaptive-execution-v0.2/decision.jsonl` with SHA-256
`19434728e19e2887b0ea62989d13986b10e38f7a88c56135450ec837a5fce89f`.
It records insufficient comparative evidence for an adaptive efficiency claim and keeps
adaptive behavior opt-in.

On 2026-08-06, the owner chose to defer the missing paid live comparison-v2
ablations and authorized `v0.2.0` as an additive, opt-in release without an
efficacy claim. Issue #45 and its reviewed metadata pull request carry that
decision into the package, lockfile, runtime identity, changelog, and release
documentation. Tag creation, GitHub Release publication, protected-environment
approval, and npm publication still follow the unchanged procedure below.

## v0.3 Owner Decision Gate

On 2026-08-07, the owner authorized `v0.3.0` as a minor release containing
reviewable stored evidence, portable unsigned evidence bundles, read-only adaptive
session review, opt-in hermetic execution, the disposable public demo, and the Phase A
maintenance fixes. Issue #71 and its reviewed metadata pull request carry that
decision into the package, lockfile, runtime identity, changelog, security support
table, and release documentation.

Signed or keyless run attestations and additional AI-provider adapters remain deferred
to Issues #69 and #70. This release makes no efficacy, provider-provenance, or trusted-
execution claim; portable bundles remain unsigned and hermetic execution remains
opt-in. Tag creation, GitHub Release publication, protected-environment approval, and
npm publication still follow the unchanged procedure below.

## v0.4 Owner Decision Gate

On 2026-08-07, the owner authorized `v0.4.0` as an additive minor release for
optional detached offline Ed25519 attestations over exact portable bundle bytes.
Issue #76 and its reviewed metadata pull request carry that decision into the
package, lockfile, runtime identity, changelog, security support table, and release
documentation.

The existing unsigned bundle path remains supported and byte-compatible.
Attestation verification proves possession of the caller-trusted key for exact
bundle bytes; it does not establish person identity, freshness, revocation,
transparency, trusted execution, import, approval, or apply authority. Sigstore
keyless transparency and additional providers in Issue #70 remain deferred. Tag
creation, GitHub Release publication, protected-environment approval, and npm
publication still follow the unchanged procedure below.

## Local Contract Check

Run both the ordinary checks and the exact release-mode contract:

```bash
npm run release:check
npm run release:check -- --tag v0.4.0 --publish
npm run check
npm test
npm run pack:check
```

The release-mode check must exit 0 with `mode:"publish"`, `publishable:true`,
`publicationBlocked:false`, and a tag version matching all three metadata
sources.

## Owner Activation Order

Complete these steps in order. Do not set `NPM_PUBLISH_ENABLED=true` until every
earlier step is done and reviewed.

1. [x] Record durable owner-source redistribution rights for the adapted
   components. Issue #22 is the canonical confirmation.
2. [x] Keep the finalized npm identity `@poketopa/believe-me` and owner scope
   `poketopa` consistent across package, runtime, and repository metadata.
3. [x] Reconfirm package-name availability immediately before the first public
   release.
4. [x] Move the changelog entries for the first release from `Unreleased` to
   `0.1.0`.
5. [x] Set `private:false` only in the same reviewed release-metadata pull
   request.
6. [x] Make the GitHub repository public.
7. [x] Enable required checks and branch/ruleset protection for `main`, plus a
   `v*` tag rule that prevents release-tag updates and deletion.
8. [x] Create the GitHub Environment named exactly `npm` and require owner
   approval.
9. [x] Create or claim the npm package under the selected owner. npm requires an
   existing package before `npm trust` can register a Trusted Publisher, so a
   minimal `0.0.0-trust-bootstrap` package established the identity. That
   version is deprecated and its temporary `bootstrap` dist-tag has been
   removed; `latest` points only to `0.1.0`.
10. [x] Configure npm Trusted Publishing for GitHub Actions with:
   - repository owner: the final GitHub owner;
   - repository name: the final public repository name;
   - workflow filename: `publish.yml`;
   - environment name: `npm`;
   - allowed action: `npm publish`.
11. [x] Verify that `package.json.repository.url` exactly matches the public
    GitHub repository.
12. [x] Set repository variable `NPM_PUBLISH_ENABLED=true` only after the prior
   gates are visible and reviewed.

Official references:

- npm Trusted Publishing: <https://docs.npmjs.com/trusted-publishers/>
- npm `trust` CLI: <https://docs.npmjs.com/cli/v11/commands/npm-trust/>
- GitHub generated release notes:
  <https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes>
- GitHub Releases API generated notes:
  <https://docs.github.com/en/rest/releases/releases#generate-release-notes-content-for-a-release>
- GitHub Actions OIDC:
  <https://docs.github.com/en/actions/concepts/security/openid-connect>
- GitHub release event SHA/ref contract:
  <https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release>
- GitHub branch and tag rulesets:
  <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets>

## Release Procedure

Use `vX.Y.Z` tags only. The workflow validator rejects malformed tags and
metadata drift.

1. Merge the reviewed metadata PR into `main` after all local and GitHub checks
   pass.
2. Draft a GitHub Release from the exact `main` commit.
3. Set the tag to `vX.Y.Z`, matching `package.json` and `package-lock.json`.
4. Generate release notes from `.github/release.yml`, then edit them against
   `CHANGELOG.md` and remove non-release noise.
5. Publish the GitHub Release only after confirming the `npm` environment,
   Trusted Publisher, `private:false`, and `NPM_PUBLISH_ENABLED=true` gates.
6. Approve the `npm` environment deployment when the workflow reaches the
   approval gate.

The publish job checks out the commit SHA frozen into the release event, verifies
that commit belongs to `origin/main`, installs with `npm ci --ignore-scripts`,
runs syntax tests, full tests, publish-mode release validation, and a
lifecycle-disabled package dry-run, then calls `npm publish --access public`
without an npm token secret. The release tag supplies version metadata but is
not re-resolved as the checkout target at job runtime.
The publish-mode validator also rejects npm publish lifecycle scripts and
requires README, license, and third-party notices to be repository-local regular
files present in the exact packed artifact, so symlink dereferencing cannot
substitute unreviewed external content.

## v0.3.0 Release Evidence

- Release decision and scope: [Issue #71](https://github.com/poketopa/believe-me/issues/71)
- GitHub Release: [`v0.3.0`](https://github.com/poketopa/believe-me/releases/tag/v0.3.0)
- Successful OIDC Trusted Publishing workflow:
  [run 31136975897](https://github.com/poketopa/believe-me/actions/runs/31136975897)
- Reviewed metadata and changelog PRs plus successful final main CI:
  [PR #72](https://github.com/poketopa/believe-me/pull/72),
  [PR #73](https://github.com/poketopa/believe-me/pull/73), and
  [run 31136849239](https://github.com/poketopa/believe-me/actions/runs/31136849239)
- Immutable release commit and npm `gitHead`:
  `ede4f81e225012a053ac8e6c88a0ab9c3867d1ea`
- Public package:
  [`@poketopa/believe-me@0.3.0`](https://www.npmjs.com/package/@poketopa/believe-me/v/0.3.0)
- Registry integrity:
  `sha512-kbblGNvvxOyCf6zU+sfNrozwqIqwYaY8c80ADaXHKgV/ppnVaxF1mCODKk8VySruYYnyyfxKUbQhxBZ473eDdg==`
- Registry provenance: npm exposes both its publish attestation and a SLSA
  provenance v1 attestation at the
  [package attestation endpoint](https://registry.npmjs.org/-/npm/v1/attestations/@poketopa%2fbelieve-me@0.3.0).
- Clean-install smoke: a fresh prefix installed the exact public registry
  artifact; `believeme --version` returned `0.3.0`, the help output listed
  `demo`, and `believeme demo` emitted exactly one successful JSONL record with
  receipt, review, export/verify, and approve/apply stages before reporting the
  disposable fixture removed.

## v0.2.0 Release Evidence

- GitHub Release: [`v0.2.0`](https://github.com/poketopa/believe-me/releases/tag/v0.2.0)
- Successful OIDC publish workflow:
  [run 31051398257](https://github.com/poketopa/believe-me/actions/runs/31051398257)
- Reviewed metadata PR and successful post-merge main CI:
  [PR #46](https://github.com/poketopa/believe-me/pull/46) and
  [run 31051249218](https://github.com/poketopa/believe-me/actions/runs/31051249218)
- Immutable release commit and npm `gitHead`:
  `8abe7e028b7685d92da1f7a98731f773d7737fe8`
- Public package:
  [`@poketopa/believe-me@0.2.0`](https://www.npmjs.com/package/@poketopa/believe-me/v/0.2.0)
- Registry integrity:
  `sha512-tSZI09Ow2L2VzLT5HTfEfqN5scd4B01ak/spLIpDyv+/28/dzeky/6MYg5v0ua+Sv44h792U0HOFqmx2pK1kBg==`
- Registry provenance: npm exposes both its publish attestation and a SLSA
  provenance v1 attestation at the
  [package attestation endpoint](https://registry.npmjs.org/-/npm/v1/attestations/@poketopa%2fbelieve-me@0.2.0).
- Clean-install smoke: a fresh prefix installed the public registry artifact;
  `believeme --version` returned `0.2.0`, and `believeme --help` listed `init`,
  `run`, `status`, `receipt`, `apply`, and `apply-session`.

## v0.1.0 Release Evidence

- GitHub Release: [`v0.1.0`](https://github.com/poketopa/believe-me/releases/tag/v0.1.0)
- Successful publish workflow:
  [run 30993026999](https://github.com/poketopa/believe-me/actions/runs/30993026999)
- Immutable release commit and npm `gitHead`:
  `a76e4ecc12baeb4daed747321e38708a9f5fa54e`
- Public package:
  [`@poketopa/believe-me@0.1.0`](https://www.npmjs.com/package/@poketopa/believe-me/v/0.1.0)
- Registry integrity:
  `sha512-JeIua763VzT2x0tlWmegEf2K3swDoYI0cJoB+//aMApVXolmT+XHyPznOgviZzdRvOV+UaRJBeBer+KbUNAKiQ==`
- Registry provenance: npm exposes a SLSA provenance v1 attestation at the
  [package attestation endpoint](https://registry.npmjs.org/-/npm/v1/attestations/@poketopa%2fbelieve-me@0.1.0).
- Clean-install smoke: a fresh prefix installed the public registry artifact;
  `believeme --version` returned `0.1.0`, and `believeme --help` listed the
  expected commands.

The original release-event run exposed a missing Java 21 setup step in the
tagged workflow. [PR #26](https://github.com/poketopa/believe-me/pull/26)
added the pinned Java setup for future releases. Because the protected
`v0.1.0` tag was intentionally not moved, a reviewed exact-tag/exact-commit
recovery path in [PR #27](https://github.com/poketopa/believe-me/pull/27)
published the already-frozen artifact with the same environment approval and
OIDC Trusted Publisher. The temporary manual trigger and temporary `main`
environment deployment policy were removed after publication.

For every future release, record the same release URL, workflow run, commit,
package version, integrity/provenance, and clean-install smoke evidence.

Verify the published registry artifact with:

```bash
npm view <package-name>@<version> name version dist.integrity provenance
npm install --global <package-name>@<version>
believeme --version
```

Do not claim operational publication readiness until the registry package,
provenance/integrity, and clean install are verified from npm.

## Failure Recovery

- If the workflow skips, verify `NPM_PUBLISH_ENABLED`, release event type,
  environment name, and repository visibility before changing code.
- If Trusted Publishing fails, verify npm owner/package, workflow filename
  `publish.yml`, environment `npm`, allowed action `npm publish`, and exact
  `repository.url`.
- If metadata validation fails, fix package, lock, runtime, changelog, or tag
  drift in a new PR. Do not retarget a published release tag casually; prefer a
  new reviewed release when public consumers may have observed it.
- If pack validation fails, remove unsafe or unexpected package contents and
  rerun `npm run pack:check` plus the publish-mode release check before another
  release attempt.
- If publication partially succeeds, freeze the failed run evidence, verify npm
  registry state, and decide between a patch release and deprecation. Treat
  unpublish as a last-resort registry operation.

## Deprecate and Unpublish Cautions

npm package versions are public registry records. Unpublish can remove artifacts
and has registry-policy limits; a used `package@version` cannot be reused.
Prefer deprecation when the intent is to steer users away without breaking
installs.

Official references:

- npm unpublishing packages:
  <https://docs.npmjs.com/unpublishing-packages-from-the-registry/>
- npm unpublish policy: <https://docs.npmjs.com/policies/unpublish/>
- npm deprecating packages:
  <https://docs.npmjs.com/deprecating-and-undeprecating-packages-or-package-versions/>
