# Threat model

## Protected assets

- original source bytes and file modes;
- frozen request, manifest, source snapshot, and workflow plan;
- candidate, verification, result, receipt, and approval bindings;
- apply journal, owner lock, rollback data, and lifecycle state;
- executor credentials admitted to a bounded adapter;
- portable evidence bytes written by an explicit export operation.

## Adversaries and failures

| Threat | Relevant capability or failure | Primary mitigation |
| --- | --- | --- |
| Unsafe generated change | Executor writes unwanted or undeclared paths | Isolated workspace, allowlisted changes, snapshot comparison |
| Verifier substitution | Live manifest changes after receipt | Frozen manifest bytes and digest-bound verifier resolution |
| Evidence tampering | Stored JSONL or sidecar changes | Canonical encoding, SHA-256 sidecars, cross-artifact binding checks |
| Stale approval | Source changes between run and apply | Source snapshot comparison immediately before mutation |
| Apply interruption | Crash after one or more filesystem mutations | Owner-token lock, journal, rollback, immutable recovery lock |
| Credential disclosure | Executor output contains credential-like material | Ephemeral adapter home, reduced environment, output screening |
| Path escape | Symlink or traversal reaches outside admitted roots | Normalized relative paths, no-follow checks, real-path boundaries |
| Verifier residue | Timed-out process or descendant survives | Process-group termination and fail-closed cleanup |
| Portable bundle misuse | Content integrity is treated as identity or authority | Read-only verification result and explicit non-goal language |

## Trust boundaries

- Executor output is untrusted until path, byte, and result contracts pass.
- A verifier is user-authorized project code. Direct mode does not make that code
  harmless; it constrains argv, environment, time, output, and cleanup.
- A receipt authorizes nothing by itself. Apply requires the exact receipt hash
  and a fresh source/verifier check.
- Review and bundle verification never import, approve, or apply candidate bytes.
- Hermetic authority is explicit, frozen, runtime-checked, and fail-closed.

## Demo-specific boundary

Invoking `believeme demo` authorizes scripted receipt-hash apply only within a
new disposable temporary project. The command accepts no caller project path,
does not load provider credentials, requires no network, and removes the project
and evidence before returning. A successful demo does not establish provider
identity, trusted execution, external reproducibility, or comparative efficacy.

## Non-goals

- proving that an AI model is correct or generally superior;
- preventing every malicious action by user-authorized verifier code in direct
  mode;
- authenticating who produced an unsigned receipt or portable bundle;
- proving freshness from stored evidence alone;
- automatically granting approval or apply authority to adaptive winners;
- supporting arbitrary package install scripts or downloading demo dependencies.

The executable checks for these boundaries live primarily in `test/integration`,
`test/unit/adapters`, `test/cli`, and `test/package-install.test.js`.
