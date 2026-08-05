import {
  RUN_STATE_IMMUTABLE_FIELDS,
  validateRunState,
} from "../contracts/run-state.js";
import { safetyRefusal, usageError } from "../contracts/errors.js";

export const LIFECYCLE_TRANSITIONS = Object.freeze({
  draft: Object.freeze(["planned", "rejected"]),
  planned: Object.freeze(["executing", "rejected"]),
  executing: Object.freeze(["verified", "rejected", "rolled_back"]),
  verified: Object.freeze(["receipted", "rejected"]),
  receipted: Object.freeze(["approved", "rejected"]),
  approved: Object.freeze(["applied", "rolled_back", "rejected"]),
  applied: Object.freeze([]),
  rolled_back: Object.freeze([]),
  rejected: Object.freeze([]),
});

const ADVANCE_GUARDS = Object.freeze({
  receipted: ["receipt_sha256"],
  approved: ["receipt_sha256", "approval_sha256"],
  applied: ["receipt_sha256", "approval_sha256"],
});

const STATE_AWARE_IMMUTABLE_FIELDS = Object.freeze([
  "receipt_sha256",
  "approval_sha256",
]);

export function canTransitionLifecycle(from, to) {
  return LIFECYCLE_TRANSITIONS[from]?.includes(to) === true;
}

export function assertLifecycleTransition(from, to) {
  if (!canTransitionLifecycle(from, to)) {
    throw usageError(`Invalid lifecycle transition '${from}' -> '${to}'.`, {
      from,
      to,
    });
  }
}

export function assertRunStateImmutableFields(previousState, nextState) {
  for (const field of RUN_STATE_IMMUTABLE_FIELDS) {
    if (previousState[field] !== nextState[field]) {
      throw safetyRefusal(`RunState immutable field '${field}' changed.`, {
        field,
      });
    }
  }

  for (const field of STATE_AWARE_IMMUTABLE_FIELDS) {
    if (
      Object.hasOwn(previousState, field) &&
      previousState[field] !== nextState[field]
    ) {
      throw safetyRefusal(`RunState immutable field '${field}' changed.`, {
        field,
      });
    }
  }
}

export function assertLifecycleGuards(nextState) {
  for (const field of ADVANCE_GUARDS[nextState.lifecycle_state] ?? []) {
    if (!Object.hasOwn(nextState, field) || nextState[field] === "") {
      throw safetyRefusal(
        `RunState cannot enter '${nextState.lifecycle_state}' without '${field}'.`,
        { field, lifecycle_state: nextState.lifecycle_state },
      );
    }
  }
}

export function advanceRunState(previousState, patch) {
  const previous = validateRunState(previousState, { persisted: true });
  const rawNext = {
    ...previous,
    ...patch,
  };

  assertLifecycleTransition(previous.lifecycle_state, rawNext.lifecycle_state);
  assertRunStateImmutableFields(previous, rawNext);
  const next = validateRunState(rawNext, { persisted: true });
  assertLifecycleGuards(next);
  return next;
}
