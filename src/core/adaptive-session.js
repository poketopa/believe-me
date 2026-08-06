import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  ADAPTIVE_SESSION_TERMINAL_REASONS,
  ADAPTIVE_TIMING_COMPONENTS,
  validateAdaptiveAttempt,
  validateAdaptiveSession,
} from "../contracts/adaptive-session.js";
import { validateContextPack } from "../contracts/context-pack.js";
import { validateExecutionPolicy, validateRouteSelection } from "../contracts/execution-policy.js";
import {
  infraError,
  notFound,
  safetyRefusal,
  usageError,
  verificationFailed,
} from "../contracts/errors.js";
import { canonicalJSONLine, canonicalJSONLineBytes } from "./canonical-json.js";
import { sha256CanonicalJSON, sha256Hex } from "./hash.js";
import { containsLikelyCredential } from "./secrets.js";
import { normalizeRelativePath, readRegularFileNoFollow } from "./snapshot.js";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256_LINE_PATTERN = /^[a-f0-9]{64}\n$/u;
const MAX_RETRY_CHANGES = 64;
const MAX_DIAGNOSTIC_BYTES = 4096;
const CANCELLATION_GRACE_MS = 2_000;

function validateSessionId(sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
    throw usageError("sessionId must be a path-safe identifier.");
  }
  return sessionId;
}

function pairPaths(directory, name) {
  return Object.freeze({
    body: join(directory, `${name}.jsonl`),
    digest: join(directory, `${name}.sha256`),
  });
}

export function adaptiveSessionPaths(stateDir, sessionId) {
  const root = join(resolve(stateDir), "sessions", validateSessionId(sessionId));
  return Object.freeze({
    root,
    input: pairPaths(root, "input"),
    final: pairPaths(root, "session"),
    failure: pairPaths(root, "failure"),
    attempts: join(root, "attempts"),
  });
}

function attemptPaths(paths, index) {
  return pairPaths(paths.attempts, `attempt-${String(index).padStart(4, "0")}`);
}

function claimPaths(paths, index) {
  return pairPaths(paths.attempts, `claim-${String(index).padStart(4, "0")}`);
}

function claimValue(request, input) {
  return Object.freeze({
    schema_version: { major: 1 },
    session_id: input.session_id,
    attempt_index: request.attemptIndex,
    attempt_id: request.attemptId,
    child_run_id: request.childRunId,
    route_reason: request.routeReason,
    retry_context_sha256: request.retryContext === null
      ? null
      : sha256CanonicalJSON(request.retryContext),
    policy_sha256: input.policy_sha256,
    context_pack_sha256: input.context_pack_sha256,
  });
}

async function claimAttempt(paths, request, input) {
  const pathsForClaim = claimPaths(paths, request.attemptIndex);
  const expected = claimValue(request, input);
  if (await pairExists(pathsForClaim)) {
    const stored = await readPair(
      pathsForClaim,
      `Adaptive attempt claim ${request.attemptIndex}`,
    );
    if (sha256CanonicalJSON(stored.value) !== sha256CanonicalJSON(expected)) {
      throw safetyRefusal("Adaptive attempt claim does not match frozen session state.");
    }
    return Object.freeze({ resumed: true, sha256: stored.sha256 });
  }
  const written = await writePair(pathsForClaim, expected);
  return Object.freeze({ resumed: false, sha256: written.sha256 });
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    return true;
  }
}

async function acquireSessionLock(paths) {
  const path = join(paths.root, "session.lock");
  const owner_token = randomUUID();
  const value = Object.freeze({
    schema_version: { major: 1 },
    pid: process.pid,
    owner_token,
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(path, canonicalJSONLine(value), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return Object.freeze({ path, owner_token });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const { bytes } = await readRegularFileNoFollow(path, "Adaptive session lock");
      let existing;
      try {
        existing = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw safetyRefusal("Adaptive session lock is malformed.");
      }
      if (
        existing?.schema_version?.major !== 1 ||
        typeof existing.owner_token !== "string" ||
        existing.owner_token.length === 0 ||
        !Number.isSafeInteger(existing.pid)
      ) {
        throw safetyRefusal("Adaptive session lock is malformed.");
      }
      if (processIsAlive(existing.pid)) {
        throw safetyRefusal("Adaptive session is already active.");
      }
      await rm(path, { force: false });
    }
  }
  throw safetyRefusal("Adaptive session lock could not be acquired.");
}

async function releaseSessionLock(lock) {
  const { bytes } = await readRegularFileNoFollow(
    lock.path,
    "Adaptive session lock",
  ).catch((error) => {
    if (error.code === "ENOENT") return { bytes: null };
    throw error;
  });
  if (bytes === null) return;
  let existing;
  try {
    existing = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw safetyRefusal("Adaptive session lock changed while owned.");
  }
  if (existing.owner_token !== lock.owner_token) {
    throw safetyRefusal("Adaptive session lock ownership changed unexpectedly.");
  }
  await rm(lock.path, { force: false });
}

async function ensureSessionRoots(stateDir) {
  const stateRoot = resolve(stateDir);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const stateStats = await lstat(stateRoot);
  if (stateStats.isSymbolicLink() || !stateStats.isDirectory()) {
    throw safetyRefusal("Adaptive session state directory must be a real directory.");
  }
  const sessionsRoot = join(stateRoot, "sessions");
  await mkdir(sessionsRoot, { recursive: false, mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const sessionsStats = await lstat(sessionsRoot);
  if (sessionsStats.isSymbolicLink() || !sessionsStats.isDirectory()) {
    throw safetyRefusal("Adaptive sessions path must be a real directory.");
  }
  return sessionsRoot;
}

async function assertRealDirectory(path, label, missingError) {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT" && missingError !== undefined) {
      throw missingError();
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw safetyRefusal(`${label} must be a real directory.`);
  }
  return path;
}

async function assertExistingSessionPaths(stateDir, sessionId) {
  const paths = adaptiveSessionPaths(stateDir, sessionId);
  const stateRoot = resolve(stateDir);
  await assertRealDirectory(
    stateRoot,
    "Adaptive session state directory",
    () => notFound("Adaptive session state directory does not exist.", {
      state_dir: stateRoot,
    }),
  );
  await assertRealDirectory(
    join(stateRoot, "sessions"),
    "Adaptive sessions path",
    () => notFound("Adaptive sessions directory does not exist.", {
      state_dir: stateRoot,
    }),
  );
  await assertRealDirectory(
    paths.root,
    "Adaptive session artifact root",
    () => notFound("Adaptive session does not exist.", {
      session_id: validateSessionId(sessionId),
    }),
  );
  return paths;
}

async function writePair(paths, value) {
  const line = canonicalJSONLine(value);
  const sha256 = sha256Hex(Buffer.from(line, "utf8"));
  await writeFile(paths.body, line, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await writeFile(paths.digest, `${sha256}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return Object.freeze({ value, sha256 });
}

async function readPair(paths, label) {
  const [body, digest] = await Promise.all([
    readRegularFileNoFollow(paths.body, `${label} body`),
    readRegularFileNoFollow(paths.digest, `${label} digest`),
  ]);
  const line = body.bytes.toString("utf8");
  const digestLine = digest.bytes.toString("utf8");
  if (!line.endsWith("\n") || line.slice(0, -1).includes("\n")) {
    throw safetyRefusal(`${label} must be exactly one JSON line.`);
  }
  if (!SHA256_LINE_PATTERN.test(digestLine)) {
    throw safetyRefusal(`${label} digest must be one lowercase SHA-256 line.`);
  }
  const sha256 = sha256Hex(Buffer.from(line, "utf8"));
  if (sha256 !== digestLine.slice(0, -1)) {
    throw safetyRefusal(`${label} digest mismatch.`);
  }
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw safetyRefusal(`${label} JSON is malformed.`);
  }
  if (sha256Hex(canonicalJSONLineBytes(value)) !== sha256) {
    throw safetyRefusal(`${label} is not canonical JSONL.`);
  }
  return Object.freeze({ value, sha256 });
}

async function pairExists(paths) {
  const existence = await Promise.all([paths.body, paths.digest].map(async (path) =>
    lstat(path).then(() => true).catch((error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    })));
  if (existence[0] !== existence[1]) {
    throw safetyRefusal("Adaptive session artifact pair is incomplete.");
  }
  return existence[0];
}

async function readRequiredPair(paths, label, missingError) {
  if (!await pairExists(paths)) {
    throw missingError();
  }
  return readPair(paths, label);
}

function validateStringSet(values, field) {
  if (!Array.isArray(values)) throw usageError(`${field} must be an array.`);
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || seen.has(value)) {
      throw usageError(`${field} must contain unique non-empty strings.`);
    }
    seen.add(value);
  }
  return Object.freeze([...seen].sort());
}

function boundedUtf8(value, maxBytes) {
  if (typeof value !== "string") return "";
  let output = value;
  while (Buffer.byteLength(output, "utf8") > maxBytes) {
    output = output.slice(0, -1);
  }
  return output;
}

function retryChanges(changes = []) {
  if (!Array.isArray(changes) || changes.length > MAX_RETRY_CHANGES) {
    throw safetyRefusal("Retry candidate changes exceed the registered bound.");
  }
  const seen = new Set();
  return changes.map((change) => {
    const path = normalizeRelativePath("/adaptive-session-root", change?.path);
    if (seen.has(path) || !/^[a-f0-9]{64}$/u.test(change?.sha256 ?? "")) {
      throw safetyRefusal("Retry candidate changes are invalid or duplicated.");
    }
    seen.add(path);
    return Object.freeze({ path, sha256: change.sha256 });
  });
}

export function buildAdaptiveRetryContext({
  contextPack,
  priorAttempt,
  candidateChanges = [],
  verifierDiagnostics = {},
}) {
  const pack = validateContextPack(contextPack);
  const message = boundedUtf8(verifierDiagnostics.message ?? "", MAX_DIAGNOSTIC_BYTES);
  if (containsLikelyCredential(Buffer.from(message, "utf8"))) {
    throw safetyRefusal("Verifier diagnostics contain credential-like text.");
  }
  const code = boundedUtf8(verifierDiagnostics.code ?? "verification_failed", 128);
  const adapterId = boundedUtf8(verifierDiagnostics.adapter_id ?? "unknown-verifier", 128);
  if (code.length === 0 || adapterId.length === 0) {
    throw safetyRefusal("Verifier diagnostics require registered code and adapter id.");
  }
  return Object.freeze({
    schema_version: { major: 1 },
    prior_attempt_id: priorAttempt.attempt_id,
    prior_child_run_id: priorAttempt.child_run_id,
    prior_child_run_evidence_sha256: priorAttempt.child_run_evidence_sha256,
    source_snapshot_sha256: pack.source_snapshot_sha256,
    context_pack_sha256: sha256CanonicalJSON(pack),
    candidate_changes: retryChanges(candidateChanges),
    verifier_diagnostics: Object.freeze({
      adapter_id: adapterId,
      code,
      message,
      truncated: message !== (verifierDiagnostics.message ?? ""),
    }),
    context_pack: pack,
  });
}

function validateRetryContext(value, contextPackSha256) {
  if (value === null) return null;
  if (value?.schema_version?.major !== 1) {
    throw safetyRefusal("Retry context schema is unsupported.");
  }
  if (value.context_pack_sha256 !== contextPackSha256) {
    throw safetyRefusal("Retry context is not bound to the frozen ContextPack.");
  }
  const rebuilt = buildAdaptiveRetryContext({
    contextPack: value.context_pack,
    priorAttempt: {
      attempt_id: value.prior_attempt_id,
      child_run_id: value.prior_child_run_id,
      child_run_evidence_sha256: value.prior_child_run_evidence_sha256,
    },
    candidateChanges: value.candidate_changes,
    verifierDiagnostics: value.verifier_diagnostics,
  });
  if (sha256CanonicalJSON(rebuilt) !== sha256CanonicalJSON(value)) {
    throw safetyRefusal("Retry context contains unsupported or unbound fields.");
  }
  return rebuilt;
}

function missingTiming(reason = "adapter_not_instrumented") {
  return Object.freeze({
    wall_ms: 0,
    ...Object.fromEntries(ADAPTIVE_TIMING_COMPONENTS.flatMap((component) => [
      [component, null],
      [`${component}_missing_reason`, reason],
    ])),
  });
}

function normalizeOutcome(outcome, request, input, expectedFeatures) {
  if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome)) {
    throw usageError("Adaptive child runner must return an outcome object.");
  }
  const selection = validateRouteSelection(outcome.route_selection);
  if (
    outcome.source_snapshot_sha256 !==
    input.context_pack.source_snapshot_sha256
  ) {
    throw safetyRefusal(
      "Child evidence source snapshot does not match the frozen ContextPack.",
    );
  }
  if (
    selection.policy_sha256 !== input.policy_sha256 ||
    selection.reason !== request.routeReason
  ) {
    throw safetyRefusal("Child route selection does not match the frozen session request.");
  }
  if (
    selection.features.context_bytes !== input.context_pack.total_bytes ||
    (expectedFeatures !== null &&
      sha256CanonicalJSON(selection.features) !==
        sha256CanonicalJSON(expectedFeatures))
  ) {
    throw safetyRefusal(
      "Child route features do not match the frozen adaptive session.",
    );
  }
  const attempt = validateAdaptiveAttempt({
    attempt_index: request.attemptIndex,
    attempt_id: request.attemptId,
    child_run_id: request.childRunId,
    attempt_claim_sha256: request.attemptClaimSha256,
    child_run_evidence_sha256: outcome.child_run_evidence_sha256,
    route_id: selection.route_id,
    route_reason: selection.reason,
    adapter_id: selection.adapter_id,
    model_id: selection.model_id,
    reasoning_effort: selection.reasoning_effort,
    route_features: selection.features,
    route_features_sha256: selection.features_sha256,
    context_pack_sha256: input.context_pack_sha256,
    status: outcome.status,
    verification_status: outcome.verification_status,
    winner: outcome.status === "completed",
    usage: outcome.usage ?? null,
    usage_missing_reason: outcome.usage === undefined
      ? "adapter_not_instrumented"
      : outcome.usage_missing_reason,
    timing: outcome.timing ?? missingTiming(),
    cost: outcome.cost ?? null,
    cost_missing_reason: outcome.cost === undefined
      ? "provider_not_reported"
      : outcome.cost_missing_reason,
    retry_context_sha256: request.retryContext === null
      ? null
      : sha256CanonicalJSON(request.retryContext),
    failure_code: outcome.failure_code ?? null,
  }, {
    contextPackSha256: input.context_pack_sha256,
    expectedIndex: request.attemptIndex,
  });
  return Object.freeze({ attempt, selection, outcome });
}

function sumUsage(attempts) {
  if (attempts.some((attempt) => attempt.usage === null)) return null;
  const fields = [
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ];
  return Object.freeze(Object.fromEntries(fields.map((field) => [
    field,
    attempts.reduce((sum, attempt) => sum + attempt.usage[field], 0),
  ])));
}

function sumTiming(attempts) {
  const timing = { wall_ms: attempts.reduce((sum, attempt) => sum + attempt.timing.wall_ms, 0) };
  for (const component of ADAPTIVE_TIMING_COMPONENTS) {
    const values = attempts.map((attempt) => attempt.timing[component]);
    if (values.every((value) => value !== null)) {
      timing[component] = values.reduce((sum, value) => sum + value, 0);
      timing[`${component}_missing_reason`] = null;
    } else {
      timing[component] = null;
      timing[`${component}_missing_reason`] = attempts.find(
        (attempt) => attempt.timing[component] === null,
      ).timing[`${component}_missing_reason`];
    }
  }
  return Object.freeze(timing);
}

function sumCost(attempts) {
  if (attempts.some((attempt) => attempt.cost === null)) return null;
  const [first] = attempts;
  if (attempts.some((attempt) =>
    attempt.cost.currency !== first.cost.currency ||
    attempt.cost.pricing_source !== first.cost.pricing_source)) return null;
  return Object.freeze({
    observation_status: attempts.every(
      (attempt) => attempt.cost.observation_status === "observed_billed",
    ) ? "observed_billed" : "estimated",
    amount: attempts.reduce((sum, attempt) => sum + attempt.cost.amount, 0),
    currency: first.cost.currency,
    pricing_source: first.cost.pricing_source,
  });
}

function buildSession(input, attempts, terminalReason) {
  const aggregateUsage = sumUsage(attempts);
  const aggregateCost = sumCost(attempts);
  return validateAdaptiveSession({
    schema_version: { major: 1 },
    session_id: input.session_id,
    policy_sha256: input.policy_sha256,
    context_pack_sha256: input.context_pack_sha256,
    attempts,
    aggregate_usage: aggregateUsage,
    aggregate_usage_missing_reason: aggregateUsage === null
      ? "adapter_not_instrumented"
      : null,
    aggregate_timing: sumTiming(attempts),
    aggregate_cost: aggregateCost,
    aggregate_cost_missing_reason: aggregateCost === null
      ? "provider_not_reported"
      : null,
    terminal_reason: terminalReason,
  });
}

function nextTransition(normalized, attempts, input) {
  const { attempt, outcome } = normalized;
  if (attempt.winner) return { terminalReason: "winner" };
  const routeReason = retryRouteReason(attempt, input);
  if (routeReason === null) return { terminalReason: "terminal_failure" };
  if (attempts.length >= input.policy.attempt_budget) {
    return { terminalReason: "attempt_budget_exhausted" };
  }
  if (attempts.some((entry) => entry.usage === null)) {
    return { terminalReason: "telemetry_missing" };
  }
  const totalTokens = attempts.reduce((sum, entry) => sum + entry.usage.total_tokens, 0);
  if (totalTokens >= input.policy.token_budget) {
    return { terminalReason: "token_budget_exhausted" };
  }
  const totalWall = attempts.reduce((sum, entry) => sum + entry.timing.wall_ms, 0);
  if (totalWall >= input.policy.wall_budget_ms) {
    return { terminalReason: "wall_budget_exhausted" };
  }
  if (input.policy.cost_budget !== undefined) {
    if (attempts.some((entry) => entry.cost === null)) {
      return { terminalReason: "telemetry_missing" };
    }
    if (attempts.some((entry) =>
      entry.cost.currency !== input.policy.cost_budget.currency ||
      entry.cost.pricing_source !== input.policy.cost_budget.pricing_source)) {
      return { terminalReason: "terminal_failure" };
    }
    const totalCost = attempts.reduce((sum, entry) => sum + entry.cost.amount, 0);
    if (totalCost >= input.policy.cost_budget.amount) {
      return { terminalReason: "cost_budget_exhausted" };
    }
  }
  if (!input.policy.routes.some((route) => route.reason === routeReason)) {
    return { terminalReason: "no_authorized_route" };
  }
  let retryContext;
  try {
    retryContext = buildAdaptiveRetryContext({
      contextPack: input.context_pack,
      priorAttempt: attempt,
      candidateChanges: outcome.candidate_changes,
      verifierDiagnostics: outcome.verifier_diagnostics,
    });
  } catch (error) {
    if (error?.code === "safety_refusal") {
      return { terminalReason: "terminal_failure" };
    }
    throw error;
  }
  return { routeReason, retryContext };
}

function validateInput(value) {
  if (value?.schema_version?.major !== 1) {
    throw safetyRefusal("Adaptive session input schema is unsupported.");
  }
  const sessionId = validateSessionId(value.session_id);
  const policy = validateExecutionPolicy(value.policy);
  const contextPack = validateContextPack(value.context_pack);
  const transientCodes = validateStringSet(
    value.transient_infra_retry_codes,
    "transient_infra_retry_codes",
  );
  const validated = Object.freeze({
    schema_version: { major: 1 },
    session_id: sessionId,
    policy,
    policy_sha256: sha256CanonicalJSON(policy),
    context_pack: contextPack,
    context_pack_sha256: sha256CanonicalJSON(contextPack),
    transient_infra_retry_codes: transientCodes,
  });
  if (sha256CanonicalJSON(validated) !== sha256CanonicalJSON(value)) {
    throw safetyRefusal("Adaptive session input contains unsupported or drifted fields.");
  }
  return validated;
}

function indexedPairStatus(names, prefix) {
  const pattern = new RegExp(`^${prefix}-(\\d{4})\\.(jsonl|sha256)$`, "u");
  const pairs = new Map();
  for (const name of names) {
    const match = pattern.exec(name);
    if (match === null) continue;
    const index = Number.parseInt(match[1], 10);
    const entry = pairs.get(index) ?? { body: false, digest: false };
    if (match[2] === "jsonl") {
      entry.body = true;
    } else {
      entry.digest = true;
    }
    pairs.set(index, entry);
  }
  for (const pair of pairs.values()) {
    if (pair.body !== pair.digest) {
      throw safetyRefusal("Adaptive session artifact pair is incomplete.");
    }
  }
  return Object.freeze([...pairs.keys()].sort((left, right) => left - right));
}

function retryRouteReason(attempt, input) {
  if (attempt.status === "verification_failed") {
    return "verifier_failure";
  }
  if (
    ["infra_error", "timeout"].includes(attempt.status) &&
    input.transient_infra_retry_codes.includes(attempt.failure_code)
  ) {
    return "transient_infra_retry";
  }
  return null;
}

function validateAttemptClaim(
  value,
  input,
  index,
  expectedRetryDigest,
  expectedRouteReason,
) {
  if (
    value?.schema_version?.major !== 1 ||
    value.session_id !== input.session_id ||
    value.attempt_index !== index ||
    typeof value.attempt_id !== "string" ||
    value.attempt_id.length === 0 ||
    typeof value.child_run_id !== "string" ||
    value.child_run_id.length === 0 ||
    value.policy_sha256 !== input.policy_sha256 ||
    value.context_pack_sha256 !== input.context_pack_sha256 ||
    value.retry_context_sha256 !== expectedRetryDigest ||
    value.route_reason !== expectedRouteReason ||
    !input.policy.routes.some((route) => route.reason === value.route_reason)
  ) {
    throw safetyRefusal("Adaptive attempt claim does not match frozen session state.");
  }
}

async function readAttemptRecords(paths, input, options = {}) {
  const records = [];
  await assertRealDirectory(
    paths.attempts,
    "Adaptive attempts path",
    () => safetyRefusal("Adaptive attempts path must be a real directory."),
  );
  const names = await readdir(paths.attempts);
  const knownArtifact = /^(?:attempt|claim)-\d{4}\.(?:jsonl|sha256)$/u;
  if (names.some((name) => !knownArtifact.test(name))) {
    throw safetyRefusal("Adaptive attempts path contains unsupported artifacts.");
  }
  const attemptIndices = indexedPairStatus(names, "attempt");
  const claimIndices = indexedPairStatus(names, "claim");
  for (const [index, actual] of attemptIndices.entries()) {
    if (actual !== index) throw safetyRefusal("Adaptive attempts must be contiguous.");
  }
  for (const [index, actual] of claimIndices.entries()) {
    if (actual !== index || actual > attemptIndices.length) {
      throw safetyRefusal("Adaptive attempt claims must be contiguous.");
    }
  }
  if (
    claimIndices.length < attemptIndices.length ||
    claimIndices.length > attemptIndices.length + 1
  ) {
    throw safetyRefusal("Every adaptive attempt requires an execution claim.");
  }
  if (
    options.allowDanglingClaim === false &&
    claimIndices.length > attemptIndices.length
  ) {
    throw safetyRefusal("A completed adaptive session cannot retain a dangling claim.");
  }
  for (const index of attemptIndices) {
    const pair = await readPair(attemptPaths(paths, index), `Adaptive attempt ${index}`);
    const attempt = validateAdaptiveAttempt(pair.value.attempt, {
      contextPackSha256: input.context_pack_sha256,
      expectedIndex: index,
    });
    const storedClaim = await readPair(
      claimPaths(paths, index),
      `Adaptive attempt claim ${index}`,
    );
    const expectedRetryDigest = index === 0
      ? null
      : sha256CanonicalJSON(records[index - 1].retry_context);
    validateAttemptClaim(
      storedClaim.value,
      input,
      index,
      expectedRetryDigest,
      index === 0
        ? "initial"
        : retryRouteReason(records[index - 1].attempt, input),
    );
    if (
      attempt.attempt_claim_sha256 !== storedClaim.sha256 ||
      storedClaim.value.attempt_id !== attempt.attempt_id ||
      storedClaim.value.child_run_id !== attempt.child_run_id ||
      storedClaim.value.route_reason !== attempt.route_reason ||
      storedClaim.value.retry_context_sha256 !== attempt.retry_context_sha256
    ) {
      throw safetyRefusal("Adaptive attempt is not bound to its execution claim.");
    }
    const route = input.policy.routes.find((candidate) =>
      candidate.route_id === attempt.route_id &&
      candidate.reason === attempt.route_reason);
    if (
      route === undefined ||
      route.adapter_id !== attempt.adapter_id ||
      route.model_id !== attempt.model_id ||
      route.reasoning_effort !== attempt.reasoning_effort ||
      attempt.route_features === undefined ||
      attempt.route_features.context_bytes !== input.context_pack.total_bytes ||
      (index > 0 && sha256CanonicalJSON(attempt.route_features) !==
        sha256CanonicalJSON(records[0].attempt.route_features))
    ) {
      throw safetyRefusal("Adaptive attempt route is not bound to frozen session input.");
    }
    const retryContext = validateRetryContext(
      pair.value.retry_context,
      input.context_pack_sha256,
    );
    if (retryContext !== null && (
      retryContext.prior_attempt_id !== attempt.attempt_id ||
      retryContext.prior_child_run_id !== attempt.child_run_id ||
      retryContext.prior_child_run_evidence_sha256 !==
        attempt.child_run_evidence_sha256
    )) {
      throw safetyRefusal("Retry context is not bound to its prior child attempt.");
    }
    if (attempt.retry_context_sha256 !== expectedRetryDigest) {
      throw safetyRefusal("Adaptive attempt retry context digest is inconsistent.");
    }
    const terminalReason = pair.value.terminal_reason ?? null;
    if (
      terminalReason !== null &&
      !ADAPTIVE_SESSION_TERMINAL_REASONS.includes(terminalReason)
    ) {
      throw safetyRefusal("Adaptive attempt terminal reason is unsupported.");
    }
    if ((terminalReason === null) === (retryContext === null)) {
      throw safetyRefusal(
        "Adaptive attempt must record exactly one terminal or retry transition.",
      );
    }
    records.push(Object.freeze({
      attempt,
      retry_context: retryContext,
      terminal_reason: terminalReason,
    }));
  }
  if (claimIndices.includes(attemptIndices.length)) {
    const expectedRetryDigest = records.length === 0
      ? null
      : sha256CanonicalJSON(records.at(-1).retry_context);
    validateAttemptClaim(
      (await readPair(
        claimPaths(paths, attemptIndices.length),
        `Adaptive attempt claim ${attemptIndices.length}`,
      )).value,
      input,
      attemptIndices.length,
      expectedRetryDigest,
      records.length === 0
        ? "initial"
        : retryRouteReason(records.at(-1).attempt, input),
    );
  }
  return records;
}

async function finalize(paths, input, attempts, terminalReason) {
  const session = buildSession(input, attempts, terminalReason);
  const written = await writePair(paths.final, session);
  return Object.freeze({
    session,
    session_receipt_sha256: written.sha256,
    paths,
  });
}

async function readCompletedSession(paths, input) {
  const pair = await readPair(paths.final, "Adaptive session");
  const session = validateAdaptiveSession(pair.value, { persisted: true });
  const records = await readAttemptRecords(paths, input, {
    allowDanglingClaim: false,
  });
  const terminalRecord = records.at(-1);
  if (
    session.session_id !== input.session_id ||
    session.policy_sha256 !== input.policy_sha256 ||
    session.context_pack_sha256 !== input.context_pack_sha256 ||
    terminalRecord?.terminal_reason !== session.terminal_reason ||
    sha256CanonicalJSON(records.map((record) => record.attempt)) !==
    sha256CanonicalJSON(session.attempts)
  ) {
    throw safetyRefusal("Adaptive session does not match its frozen input and child checkpoints.");
  }
  return Object.freeze({
    session,
    session_receipt_sha256: pair.sha256,
    input,
    paths,
  });
}

function validateParentFailure(value, input) {
  if (
    value?.schema_version?.major !== 1 ||
    value.session_id !== input.session_id ||
    !Number.isSafeInteger(value.attempt_index) ||
    value.attempt_index < 0 ||
    typeof value.attempt_id !== "string" ||
    value.attempt_id.length === 0 ||
    typeof value.child_run_id !== "string" ||
    value.child_run_id.length === 0 ||
    !/^[a-f0-9]{64}$/u.test(value.attempt_claim_sha256 ?? "") ||
    typeof value.code !== "string" ||
    value.code.length === 0
  ) {
    throw safetyRefusal("Adaptive session failure is not bound to frozen session state.");
  }
  return Object.freeze(structuredClone(value));
}

function adaptiveSessionStatusSummary({
  input,
  records,
  status,
  session = null,
  receiptSha256 = null,
}) {
  const winner = session?.attempts.find((attempt) => attempt.winner) ?? null;
  return Object.freeze({
    session_id: input.session_id,
    session_status: status,
    attempt_count: records.length,
    terminal_reason: session?.terminal_reason ?? null,
    winner_run_id: winner?.child_run_id ?? null,
    session_receipt_sha256: receiptSha256,
    policy_sha256: input.policy_sha256,
    context_pack_sha256: input.context_pack_sha256,
  });
}

async function runAttemptWithinDeadline(runner, request, paths) {
  const controller = new AbortController();
  let timer;
  let deadlineFailure = null;
  const runnerPromise = Promise.resolve().then(() =>
    runner(Object.freeze({ ...request, signal: controller.signal })));
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      deadlineFailure = Object.freeze({
        schema_version: { major: 1 },
        session_id: request.sessionId,
        attempt_index: request.attemptIndex,
        attempt_id: request.attemptId,
        child_run_id: request.childRunId,
        attempt_claim_sha256: request.attemptClaimSha256,
        code: "timeout",
        timeout_ms: request.timeoutMs,
      });
      reject(infraError("Adaptive child exceeded its parent deadline.", {
        child_run_id: request.childRunId,
        timeout_ms: request.timeoutMs,
      }));
    }, request.timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      runnerPromise,
      timeout,
    ]);
  } catch (error) {
    if (deadlineFailure !== null) {
      let graceTimer;
      try {
        await Promise.race([
          runnerPromise.then(() => undefined, () => undefined),
          new Promise((resolveGrace) => {
            graceTimer = setTimeout(resolveGrace, CANCELLATION_GRACE_MS);
          }),
        ]);
      } finally {
        clearTimeout(graceTimer);
      }
      await writePair(paths.failure, deadlineFailure);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function continueAdaptive(options, paths, input) {
  if (await pairExists(paths.failure)) {
    const failure = await readPair(paths.failure, "Adaptive session failure");
    throw safetyRefusal("Adaptive session has a terminal parent failure.", {
      failure: failure.value,
    });
  }
  if (await pairExists(paths.final)) {
    return readCompletedSession(paths, input);
  }
  const records = await readAttemptRecords(paths, input);
  const attempts = records.map((record) => record.attempt);
  let routeReason = "initial";
  let retryContext = null;
  if (records.length > 0) {
    const last = records.at(-1);
    if (last.terminal_reason !== null) {
      return finalize(paths, input, attempts, last.terminal_reason);
    }
    routeReason = last.attempt.status === "verification_failed"
      ? "verifier_failure"
      : "transient_infra_retry";
    retryContext = last.retry_context;
  }
  while (true) {
    const attemptIndex = attempts.length;
    const request = Object.freeze({
      attemptIndex,
      sessionId: input.session_id,
      attemptId: `${input.session_id}-attempt-${attemptIndex + 1}`,
      childRunId: `${input.session_id}-child-${attemptIndex + 1}`,
      routeReason,
      retryContext,
      policy: input.policy,
      contextPack: input.context_pack,
      remainingTokenBudget: input.policy.token_budget - attempts.reduce(
        (sum, attempt) => sum + (attempt.usage?.total_tokens ?? 0),
        0,
      ),
      remainingWallBudgetMs: input.policy.wall_budget_ms - attempts.reduce(
        (sum, attempt) => sum + attempt.timing.wall_ms,
        0,
      ),
      remainingCostBudget: input.policy.cost_budget === undefined
        ? null
        : input.policy.cost_budget.amount - attempts.reduce(
            (sum, attempt) => sum + (attempt.cost?.amount ?? 0),
            0,
          ),
      timeoutMs: Math.min(
        ...input.policy.routes
          .filter((route) => route.reason === routeReason)
          .map((route) => route.timeout_ms),
        input.policy.wall_budget_ms - attempts.reduce(
          (sum, attempt) => sum + attempt.timing.wall_ms,
          0,
        ),
      ),
    });
    const claim = await claimAttempt(paths, request, input);
    const runner = claim.resumed ? options.resumeAttempt : options.runAttempt;
    if (typeof runner !== "function") {
      throw safetyRefusal(
        "A claimed adaptive child requires resumeAttempt; it cannot be run again.",
      );
    }
    const claimedRequest = Object.freeze({
      ...request,
      attemptClaimSha256: claim.sha256,
      resumed: claim.resumed,
    });
    const normalized = normalizeOutcome(
      await runAttemptWithinDeadline(runner, claimedRequest, paths),
      claimedRequest,
      input,
      attempts[0]?.route_features ?? null,
    );
    attempts.push(normalized.attempt);
    const transition = nextTransition(normalized, attempts, input);
    const nextRetryContext = transition.retryContext ?? null;
    await writePair(attemptPaths(paths, attemptIndex), Object.freeze({
      attempt: normalized.attempt,
      retry_context: nextRetryContext,
      terminal_reason: transition.terminalReason ?? null,
    }));
    if (transition.terminalReason !== undefined) {
      return finalize(paths, input, attempts, transition.terminalReason);
    }
    routeReason = transition.routeReason;
    retryContext = nextRetryContext;
  }
}

async function executeAdaptive(options, resume) {
  if (!resume && typeof options.runAttempt !== "function") {
    throw usageError("runAttempt must be a function.");
  }
  const paths = adaptiveSessionPaths(options.stateDir, options.sessionId);
  await ensureSessionRoots(options.stateDir);
  let input;
  if (resume) {
    const stored = await readPair(paths.input, "Adaptive session input");
    input = validateInput(stored.value);
    if (options.policy !== undefined &&
      sha256CanonicalJSON(validateExecutionPolicy(options.policy)) !== input.policy_sha256) {
      throw safetyRefusal("Resume policy does not match frozen session input.");
    }
    if (options.contextPack !== undefined &&
      sha256CanonicalJSON(validateContextPack(options.contextPack)) !==
        input.context_pack_sha256) {
      throw safetyRefusal("Resume ContextPack does not match frozen session input.");
    }
    if (options.transientInfraRetryCodes !== undefined &&
      sha256CanonicalJSON(validateStringSet(
        options.transientInfraRetryCodes,
        "transientInfraRetryCodes",
      )) !== sha256CanonicalJSON(input.transient_infra_retry_codes)) {
      throw safetyRefusal("Resume transient retry allowlist does not match frozen input.");
    }
  } else {
    await mkdir(paths.root, { recursive: false, mode: 0o700 }).catch((error) => {
      if (error.code === "EEXIST") {
        throw safetyRefusal("Adaptive session already exists; use resume.");
      }
      throw error;
    });
    await mkdir(paths.attempts, { recursive: false, mode: 0o700 });
    input = validateInput({
      schema_version: { major: 1 },
      session_id: options.sessionId,
      policy: options.policy,
      policy_sha256: sha256CanonicalJSON(validateExecutionPolicy(options.policy)),
      context_pack: options.contextPack,
      context_pack_sha256: sha256CanonicalJSON(validateContextPack(options.contextPack)),
      transient_infra_retry_codes: validateStringSet(
        options.transientInfraRetryCodes ?? [],
        "transientInfraRetryCodes",
      ),
    });
    await writePair(paths.input, input);
  }
  const lock = await acquireSessionLock(paths);
  try {
    return await continueAdaptive(options, paths, input);
  } finally {
    await releaseSessionLock(lock);
  }
}

export async function runAdaptiveSession(options = {}) {
  return executeAdaptive(options, false);
}

export async function resumeAdaptiveSession(options = {}) {
  return executeAdaptive(options, true);
}

export async function readAdaptiveSession(stateDir, sessionId) {
  const paths = await assertExistingSessionPaths(stateDir, sessionId);
  const input = validateInput((await readRequiredPair(
    paths.input,
    "Adaptive session input",
    () => notFound("Adaptive session input does not exist.", {
      session_id: validateSessionId(sessionId),
    }),
  )).value);
  const [hasFinal, hasFailure] = await Promise.all([
    pairExists(paths.final),
    pairExists(paths.failure),
  ]);
  if (hasFinal && hasFailure) {
    throw safetyRefusal("Adaptive session has conflicting terminal artifacts.");
  }
  if (!hasFinal) {
    throw notFound("Adaptive session is not completed.", {
      session_id: validateSessionId(sessionId),
    });
  }
  return readCompletedSession(paths, input);
}

export async function readAdaptiveSessionStatus(stateDir, sessionId) {
  const paths = await assertExistingSessionPaths(stateDir, sessionId);
  const input = validateInput((await readRequiredPair(
    paths.input,
    "Adaptive session input",
    () => notFound("Adaptive session input does not exist.", {
      session_id: validateSessionId(sessionId),
    }),
  )).value);
  const [hasFinal, hasFailure] = await Promise.all([
    pairExists(paths.final),
    pairExists(paths.failure),
  ]);
  if (hasFinal && hasFailure) {
    throw safetyRefusal("Adaptive session has conflicting terminal artifacts.");
  }
  if (hasFinal) {
    const completed = await readCompletedSession(paths, input);
    return adaptiveSessionStatusSummary({
      input,
      records: completed.session.attempts,
      status: "completed",
      session: completed.session,
      receiptSha256: completed.session_receipt_sha256,
    });
  }
  const records = await readAttemptRecords(paths, input);
  if (hasFailure) {
    const parentFailure = validateParentFailure(
      (await readPair(paths.failure, "Adaptive session failure")).value,
      input,
    );
    const claim = await readRequiredPair(
      claimPaths(paths, parentFailure.attempt_index),
      `Adaptive attempt claim ${parentFailure.attempt_index}`,
      () => safetyRefusal(
        "Adaptive session failure is missing its execution claim.",
      ),
    );
    validateAttemptClaim(
      claim.value,
      input,
      parentFailure.attempt_index,
      parentFailure.attempt_index === 0
        ? null
        : sha256CanonicalJSON(records.at(-1)?.retry_context ?? null),
      parentFailure.attempt_index === 0
        ? "initial"
        : retryRouteReason(records.at(-1).attempt, input),
    );
    if (
      parentFailure.attempt_index !== records.length ||
      parentFailure.attempt_claim_sha256 !== claim.sha256 ||
      parentFailure.attempt_id !== claim.value.attempt_id ||
      parentFailure.child_run_id !== claim.value.child_run_id
    ) {
      throw safetyRefusal(
        "Adaptive session failure is not bound to its execution claim.",
      );
    }
    return adaptiveSessionStatusSummary({
      input,
      records,
      status: "parent_failed",
    });
  }
  if (records.at(-1)?.terminal_reason !== null && records.length > 0) {
    throw safetyRefusal("Adaptive session terminal attempt is missing its final session.");
  }
  return adaptiveSessionStatusSummary({
    input,
    records,
    status: "in_progress",
  });
}

export function resolveAdaptiveSessionWinner(session) {
  const validated = validateAdaptiveSession(session, { persisted: true });
  const winners = validated.attempts.filter((attempt) => attempt.winner);
  if (winners.length !== 1) {
    throw verificationFailed("Adaptive session has no unique verified winner.");
  }
  return winners[0];
}
