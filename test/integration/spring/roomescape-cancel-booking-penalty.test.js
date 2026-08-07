import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runSpringVerifier } from "../../../src/index.js";
import { isolateGradleUserHome } from "../../helpers/isolated-gradle-user-home.js";

isolateGradleUserHome("spring-fixture");

const fixtureRoot = fileURLToPath(new URL(
  "../../fixtures/roomescape-cancel-booking-penalty/",
  import.meta.url,
));

test("canonical Roomescape Spring fixture satisfies its declared oracle", {
  timeout: 240_000,
}, async () => {
  const fixture = JSON.parse(await readFile(
    new URL("../../fixtures/roomescape-cancel-booking-penalty/fixture.json", import.meta.url),
    "utf8",
  ));

  assert.equal(fixture.fixture_id, "roomescape-cancel-booking-penalty");
  assert.equal(fixture.oracle_source.implementation_origin, "clean_room");
  assert.deepEqual(fixture.verifier, {
    command: "./gradlew",
    args: ["--no-daemon", "--console=plain", "-q", "test"],
  });
  assert.deepEqual(fixture.required_assertions, [
    "owner_before_deadline_allowed",
    "owner_at_deadline_refused",
    "owner_after_deadline_refused",
    "manager_deadline_exempt",
    "manager_store_ownership_preserved",
    "manager_past_reservation_restriction_preserved",
    "owner_not_found_preserved",
    "refusal_preserves_reservation_and_waiting_order",
    "allowed_cancel_promotes_first_waiting",
    "promotion_failure_rolls_back",
    "postgresql_refusal_preserves_rows",
  ]);

  const result = await runSpringVerifier({
    fixtureRoot,
    timeoutMs: 180_000,
    maxOutputBytes: 2 * 1024 * 1024,
  });

  assert.equal(result.fixture_id, fixture.fixture_id);
  assert.equal(result.adapter_id, "spring-verifier");
  assert.deepEqual(result.argv, [fixture.verifier.command, ...fixture.verifier.args]);
  assert.equal(result.status, "passed");
  assert.equal(result.exit_code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.timed_out, false);
  assert.match(result.stdout_sha256, /^[a-f0-9]{64}$/);
  assert.match(result.stderr_sha256, /^[a-f0-9]{64}$/);
});
