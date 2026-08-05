# Contributing

## Development workflow

1. Open or link an issue that states expected behavior and acceptance criteria.
2. Create a focused branch.
3. Add or update tests before changing a public contract.
4. Run `npm test`, `npm run check`, and `npm run pack:check`.
5. Open a pull request using the repository template.

An ADR is required for lifecycle, persistence, trust-boundary, evidence-schema,
adapter-contract, or public CLI changes.

## Commit and pull-request titles

Use Conventional Commit style, for example:

- `feat(core): add immutable run specification`
- `fix(apply): reject stale source receipt`
- `docs(adr): explain workflow gate boundary`
