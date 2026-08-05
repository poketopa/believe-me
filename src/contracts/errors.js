export class HarnessContractError extends Error {
  constructor(code, message, details = {}, exitCode = 2) {
    super(message);
    this.name = "HarnessContractError";
    this.code = code;
    this.details = Object.freeze({ ...details });
    this.exitCode = exitCode;
  }
}

export function usageError(message, details = {}) {
  return new HarnessContractError("usage_error", message, details, 2);
}

export function persistedSchemaUnsupported(message, details = {}) {
  return new HarnessContractError(
    "persisted_schema_unsupported",
    message,
    details,
    3,
  );
}

export function safetyRefusal(message, details = {}) {
  return new HarnessContractError("safety_refusal", message, details, 3);
}

export function notFound(message, details = {}) {
  return new HarnessContractError("not_found", message, details, 4);
}

export function verificationFailed(message, details = {}) {
  return new HarnessContractError("verification_failed", message, details, 5);
}

export function infraError(message, details = {}) {
  return new HarnessContractError("infra_error", message, details, 10);
}
