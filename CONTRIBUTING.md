# Contributing

## Development workflow

1. Open one feature, bug, or experiment issue that states expected behavior and
   acceptance criteria. Unclear public-contract, provider-boundary, or release-policy
   changes may begin as an RFC.
2. Create one focused branch for that issue. Adaptive milestone branches use
   `codex/m5-NN-short-slug`.
3. Add or update tests before changing a public contract.
4. Run `npm test`, `npm run check`, and `npm run pack:check`.
5. Open one primary pull request using the repository template and link it with
   `Closes #N`. Open a Draft PR early for public-contract, lifecycle,
   benchmark-protocol, or multi-module changes.
6. Move newly discovered scope into follow-up issues instead of expanding the current
   issue and pull request silently.
7. After required checks pass, squash-merge with the Conventional Commit pull-request
   title and delete the branch.

An ADR is required for lifecycle, persistence, trust-boundary, evidence-schema,
adapter-contract, or public CLI changes.

## Experiment workflow

Use the experiment issue form for an optimization, routing, context, retry, verifier,
or benchmark intervention. Register the hypothesis, frozen control, single principal
intervention, primary and secondary metrics, frozen inputs, protocol-invalid
conditions, acceptance criteria, scope, non-goals, risk, and expected release impact
before live provider runs.

The pull request must report the ablation result or explain why benchmarking is not
applicable. Preserve negative, inconclusive, timeout, infrastructure, safety, and
missing-data outcomes. State observed regressions and limit the claim to the exact
frozen evidence; do not turn a pilot or open analysis cut into a population claim.

## Release-impact workflow

Run `npm run release:check` when a change touches package metadata, release
workflow files, packed files, third-party notices, security policy, generated
release-note configuration, or public claims.

Do not change package versions, create a public tag, publish a GitHub Release,
or change `NPM_PUBLISH_ENABLED` inside an ordinary feature PR. Release
activation requires an owner-approved release issue, a dedicated metadata PR,
passing release-mode validation, and the protected publication workflow.

Every pull request selects one release type: `none`, `patch`, `minor`, or `breaking`.
User-visible changes add an `Unreleased` changelog entry. Internal governance or
measurement-only work may select `none`. Release type records intent; it does not
authorize a version change, tag, GitHub Release, or npm publication.

Before any public npm release, `THIRD_PARTY_NOTICES.md` must either contain
durable written redistribution/license confirmation for adapted owner-source
components or those components must be replaced through clean-room work.

## Commit and pull-request titles

Use Conventional Commit style, for example:

- `feat(core): add immutable run specification`
- `fix(apply): reject stale source receipt`
- `docs(adr): explain workflow gate boundary`
