# BelieveMe

**Don't trust the summary. Verify the run.**

A local-first execution harness that turns AI code changes into a verifiable
workflow: select policy, execute in isolation, verify evidence, approve, and
apply atomically.

> [!NOTE]
> BelieveMe v0.2.0 adds adaptive execution as an opt-in feature set without an
> efficacy claim. The frozen decision cut found insufficient comparative evidence
> for adaptive token, cost, or quality gains. The npm package is
> `@poketopa/believe-me`, and the CLI command is `believeme`.

## Install

Node.js 24 LTS or later is required.

```bash
npm install --global @poketopa/believe-me
believeme --version
```

## Product promise

The harness does not assume an AI agent is trustworthy. It binds a requested
change to a policy, workflow gates, an isolated source snapshot, verification
results, and an evidence receipt before the user may apply it.

```text
skill / policy
  -> workflow gates
  -> isolated execution
  -> verification
  -> evidence receipt
  -> explicit approval
  -> atomic apply or rollback
```

## Current development scope

- one npm CLI package;
- one Codex execution adapter;
- manifest-selected bounded command verification plus one Java/Spring reference adapter;
- one Spring use-case policy;
- one Roomescape development fixture;
- deterministic stale-source, tamper, crash, resume, and rollback tests.
- deterministic verifier mutation calibration over independent Node and Spring tasks.

The CLI surface is `init`, `run`, `status`, `receipt`, `review`,
`status-session`, `review-session`, `export-bundle`, `verify-bundle`, `apply`,
and the additive `apply-session` command for a verified adaptive-session winner.

## Current proof

The repository now includes an executor-neutral run orchestrator, deterministic
and bounded Codex executors, the contract/evidence/apply kernel, and the first
real verifier adapter. A run
freezes its manifest, run spec, source snapshot, workflow plan, and executor
input before creating an isolated workspace. Only a non-empty candidate that
passes verification can reach `receipted`; executor and verifier failures keep
typed evidence while leaving the source project unchanged.

The Codex adapter invokes the official non-interactive JSONL surface with a
fixed argument array and stdin prompt. It copies only `auth.json` into an
ephemeral Codex home, ignores user config and exec rules, disables web, shell,
plugin, browser, computer-use, and multi-agent tools, and confines edits to the
isolated workspace. The harness derives candidate bytes from the workspace,
rejects deletions and out-of-allowlist changes, and binds credential-screened raw
events, usage, and execution configuration into the result receipt.

The canonical Roomescape Spring fixture proves the strict owner cancellation
boundary, manager exemption, unchanged not-found behavior, first-waiting
promotion, transactional rollback, and PostgreSQL row preservation. Its
deterministic baseline-to-candidate run now reaches `receipted` without manual
state editing, and the resulting change set is directly compatible with the
atomic apply contract exercised by the core tests.

The fixture is verified through its pinned Gradle wrapper with a direct argv
spawn (`shell: false`). Gradle distribution and dependency versions are locked;
GitHub Actions also runs the preservation test against a digest-pinned
PostgreSQL service.

Verifier selection is no longer hard-coded by the CLI. A skill manifest may bind
an explicit `command-verifier` argv, timeout, and output limit; that exact
descriptor is frozen and reused for run, resume, receipt, and apply. Legacy
major-v1 manifests without the field retain the Spring compatibility route.
Apply re-verification runs in a fresh copy of the applied candidate, so verifier
source drift cannot contaminate the user's project.

## Paired benchmark direction

Milestone 2 adds an honest paired comparison between direct Codex execution and
the harness treatment. It keeps identical task baselines, provider settings, and
verifiers while measuring verified success, unsafe changes, pre-verification
source mutation, tokens, latency, and orchestration overhead. Infrastructure and
negative outcomes remain in the report instead of being filtered until an
experiment appears to pass.

The protocol and claim boundary are documented in
[docs/BENCHMARK.md](docs/BENCHMARK.md). Living reports are descriptive; there is
no global benchmark pass gate and no universal-efficacy claim.

The frozen v0.2 decision cut finds insufficient comparative evidence to claim
adaptive token, cost, or quality gains. The only protocol-valid live comparison is
one Roomescape direct-versus-current-harness pilot: the harness succeeded where the
direct arm did not, while using 151,237 more tokens and 49,697 ms more wall time.
No compatible live ContextPack-only, routing-only, or routing-plus-repair ledger exists.
Those features therefore remain opt-in. The canonical decision report is
`benchmarks/reports/adaptive-execution-v0.2/decision.jsonl` with SHA-256
`19434728e19e2887b0ea62989d13986b10e38f7a88c56135450ec837a5fce89f`.

## CLI contract

Every command outcome writes exactly one canonical JSONL record: success goes
to stdout and failure goes to stderr. Help and version remain plain text.

```bash
believeme init --project ./my-project

believeme run \
  --project ./my-project \
  --skill ./skill-manifest.json \
  --executor deterministic \
  --input ./candidate-changes.json

believeme status <run-id> --project ./my-project
believeme receipt <run-id> --project ./my-project
believeme review <run-id> --project ./my-project
believeme status-session <session-id> --project ./my-project
believeme review-session <session-id> --project ./my-project
believeme export-bundle <run-id> \
  --output ./run-evidence.jsonl \
  --project ./my-project
believeme verify-bundle --bundle ./run-evidence.jsonl
believeme apply <run-id> \
  --approve <receipt-sha256> \
  --project ./my-project

believeme apply-session <session-id> \
  --approve <winner-receipt-sha256> \
  --project ./my-project
```

The deterministic executor accepts a declared candidate change set. The Codex
executor accepts a task and explicit file allowlist:

```json
{
  "task": "Fix the owner cancellation deadline boundary.",
  "allowed_paths": [
    "src/main/java/com/roomescape/booking/application/ReservationService.java"
  ]
}
```

Use a manifest whose `executor_kinds` includes `codex` and whose
`input_schema_ref` is `codex-executor-input/v1`, then pass `--executor codex`.
The Codex CLI must be installed and authenticated with `codex login`. Missing
authentication, a missing executable, timeouts, malformed events, and cleanup
failures return typed `infra_error` records and never fall back to deterministic
execution. The adapter follows the official
[Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
contract.

Language-neutral verification is declared in the same manifest:

```json
{
  "verifier": {
    "schema_version": { "major": 1 },
    "adapter_id": "command-verifier",
    "command": "node",
    "args": ["--test"],
    "timeout_ms": 30000,
    "max_output_bytes": 1048576
  }
}
```

The command is spawned as exact argv with `shell: false`, a fixed project cwd,
a reduced environment, bounded combined output, timeout, and forced cleanup.
On POSIX, the verifier receives its own process group; descendant residue is
terminated and an uncleanable group fails closed instead of producing a pass.
The verifier is user-authorized project code: this adapter does not provide a
network sandbox or install dependencies. Project-relative executable paths must
start with `./`, resolve through regular non-symlink entries, and remain inside
the project; bare executable names use the reduced `PATH`.

| Exit | Meaning |
| ---: | --- |
| 0 | command succeeded |
| 2 | usage or input contract error |
| 3 | safety refusal or unsupported persisted schema |
| 4 | run or artifact not found |
| 5 | verification failed |
| 10 | infrastructure or unavailable-adapter failure |

Example success record:

```json
{"command":"run","data":{"lifecycle_state":"receipted","run_id":"run-..."},"schema_version":{"major":1},"status":"ok"}
```

The complete record also includes the receipt hash, artifact root, and state
directory. The CLI is covered both as a source process and after installing an
`npm pack` tarball into a clean temporary project. The installed tarball proof
also repairs and applies a dependency-free Node reservation policy through the
manifest-selected command verifier, demonstrating that the CLI lifecycle is not
tied to Spring.

`believeme review` is the approval-facing read-only companion to `receipt`. It
re-validates the stored evidence binding and returns a bounded summary of the
approved run without re-running the verifier, reading the current working tree,
or exposing candidate bytes. Its `stored_evidence_verified` status describes
stored canonical bytes, receipt hash links, minimal result/verifier semantics,
and run-state binding only; it is not a signature, a fresh verifier run, or a
current-source freshness claim.

`believeme status-session` reads validated adaptive-session artifacts without
creating state directories, taking a session lock, resuming a child, or running
a verifier. It distinguishes in-progress, completed, and terminal parent-failure
state while returning only bounded hashes and identifiers. `believeme
review-session` requires a completed session, validates the frozen input,
ordered attempt checkpoints, and final session receipt, and validates the
winning child receipt when one exists. `adaptive_session_verified` describes
stored content binding only: non-winning attempt hashes remain session-bound
pointers, and neither command proves identity, freshness, attestation, or a new
verifier execution.

`believeme export-bundle` writes the same validated stored evidence as one
deterministic canonical JSONL file. The output contains candidate source bytes
in base64, so export is explicit, refuses overwrite, and creates the file with
private `0600` permissions subject to a stricter process umask. The parent must
already be a real directory path, and the encoded file is limited to 64 MiB.
Two exports of unchanged stored evidence are byte-identical.

`believeme verify-bundle` reads only the supplied regular file: it does not need
the original project or `.harness`, does not rerun the verifier, and does not
compare current source. Its `portable_evidence_verified` status means the
canonical file, receipt digest, embedded verification/result digests, and their
run/executor semantics are internally consistent. The unsigned bundle does not
prove identity, provenance, freshness, or independent execution, and it cannot
be imported, approved, or applied.

## Development

Node.js 24 LTS or later is required.

Apply locks are immutable owner-token files. If an `apply.recovery.lock.jsonl`
file remains after an interrupted recovery attempt, the harness preserves it as
evidence and refuses further apply attempts until a manual investigation removes
or archives that recovery lock.

Interrupted runs resume only after revalidating the frozen input, plan,
manifest, source-tree, executor kind, and evidence hashes. A verified run with
a complete receipt can finish its lifecycle without executing the candidate
again.

```bash
npm ci
npm test
npm run check
npm run pack:check
```

An authenticated, usage-consuming Roomescape smoke is opt-in:

```bash
npm run smoke:codex
```

It stops at `receipted` and proves that the original source remains unchanged;
it does not auto-approve or apply the generated candidate.

The paired A/B pilot is also opt-in and consumes two Codex runs:

```bash
npm run benchmark:smoke:codex
```

It writes a replay-verified canonical JSONL ledger and digest under a temporary
benchmark directory. A one-pair result is labelled `pilot`; it validates the
measurement path but is not presented as efficacy evidence.

## Release and publication

The package identity is `@poketopa/believe-me`. Public releases originate from
a reviewed commit on `main`, an immutable `v*` tag, and a published GitHub
Release. The release-only workflow validates the tag, package metadata, locked
metadata, runtime identity, tests, and packed files before one final
`npm publish --access public` through npm Trusted Publishing. The workflow also
requires the protected GitHub `npm` environment and the repository variable
`NPM_PUBLISH_ENABLED=true`.

The prior owner-source licensing blocker for the three listed adapted
components is resolved by the durable rights-holder confirmation in
[Issue #22](https://github.com/poketopa/believe-me/issues/22#issuecomment-5189562788)
and recorded in `THIRD_PARTY_NOTICES.md`. See [CHANGELOG.md](CHANGELOG.md) and
[docs/RELEASING.md](docs/RELEASING.md) for the release record and verification
procedure.

## Provenance

The product selectively learns from the current harness project,
`jyt6640/persona-harness`, and `bhoon716/skill-forge`. Reused source and adapted
contracts must be recorded in `THIRD_PARTY_NOTICES.md` before publication.

## License

Apache-2.0. See [LICENSE](LICENSE).
