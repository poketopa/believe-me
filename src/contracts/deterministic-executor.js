import { usageError } from "./errors.js";
import {
  EXECUTOR_INPUT_REQUIRED_FIELDS,
  EXECUTOR_RESULT_REQUIRED_FIELDS,
  validateExecutorInput,
  validateExecutorResult,
} from "./executor.js";

export const DETERMINISTIC_EXECUTOR_INPUT_REQUIRED_FIELDS =
  EXECUTOR_INPUT_REQUIRED_FIELDS;

export const DETERMINISTIC_EXECUTOR_RESULT_REQUIRED_FIELDS =
  EXECUTOR_RESULT_REQUIRED_FIELDS;

function assertDeterministicExecutorKind(value) {
  if (value !== "deterministic") {
    throw usageError("executor_kind must be deterministic.", {
      field: "executor_kind",
      expected: "deterministic",
      actual: value,
    });
  }
}

export function validateDeterministicExecutorInput(value, options = {}) {
  const validated = validateExecutorInput(value, options);
  assertDeterministicExecutorKind(validated.executor_kind);
  return validated;
}

export function validateDeterministicExecutorResult(value, options = {}) {
  const validated = validateExecutorResult(value, options);
  assertDeterministicExecutorKind(validated.executor_kind);
  return validated;
}

export const freezeDeterministicExecutorInput =
  validateDeterministicExecutorInput;
export const freezeDeterministicExecutorResult =
  validateDeterministicExecutorResult;
