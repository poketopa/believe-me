import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildContextPack, createProjectSnapshot } from "../../src/index.js";

const nodeFixture = fileURLToPath(new URL(
  "../fixtures/node-reservation-policy/",
  import.meta.url,
));
const springFixture = fileURLToPath(new URL(
  "../fixtures/roomescape-cancel-booking-penalty/",
  import.meta.url,
));

test("Node and Spring fixtures produce deterministic task-relevant ContextPacks", async () => {
  const cases = [
    {
      root: nodeFixture,
      task: "Fix reservation policy remainingSeats requestedSeats boundary",
      expected: "src/reservation-policy.js",
    },
    {
      root: springFixture,
      task: "Fix ReservationService cancellation deadline and waiting promotion",
      expected: "src/main/java/com/roomescape/booking/application/ReservationService.java",
    },
  ];
  for (const fixture of cases) {
    const sourceSnapshot = await createProjectSnapshot(fixture.root);
    const first = await buildContextPack({
      projectRoot: fixture.root,
      sourceSnapshot,
      task: fixture.task,
    });
    const second = await buildContextPack({
      projectRoot: fixture.root,
      sourceSnapshot,
      task: fixture.task,
    });
    assert.deepEqual(first, second);
    assert.equal(first.entries.some((entry) => entry.path === fixture.expected), true);
    assert.equal(first.source_snapshot_sha256, sourceSnapshot.sha256);
  }
});
