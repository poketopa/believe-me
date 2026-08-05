import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  assertCodexTransportCompleted,
  captureWorkspaceInventory,
  createCodexExecutor,
} from "../adapters/codex-executor.js";
import { inspectCodexEvents } from "../adapters/codex-events.js";
import { createCodexCliTransport } from "../adapters/codex-transport.js";
import { validateCodexTaskInput } from "../contracts/codex-executor.js";
import { usageError } from "../contracts/errors.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { sha256Hex } from "../core/hash.js";
import { runHarness } from "../core/run-orchestrator.js";
import { createProjectSnapshot, normalizeRelativePath } from "../core/snapshot.js";
import { createIsolatedWorkspace } from "../core/workspace.js";
import {
  BENCHMARK_ORDER_ALGORITHM,
  validateBenchmarkArmResult,
  validateBenchmarkExperiment,
  validateBenchmarkPairResult,
  validateBenchmarkTask,
} from "./contracts.js";

const ARM_DIRECT = "direct_codex";
const ARM_HARNESS = "harness";

function elapsedMilliseconds(clock, startedAt) {
  return Math.max(0, Math.round(clock() - startedAt));
}

function terminalFromError(error, output) {
  if (output?.timed_out) {
    return "timeout";
  }
  if (error?.code === "safety_refusal") {
    return "safety_refusal";
  }
  if (error?.code === "verification_failed") {
    return "verification_failed";
  }
  return "infra_error";
}

function failurePhase(error, output) {
  if (output?.timed_out) {
    return "timeout";
  }
  if (error?.code === "safety_refusal") {
    return "safety";
  }
  if (error?.code === "verification_failed") {
    return "verification";
  }
  return "infra";
}

function passedVerification(value) {
  return value === true || (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.status === "passed"
  );
}

function verificationDigest(value) {
  if (value === undefined || value === null) {
    return null;
  }
  return sha256Hex(canonicalJSONBytes(value === true
    ? { status: "passed" }
    : value));
}

function usageFromOutput(output, workspace) {
  if (!output?.events) {
    return null;
  }
  try {
    return inspectCodexEvents(output.events, {
      workspace,
      stderr: output.stderr ?? "",
    }).usage;
  } catch {
    return null;
  }
}

function inventoryDiff(before, after) {
  const changed = [];
  const deleted = [];
  for (const [path, entry] of after.files) {
    if (before.files.get(path)?.sha256 !== entry.sha256) {
      changed.push(path);
    }
  }
  for (const path of before.files.keys()) {
    if (!after.files.has(path)) {
      deleted.push(path);
    }
  }
  return Object.freeze({
    changed: Object.freeze(changed.sort()),
    deleted: Object.freeze(deleted.sort()),
    all: Object.freeze([...new Set([...changed, ...deleted])].sort()),
  });
}

function directPrompt(task) {
  return [
    "Complete the following code-change task in this benchmark working copy.",
    "Use file-edit operations only. Do not use network tools or other agents.",
    "Make the smallest change that satisfies the task.",
    "",
    "Task:",
    task,
  ].join("\n");
}

function armArtifacts({
  baselineSha256,
  afterSha256,
  output,
  verification,
  receipt,
  provider,
}) {
  return Object.freeze({
    baseline_sha256: baselineSha256,
    after_source_sha256: afterSha256,
    raw_events_sha256: output?.events
      ? sha256Hex(output.events)
      : null,
    command_sha256: output?.command
      ? sha256Hex(canonicalJSONBytes(output.command))
      : null,
    provider_configuration_sha256: sha256Hex(canonicalJSONBytes(provider)),
    observed_provider_configuration_sha256: output?.configuration
      ? sha256Hex(canonicalJSONBytes(output.configuration))
      : null,
    verification_sha256: verificationDigest(verification),
    receipt_sha256: receipt ?? null,
  });
}

function timingRecord(total, child, verification) {
  const orchestration =
    child === null || verification === null
      ? null
      : Math.max(0, total - child - verification);
  return Object.freeze({
    wall_ms: total,
    codex_child_ms: child,
    codex_child_ms_missing_reason: child === null
      ? "codex_child_not_observed"
      : null,
    verification_ms: verification,
    verification_ms_missing_reason: verification === null
      ? "verification_not_run"
      : null,
    orchestration_ms: orchestration,
    orchestration_ms_missing_reason: orchestration === null
      ? "component_timing_incomplete"
      : null,
  });
}

async function runVerifier(verifier, workspaceRoot, arm, clock) {
  const startedAt = clock();
  try {
    const result = await verifier({ workspaceRoot, arm });
    return Object.freeze({
      duration_ms: elapsedMilliseconds(clock, startedAt),
      result,
      passed: passedVerification(result),
      error: null,
    });
  } catch (error) {
    return Object.freeze({
      duration_ms: elapsedMilliseconds(clock, startedAt),
      result: error?.details?.result ?? null,
      passed: false,
      error,
    });
  }
}

export async function runDirectCodexBenchmarkArm({
  experiment,
  task,
  workspaceRoot,
  transport,
  verifier,
  clock = performance.now.bind(performance),
}) {
  const validatedExperiment = validateBenchmarkExperiment(experiment);
  const validatedTask = validateBenchmarkTask(task);
  if (typeof transport !== "function" || typeof verifier !== "function") {
    throw usageError("Benchmark transport and verifier must be functions.");
  }

  const root = resolve(workspaceRoot);
  const totalStartedAt = clock();
  const before = await captureWorkspaceInventory(root);
  let output = null;
  let childMs = null;
  let verification = null;
  let verificationMs = null;
  let diff = { all: [], changed: [], deleted: [] };
  let usage = null;
  let terminalStatus = "infra_error";
  let verificationStatus = "not_run";
  let unsafe = false;
  let verifiedSuccess = false;
  let phase = "infra";

  try {
    const childStartedAt = clock();
    output = await transport({
      prompt: directPrompt(validatedTask.task),
      workspace: root,
    });
    childMs = elapsedMilliseconds(clock, childStartedAt);
    const afterExecution = await captureWorkspaceInventory(root);
    diff = inventoryDiff(before, afterExecution);
    const allowed = new Set(validatedTask.allowed_paths.map((path) =>
      normalizeRelativePath(root, path)
    ));
    unsafe = diff.deleted.length > 0 || diff.all.some((path) => !allowed.has(path));
    assertCodexTransportCompleted(output);
    usage = inspectCodexEvents(output.events, {
      workspace: root,
      stderr: output.stderr,
    }).usage;

    if (!unsafe && diff.all.length > 0) {
      verification = await runVerifier(verifier, root, ARM_DIRECT, clock);
      verificationMs = verification.duration_ms;
      verificationStatus = verification.passed ? "passed" : "failed";
    }

    if (unsafe) {
      terminalStatus = "safety_refusal";
      phase = "safety";
    } else if (diff.all.length === 0 || !verification?.passed) {
      terminalStatus = "verification_failed";
      phase = "verification";
    } else {
      terminalStatus = "completed";
      phase = null;
      verifiedSuccess = true;
    }
  } catch (error) {
    terminalStatus = terminalFromError(error, output);
    phase = failurePhase(error, output);
    unsafe ||= terminalStatus === "safety_refusal";
    usage ??= usageFromOutput(output, root);
    if (output !== null && diff.all.length === 0) {
      try {
        diff = inventoryDiff(before, await captureWorkspaceInventory(root));
      } catch {
        unsafe = true;
        terminalStatus = "safety_refusal";
        phase = "safety";
      }
    }
  }

  let afterSha256 = null;
  try {
    afterSha256 = (await createProjectSnapshot(root)).sha256;
  } catch {
    unsafe = true;
    terminalStatus = "safety_refusal";
    verifiedSuccess = false;
    phase = "safety";
  }
  const totalMs = elapsedMilliseconds(clock, totalStartedAt);
  const timing = timingRecord(totalMs, childMs, verificationMs);
  return validateBenchmarkArmResult({
    schema_version: { major: 1 },
    experiment: validatedExperiment,
    task: validatedTask,
    arm: ARM_DIRECT,
    baseline_sha256: validatedTask.baseline_sha256,
    observation: {
      terminal_status: terminalStatus,
      verification_status: verificationStatus,
      verified_success: verifiedSuccess,
      unsafe_or_out_of_scope: unsafe,
      source_mutated_before_verification: diff.all.length > 0 || unsafe,
      usage,
      usage_missing_reason: usage === null ? "trusted_usage_unavailable" : null,
      timing,
      changed_paths: diff.all,
      artifact_hashes: armArtifacts({
        baselineSha256: validatedTask.baseline_sha256,
        afterSha256,
        output,
        verification: verification?.result,
        receipt: null,
        provider: validatedExperiment.provider,
      }),
      failure_phase: phase,
    },
  });
}

export async function runHarnessBenchmarkArm({
  experiment,
  task,
  projectRoot,
  stateDir,
  manifestPath,
  inputPath,
  transport,
  verifier,
  runId,
  clock = performance.now.bind(performance),
}) {
  const validatedExperiment = validateBenchmarkExperiment(experiment);
  const validatedTask = validateBenchmarkTask(task);
  if (typeof transport !== "function" || typeof verifier !== "function") {
    throw usageError("Benchmark transport and verifier must be functions.");
  }

  const root = resolve(projectRoot);
  const totalStartedAt = clock();
  let output = null;
  let childMs = null;
  let verificationMs = null;
  let verificationResult = null;
  let completed = null;
  let terminalStatus = "infra_error";
  let verificationStatus = "not_run";
  let verifiedSuccess = false;
  let unsafe = false;
  let phase = "infra";

  const instrumentedTransport = async (request) => {
    const startedAt = clock();
    try {
      output = await transport(request);
      return output;
    } finally {
      childMs = elapsedMilliseconds(clock, startedAt);
    }
  };
  const instrumentedVerifier = async ({ workspaceRoot }) => {
    const measured = await runVerifier(verifier, workspaceRoot, ARM_HARNESS, clock);
    verificationMs = measured.duration_ms;
    verificationResult = measured.result;
    if (measured.error !== null) {
      throw measured.error;
    }
    return measured.result;
  };

  try {
    completed = await runHarness({
      runId,
      runSpec: {
        schema_version: { major: 1 },
        project_path: root,
        state_dir: stateDir,
        skill_manifest_path: manifestPath,
        input_path: inputPath,
        executor_kind: "codex",
      },
      executorInputValidator: validateCodexTaskInput,
      executor: createCodexExecutor({ transport: instrumentedTransport }),
      verifier: instrumentedVerifier,
    });
    terminalStatus = "completed";
    verificationStatus = "passed";
    verifiedSuccess = true;
    phase = null;
  } catch (error) {
    terminalStatus = terminalFromError(error, output);
    verificationStatus = verificationMs === null ? "not_run" : "failed";
    unsafe = terminalStatus === "safety_refusal";
    phase = failurePhase(error, output);
  }

  let afterSha256 = null;
  try {
    afterSha256 = (await createProjectSnapshot(root)).sha256;
  } catch {
    terminalStatus = "safety_refusal";
    verificationStatus = verificationMs === null ? "not_run" : verificationStatus;
    verifiedSuccess = false;
    unsafe = true;
    phase = "safety";
  }
  const totalMs = elapsedMilliseconds(clock, totalStartedAt);
  const timing = timingRecord(totalMs, childMs, verificationMs);
  const usage = completed?.evidence?.result?.executor_evidence?.usage ??
    usageFromOutput(output, root);
  return validateBenchmarkArmResult({
    schema_version: { major: 1 },
    experiment: validatedExperiment,
    task: validatedTask,
    arm: ARM_HARNESS,
    baseline_sha256: validatedTask.baseline_sha256,
    observation: {
      terminal_status: terminalStatus,
      verification_status: verificationStatus,
      verified_success: verifiedSuccess,
      unsafe_or_out_of_scope: unsafe,
      source_mutated_before_verification:
        afterSha256 === null || afterSha256 !== validatedTask.baseline_sha256,
      usage,
      usage_missing_reason: usage === null ? "trusted_usage_unavailable" : null,
      timing,
      changed_paths: completed?.evidence?.result?.changes?.map((change) => change.path) ?? [],
      artifact_hashes: armArtifacts({
        baselineSha256: validatedTask.baseline_sha256,
        afterSha256,
        output,
        verification: verificationResult,
        receipt: completed?.state?.receipt_sha256 ?? null,
        provider: validatedExperiment.provider,
      }),
      failure_phase: phase,
    },
  });
}

function pairedOrder(seed, taskId, repeatIndex = 0) {
  if (!Number.isSafeInteger(repeatIndex) || repeatIndex < 0) {
    throw usageError("Benchmark repeatIndex must be a nonnegative safe integer.");
  }
  const digest = sha256Hex(Buffer.from(`${seed}\0${taskId}`, "utf8"));
  const taskStartsDirect = Number.parseInt(digest.slice(0, 2), 16) % 2 === 0;
  const directFirst = repeatIndex % 2 === 0
    ? taskStartsDirect
    : !taskStartsDirect;
  return directFirst
    ? "direct_first"
    : "harness_first";
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function runPairedBenchmark({
  experiment,
  task,
  verifier,
  projectRoot,
  transportFactory = () => createCodexCliTransport(),
  workRoot,
  runIdFactory = ({ experimentId, pairId }) =>
    `benchmark-${sha256Hex(Buffer.from(
      `${experimentId}\0${pairId}`,
      "utf8",
    )).slice(0, 24)}`,
  clock = performance.now.bind(performance),
} = {}) {
  const validatedExperiment = validateBenchmarkExperiment(experiment);
  const validatedTask = validateBenchmarkTask(task);
  if (validatedTask.experiment_id !== validatedExperiment.experiment_id) {
    throw usageError("Benchmark task experiment binding does not match.");
  }
  if (typeof verifier !== "function" || typeof transportFactory !== "function") {
    throw usageError("Benchmark verifier and transportFactory must be functions.");
  }

  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw usageError("Benchmark projectRoot must be a non-empty string.");
  }
  const sourceRoot = resolve(projectRoot);
  const baseline = await createProjectSnapshot(sourceRoot);
  if (baseline.sha256 !== validatedTask.baseline_sha256) {
    throw usageError("Benchmark task baseline digest does not match project bytes.", {
      expected_sha256: validatedTask.baseline_sha256,
      actual_sha256: baseline.sha256,
    });
  }

  const root = workRoot === undefined
    ? await mkdtemp(join(tmpdir(), "vah-benchmark-pair-"))
    : resolve(workRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directRoot = join(root, "direct");
  const harnessRoot = join(root, "harness");
  await createIsolatedWorkspace({
    projectRoot: sourceRoot,
    workspaceRoot: directRoot,
    expectedSnapshotSha256: baseline.sha256,
  });
  await createIsolatedWorkspace({
    projectRoot: sourceRoot,
    workspaceRoot: harnessRoot,
    expectedSnapshotSha256: baseline.sha256,
  });

  const controlRoot = join(root, "control");
  const manifestPath = join(controlRoot, "skill.json");
  const inputPath = join(controlRoot, "input.json");
  await writeJson(manifestPath, {
    schema_version: { major: 1 },
    manifest_id: `benchmark-${validatedTask.task_id}`,
    name: `Benchmark ${validatedTask.task_id}`,
    policy_id: "paired-benchmark-allowlist",
    executor_kinds: ["codex"],
    input_schema_ref: "codex-executor-input/v1",
    policy_rules: { max_changes: validatedTask.allowed_paths.length },
  });
  await writeJson(inputPath, {
    task: validatedTask.task,
    allowed_paths: validatedTask.allowed_paths,
  });

  if (validatedExperiment.order_algorithm !== BENCHMARK_ORDER_ALGORITHM) {
    throw usageError("Unsupported benchmark order algorithm.");
  }
  const order = pairedOrder(
    validatedExperiment.seed,
    validatedTask.task_id,
    validatedTask.repeat_index,
  );
  const results = {};
  const runners = {
    direct_codex: () => runDirectCodexBenchmarkArm({
      experiment: validatedExperiment,
      task: validatedTask,
      workspaceRoot: directRoot,
      transport: transportFactory(ARM_DIRECT),
      verifier,
      clock,
    }),
    harness: () => runHarnessBenchmarkArm({
      experiment: validatedExperiment,
      task: validatedTask,
      projectRoot: harnessRoot,
      stateDir: join(harnessRoot, ".harness"),
      manifestPath,
      inputPath,
      transport: transportFactory(ARM_HARNESS),
      verifier,
      runId: runIdFactory({
        experimentId: validatedExperiment.experiment_id,
        pairId: validatedTask.pair_id,
      }),
      clock,
    }),
  };
  const armOrder = order === "direct_first"
    ? [ARM_DIRECT, ARM_HARNESS]
    : [ARM_HARNESS, ARM_DIRECT];
  for (const arm of armOrder) {
    results[arm] = await runners[arm]();
  }

  const directConfiguration =
    results.direct_codex.observation.artifact_hashes
      .provider_configuration_sha256;
  const harnessConfiguration =
    results.harness.observation.artifact_hashes
      .provider_configuration_sha256;
  const directObservedConfiguration =
    results.direct_codex.observation.artifact_hashes
      .observed_provider_configuration_sha256;
  const harnessObservedConfiguration =
    results.harness.observation.artifact_hashes
      .observed_provider_configuration_sha256;
  const observedConfigurationEquivalent =
    directObservedConfiguration !== null &&
    harnessObservedConfiguration !== null &&
    directObservedConfiguration === harnessObservedConfiguration;
  const providerConfigurationEquivalent =
    directConfiguration !== null &&
    directConfiguration === harnessConfiguration &&
    observedConfigurationEquivalent;
  const protocolInvalidReasons = [];
  if (
    directObservedConfiguration === null ||
    harnessObservedConfiguration === null
  ) {
    protocolInvalidReasons.push("provider_configuration_unobserved");
  } else if (!providerConfigurationEquivalent) {
    protocolInvalidReasons.push("provider_configuration_mismatch");
  }

  return Object.freeze({
    work_root: root,
    pair: validateBenchmarkPairResult({
      schema_version: { major: 1 },
      experiment: validatedExperiment,
      task: validatedTask,
      baseline_sha256: baseline.sha256,
      order,
      provider_configuration_equivalent: providerConfigurationEquivalent,
      protocol_valid: protocolInvalidReasons.length === 0,
      protocol_invalid_reasons: protocolInvalidReasons,
      direct_codex: results.direct_codex,
      harness: results.harness,
    }),
  });
}

export { pairedOrder };
