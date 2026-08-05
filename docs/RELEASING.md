# Releasing

This project has a reviewed release contract, but it is intentionally dormant.
The current maximum claim is `dormant contract validated; publication blocked
and unproven`.

## Current State

- `package.json` keeps `private: true`.
- The package name and version remain the working values
  `verifiable-agent-harness@0.0.0-development`.
- `.github/workflows/publish.yml` listens only for a published GitHub Release,
  but the job skips unless `vars.NPM_PUBLISH_ENABLED == 'true'`.
- No npm package, GitHub Release, release tag, public repository setting,
  Trusted Publisher, or GitHub `npm` environment is created by this milestone.
- `THIRD_PARTY_NOTICES.md` still records unresolved owner-source licensing for
  adapted components. Public npm publication requires durable written
  redistribution/license confirmation for those components or clean-room
  replacement before activation.

## Local Contract Check

These commands are safe in the dormant development state:

```bash
npm run release:check
npm run check
npm test
npm run pack:check
```

`npm run release:check` must exit 0 with `mode:"development"`,
`publishable:false`, and `publicationBlocked:true` while `private:true` remains
set.

## Owner Activation Order

Complete these steps in order. Do not set `NPM_PUBLISH_ENABLED=true` until every
earlier step is done and reviewed.

1. Resolve third-party redistribution rights with durable written license
   confirmation, or replace the affected adapted components through clean-room
   implementation.
2. Choose the final npm package name and owning npm account.
3. Confirm package-name availability and update `package.json` metadata in a
   reviewed pull request.
4. Move the changelog entries for the first release from `Unreleased` to the
   chosen version.
5. Remove `private:true` only in the same reviewed release-metadata pull request.
6. Make the GitHub repository public.
7. Enable required checks and branch/ruleset protection for `main`, plus a
   `v*` tag rule that prevents release-tag updates and deletion.
8. Create the GitHub Environment named exactly `npm` and require owner approval.
9. Create or claim the npm package under the selected owner.
10. Configure npm Trusted Publishing for GitHub Actions with:
   - repository owner: the final GitHub owner;
   - repository name: the final public repository name;
   - workflow filename: `publish.yml`;
   - environment name: `npm`;
   - allowed action: `npm publish`.
11. Verify that `package.json.repository.url` exactly matches the public GitHub
   repository.
12. Set repository variable `NPM_PUBLISH_ENABLED=true` only after the prior gates
   are visible and reviewed.

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

## First Release

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

## Verification

After the workflow succeeds, record:

- GitHub Release URL and tag;
- publish workflow run URL;
- commit SHA;
- package name and version;
- npm package URL;
- npm integrity and provenance evidence;
- clean-install smoke result.

Future registry verification commands are templates. They are not executable in
the current dormant state because no public package exists:

```bash
npm view <package-name>@<version> name version dist.integrity provenance
npm install --global <package-name>@<version>
verifiable-agent-harness --version
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
