import {
  lstat,
  mkdir,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  assertChildExecutorInputMatchesLaunch,
  assertChildManifestMatchesLaunch,
  assertRouteSelectionMatchesLaunch,
  validateAdaptiveSessionLaunch,
} from "../contracts/adaptive-session-launch.js";
import {
  HarnessContractError,
  infraError,
  notFound,
  safetyRefusal,
  usageError,
  verificationFailed,
} from "../contracts/errors.js";
import { validateRunSpec } from "../contracts/run-spec.js";
import { validateSkillManifest } from "../contracts/skill-manifest.js";
import { verifierSpecFromManifest } from "../contracts/verifier.js";
import {
  validateExecutorInput,
  validateExecutorResult,
} from "../contracts/executor.js";
import {
  validateDeterministicExecutorInput,
  validateDeterministicExecutorResult,
} from "../contracts/deterministic-executor.js";
import { createManifestVerifier } from "../adapters/manifest-verifier.js";
import { canonicalJSONLineBytes } from "./canonical-json.js";
import { writeEvidenceBundle, readEvidenceBundle, evidencePaths } from "./evidence.js";
import { sha256CanonicalJSONLine, sha256Hex } from "./hash.js";
import {
  advanceStoredRunState,
  readRunState,
  writeRunState,
} from "./state-store.js";
import { createProjectSnapshot, readRegularFileNoFollow } from "./snapshot.js";
import { compileWorkflowPlan } from "./workflow-compiler.js";
import {
  frozenRunInputPaths,
  readFrozenRunInputs,
  runArtifactRoot,
  runDirectory,
  runWorkspacePath,
  writeFailedRunEvidence,
  writeFrozenRunInputs,
} from "./run-artifacts.js";
import {
  applyDeterministicChanges,
  assertDeterministicResultMatchesWorkspace,
  createIsolatedWorkspace,
} from "./workspace.js";
import {
  createOneAttemptRoutedExecutor,
  deriveRouteFeatures,
  selectExecutionRoute,
} from "./route-selector.js";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function validateRunId(runId) {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    throw usageError("runId must be a path-safe identifier.", {
      field: "runId",
    });
  }
  return runId;
}

function resolveFromProject(projectRoot, path) {
  return isAbsolute(path) ? resolve(path) : resolve(projectRoot, path);
}

async function canonicalProjectRoot(path) {
  const absolute = resolve(path);
  const stats = await lstat(absolute).catch((error) => {
    if (error.code === "ENOENT") {
      throw notFound("Project root does not exist.", { path: absolute });
    }
    throw infraError("Project root could not be inspected.", {
      path: absolute,
      cause_code: error.code,
    });
  });
  if (stats.isSymbolicLink()) {
    throw safetyRefusal("Project root must not be a symlink.", { path: absolute });
  }
  if (!stats.isDirectory()) {
    throw usageError("Project root must be a directory.", { path: absolute });
  }
  return absolute;
}

async function canonicalStateDir(projectRoot, stateDirPath) {
  const requested = resolveFromProject(projectRoot, stateDirPath);
  const relativePath = relative(projectRoot, requested);
  if (requested === projectRoot) {
    throw safetyRefusal("State directory must not be the project root.");
  }
  const insideProject =
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`);
  if (insideProject && relativePath.split(sep)[0] !== ".harness") {
    throw safetyRefusal(
      "A state directory inside the project must stay under '.harness'.",
      { state_dir: requested },
    );
  }

  if (insideProject) {
    let current = projectRoot;
    for (const segment of relativePath.split(sep)) {
      current = join(current, segment);
      await ensureRealDirectory(current, { create: true, label: "State path" });
    }
  } else {
    await mkdir(requested, { recursive: true, mode: 0o700 }).catch((error) => {
      throw infraError("State directory could not be created.", {
        path: requested,
        cause_code: error.code,
      });
    });
    await ensureRealDirectory(requested, { create: false, label: "State directory" });
  }
  return requested;
}

async function ensureRealDirectory(path, { create, label }) {
  let stats = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (stats === null && create) {
    try {
      await mkdir(path, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw infraError(`${label} could not be created.`, {
          path,
          cause_code: error.code,
        });
      }
    }
    stats = await lstat(path);
  }
  if (stats === null) {
    throw notFound(`${label} does not exist.`, { path });
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw safetyRefusal(`${label} must be a real directory.`, { path });
  }
  return path;
}

async function readJsonInput(path, label) {
  const absolute = resolve(path);
  let bytes;
  try {
    ({ bytes } = await readRegularFileNoFollow(absolute, absolute));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw notFound(`${label} does not exist.`, { path: absolute });
    }
    if (error instanceof HarnessContractError) {
      throw error;
    }
    throw infraError(`${label} could not be read.`, {
      path: absolute,
      cause_code: error.code,
    });
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw usageError(`${label} must contain valid JSON.`, { path: absolute });
  }
}

function canonicalizeRunSpec(spec, projectRoot, stateDir) {
  return validateRunSpec({
    ...spec,
    project_path: projectRoot,
    state_dir: stateDir,
    skill_manifest_path: resolveFromProject(projectRoot, spec.skill_manifest_path),
    input_path: resolveFromProject(projectRoot, spec.input_path),
  });
}

function allowedPathsFromRawInput(rawInput) {
  if (Array.isArray(rawInput.allowed_paths)) {
    return rawInput.allowed_paths;
  }
  if (Array.isArray(rawInput.changes)) {
    return rawInput.changes.map((change) => change?.path);
  }
  throw usageError(
    "Routed executor input must expose allowed_paths or changes[].path.",
  );
}

async function createRunDirectory(stateDir, runId) {
  const runsRoot = join(stateDir, "runs");
  await ensureRealDirectory(runsRoot, {
    create: true,
    label: "Runs directory",
  });
  const directory = runDirectory(stateDir, runId);
  try {
    await mkdir(directory, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw safetyRefusal("Run id already exists; use resume instead.", {
        run_id: runId,
      });
    }
    throw infraError("Run directory could not be created.", {
      run_id: runId,
      cause_code: error.code,
    });
  }
  await ensureRealDirectory(directory, {
    create: false,
    label: "Run directory",
  });
  return directory;
}

async function assertExistingRunDirectory(stateDir, runId) {
  const paths = [stateDir, join(stateDir, "runs"), runDirectory(stateDir, runId)];
  for (const path of paths) {
    const stats = await lstat(path).catch((error) => {
      if (error.code === "ENOENT") {
        throw notFound("Run directory does not exist.", { run_id: runId });
      }
      throw error;
    });
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw safetyRefusal("Run path must contain only real directories.", {
        path,
      });
    }
  }
}

function errorDetails(error) {
  if (error?.details === null || typeof error?.details !== "object") {
    return {};
  }
  try {
    return JSON.parse(JSON.stringify(error.details));
  } catch {
    return {};
  }
}

function failureArtifact(runId, phase, error, recordedAt) {
  return {
    schema_version: { major: 1 },
    run_id: runId,
    phase,
    code: typeof error?.code === "string" ? error.code : "infra_error",
    message: typeof error?.message === "string" ? error.message : "Run failed.",
    details: errorDetails(error),
    recorded_at: recordedAt,
  };
}

function runFailureArtifact(state, phase, error, recordedAt) {
  return Object.freeze({
    ...failureArtifact(state.run_id, phase, error, recordedAt),
    executor_kind: state.executor_kind,
  });
}

function failedVerificationArtifact(error) {
  if (error?.details?.result && typeof error.details.result === "object") {
    return error.details.result;
  }
  return {
    schema_version: { major: 1 },
    adapter_id: "injected-verifier",
    status: "failed",
    error_code: typeof error?.code === "string" ? error.code : "infra_error",
  };
}

function normalizePhaseError(error, phase) {
  if (error instanceof HarnessContractError) {
    return error;
  }
  return infraError(`Run ${phase} failed unexpectedly.`, {
    cause_name: error?.name ?? "Error",
    cause_message: error?.message ?? String(error),
  });
}

async function rejectFailedRun(context, phase, error, result) {
  const artifactRoot = context.state.artifact_root;
  const failure = runFailureArtifact(
    context.state,
    phase,
    error,
    context.recordedAt(),
  );
  try {
    await writeFailedRunEvidence({
      artifactRoot,
      result,
      verification: phase === "verification"
        ? failedVerificationArtifact(error)
        : undefined,
      failure,
    });
  } catch (persistenceError) {
    if (persistenceError?.code !== "EEXIST") {
      error.failure_persistence_error = persistenceError;
    }
  }

  try {
    const currentSnapshot = await createProjectSnapshot(
      context.inputs.runSpec.value.project_path,
    );
    if (currentSnapshot.sha256 === context.state.source_snapshot_sha256) {
      const current = await readRunState(context.stateDir, context.state.run_id);
      if (["draft", "planned", "executing", "verified"].includes(
        current.state.lifecycle_state,
      )) {
        await advanceStoredRunState(
          context.stateDir,
          context.state.run_id,
          { lifecycle_state: "rejected" },
          { observed: { source_snapshot_sha256: currentSnapshot.sha256 } },
        );
      }
    }
  } catch {
    // The original error remains authoritative; persisted state is left for audit.
  }
}

function assertFrozenBindings(state, inputs) {
  const { manifest, runSpec, sourceSnapshot, workflowPlan, executorInput } = inputs;
  const plan = workflowPlan.value;
  const input = executorInput.value;
  const checks = [
    ["manifest_sha256", state.manifest_sha256, manifest.sha256],
    ["workflow_plan_sha256", state.workflow_plan_sha256, workflowPlan.sha256],
    ["source_snapshot_sha256", state.source_snapshot_sha256, sourceSnapshot.value.sha256],
    ["run_spec.executor_kind", state.executor_kind, runSpec.value.executor_kind],
    ["plan.run_id", state.run_id, plan.run_id],
    ["plan.manifest_sha256", state.manifest_sha256, plan.manifest_sha256],
    ["plan.source_snapshot_sha256", state.source_snapshot_sha256, plan.source_snapshot_sha256],
    ["plan.executor_kind", state.executor_kind, plan.executor_kind],
    ["plan.input_sha256", plan.expected_result.input_sha256, executorInput.sha256],
    ["plan.run_spec_sha256", plan.expected_result.run_spec_sha256, runSpec.sha256],
    ["executor_input.run_id", state.run_id, input.run_id],
    ["executor_input.manifest_sha256", state.manifest_sha256, input.manifest_sha256],
    ["executor_input.source_snapshot_sha256", state.source_snapshot_sha256, input.source_snapshot_sha256],
    ["executor_input.executor_kind", state.executor_kind, input.executor_kind],
  ];
  for (const [field, expected, actual] of checks) {
    if (expected !== actual) {
      throw safetyRefusal(`Frozen run binding '${field}' does not match.`, {
        field,
        expected,
        actual,
      });
    }
  }
}

function assertArtifactRoot(stateDir, runId, artifactRoot) {
  const expected = resolve(runArtifactRoot(stateDir, runId));
  if (resolve(artifactRoot) !== expected) {
    throw safetyRefusal("Run artifact root does not match the configured state directory.", {
      expected,
      actual: artifactRoot,
    });
  }
}

function assertRouteSelectionMatchesWorkflow(workflowPlan, result) {
  const plannedRoute = workflowPlan.route_selection;
  const resultRoute = result.route_selection;
  if (
    (plannedRoute === undefined) !== (resultRoute === undefined) ||
    (plannedRoute !== undefined &&
      sha256CanonicalJSONLine(plannedRoute) !== sha256CanonicalJSONLine(resultRoute))
  ) {
    throw safetyRefusal(
      "Executor result route selection does not match the frozen workflow plan.",
    );
  }
}

function validatedAdaptiveLaunch(value) {
  return value === undefined ? null : validateAdaptiveSessionLaunch(value);
}

function assertRunContextMatchesAdaptiveLaunch({
  launch,
  projectRoot,
  stateDir,
  sourceSnapshot,
  manifest,
  executorInput,
  routeSelection,
}) {
  if (launch === null) return;
  if (launch.project_path !== projectRoot || launch.state_dir !== stateDir) {
    throw safetyRefusal("Adaptive launch paths do not match child run paths.");
  }
  if (launch.context_pack.source_snapshot_sha256 !== sourceSnapshot.sha256) {
    throw safetyRefusal("Adaptive launch snapshot does not match child run snapshot.", {
      expected_sha256: launch.context_pack.source_snapshot_sha256,
      actual_sha256: sourceSnapshot.sha256,
    });
  }
  assertChildManifestMatchesLaunch(manifest, launch);
  assertChildExecutorInputMatchesLaunch(executorInput, launch);
  assertRouteSelectionMatchesLaunch(routeSelection, launch);
}

function assertEvidenceMatchesState(state, evidence, workflowPlan) {
  if (evidence.receipt_sha256 !== state.receipt_sha256 && state.receipt_sha256) {
    throw safetyRefusal("Evidence receipt hash does not match run state.");
  }
  for (const field of [
    "run_id",
    "manifest_sha256",
    "workflow_plan_sha256",
    "source_snapshot_sha256",
  ]) {
    if (evidence.receipt[field] !== state[field]) {
      throw safetyRefusal(`Evidence receipt field '${field}' does not match run state.`, {
        field,
      });
    }
  }
  const result = validateExecutorResult(evidence.result, {
    persisted: true,
  });
  if (result.run_id !== state.run_id) {
    throw safetyRefusal("Evidence result run id does not match run state.");
  }
  if (result.executor_kind !== state.executor_kind) {
    throw safetyRefusal("Evidence result executor kind does not match run state.");
  }
  assertRouteSelectionMatchesWorkflow(workflowPlan, result);
  if (evidence.verification?.status !== "passed") {
    throw safetyRefusal("Evidence verification is not a passed result.");
  }
}

async function inspectExistingEvidence(artifactRoot) {
  const paths = evidencePaths(artifactRoot);
  const entries = await Promise.all(
    Object.values(paths).map(async (path) => {
      try {
        await lstat(path);
        return true;
      } catch (error) {
        if (error.code === "ENOENT") {
          return false;
        }
        throw error;
      }
    }),
  );
  if (entries.every((entry) => entry === false)) {
    return null;
  }
  if (entries.some((entry) => entry === false)) {
    throw safetyRefusal("Run evidence bundle is incomplete after interruption.");
  }
  return readEvidenceBundle(artifactRoot);
}

async function loadResumeContext(options) {
  const runId = validateRunId(options.runId);
  const suppliedStateDir = resolve(options.stateDir);
  await assertExistingRunDirectory(suppliedStateDir, runId);
  const { state } = await readRunState(suppliedStateDir, runId).catch((error) => {
    if (error.code === "ENOENT") {
      throw notFound("Run state does not exist.", { run_id: runId });
    }
    throw error;
  });
  assertArtifactRoot(suppliedStateDir, runId, state.artifact_root);
  const inputs = await readFrozenRunInputs(suppliedStateDir, runId);
  assertFrozenBindings(state, inputs);

  const projectRoot = await canonicalProjectRoot(inputs.runSpec.value.project_path);
  const canonicalState = await canonicalStateDir(projectRoot, inputs.runSpec.value.state_dir);
  if (canonicalState !== suppliedStateDir || projectRoot !== inputs.runSpec.value.project_path) {
    throw safetyRefusal("Persisted run paths no longer resolve to their frozen locations.");
  }

  const currentSnapshot = await createProjectSnapshot(projectRoot);
  if (currentSnapshot.sha256 !== state.source_snapshot_sha256) {
    throw safetyRefusal("Source snapshot changed before run resume.", {
      expected_sha256: state.source_snapshot_sha256,
      actual_sha256: currentSnapshot.sha256,
    });
  }

  return {
    stateDir: suppliedStateDir,
    state,
    inputs,
    currentSnapshot,
    recordedAt: options.recordedAt ?? (() => new Date().toISOString()),
  };
}

async function finishFromExistingEvidence(context, evidence) {
  if (!context.state.receipt_sha256) {
    throw safetyRefusal(
      "Existing evidence is not bound by the persisted run state.",
      { lifecycle_state: context.state.lifecycle_state },
    );
  }
  assertEvidenceMatchesState(
    context.state,
    evidence,
    context.inputs.workflowPlan.value,
  );
  let state = context.state;
  const observed = {
    source_snapshot_sha256: state.source_snapshot_sha256,
    receipt_sha256: state.receipt_sha256,
  };
  if (state.lifecycle_state === "executing") {
    ({ state } = await advanceStoredRunState(
      context.stateDir,
      state.run_id,
      { lifecycle_state: "verified" },
      { observed },
    ));
  }
  if (state.lifecycle_state === "verified") {
    ({ state } = await advanceStoredRunState(
      context.stateDir,
      state.run_id,
      {
        lifecycle_state: "receipted",
        receipt_sha256: evidence.receipt_sha256,
      },
      { observed },
    ));
  }
  if (state.lifecycle_state !== "receipted") {
    throw safetyRefusal("Existing evidence cannot finalize the current lifecycle state.", {
      lifecycle_state: state.lifecycle_state,
    });
  }
  return Object.freeze({ state, evidence, workspace_root: runWorkspacePath(
    context.stateDir,
    state.run_id,
  ) });
}

async function executeRun(context, options) {
  await assertExistingRunDirectory(context.stateDir, context.state.run_id);
  let state = context.state;
  if (state.lifecycle_state === "planned") {
    ({ state } = await advanceStoredRunState(
      context.stateDir,
      state.run_id,
      { lifecycle_state: "executing" },
      { observed: { source_snapshot_sha256: state.source_snapshot_sha256 } },
    ));
    context.state = state;
    await options.onCheckpoint?.({ state });
  }
  if (state.lifecycle_state !== "executing") {
    throw safetyRefusal("Run execution requires planned or executing state.", {
      lifecycle_state: state.lifecycle_state,
    });
  }

  const existingEvidence = await inspectExistingEvidence(state.artifact_root);
  if (existingEvidence !== null) {
    return finishFromExistingEvidence(context, existingEvidence);
  }

  const workspaceRoot = runWorkspacePath(context.stateDir, state.run_id);
  await rm(workspaceRoot, { recursive: true, force: true });
  await createIsolatedWorkspace({
    projectRoot: context.inputs.runSpec.value.project_path,
    workspaceRoot,
    expectedSnapshotSha256: state.source_snapshot_sha256,
  });

  let executor = options.executor;
  if (executor === undefined && state.executor_kind === "deterministic") {
    executor = async ({ workspaceRoot: root, input }) =>
      applyDeterministicChanges({
        workspaceRoot: root,
        executorInput: input,
        validateResult: validateDeterministicExecutorResult,
      });
  }
  if (executor === undefined) {
    executor = async () => {
      throw infraError("Executor is not available for this run.", {
        executor_kind: state.executor_kind,
      });
    };
  }

  let result;
  try {
    result = validateExecutorResult(await executor({
      workspaceRoot,
      input: context.inputs.executorInput.value,
      plan: context.inputs.workflowPlan.value,
      signal: options.signal,
    }));
    if (result.run_id !== state.run_id) {
      throw safetyRefusal("Executor result run id does not match run state.");
    }
    if (result.executor_kind !== state.executor_kind) {
      throw safetyRefusal("Executor result kind does not match run state.");
    }
    assertRouteSelectionMatchesWorkflow(
      context.inputs.workflowPlan.value,
      result,
    );
    await assertDeterministicResultMatchesWorkspace({
      workspaceRoot,
      result,
      sourceSnapshot: context.inputs.sourceSnapshot.value,
    });
  } catch (caught) {
    const error = normalizePhaseError(caught, "execution");
    await rejectFailedRun(context, "execution", error, result);
    throw error;
  }

  const afterExecution = await createProjectSnapshot(
    context.inputs.runSpec.value.project_path,
  );
  if (afterExecution.sha256 !== state.source_snapshot_sha256) {
    const error = safetyRefusal("Source project changed during isolated execution.");
    await rejectFailedRun(context, "execution", error, result);
    throw error;
  }

  const verifier = options.verifier ?? createManifestVerifier(
    context.inputs.manifest.value,
  );
  let verification;
  try {
    verification = await verifier({
      workspaceRoot,
      result,
      plan: context.inputs.workflowPlan.value,
      signal: options.signal,
    });
    if (verification === true) {
      verification = {
        schema_version: { major: 1 },
        adapter_id: "injected-verifier",
        status: "passed",
      };
    }
    if (
      verification === null ||
      typeof verification !== "object" ||
      verification.status !== "passed"
    ) {
      throw verificationFailed("Verifier did not return a passed result.", {
        verification,
      });
    }
    await assertDeterministicResultMatchesWorkspace({
      workspaceRoot,
      result,
      sourceSnapshot: context.inputs.sourceSnapshot.value,
    });
  } catch (caught) {
    const error = normalizePhaseError(caught, "verification");
    await rejectFailedRun(context, "verification", error, result);
    throw error;
  }

  const afterVerification = await createProjectSnapshot(
    context.inputs.runSpec.value.project_path,
  );
  if (afterVerification.sha256 !== state.source_snapshot_sha256) {
    const error = safetyRefusal("Source project changed during isolated verification.");
    await rejectFailedRun(context, "verification", error, result);
    throw error;
  }

  const bundle = await writeEvidenceBundle({
    artifactRoot: state.artifact_root,
    runState: state,
    verification,
    result,
    issuedAt: options.issuedAt,
  });

  ({ state } = await advanceStoredRunState(
    context.stateDir,
    state.run_id,
    {
      lifecycle_state: "verified",
      receipt_sha256: bundle.receipt_sha256,
    },
    { observed: { source_snapshot_sha256: state.source_snapshot_sha256 } },
  ));
  context.state = state;
  await options.onCheckpoint?.({ state, bundle });

  const evidence = await readEvidenceBundle(state.artifact_root);
  assertEvidenceMatchesState(
    state,
    evidence,
    context.inputs.workflowPlan.value,
  );
  return finishFromExistingEvidence(context, evidence);
}

export async function runHarness(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw usageError("Run options must be an object.");
  }
  const adaptiveLaunch = validatedAdaptiveLaunch(options.adaptiveLaunch);
  const runId = validateRunId(options.runId);
  const rawSpec = validateRunSpec(options.runSpec);

  const projectRoot = await canonicalProjectRoot(rawSpec.project_path);
  const stateDir = await canonicalStateDir(projectRoot, rawSpec.state_dir);
  let runSpec = canonicalizeRunSpec(rawSpec, projectRoot, stateDir);
  const manifest = adaptiveLaunch === null
    ? validateSkillManifest(await readJsonInput(
        runSpec.skill_manifest_path,
        "Skill manifest",
      ))
    : adaptiveLaunch.skill_manifest;
  const rawInput = adaptiveLaunch === null
    ? await readJsonInput(runSpec.input_path, "Executor input")
    : adaptiveLaunch.task_input;
  if (rawInput === null || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    throw usageError("Executor input must be an object.");
  }
  const sourceSnapshot = await createProjectSnapshot(projectRoot);
  let routeSelection;
  let selectedExecutor = options.executor;
  let inputValidator = options.executorInputValidator;
  if (options.routeRequest !== undefined) {
    if (
      options.executor !== undefined ||
      options.executorInputValidator !== undefined ||
      options.routeSelection !== undefined
    ) {
      throw usageError("Routed runs do not accept injected execution overrides.");
    }
    const request = options.routeRequest;
    if (request === null || typeof request !== "object" || Array.isArray(request)) {
      throw usageError("routeRequest must be an object.");
    }
    if (
      rawInput.context_pack !== undefined &&
      rawInput.context_pack?.source_snapshot_sha256 !== sourceSnapshot.sha256
    ) {
      throw safetyRefusal(
        "ContextPack source snapshot does not match the frozen project snapshot.",
      );
    }
    const features = deriveRouteFeatures({
      contextPack: rawInput.context_pack,
      allowedPaths: allowedPathsFromRawInput(rawInput),
      verifierKind: verifierSpecFromManifest(manifest).adapter_id,
      riskTier: request.riskTier,
    });
    routeSelection = selectExecutionRoute({
      policy: request.policy,
      features,
      reason: request.reason,
    });
    const routed = createOneAttemptRoutedExecutor({
      selection: routeSelection,
      adapterRegistry: request.adapterRegistry,
    });
    runSpec = canonicalizeRunSpec({
      ...rawSpec,
      executor_kind: routed.executor_kind,
    }, projectRoot, stateDir);
    selectedExecutor = routed.executor;
    inputValidator = routed.executor_input_validator;
  }
  const normalizedRawInput =
    typeof inputValidator === "function"
      ? inputValidator(rawInput)
      : rawInput;
  if (
    normalizedRawInput === null ||
    typeof normalizedRawInput !== "object" ||
    Array.isArray(normalizedRawInput)
  ) {
    throw usageError("Executor input validator must return an object.");
  }

  const manifestSha256 = sha256CanonicalJSONLine(manifest);
  const executorInput = validateExecutorInput({
    schema_version: { major: 1 },
    run_id: runId,
    manifest_sha256: manifestSha256,
    source_snapshot_sha256: sourceSnapshot.sha256,
    executor_kind: runSpec.executor_kind,
    input: normalizedRawInput,
  });

  const runSpecSha256 = sha256Hex(canonicalJSONLineBytes(runSpec));
  const inputSha256 = sha256Hex(canonicalJSONLineBytes(executorInput));
  const workflowPlan = compileWorkflowPlan({
    skillManifest: manifest,
    runSpec,
    sourceSnapshot,
    inputSha256,
    runSpecSha256,
    runId,
    routeSelection,
  });
  const workflowPlanSha256 = sha256CanonicalJSONLine(workflowPlan);
  if (workflowPlan.manifest_sha256 !== manifestSha256) {
    throw safetyRefusal("Compiled workflow plan manifest binding is inconsistent.");
  }
  assertRunContextMatchesAdaptiveLaunch({
    launch: adaptiveLaunch,
    projectRoot,
    stateDir,
    sourceSnapshot,
    manifest,
    executorInput,
    routeSelection,
  });

  await createRunDirectory(stateDir, runId);
  await writeFrozenRunInputs({
    stateDir,
    runId,
    manifest,
    runSpec,
    sourceSnapshot,
    workflowPlan,
    executorInput,
  });

  const artifactRoot = runArtifactRoot(stateDir, runId);
  await mkdir(artifactRoot, { recursive: false, mode: 0o700 });
  const initial = await writeRunState(stateDir, {
    schema_version: { major: 1 },
    run_id: runId,
    lifecycle_state: "draft",
    manifest_sha256: manifestSha256,
    workflow_plan_sha256: workflowPlanSha256,
    source_snapshot_sha256: sourceSnapshot.sha256,
    executor_kind: runSpec.executor_kind,
    artifact_root: artifactRoot,
  });
  const planned = await advanceStoredRunState(
    stateDir,
    runId,
    { lifecycle_state: "planned" },
    { observed: { source_snapshot_sha256: sourceSnapshot.sha256 } },
  );

  const completed = await executeRun({
    stateDir,
    state: planned.state,
    inputs: await readFrozenRunInputs(stateDir, runId),
    currentSnapshot: sourceSnapshot,
    recordedAt: options.recordedAt ?? (() => new Date().toISOString()),
  }, { ...options, executor: selectedExecutor });
  return routeSelection === undefined
    ? completed
    : Object.freeze({ ...completed, route_selection: routeSelection });
}

export async function runDeterministicHarness(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw usageError("Run options must be an object.");
  }
  const rawSpec = validateRunSpec(options.runSpec);
  if (rawSpec.executor_kind !== "deterministic") {
    throw usageError("Deterministic run requires deterministic executor.");
  }
  return runHarness({
    ...options,
    executorInputValidator(rawInput) {
      const normalized = typeof options.executorInputValidator === "function"
        ? options.executorInputValidator(rawInput)
        : rawInput;
      if (
        normalized === null ||
        typeof normalized !== "object" ||
        Array.isArray(normalized)
      ) {
        throw usageError("Executor input validator must return an object.");
      }
      validateDeterministicExecutorResult({
        schema_version: { major: 1 },
        run_id: validateRunId(options.runId),
        executor_kind: "deterministic",
        status: "completed",
        changes: normalized.changes,
      });
      return normalized;
    },
  });
}

export async function runOneAttemptRoutedHarness(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw usageError("Routed run options must be an object.");
  }
  if (options.features !== undefined) {
    throw usageError("Routed run features are derived from frozen run inputs.");
  }
  return runHarness({
    runId: options.runId,
    runSpec: options.runSpec,
    adaptiveLaunch: options.adaptiveLaunch,
    routeRequest: {
      policy: options.policy,
      riskTier: options.riskTier,
      adapterRegistry: options.adapterRegistry,
      reason: options.routeReason ?? "initial",
    },
    recordedAt: options.recordedAt,
    onCheckpoint: options.onCheckpoint,
    signal: options.signal,
  });
}

export async function resumeHarness(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw usageError("Resume options must be an object.");
  }
  const adaptiveLaunch = validatedAdaptiveLaunch(options.adaptiveLaunch);
  const context = await loadResumeContext(options);
  assertRunContextMatchesAdaptiveLaunch({
    launch: adaptiveLaunch,
    projectRoot: context.inputs.runSpec.value.project_path,
    stateDir: context.stateDir,
    sourceSnapshot: context.currentSnapshot,
    manifest: context.inputs.manifest.value,
    executorInput: context.inputs.executorInput.value,
    routeSelection: context.inputs.workflowPlan.value.route_selection,
  });
  if (context.state.lifecycle_state === "receipted") {
    const evidence = await readEvidenceBundle(context.state.artifact_root);
    assertEvidenceMatchesState(
      context.state,
      evidence,
      context.inputs.workflowPlan.value,
    );
    return Object.freeze({
      state: context.state,
      evidence,
      workspace_root: runWorkspacePath(context.stateDir, context.state.run_id),
    });
  }
  if (context.state.lifecycle_state === "verified") {
    const evidence = await readEvidenceBundle(context.state.artifact_root);
    return finishFromExistingEvidence(context, evidence);
  }
  const routeSelection = context.inputs.workflowPlan.value.route_selection;
  if (routeSelection === undefined) {
    return executeRun(context, options);
  }
  if (options.executor !== undefined) {
    throw usageError("Routed resume does not accept an injected executor.");
  }
  const routed = createOneAttemptRoutedExecutor({
    selection: routeSelection,
    adapterRegistry: options.adapterRegistry,
  });
  if (routed.executor_kind !== context.state.executor_kind) {
    throw safetyRefusal(
      "Resumed route executor kind does not match the frozen run state.",
    );
  }
  const completed = await executeRun(
    context,
    { ...options, executor: routed.executor },
  );
  return Object.freeze({ ...completed, route_selection: routeSelection });
}

export async function resumeDeterministicHarness(options = {}) {
  const context = await loadResumeContext(options);
  if (context.state.executor_kind !== "deterministic") {
    throw usageError("Deterministic resume requires deterministic executor.", {
      executor_kind: context.state.executor_kind,
    });
  }
  if (context.state.lifecycle_state === "receipted") {
    const evidence = await readEvidenceBundle(context.state.artifact_root);
    assertEvidenceMatchesState(
      context.state,
      evidence,
      context.inputs.workflowPlan.value,
    );
    return Object.freeze({
      state: context.state,
      evidence,
      workspace_root: runWorkspacePath(context.stateDir, context.state.run_id),
    });
  }
  if (context.state.lifecycle_state === "verified") {
    const evidence = await readEvidenceBundle(context.state.artifact_root);
    return finishFromExistingEvidence(context, evidence);
  }
  if (context.inputs.workflowPlan.value.route_selection !== undefined) {
    throw usageError(
      "Routed deterministic runs must resume through resumeHarness with an adapter registry.",
    );
  }
  return executeRun(context, options);
}

export function deterministicRunDebugPaths(stateDir, runId) {
  return Object.freeze({
    run_root: runDirectory(stateDir, runId),
    artifact_root: runArtifactRoot(stateDir, runId),
    workspace_root: runWorkspacePath(stateDir, runId),
    inputs: frozenRunInputPaths(stateDir, runId),
  });
}
