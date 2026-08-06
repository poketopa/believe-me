import { resolve } from "node:path";
import { createAdaptiveCodexRegistry } from "../adapters/adaptive-codex-registry.js";
import { validateCodexTaskInput } from "../contracts/codex-executor.js";
import { validateContextPack } from "../contracts/context-pack.js";
import { infraError, safetyRefusal, usageError } from "../contracts/errors.js";
import { validateExecutionPolicy } from "../contracts/execution-policy.js";
import {
  validateAdaptiveSessionLaunch,
} from "../contracts/adaptive-session-launch.js";
import { validateSkillManifest } from "../contracts/skill-manifest.js";
import { adaptiveSessionLaunchPaths } from "./adaptive-session-launch.js";
import { sha256CanonicalJSON, sha256CanonicalJSONLine } from "./hash.js";
import { readFailedRunEvidence } from "./run-artifacts.js";
import { createProjectSnapshot, readRegularFileNoFollow } from "./snapshot.js";

function validateRetryCodes(values) {
  if (!Array.isArray(values)) {
    throw usageError("retry codes must be a JSON string array.");
  }
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) {
      throw usageError("retry codes must contain only non-empty strings.");
    }
  }
  return Object.freeze([...values]);
}

async function readJsonFile(path, label) {
  const absolute = resolve(path);
  const { bytes } = await readRegularFileNoFollow(absolute, label).catch((error) => {
    if (error.code === "ENOENT") {
      throw usageError(`${label} does not exist.`, { path: absolute });
    }
    throw error;
  });
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw usageError(`${label} must contain valid JSON.`, { path: absolute });
  }
}

function assertCodexOnlyPolicy(policy) {
  const unsupported = policy.routes
    .filter((route) => route.adapter_id !== "codex-cli")
    .map((route) => route.adapter_id);
  if (unsupported.length > 0) {
    throw infraError("Adaptive session policy references an unavailable adapter.", {
      adapter_ids: [...new Set(unsupported)].sort(),
    });
  }
}

export async function buildAdaptiveSessionLaunch(options) {
  const {
    sessionId,
    projectRoot,
    stateDir,
    skillPath,
    inputPath,
    policyPath,
    contextPath,
    riskTier,
    retryCodesPath,
  } = options;
  const [rawSkill, rawInput, rawPolicy, rawContext, rawRetryCodes] = await Promise.all([
    readJsonFile(skillPath, "Skill manifest"),
    readJsonFile(inputPath, "Codex task input"),
    readJsonFile(policyPath, "Execution policy"),
    readJsonFile(contextPath, "ContextPack"),
    retryCodesPath === undefined
      ? Promise.resolve([])
      : readJsonFile(retryCodesPath, "Transient retry codes"),
  ]);
  const skillManifest = validateSkillManifest(rawSkill);
  const taskInput = validateCodexTaskInput(rawInput);
  const policy = validateExecutionPolicy(rawPolicy);
  assertCodexOnlyPolicy(policy);
  const contextPack = validateContextPack(rawContext);
  const currentSnapshot = await createProjectSnapshot(projectRoot);
  if (contextPack.source_snapshot_sha256 !== currentSnapshot.sha256) {
    throw safetyRefusal("ContextPack is not bound to the current project snapshot.", {
      expected_sha256: currentSnapshot.sha256,
      actual_sha256: contextPack.source_snapshot_sha256,
    });
  }
  return validateAdaptiveSessionLaunch({
    schema_version: { major: 1 },
    session_id: sessionId,
    project_path: projectRoot,
    state_dir: stateDir,
    skill_manifest: skillManifest,
    skill_manifest_sha256: sha256CanonicalJSONLine(skillManifest),
    task_input: taskInput,
    task_input_sha256: sha256CanonicalJSON(taskInput),
    policy,
    policy_sha256: sha256CanonicalJSON(policy),
    context_pack: contextPack,
    context_pack_sha256: sha256CanonicalJSON(contextPack),
    risk_tier: riskTier,
    transient_infra_retry_codes: validateRetryCodes(rawRetryCodes),
    adapter_id: "codex-cli",
  });
}

function derivedChildRunSpec(launch) {
  const launchBodyPath = adaptiveSessionLaunchPaths(
    launch.state_dir,
    launch.session_id,
  ).body;
  // RunSpec remains required persisted child metadata. These compatibility
  // paths name the canonical launch artifact, but adaptive execution never
  // rereads them; every authority-bearing field is cross-validated to launch.
  return Object.freeze({
    schema_version: { major: 1 },
    project_path: launch.project_path,
    state_dir: launch.state_dir,
    skill_manifest_path: launchBodyPath,
    input_path: launchBodyPath,
    executor_kind: "codex",
  });
}

function attemptTiming(wallMs) {
  return Object.freeze({
    wall_ms: wallMs,
    executor_ms: null,
    executor_ms_missing_reason: "adapter_not_instrumented",
    verification_ms: null,
    verification_ms_missing_reason: "adapter_not_instrumented",
    orchestration_ms: null,
    orchestration_ms_missing_reason: "adapter_not_instrumented",
    localization_ms: null,
    localization_ms_missing_reason: "not_applicable",
    routing_ms: null,
    routing_ms_missing_reason: "not_applicable",
  });
}

function successOutcome(child, wallMs) {
  const usage = child.evidence?.result?.executor_evidence?.usage;
  return Object.freeze({
    child_run_evidence_sha256: child.state.receipt_sha256,
    source_snapshot_sha256: child.evidence.receipt.source_snapshot_sha256,
    route_selection: child.route_selection,
    status: "completed",
    verification_status: "passed",
    ...(usage === undefined ? {} : {
      usage,
      usage_missing_reason: null,
    }),
    timing: attemptTiming(wallMs),
  });
}

function isMissingFailedEvidence(error) {
  return error?.code === "ENOENT" ||
    error?.code === "not_found" ||
    error?.details?.cause_code === "ENOENT";
}

async function failedOutcome({ launch, request, error, wallMs }) {
  let evidence;
  try {
    evidence = await readFailedRunEvidence({
      stateDir: launch.state_dir,
      runId: request.childRunId,
    });
  } catch (evidenceError) {
    if (isMissingFailedEvidence(evidenceError)) {
      throw error;
    }
    throw evidenceError;
  }
  const status = error?.code === "verification_failed"
    ? "verification_failed"
    : error?.code === "timeout"
      ? "timeout"
      : error?.code === "safety_refusal"
        ? "safety_refusal"
        : "infra_error";
  return Object.freeze({
    child_run_evidence_sha256: evidence.sha256,
    source_snapshot_sha256: evidence.source_snapshot_sha256,
    route_selection: evidence.route_selection,
    status,
    verification_status: status === "verification_failed" ? "failed" : "not_run",
    failure_code: evidence.failure.code,
    timing: attemptTiming(wallMs),
    candidate_changes: evidence.candidate_changes,
    verifier_diagnostics: {
      adapter_id: evidence.verification?.adapter_id ?? "child-run",
      code: evidence.failure.code,
      message: evidence.failure.message,
    },
  });
}

export function createAdaptiveSessionRunners(launch, deps = {}) {
  const frozenLaunch = validateAdaptiveSessionLaunch(launch);
  const registryFactory = deps.createAdaptiveCodexRegistry ?? createAdaptiveCodexRegistry;
  const runChild = deps.runOneAttemptRoutedHarness;
  const resumeChild = deps.resumeHarness;
  const now = deps.now ?? Date.now;
  if (typeof runChild !== "function" || typeof resumeChild !== "function") {
    throw usageError("Adaptive session child harness dependencies are unavailable.");
  }
  const childOptions = (request) => Object.freeze({
    runId: request.childRunId,
    runSpec: derivedChildRunSpec(frozenLaunch),
    policy: frozenLaunch.policy,
    riskTier: frozenLaunch.risk_tier,
    routeReason: request.routeReason,
    adapterRegistry: registryFactory(frozenLaunch),
    adaptiveLaunch: frozenLaunch,
    signal: request.signal,
  });
  const executeAttempt = async (request, execute) => {
    const startedAt = now();
    try {
      const child = await execute();
      return successOutcome(child, Math.max(0, Math.trunc(now() - startedAt)));
    } catch (error) {
      return failedOutcome({
        launch: frozenLaunch,
        request,
        error,
        wallMs: Math.max(0, Math.trunc(now() - startedAt)),
      });
    }
  };
  return Object.freeze({
    async runAttempt(request) {
      return executeAttempt(request, () => runChild(childOptions(request)));
    },
    async resumeAttempt(request) {
      return executeAttempt(request, () => resumeChild({
        stateDir: frozenLaunch.state_dir,
        runId: request.childRunId,
        adapterRegistry: registryFactory(frozenLaunch),
        adaptiveLaunch: frozenLaunch,
        signal: request.signal,
      }));
    },
  });
}
