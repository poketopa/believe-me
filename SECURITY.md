# Security policy

This project is pre-release and has no supported public versions yet.

## Supported versions

| Version | Supported |
| --- | --- |
| `0.0.0-development` | No public security support |

The release system is currently dormant. The maximum release claim is
`dormant contract validated; publication blocked and unproven`.

Do not open a public issue for a vulnerability involving secret exposure,
workspace escape, command injection, evidence forgery, or unsafe apply. Use
GitHub's private vulnerability reporting after it is enabled for the repository.

The security boundary includes source snapshots, allowed paths and commands,
network policy, receipts, approvals, and atomic apply/rollback behavior.

## Release security boundary

Public npm publication is blocked by `private:true`, the
`NPM_PUBLISH_ENABLED` workflow gate, owner-controlled GitHub/npm settings, and
unresolved third-party redistribution proof in `THIRD_PARTY_NOTICES.md`.
Conversational reuse permission does not establish durable public
redistribution rights; the affected adapted components must have written
license confirmation or clean-room replacement before publication.

Release changes that touch package metadata, workflow permissions, Trusted
Publishing, provenance, changelog contents, third-party notices, or support
claims require explicit release/security review.
