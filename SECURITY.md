# Security policy

Security fixes are provided for the latest stable `0.3.x` release.

## Supported versions

| Version | Supported |
| --- | --- |
| `0.3.x` | Yes |
| `< 0.3.0` | No |

Do not open a public issue for a vulnerability involving secret exposure,
workspace escape, command injection, evidence forgery, or unsafe apply. Submit
a private report through the repository's
[private vulnerability reporting form](https://github.com/poketopa/believe-me/security/advisories/new).

The security boundary includes source snapshots, allowed paths and commands,
network policy, receipts, approvals, and atomic apply/rollback behavior.

## Release security boundary

Public npm publication is allowed only through the release workflow after the
release validator, `NPM_PUBLISH_ENABLED` gate, protected GitHub `npm`
environment, and npm Trusted Publisher all agree. The durable redistribution
grant for adapted owner-source components is recorded in
`THIRD_PARTY_NOTICES.md`.

Release changes that touch package metadata, workflow permissions, Trusted
Publishing, provenance, changelog contents, third-party notices, or support
claims require explicit release/security review.
