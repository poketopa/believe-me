import { randomUUID } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { createCodexExecutor } from "../adapters/codex-executor.js";
import { createManifestVerifier } from "../adapters/manifest-verifier.js";
import { applyEvidenceBundle } from "../core/apply.js";
import { readEvidenceBundle } from "../core/evidence.js";
import {
  buildPortableEvidenceBundle,
  readPortableEvidenceBundle,
  writePortableEvidenceBundle,
} from "../core/portable-evidence.js";
import {
  assertEvidenceReceiptBoundToState,
  assertReviewableLifecycle,
  storedReviewSummary,
  validateReviewEvidence,
} from "../core/review-evidence.js";
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
import { validateCodexTaskInput } from "../contracts/codex-executor.js";
import { canonicalJSONLine } from "../core/canonical-json.js";
import { readRegularFileNoFollow } from "../core/snapshot.js";
import { readFrozenRunInputs } from "../core/run-artifacts.js";
import {
  readAdaptiveSession,
  resolveAdaptiveSessionWinner,
} from "../core/adaptive-session.js";

const INIT_CONFIG_FILE = "config.jsonl";
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
  if (options.review === true) {
    assertReviewableLifecycle(stored.state);
  }
  if (!stored.state.receipt_sha256) {
    throw notFound("Run has not produced a receipt.", { run_id: runId });
  }
  const evidence = await mapMissingRun(() => dependencies.readEvidenceBundle(
    stored.state.artifact_root,
  ));
  assertEvidenceReceiptBoundToState(stored.state, evidence);
  return Object.freeze({
    ...stored,
    evidence,
  });
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

async function readValidatedReview(stateDir, runId, dependencies) {
  const { state, sha256: stateSha256, evidence } = await readBoundReceipt(
    stateDir,
    runId,
    dependencies,
    { review: true },
  );
  return validateReviewEvidence({
    state,
    stateSha256,
    evidence,
  });
}

async function readReviewCommand(stateDir, runId, dependencies) {
  return storedReviewSummary(
    await readValidatedReview(stateDir, runId, dependencies),
  );
}

function dependencies(options) {
  return {
    applyEvidenceBundle: options.applyEvidenceBundle ?? applyEvidenceBundle,
    buildPortableEvidenceBundle:
      options.buildPortableEvidenceBundle ?? buildPortableEvidenceBundle,
    createCodexExecutor: options.createCodexExecutor ?? createCodexExecutor,
    createManifestVerifier:
      options.createManifestVerifier ?? createManifestVerifier,
    readEvidenceBundle: options.readEvidenceBundle ?? readEvidenceBundle,
    readPortableEvidenceBundle:
      options.readPortableEvidenceBundle ?? readPortableEvidenceBundle,
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
    writePortableEvidenceBundle:
      options.writePortableEvidenceBundle ?? writePortableEvidenceBundle,
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
  const deps = dependencies(options);

  if (parsed.command === "verify-bundle") {
    return deps.readPortableEvidenceBundle(parsed.bundle, { cwd });
  }

  const paths = commandPaths(parsed, cwd);

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

  if (parsed.command === "export-bundle") {
    const validated = await readValidatedReview(
      paths.stateDir,
      parsed.runId,
      deps,
    );
    const bundle = deps.buildPortableEvidenceBundle({
      state: {
        run_id: validated.run_id,
        lifecycle_state: validated.lifecycle_state,
        manifest_sha256: validated.receipt.manifest_sha256,
        workflow_plan_sha256: validated.receipt.workflow_plan_sha256,
        source_snapshot_sha256: validated.receipt.source_snapshot_sha256,
        executor_kind: validated.executor_kind,
        receipt_sha256: validated.receipt_sha256,
      },
      stateSha256: validated.state_sha256,
      evidence: {
        receipt_sha256: validated.receipt_sha256,
        receipt: validated.receipt,
        verification: validated.verification,
        result: validated.result,
      },
    });
    const published = await deps.writePortableEvidenceBundle(
      parsed.output,
      bundle.bytes,
      { cwd },
    );
    return Object.freeze({
      run_id: validated.run_id,
      output_path: published.output_path,
      bundle_bytes: published.bundle_bytes,
      bundle_sha256: published.bundle_sha256,
      receipt_sha256: validated.receipt_sha256,
    });
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
