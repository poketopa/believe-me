import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  assertObject,
  assertString,
  deepFreeze,
} from "../contracts/common.js";
import {
  HarnessContractError,
  safetyRefusal,
  usageError,
} from "../contracts/errors.js";
import { validateVerifierSpec } from "../contracts/verifier.js";
import { sha256Hex } from "../core/hash.js";

export const COMMAND_VERIFIER_ADAPTER_ID = "command-verifier";

const TERMINATION_GRACE_MS = 500;
const FORCE_SETTLE_MS = 1_500;

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

export async function runCommandVerifier(options = {}) {
  const { projectRoot, spec, spawnImpl, processKill, signal } = validateOptions(options);
  const root = await validateProjectRoot(projectRoot);
  const verifierSpec = validateVerifierSpec(spec);
  assertCommandVerifierSpec(verifierSpec);
  await validateProjectRelativeExecutable(root, verifierSpec.command);

  return runVerifierProcess({
    root,
    spec: verifierSpec,
    spawnImpl,
    processKill,
    signal,
  });
}

async function validateProjectRelativeExecutable(root, command) {
  if (!command.startsWith("./")) {
    return;
  }

  const segments = command.slice(2).split("/");
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    const stats = await lstat(current).catch((error) => {
      throw infraError("Project-relative verifier executable is not readable.", {
        path: command,
        cause_code: error.code,
      });
    });
    if (stats.isSymbolicLink()) {
      throw safetyRefusal(
        "Project-relative verifier executable must not traverse symbolic links.",
        { path: command, segment_index: index },
      );
    }
    const isLast = index === segments.length - 1;
    if ((!isLast && !stats.isDirectory()) || (isLast && !stats.isFile())) {
      throw safetyRefusal(
        "Project-relative verifier executable must resolve to a regular file inside the project.",
        { path: command, segment_index: index },
      );
    }
  }
}

function validateOptions(options) {
  assertObject(options, "command verifier options");
  assertString(options.projectRoot, "projectRoot");
  if (typeof (options.spawnImpl ?? spawn) !== "function") {
    throw usageError("spawnImpl must be a function.", { field: "spawnImpl" });
  }
  if (typeof (options.processKill ?? process.kill) !== "function") {
    throw usageError("processKill must be a function.", { field: "processKill" });
  }
  if (
    options.signal !== undefined &&
    (options.signal === null ||
      typeof options.signal.aborted !== "boolean" ||
      typeof options.signal.addEventListener !== "function" ||
      typeof options.signal.removeEventListener !== "function")
  ) {
    throw usageError("signal must be an AbortSignal.", { field: "signal" });
  }

  return {
    projectRoot: options.projectRoot,
    spec: options.spec,
    spawnImpl: options.spawnImpl ?? spawn,
    processKill: options.processKill ?? process.kill,
    signal: options.signal,
  };
}

async function validateProjectRoot(projectRoot) {
  const resolved = resolve(projectRoot);
  const stats = await lstat(resolved).catch((error) => {
    throw infraError("Project root is not readable.", {
      path: resolved,
      cause_code: error.code,
    });
  });

  if (!stats.isDirectory()) {
    throw usageError("projectRoot must be a directory.", {
      field: "projectRoot",
      path: resolved,
    });
  }

  return realpath(resolved);
}

function assertCommandVerifierSpec(spec) {
  if (spec.adapter_id !== COMMAND_VERIFIER_ADAPTER_ID) {
    throw usageError("verifier spec adapter_id must be 'command-verifier'.", {
      field: "adapter_id",
    });
  }
}

async function runVerifierProcess({ root, spec, spawnImpl, processKill, signal }) {
  const processGroupEnabled = process.platform !== "win32";
  let child;
  try {
    child = spawnImpl(spec.command, spec.args, {
      cwd: root,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: verifierEnvironment(),
      detached: processGroupEnabled,
    });
  } catch (error) {
    throw infraError("Command verifier process could not be started.", {
      cause_name: error.name,
      cause_code: error.code ?? null,
    });
  }

  if (!child || typeof child.on !== "function" || typeof child.once !== "function") {
    throw usageError("spawnImpl must return a ChildProcess-like object.", {
      field: "spawnImpl",
    });
  }

  let timedOut = false;
  let outputBoundExceeded = false;
  let stopRequested = false;
  let settleOutcome;
  let forceKillTimer;
  let forceSettleTimer;
  let childClosed = false;
  let cleanupError = null;
  let removeAbortListener = () => {};

  function signalProcessTree(signal) {
    if (!processGroupEnabled || !Number.isSafeInteger(child.pid)) {
      return terminate(child, signal);
    }
    try {
      processKill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") {
        return false;
      }
      cleanupError = `${error.code ?? "UNKNOWN"}:${error.message}`;
      return false;
    }
  }

  function processTreeExists() {
    if (!processGroupEnabled || !Number.isSafeInteger(child.pid)) {
      return !childClosed;
    }
    try {
      processKill(-child.pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") {
        return false;
      }
      cleanupError = `${error.code ?? "UNKNOWN"}:${error.message}`;
      return true;
    }
  }

  async function cleanProcessTree() {
    if (!processTreeExists()) {
      return false;
    }
    signalProcessTree("SIGTERM");
    await wait(TERMINATION_GRACE_MS);
    if (processTreeExists()) {
      signalProcessTree("SIGKILL");
      await wait(TERMINATION_GRACE_MS);
    }
    return processTreeExists();
  }

  function requestStop(reason) {
    if (reason === "timeout") {
      timedOut = true;
    } else if (reason === "output_bound") {
      outputBoundExceeded = true;
    }
    if (stopRequested) {
      return;
    }
    stopRequested = true;
    signalProcessTree("SIGTERM");
    forceKillTimer = setTimeout(() => {
      signalProcessTree("SIGKILL");
    }, TERMINATION_GRACE_MS);
    forceSettleTimer = setTimeout(() => {
      child.stdout?.destroy?.();
      child.stderr?.destroy?.();
      child.unref?.();
      settleOutcome?.({ exitCode: null, signal: "SIGKILL" });
    }, FORCE_SETTLE_MS);
  }

  const output = createBoundedOutput(spec.max_output_bytes, () => {
    requestStop("output_bound");
  });

  child.stdout?.on?.("data", (chunk) => output.appendStdout(chunk));
  child.stderr?.on?.("data", (chunk) => output.appendStderr(chunk));

  const timeout = setTimeout(() => {
    requestStop("timeout");
  }, spec.timeout_ms);
  if (signal !== undefined) {
    const abort = () => requestStop("abort");
    signal.addEventListener("abort", abort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) abort();
  }

  let outcome;
  let processError;
  try {
    outcome = await new Promise((resolveOutcome, rejectOutcome) => {
      let settled = false;
      settleOutcome = (value) => {
        if (!settled) {
          settled = true;
          resolveOutcome(value);
        }
      };
      child.once("error", (error) => {
        childClosed = true;
        if (!settled) {
          settled = true;
          rejectOutcome(infraError("Command verifier process failed.", {
            cause_name: error.name,
            cause_code: error.code ?? null,
          }));
        }
      });
      child.once("close", (exitCode, signal) => {
        childClosed = true;
        settleOutcome({ exitCode, signal });
      });
    });
  } catch (error) {
    processError = error;
  } finally {
    removeAbortListener();
    clearTimeout(timeout);
    clearTimeout(forceKillTimer);
    clearTimeout(forceSettleTimer);
  }

  const processResidue = await cleanProcessTree();
  if (processResidue || cleanupError !== null) {
    throw infraError("Command verifier process tree could not be cleaned.", {
      process_residue: processResidue,
      cleanup_error: cleanupError,
    });
  }
  if (processError !== undefined) {
    throw processError;
  }

  const result = buildResult({
    spec,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut,
    outputTruncated: output.truncated,
    stdout: output.stdout,
    stderr: output.stderr,
  });

  if (
    timedOut ||
    outputBoundExceeded ||
    outcome.exitCode !== 0 ||
    outcome.signal !== null
  ) {
    throw verificationFailed("Command verifier failed.", result, {
      stdout: output.stdout.toString("utf8"),
      stderr: output.stderr.toString("utf8"),
    });
  }

  return result;
}

function verifierEnvironment() {
  const env = { CI: "true" };
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"]) {
    if (typeof process.env[key] === "string") {
      env[key] = process.env[key];
    }
  }
  return env;
}

function createBoundedOutput(maxBytes, onExceeded) {
  let used = 0;
  let truncated = false;
  const stdout = [];
  const stderr = [];

  function append(target, chunk) {
    if (truncated) {
      return;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const available = maxBytes - used;
    if (buffer.length > available) {
      if (available > 0) {
        target.push(buffer.subarray(0, available));
        used += available;
      }
      truncated = true;
      onExceeded();
      return;
    }
    target.push(buffer);
    used += buffer.length;
  }

  return {
    appendStdout: (chunk) => append(stdout, chunk),
    appendStderr: (chunk) => append(stderr, chunk),
    get stdout() {
      return Buffer.concat(stdout);
    },
    get stderr() {
      return Buffer.concat(stderr);
    },
    get truncated() {
      return truncated;
    },
  };
}

function buildResult({
  spec,
  exitCode,
  signal,
  timedOut,
  outputTruncated,
  stdout,
  stderr,
}) {
  return deepFreeze({
    schema_version: { major: 1 },
    adapter_id: COMMAND_VERIFIER_ADAPTER_ID,
    argv: [spec.command, ...spec.args],
    status: exitCode === 0 && signal === null && !timedOut && !outputTruncated
      ? "passed"
      : "failed",
    exit_code: exitCode,
    signal,
    timed_out: timedOut,
    output_truncated: outputTruncated,
    stdout_sha256: sha256Hex(stdout),
    stderr_sha256: sha256Hex(stderr),
  });
}

function terminate(child, signal) {
  if (typeof child.kill === "function") {
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  }
  return false;
}

function verificationFailed(message, result, details) {
  return new HarnessContractError(
    "verification_failed",
    message,
    { ...details, result },
    5,
  );
}

function infraError(message, details) {
  return new HarnessContractError("infra_error", message, details, 10);
}
