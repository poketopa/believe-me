import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex, validateMutationRegistry } from "../../src/index.js";

const fixturesRoot = dirname(fileURLToPath(import.meta.url));
const schema_version = { major: 1 };

function mutateOnce(source, before, after) {
  const first = source.indexOf(before);
  if (first === -1 || source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`Mutation fixture replacement must match exactly once: ${before}`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

function definition({
  mutationId,
  taskId,
  fixtureKind,
  targetPath,
  baselineBytes,
  mutatedText,
  family,
  verifier,
}) {
  const mutatedBytes = Buffer.from(mutatedText, "utf8");
  return {
    schema_version,
    mutation_id: mutationId,
    task_id: taskId,
    fixture_kind: fixtureKind,
    target_path: targetPath,
    baseline_sha256: sha256Hex(baselineBytes),
    mutated_content_base64: mutatedBytes.toString("base64"),
    mutated_sha256: sha256Hex(mutatedBytes),
    family,
    expected_verifier_outcome: "reject",
    verifier,
  };
}

export async function buildVerifierMutationCorpus() {
  const nodeTaskId = "node-reservation-policy";
  const springTaskId = "roomescape-cancel-booking-penalty";
  const nodeRoot = join(fixturesRoot, nodeTaskId);
  const springRoot = join(fixturesRoot, springTaskId);
  const nodeTarget = "src/reservation-policy.js";
  const springTarget =
    "src/main/java/com/roomescape/booking/application/ReservationService.java";
  const nodeBytes = await readFile(join(nodeRoot, nodeTarget));
  const springBytes = await readFile(join(springRoot, springTarget));
  const nodeSource = nodeBytes.toString("utf8");
  const springSource = springBytes.toString("utf8");
  const nodeVerifier = {
    adapter_id: "command-verifier",
    command: "node",
    args: ["--test", "test/reservation-policy.test.js"],
    timeout_ms: 30_000,
    max_output_bytes: 1024 * 1024,
  };
  const springVerifier = {
    adapter_id: "command-verifier",
    command: "./gradlew",
    args: ["--no-daemon", "--console=plain", "-q", "test"],
    timeout_ms: 180_000,
    max_output_bytes: 1024 * 1024,
  };
  const nodeMutation = (mutationId, family, before, after) => definition({
    mutationId,
    taskId: nodeTaskId,
    fixtureKind: "node",
    targetPath: nodeTarget,
    baselineBytes: nodeBytes,
    mutatedText: mutateOnce(nodeSource, before, after),
    family,
    verifier: nodeVerifier,
  });
  const springMutation = (mutationId, family, before, after) => definition({
    mutationId,
    taskId: springTaskId,
    fixtureKind: "spring",
    targetPath: springTarget,
    baselineBytes: springBytes,
    mutatedText: mutateOnce(springSource, before, after),
    family,
    verifier: springVerifier,
  });

  const registry = validateMutationRegistry({
    schema_version,
    corpus_id: "verifier-calibration-node-spring-v1",
    mutations: [
      nodeMutation(
        "node-001-condition-inversion",
        "condition_inversion",
        "remainingSeats >= requestedSeats",
        "remainingSeats < requestedSeats",
      ),
      nodeMutation(
        "node-002-boundary-alteration",
        "boundary_alteration",
        "requestedSeats > 0",
        "requestedSeats >= 0",
      ),
      nodeMutation(
        "node-003-guard-removal",
        "guard_or_exception_removal",
        "    Number.isInteger(requestedSeats) &&\n",
        "",
      ),
      nodeMutation(
        "node-004-incorrect-return",
        "incorrect_return",
        "  return Number.isInteger(remainingSeats) &&",
        "  return false && Number.isInteger(remainingSeats) &&",
      ),
      springMutation(
        "spring-001-condition-inversion",
        "condition_inversion",
        "if (!now.isBefore(deadline))",
        "if (now.isBefore(deadline))",
      ),
      springMutation(
        "spring-002-boundary-alteration",
        "boundary_alteration",
        "Duration.ofMinutes(30)",
        "Duration.ofMinutes(29)",
      ),
      springMutation(
        "spring-003-guard-removal",
        "guard_or_exception_removal",
        "        validateOwnerDeadline(reservation, Instant.now(clock));\n",
        "",
      ),
      springMutation(
        "spring-004-incorrect-return",
        "incorrect_return",
        "        return LocalDateTime.of(\n                reservation.getReservedDate(),\n                reservation.getStartAt()\n        ).atZone(BUSINESS_ZONE).toInstant();",
        "        return Instant.EPOCH;",
      ),
    ],
  });
  return Object.freeze({
    registry,
    fixtureRoots: Object.freeze({
      [nodeTaskId]: nodeRoot,
      [springTaskId]: springRoot,
    }),
  });
}
