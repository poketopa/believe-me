# Design decisions

## Receipt-hash approval instead of a boolean flag

**Decision:** approval supplies the exact SHA-256 of the receipt being applied.

**Reason:** a generic yes/no approval can be replayed against changed evidence.
Digest equality binds the user's approval to one canonical receipt and candidate.

**Consequence:** any evidence change requires a new receipt and approval.

## Fresh verification at apply

**Decision:** apply checks the source snapshot and reruns the frozen verifier on
a fresh candidate copy immediately before committing source mutations.

**Reason:** a verifier pass during the original run cannot establish that the
source remained unchanged or that candidate bytes still produce the same result.

**Consequence:** apply costs another verifier execution but rejects stale source,
candidate drift, and verifier-created source mutation.

## Immutable recovery locks

**Decision:** an interrupted recovery lock is preserved for manual investigation
instead of being silently stolen or deleted by a later apply attempt.

**Reason:** lock replacement can conceal an incomplete mutation or allow two
owners to disagree about filesystem and lifecycle state.

**Consequence:** recovery residue blocks progress until explicitly investigated
and archived or removed.

## Unsigned portable evidence remains read-only

**Decision:** portable bundles provide deterministic embedded bytes and binding
verification without import, approval, or apply capability.

**Reason:** content integrity does not prove signer identity, trusted execution,
time, or freshness. Treating the bundle as authority would collapse those
separate claims.

**Consequence:** bundles are independently checkable and relocatable, while
identity attestation remains a future optional layer.

## Hermetic verification is opt-in

**Decision:** direct bounded command verification remains the compatibility path;
Bubblewrap and rootless OCI boundaries require explicit frozen authority.

**Reason:** runtime and platform availability are not broad enough to change the
default without breaking existing verified workflows.

**Consequence:** direct mode's network-sandbox limitation stays explicit, and a
future default change requires compatibility, operational, and semver evidence.

## The public demo is disposable and dependency-free

**Decision:** `believeme demo` generates its Node fixture inside a private
temporary directory, uses the deterministic executor and built-in Node test
runner, applies only to that fixture, and removes it before returning.

**Reason:** the first successful experience must work from the packed npm
artifact without credentials, Java, databases, container runtimes, repository
fixtures, or mutation of the caller's project.

**Consequence:** the command is an additive public CLI contract requiring a minor
release. Its result demonstrates lifecycle and packaging, not AI efficacy or
external provenance.
