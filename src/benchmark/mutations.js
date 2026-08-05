import {
  assertEnum,
  assertObject,
  assertRequiredFields,
  assertSha256Hex,
  assertString,
  deepFreeze,
  validateContractBase,
} from "../contracts/common.js";
import { usageError } from "../contracts/errors.js";
import { sha256CanonicalJSON, sha256Hex } from "../core/hash.js";
import { compareCodeUnit } from "../core/snapshot.js";

export const MUTATION_FAMILIES = Object.freeze([
  "condition_inversion",
  "boundary_alteration",
  "guard_or_exception_removal",
  "incorrect_return",
]);

export const MUTATION_EXPECTED_VERIFIER_OUTCOMES = Object.freeze([
  "reject",
  "accept",
  "undetermined",
]);

export const MUTATION_OUTCOMES = Object.freeze([
  "killed",
  "survived",
  "invalid",
  "equivalent_or_undetermined",
  "infrastructure",
]);

export const MUTATION_FIXTURE_KINDS = Object.freeze(["node", "spring"]);
export const MUTATION_VERIFIER_STATUSES = Object.freeze([
  "reject",
  "accept",
  "undetermined",
]);

const MUTATION_DEFINITION_REQUIRED_FIELDS = Object.freeze([
  "schema_version",
  "mutation_id",
  "task_id",
  "fixture_kind",
  "target_path",
  "baseline_sha256",
  "mutated_content_base64",
  "mutated_sha256",
  "family",
  "expected_verifier_outcome",
  "verifier",
]);

const MUTATION_REGISTRY_REQUIRED_FIELDS = Object.freeze([
  "schema_version",
  "corpus_id",
  "mutations",
]);

const MUTATION_OBSERVATION_REQUIRED_FIELDS = Object.freeze([
  "schema_version",
  "corpus_id",
  "registry_sha256",
  "mutation_id",
  "mutation_sha256",
  "task_id",
  "fixture_kind",
  "target_path",
  "baseline_sha256",
  "target_sha256",
  "expected_verifier_outcome",
  "outcome",
  "verifier_status",
  "verifier_result_sha256",
  "verifier_failure_code",
]);

const normalizedPathPattern =
  /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\/\/)[^\\\0]+$/u;

function assertNormalizedRelativePath(value, field) {
  assertString(value, field);
  if (
    value.length > 512 ||
    value.endsWith("/") ||
    !normalizedPathPattern.test(value)
  ) {
    throw usageError(`${field} must be a normalized safe relative POSIX path.`, {
      field,
    });
  }
}

function assertStringArray(value, field) {
  if (!Array.isArray(value)) {
    throw usageError(`${field} must be an array.`, { field });
  }
  for (const item of value) {
    assertString(item, field);
  }
}

function assertNullableSha256(value, field) {
  if (value !== null) {
    assertSha256Hex(value, field);
  }
}

function assertNullableString(value, field) {
  if (value !== null) {
    assertString(value, field);
  }
}

function decodeCanonicalBase64(value, field) {
  assertString(value, field);
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value) {
    throw usageError(`${field} must be canonical non-empty base64.`, { field });
  }
  return bytes;
}

function assertVerifierDescriptor(value) {
  assertRequiredFields(
    value,
    ["adapter_id", "command", "args", "timeout_ms", "max_output_bytes"],
    "verifier",
  );
  assertString(value.adapter_id, "verifier.adapter_id");
  assertString(value.command, "verifier.command");
  assertStringArray(value.args, "verifier.args");
  for (const field of ["timeout_ms", "max_output_bytes"]) {
    if (!Number.isSafeInteger(value[field]) || value[field] <= 0) {
      throw usageError(`verifier.${field} must be a positive safe integer.`, {
        field: `verifier.${field}`,
      });
    }
  }
}

function withCanonicalDigest(value, digestField) {
  const clone = structuredClone(value);
  delete clone[digestField];
  const digest = sha256CanonicalJSON(clone);
  if (Object.hasOwn(value, digestField) && value[digestField] !== digest) {
    throw usageError(`${digestField} does not match canonical mutation contract.`, {
      field: digestField,
      expected_sha256: digest,
      actual_sha256: value[digestField],
    });
  }
  return deepFreeze({ ...clone, [digestField]: digest });
}

function assertDefinitionFields(value, options) {
  validateContractBase(
    value,
    MUTATION_DEFINITION_REQUIRED_FIELDS,
    "MutationDefinition",
    options,
  );
  assertString(value.mutation_id, "mutation_id");
  assertString(value.task_id, "task_id");
  assertEnum(value.fixture_kind, "fixture_kind", MUTATION_FIXTURE_KINDS);
  assertNormalizedRelativePath(value.target_path, "target_path");
  assertSha256Hex(value.baseline_sha256, "baseline_sha256");
  const mutatedBytes = decodeCanonicalBase64(
    value.mutated_content_base64,
    "mutated_content_base64",
  );
  assertSha256Hex(value.mutated_sha256, "mutated_sha256");
  if (sha256Hex(mutatedBytes) !== value.mutated_sha256) {
    throw usageError("mutated_sha256 must match mutated_content_base64.", {
      field: "mutated_sha256",
    });
  }
  if (value.baseline_sha256 === value.mutated_sha256) {
    throw usageError("mutated_sha256 must differ from baseline_sha256.", {
      field: "mutated_sha256",
    });
  }
  assertEnum(value.family, "family", MUTATION_FAMILIES);
  assertEnum(
    value.expected_verifier_outcome,
    "expected_verifier_outcome",
    MUTATION_EXPECTED_VERIFIER_OUTCOMES,
  );
  assertVerifierDescriptor(value.verifier);
}

function expectedOutcomeForObservation(value) {
  if (value.outcome === "infrastructure") {
    return value.verifier_status === "undetermined" &&
      value.verifier_failure_code !== null;
  }
  if (value.outcome === "invalid") {
    return value.verifier_status === "undetermined" &&
      value.verifier_failure_code !== null;
  }
  if (value.outcome === "killed") {
    return value.expected_verifier_outcome === "reject" &&
      value.verifier_status === "reject" &&
      value.verifier_failure_code !== null;
  }
  if (value.outcome === "survived") {
    return value.expected_verifier_outcome === "reject" &&
      value.verifier_status === "accept" &&
      value.verifier_failure_code === null;
  }
  return (
    value.expected_verifier_outcome !== "reject" ||
    value.verifier_status === "undetermined"
  );
}

function assertObservationSemantics(value) {
  if (!expectedOutcomeForObservation(value)) {
    throw usageError(
      "mutation observation outcome contradicts expected verifier semantics.",
      { field: "outcome" },
    );
  }
  if (
    value.outcome === "equivalent_or_undetermined" &&
    value.expected_verifier_outcome === "reject" &&
    value.verifier_status !== "undetermined"
  ) {
    throw usageError(
      "reject-expected mutations must be killed, survived, invalid, infrastructure, or verifier-undetermined.",
      { field: "outcome" },
    );
  }
  if (
    (value.outcome === "killed" || value.outcome === "survived") &&
    value.baseline_sha256 === value.target_sha256
  ) {
    throw usageError("killed and survived mutations require a changed target hash.", {
      field: "target_sha256",
    });
  }
}

export function validateMutationDefinition(value, options = {}) {
  assertDefinitionFields(value, options);
  return withCanonicalDigest(value, "mutation_sha256");
}

export function validateMutationRegistry(value, options = {}) {
  validateContractBase(
    value,
    MUTATION_REGISTRY_REQUIRED_FIELDS,
    "MutationRegistry",
    options,
  );
  assertString(value.corpus_id, "corpus_id");
  if (!Array.isArray(value.mutations) || value.mutations.length === 0) {
    throw usageError("mutations must be a non-empty array.", { field: "mutations" });
  }
  if (value.mutations.length > 256) {
    throw usageError("mutation registry cannot contain more than 256 mutations.", {
      field: "mutations",
    });
  }

  const seen = new Set();
  let previousMutationId = "";
  const mutations = value.mutations.map((mutation, index) => {
    const validated = validateMutationDefinition(mutation, options);
    if (seen.has(validated.mutation_id)) {
      throw usageError("mutation_id values must be unique.", {
        field: `mutations[${index}].mutation_id`,
      });
    }
    seen.add(validated.mutation_id);
    if (index > 0 && compareCodeUnit(previousMutationId, validated.mutation_id) >= 0) {
      throw usageError("mutations must be sorted by mutation_id.", {
        field: `mutations[${index}].mutation_id`,
      });
    }
    previousMutationId = validated.mutation_id;
    return structuredClone(validated);
  });

  return withCanonicalDigest(
    {
      ...structuredClone(value),
      mutations,
    },
    "registry_sha256",
  );
}

export function validateMutationObservation(value, options = {}) {
  validateContractBase(
    value,
    MUTATION_OBSERVATION_REQUIRED_FIELDS,
    "MutationObservation",
    options,
  );
  assertString(value.corpus_id, "corpus_id");
  assertSha256Hex(value.registry_sha256, "registry_sha256");
  assertString(value.mutation_id, "mutation_id");
  assertSha256Hex(value.mutation_sha256, "mutation_sha256");
  assertString(value.task_id, "task_id");
  assertEnum(value.fixture_kind, "fixture_kind", MUTATION_FIXTURE_KINDS);
  assertNormalizedRelativePath(value.target_path, "target_path");
  assertSha256Hex(value.baseline_sha256, "baseline_sha256");
  assertSha256Hex(value.target_sha256, "target_sha256");
  assertEnum(
    value.expected_verifier_outcome,
    "expected_verifier_outcome",
    MUTATION_EXPECTED_VERIFIER_OUTCOMES,
  );
  assertEnum(value.outcome, "outcome", MUTATION_OUTCOMES);
  assertEnum(value.verifier_status, "verifier_status", MUTATION_VERIFIER_STATUSES);
  assertNullableSha256(value.verifier_result_sha256, "verifier_result_sha256");
  assertNullableString(value.verifier_failure_code, "verifier_failure_code");
  if (value.verifier_status === "accept" && value.verifier_failure_code !== null) {
    throw usageError("accept verifier status cannot preserve a failure code.", {
      field: "verifier_failure_code",
    });
  }
  assertObservationSemantics(value);
  return deepFreeze(structuredClone(value));
}
