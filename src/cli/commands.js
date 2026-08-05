import { randomUUID } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { createCodexExecutor } from "../adapters/codex-executor.js";
import { createManifestVerifier } from "../adapters/manifest-verifier.js";
import { applyEvidenceBundle } from "../core/apply.js";
import { readEvidenceBundle } from "../core/evidence.js";
import {
  runDeterministicHarness,
  runHarness,
} from "../core/run-orchestrator.js";
import { readRunState } from "../core/state-store.js";
import {
  notFound,
  safetyRefusal,
  usageError,
  verificationFailed,
} from "../contracts/errors.js";
import { validateExecutorResult } from "../contracts/executor.js";
import { validateCodexTaskInput } from "../contracts/codex-executor.js";
import { canonicalJSONLine } from "../core/canonical-json.js";
import { readRegularFileNoFollow } from "../core/snapshot.js";
import { readFrozenRunInputs } from "../core/run-artifacts.js";
import {
  readAdaptiveSession,
  resolveAdaptiveSessionWinner,
} from "../core/adaptive-session.js";

const INIT_CONFIG_FILE = "config.jsonl";
const REVIEWABLE_LIFECYCLE_STATES = Object.freeze([
  "verified",
  "receipted",
  "approved",
  "applied",
  "rolled_back",
]);

function resolveProjectPath(cwd, project = ".") {
  return resolve(cwd, project);
}

function resolveStatePath(projectRoot, stateDir) {
  if (stateDir === undefined) {
    return join(projectRoot, ".harness");
  }
  return isAbsolute(stateDir) ? resolve(stateDir) : resolve(projectRoot, stateDir);
}

function commandPaths(parsed, cwd) {
  const projectRoot = resolveProjectPath(cwd, parsed.project);
  return Object.freeze({
    projectRoot,
    stateDir: resolveStatePath(projectRoot, parsed.stateDir),
  });
}

async function assertProjectDirectory(projectRoot) {
  const stats = await lstat(projectRoot).catch((error) => {
    if (error.code === "ENOENT") {
      throw notFound("Project directory does not exist.", {
        project_path: projectRoot,
      });
    }
    throw error;
  });
  if (stats.isSymbolicLink()) {
    throw safetyRefusal("Project directory must not be a symlink.", {
      project_path: projectRoot,
    });
  }
  if (!stats.isDirectory()) {
    throw notFound("Project path is not a directory.", {
      project_path: projectRoot,
    });
  }
}

async function ensureRealDirectory(path) {
  let stats = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (stats === null) {
    try {
      await mkdir(path, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }
    stats = await lstat(path);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw safetyRefusal("Harness state path must be a real directory.", {
      path,
    });
  }
}

async function ensureStateDirectory(projectRoot, stateDir) {
  if (stateDir === projectRoot) {
    throw safetyRefusal("State directory must not be the project root.");
  }
  const stateRelative = relative(projectRoot, stateDir);
  const insideProject =
    stateRelative !== "" &&
    stateRelative !== ".." &&
    !stateRelative.startsWith(`..${sep}`);
  if (insideProject) {
    const segments = stateRelative.split(sep);
    if (segments[0] !== ".harness") {
      throw safetyRefusal(
        "A state directory inside the project must stay under '.harness'.",
        { state_dir: stateDir },
      );
    }
    let current = projectRoot;
    for (const segment of segments) {
      current = join(current, segment);
      await ensureRealDirectory(current);
    }
    return;
  }

  const { root } = parse(stateDir);
  let current = root;
  for (const segment of relative(root, stateDir).split(sep).filter(Boolean)) {
    current = join(current, segment);
    await ensureRealDirectory(current);
  }
}

async function initializeProject(projectRoot, stateDir) {
  await assertProjectDirectory(projectRoot);
  await ensureStateDirectory(projectRoot, stateDir);
  const config = Object.freeze({
    schema_version: { major: 1 },
    project_path: projectRoot,
    state_dir: stateDir,
  });
  const line = canonicalJSONLine(config);
  const configPath = join(stateDir, INIT_CONFIG_FILE);
  let created = true;
  try {
    await writeFile(configPath, line, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
    created = false;
    const { bytes } = await readRegularFileNoFollow(
      configPath,
      "Harness init config",
    );
    if (bytes.toString("utf8") !== line) {
      throw safetyRefusal("Existing harness config does not match this project.", {
        path: configPath,
      });
    }
  }
  return Object.freeze({
    created,
    project_path: projectRoot,
    state_dir: stateDir,
    config_path: configPath,
  });
}

async function mapMissingRun(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw notFound("Run or artifact does not exist.");
    }
    throw error;
  }
}

async function readBoundRunState(stateDir, runId, dependencies) {
  const stored = await mapMissingRun(() => dependencies.readRunState(
    stateDir,
    runId,
  ));
  if (stored.state.run_id !== runId) {
    throw safetyRefusal("Persisted run id does not match the requested run.", {
      requested_run_id: runId,
      persisted_run_id: stored.state.run_id ?? null,
    });
  }
  return stored;
}

async function readBoundReceipt(stateDir, runId, dependencies, options = {}) {
  const stored = await readBoundRunState(stateDir, runId, dependencies);
  if (stored.state.lifecycle_state === "rejected") {
    throw verificationFailed("Rejected run did not produce an approved receipt.", {
      run_id: runId,
    });
  }
  if (
    options.review === true &&
    !REVIEWABLE_LIFECYCLE_STATES.includes(stored.state.lifecycle_state)
  ) {
    throw safetyRefusal("Run lifecycle state cannot be reviewed.", {
      run_id: runId,
      lifecycle_state: stored.state.lifecycle_state,
      allowed_lifecycle_states: REVIEWABLE_LIFECYCLE_STATES,
    });
  }
  if (!stored.state.receipt_sha256) {
    throw notFound("Run has not produced a receipt.", { run_id: runId });
  }
  const evidence = await mapMissingRun(() => dependencies.readEvidenceBundle(
    stored.state.artifact_root,
  ));
  assertReceiptBoundToState(stored.state, evidence);
  return Object.freeze({
    ...stored,
    evidence,
  });
}

function assertReceiptBoundToState(state, evidence) {
  if (
    !state.receipt_sha256 ||
    state.receipt_sha256 !== evidence.receipt_sha256
  ) {
    throw safetyRefusal("Receipt hash does not match persisted run state.");
  }
  for (const field of [
    "run_id",
    "manifest_sha256",
    "workflow_plan_sha256",
    "source_snapshot_sha256",
  ]) {
    if (state[field] !== evidence.receipt[field]) {
      throw safetyRefusal(`Receipt field '${field}' does not match run state.`, {
        field,
      });
    }
  }
}

async function readReceiptCommand(stateDir, runId, dependencies) {
  const { state, evidence } = await readBoundReceipt(stateDir, runId, dependencies);
  return Object.freeze({
    run_id: runId,
    lifecycle_state: state.lifecycle_state,
    receipt_sha256: evidence.receipt_sha256,
    receipt: evidence.receipt,
  });
}

function assertReviewVerification(verification) {
  if (verification === null || typeof verification !== "object" || Array.isArray(verification)) {
    throw safetyRefusal("Stored verification artifact is malformed.");
  }
  if (
    verification.schema_version === null ||
    typeof verification.schema_version !== "object" ||
    Array.isArray(verification.schema_version) ||
    verification.schema_version.major !== 1
  ) {
    throw safetyRefusal("Stored verification artifact schema is unsupported.", {
      schema_version: verification.schema_version ?? null,
    });
  }
  if (typeof verification.adapter_id !== "string" || verification.adapter_id.length === 0) {
    throw safetyRefusal("Stored verification artifact is missing adapter_id.");
  }
  if (typeof verification.status !== "string" || verification.status.length === 0) {
    throw safetyRefusal("Stored verification artifact is missing status.");
  }
  if (verification.status !== "passed") {
    throw verificationFailed("Stored verification artifact did not pass.", {
      adapter_id: verification.adapter_id,
      status: verification.status,
    });
  }
  return verification;
}

function assertReviewResult(result, state) {
  let validated;
  try {
    validated = validateExecutorResult(result, { persisted: true });
  } catch (error) {
    throw safetyRefusal("Stored result artifact is malformed.", {
      cause_code: error.code ?? null,
    });
  }
  if (validated.run_id !== state.run_id) {
    throw safetyRefusal("Evidence result run id does not match run state.", {
      expected_run_id: state.run_id,
      actual_run_id: validated.run_id,
    });
  }
  if (validated.executor_kind !== state.executor_kind) {
    throw safetyRefusal("Evidence result executor kind does not match run state.", {
      expected_executor_kind: state.executor_kind,
      actual_executor_kind: validated.executor_kind,
    });
  }
  return validated;
}

function freezeReviewChanges(changes) {
  return Object.freeze(changes.map((change) => Object.freeze({
    path: change.path,
    sha256: change.sha256,
  })));
}

async function readReviewCommand(stateDir, runId, dependencies) {
  const { state, sha256: stateSha256, evidence } = await readBoundReceipt(
    stateDir,
    runId,
    dependencies,
    { review: true },
  );
  const verification = assertReviewVerification(evidence.verification);
  const result = assertReviewResult(evidence.result, state);

  return Object.freeze({
    run_id: runId,
    lifecycle_state: state.lifecycle_state,
    state_sha256: stateSha256,
    review_status: "stored_evidence_verified",
    approval: Object.freeze({
      method: evidence.receipt.approval_method,
      receipt_sha256: evidence.receipt_sha256,
    }),
    bindings: Object.freeze({
      manifest_sha256: evidence.receipt.manifest_sha256,
      workflow_plan_sha256: evidence.receipt.workflow_plan_sha256,
      source_snapshot_sha256: evidence.receipt.source_snapshot_sha256,
      verification_sha256: evidence.receipt.verification_sha256,
      result_sha256: evidence.receipt.result_sha256,
    }),
    verification: Object.freeze({
      adapter_id: verification.adapter_id,
      status: verification.status,
    }),
    changes: freezeReviewChanges(result.changes),
  });
}

function dependencies(options) {
  return {
    applyEvidenceBundle: options.applyEvidenceBundle ?? applyEvidenceBundle,
    createCodexExecutor: options.createCodexExecutor ?? createCodexExecutor,
    createManifestVerifier:
      options.createManifestVerifier ?? createManifestVerifier,
    readEvidenceBundle: options.readEvidenceBundle ?? readEvidenceBundle,
    readRunState: options.readRunState ?? readRunState,
    readFrozenRunInputs:
      options.readFrozenRunInputs ?? readFrozenRunInputs,
    readAdaptiveSession:
      options.readAdaptiveSession ?? readAdaptiveSession,
    runDeterministicHarness:
      options.runDeterministicHarness ?? runDeterministicHarness,
    runHarness: options.runHarness ?? runHarness,
    runIdFactory: options.runIdFactory ?? (() => `run-${randomUUID()}`),
    verifyAppliedProject: options.verifyAppliedProject ?? null,
  };
}

async function applyVerifierForStoredRun(stateDir, runId, state, deps) {
  if (deps.verifyAppliedProject !== null) {
    return ({ projectRoot }) => deps.verifyAppliedProject(projectRoot);
  }
  const frozen = await deps.readFrozenRunInputs(stateDir, runId);
  if (frozen.manifest.sha256 !== state.manifest_sha256) {
    throw safetyRefusal("Frozen manifest digest does not match persisted run state.", {
      expected_sha256: state.manifest_sha256 ?? null,
      actual_sha256: frozen.manifest.sha256,
    });
  }
  const verify = deps.createManifestVerifier(frozen.manifest.value);
  return async ({ projectRoot }) => {
    const result = await verify({ workspaceRoot: projectRoot });
    return result?.status === "passed";
  };
}

export async function executeCliCommand(parsed, options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const paths = commandPaths(parsed, cwd);
  const deps = dependencies(options);

  if (parsed.command === "init") {
    return initializeProject(paths.projectRoot, paths.stateDir);
  }

  if (parsed.command === "run") {
    const runId = deps.runIdFactory();
    const runOptions = {
      runId,
      runSpec: {
        schema_version: { major: 1 },
        project_path: paths.projectRoot,
        state_dir: paths.stateDir,
        skill_manifest_path: parsed.skill,
        input_path: parsed.input,
        executor_kind: parsed.executor,
      },
    };
    const completed = parsed.executor === "codex"
      ? await deps.runHarness({
          ...runOptions,
          executor: deps.createCodexExecutor(),
          executorInputValidator: validateCodexTaskInput,
        })
      : await deps.runDeterministicHarness(runOptions);
    return Object.freeze({
      run_id: completed.state.run_id,
      lifecycle_state: completed.state.lifecycle_state,
      receipt_sha256: completed.state.receipt_sha256,
      artifact_root: completed.state.artifact_root,
      state_dir: paths.stateDir,
    });
  }

  if (parsed.command === "status") {
    const stored = await readBoundRunState(
      paths.stateDir,
      parsed.runId,
      deps,
    );
    return Object.freeze({
      state: stored.state,
      state_sha256: stored.sha256,
    });
  }

  if (parsed.command === "receipt") {
    return readReceiptCommand(paths.stateDir, parsed.runId, deps);
  }

  if (parsed.command === "review") {
    return readReviewCommand(paths.stateDir, parsed.runId, deps);
  }

  if (parsed.command === "apply") {
    const stored = await readBoundRunState(
      paths.stateDir,
      parsed.runId,
      deps,
    );
    if (stored.state.lifecycle_state === "rejected") {
      throw verificationFailed("Rejected run cannot be applied.", {
        run_id: parsed.runId,
      });
    }
    const verifier = await applyVerifierForStoredRun(
      paths.stateDir,
      parsed.runId,
      stored.state,
      deps,
    );
    const applied = await deps.applyEvidenceBundle({
      projectRoot: paths.projectRoot,
      stateDir: paths.stateDir,
      runId: parsed.runId,
      approvalSha256: parsed.approve,
      verifier,
    });
    return Object.freeze({
      run_id: applied.state.run_id,
      lifecycle_state: applied.state.lifecycle_state,
      receipt_sha256: applied.receipt_sha256,
      changed_paths: applied.changed_paths,
    });
  }

  if (parsed.command === "apply-session") {
    const storedSession = await deps.readAdaptiveSession(
      paths.stateDir,
      parsed.runId,
    );
    const winner = resolveAdaptiveSessionWinner(storedSession.session);
    const stored = await readBoundRunState(paths.stateDir, winner.child_run_id, deps);
    if (
      stored.state.receipt_sha256 !== winner.child_run_evidence_sha256 ||
      parsed.approve !== winner.child_run_evidence_sha256
    ) {
      throw safetyRefusal(
        "Adaptive winner evidence does not match the approved child receipt.",
      );
    }
    if (stored.state.lifecycle_state === "rejected") {
      throw verificationFailed("Rejected winning child cannot be applied.", {
        run_id: winner.child_run_id,
      });
    }
    const verifier = await applyVerifierForStoredRun(
      paths.stateDir,
      winner.child_run_id,
      stored.state,
      deps,
    );
    const applied = await deps.applyEvidenceBundle({
      projectRoot: paths.projectRoot,
      stateDir: paths.stateDir,
      runId: winner.child_run_id,
      approvalSha256: parsed.approve,
      verifier,
    });
    return Object.freeze({
      session_id: parsed.runId,
      run_id: applied.state.run_id,
      lifecycle_state: applied.state.lifecycle_state,
      receipt_sha256: applied.receipt_sha256,
      changed_paths: applied.changed_paths,
    });
  }

  throw usageError("Unknown CLI command.", {
    command: parsed.command ?? null,
  });
}
