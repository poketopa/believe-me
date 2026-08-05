# Contributing

## Development workflow

1. Open or link an issue that states expected behavior and acceptance criteria.
2. Create a focused branch.
3. Add or update tests before changing a public contract.
4. Run `npm test`, `npm run check`, and `npm run pack:check`.
5. Open a pull request using the repository template.

An ADR is required for lifecycle, persistence, trust-boundary, evidence-schema,
adapter-contract, or public CLI changes.

## Release-impact workflow

Run `npm run release:check` when a change touches package metadata, release
workflow files, packed files, third-party notices, security policy, generated
release-note configuration, or public claims.

The current maximum release claim is `dormant contract validated; publication
blocked and unproven`. Do not remove `private:true`, create a public tag,
publish a GitHub Release, enable `NPM_PUBLISH_ENABLED`, configure npm Trusted
Publishing, or make npm/package-support claims inside an ordinary feature PR.

Before any public npm release, `THIRD_PARTY_NOTICES.md` must either contain
durable written redistribution/license confirmation for adapted owner-source
components or those components must be replaced through clean-room work.

## Commit and pull-request titles

Use Conventional Commit style, for example:

- `feat(core): add immutable run specification`
- `fix(apply): reject stale source receipt`
- `docs(adr): explain workflow gate boundary`
