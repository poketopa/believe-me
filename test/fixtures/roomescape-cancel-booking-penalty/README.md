# Roomescape cancellation deadline fixture

This fixture is the canonical Java/Spring proof for the harness. It implements
one narrow booking rule: an owner may cancel only while the current instant is
strictly earlier than the reservation start instant minus 30 minutes.

The oracle comes from owner requirement `P3-M04` at commit
`dc958f858882f10e11644326296690b8670ae7b5`. The referenced candidate did not
implement the rule, so this fixture is a clean-room implementation of the
written behavior rather than a source-code copy.

The fixture uses Spring transactions and JPA. H2 provides the fast default
test path. `PostgresCancellationPreservationTest` runs only when
`ROOMESCAPE_POSTGRES_URL` is present; CI supplies a real PostgreSQL service for
that required preservation proof.

The verifier-owned command is declared in `fixture.json` and executed directly
without a shell:

```text
./gradlew --no-daemon --console=plain -q test
```
