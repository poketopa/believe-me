import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  assertObject,
  assertString,
  deepFreeze,
} from "../contracts/common.js";
import { HarnessContractError, usageError } from "../contracts/errors.js";
import { assertSupportedSchemaVersion } from "../contracts/schema-version.js";
import { sha256Hex } from "../core/hash.js";

export const SPRING_VERIFIER_ADAPTER_ID = "spring-verifier";

const FIXTURE_FILE = "fixture.json";
const WRAPPER_COMMAND = "./gradlew";
const WRAPPER_ARGS = Object.freeze([
  "--no-daemon",
  "--console=plain",
  "-q",
  "test",
]);
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const TERMINATION_GRACE_MS = 500;
const FORCE_SETTLE_MS = 1_500;

export async function runSpringVerifier(options = {}) {
  const {
    fixtureRoot,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    spawnImpl = spawn,
  } = validateOptions(options);

  const root = await validateFixtureRoot(fixtureRoot);
  const fixture = await readFixture(root);
  await validateWrapper(root);

  return runVerifierProcess({
    root,
    fixture,
    timeoutMs,
    maxOutputBytes,
    spawnImpl,
  });
}

function validateOptions(options) {
  assertObject(options, "spring verifier options");
  assertString(options.fixtureRoot, "fixtureRoot");
  if (!Number.isSafeInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) ||
    (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) <= 0) {
    throw usageError("timeoutMs must be a positive safe integer.", {
      field: "timeoutMs",
    });
  }
  if (!Number.isSafeInteger(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES) ||
    (options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES) <= 0) {
    throw usageError("maxOutputBytes must be a positive safe integer.", {
      field: "maxOutputBytes",
    });
  }
  if (typeof (options.spawnImpl ?? spawn) !== "function") {
    throw usageError("spawnImpl must be a function.", { field: "spawnImpl" });
  }

  return {
    fixtureRoot: options.fixtureRoot,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    spawnImpl: options.spawnImpl ?? spawn,
  };
}

async function validateFixtureRoot(fixtureRoot) {
  const resolved = resolve(fixtureRoot);
  const stats = await lstat(resolved).catch((error) => {
    throw infraError("Fixture root is not readable.", {
      path: resolved,
      cause_code: error.code,
    });
  });

  if (!stats.isDirectory()) {
    throw usageError("fixtureRoot must be a directory.", {
      field: "fixtureRoot",
      path: resolved,
    });
  }

  return realpath(resolved);
}

async function readFixture(root) {
  const fixturePath = assertInsideRoot(root, resolve(root, FIXTURE_FILE), "fixture path");
  const bytes = await readFile(fixturePath).catch((error) => {
    throw infraError("Fixture file is not readable.", {
      path: fixturePath,
      cause_code: error.code,
    });
  });

  let fixture;
  try {
    fixture = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw usageError("fixture.json must contain valid JSON.", {
      path: fixturePath,
      cause_name: error.name,
    });
  }

  validateFixture(fixture);
  return fixture;
}

function validateFixture(fixture) {
  assertObject(fixture, "fixture");
  assertSupportedSchemaVersion(fixture.schema_version);
  assertString(fixture.fixture_id, "fixture_id");
  assertObject(fixture.verifier, "verifier");

  if (fixture.verifier.command !== WRAPPER_COMMAND) {
    throw usageError("verifier.command must be exactly './gradlew'.", {
      field: "verifier.command",
    });
  }

  assertNonEmptyStringArray(fixture.verifier.args, "verifier.args");
  if (
    fixture.verifier.args.length !== WRAPPER_ARGS.length ||
    fixture.verifier.args.some((arg, index) => arg !== WRAPPER_ARGS[index])
  ) {
    throw usageError("verifier.args do not match the canonical Spring verifier argv.", {
      field: "verifier.args",
      expected: WRAPPER_ARGS,
    });
  }
}

function assertNonEmptyStringArray(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw usageError(`${field} must be a non-empty string array.`, { field });
  }

  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      throw usageError(`${field} must be a non-empty string array.`, {
        field,
      });
    }
  }
}

async function validateWrapper(root) {
  const wrapperPath = assertInsideRoot(root, resolve(root, WRAPPER_COMMAND), "wrapper path");
  const stats = await lstat(wrapperPath).catch((error) => {
    throw usageError("Gradle wrapper must exist inside the fixture root.", {
      path: wrapperPath,
      cause_code: error.code,
    });
  });

  if (stats.isSymbolicLink()) {
    throw usageError("Gradle wrapper must not be a symlink.", {
      path: wrapperPath,
    });
  }
  if (!stats.isFile()) {
    throw usageError("Gradle wrapper must be a regular file.", {
      path: wrapperPath,
    });
  }

  await access(wrapperPath, fsConstants.X_OK).catch(() => {
    throw usageError("Gradle wrapper must be executable.", {
      path: wrapperPath,
    });
  });
}

function assertInsideRoot(root, targetPath, label) {
  const rootPrefix = root.endsWith("/") ? root : `${root}/`;
  if (targetPath !== root && !targetPath.startsWith(rootPrefix)) {
    throw usageError(`${label} must stay inside fixtureRoot.`, {
      root,
      path: targetPath,
    });
  }

  return targetPath;
}

async function runVerifierProcess({
  root,
  fixture,
  timeoutMs,
  maxOutputBytes,
  spawnImpl,
}) {
  let child;
  try {
    child = spawnImpl(fixture.verifier.command, fixture.verifier.args, {
      cwd: root,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: verifierEnvironment(),
    });
  } catch (error) {
    throw infraError("Spring verifier process could not be started.", {
      cause_name: error.name,
      cause_code: error.code ?? null,
    });
  }

  if (!child || typeof child.on !== "function") {
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

  function requestStop(reason) {
    if (reason === "timeout") {
      timedOut = true;
    } else {
      outputBoundExceeded = true;
    }
    if (stopRequested) {
      return;
    }
    stopRequested = true;
    terminate(child, "SIGTERM");
    forceKillTimer = setTimeout(() => {
      terminate(child, "SIGKILL");
    }, TERMINATION_GRACE_MS);
    forceSettleTimer = setTimeout(() => {
      child.stdout?.destroy?.();
      child.stderr?.destroy?.();
      child.unref?.();
      settleOutcome?.({ exitCode: null, signal: "SIGKILL" });
    }, FORCE_SETTLE_MS);
  }

  const output = createBoundedOutput(maxOutputBytes, () => {
    requestStop("output_bound");
  });

  child.stdout?.on?.("data", (chunk) => output.appendStdout(chunk));
  child.stderr?.on?.("data", (chunk) => output.appendStderr(chunk));

  const timeout = setTimeout(() => {
    requestStop("timeout");
  }, timeoutMs);

  const outcome = await new Promise((resolveOutcome, rejectOutcome) => {
    let settled = false;
    settleOutcome = (value) => {
      if (!settled) {
        settled = true;
        resolveOutcome(value);
      }
    };
    child.once?.("error", (error) => {
      if (!settled) {
        settled = true;
        rejectOutcome(infraError("Spring verifier process failed.", {
          cause_name: error.name,
          cause_code: error.code ?? null,
        }));
      }
    });
    child.once?.("close", (exitCode, signal) => {
      settleOutcome({ exitCode, signal });
    });
  }).finally(() => {
    clearTimeout(timeout);
    clearTimeout(forceKillTimer);
    clearTimeout(forceSettleTimer);
  });

  const result = buildResult({
    fixture,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut,
    stdout: output.stdout,
    stderr: output.stderr,
  });

  if (timedOut || outputBoundExceeded || outcome.exitCode !== 0) {
    throw verificationFailed("Spring verifier failed.", result, {
      stdout: output.stdout.toString("utf8"),
      stderr: output.stderr.toString("utf8"),
      output_truncated: output.truncated,
    });
  }

  return result;
}

function verifierEnvironment() {
  const env = { CI: "true" };
  for (const key of [
    "PATH",
    "JAVA_HOME",
    "GRADLE_USER_HOME",
    "HOME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
  ]) {
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

function buildResult({ fixture, exitCode, signal, timedOut, stdout, stderr }) {
  return deepFreeze({
    schema_version: { major: 1 },
    fixture_id: fixture.fixture_id,
    adapter_id: SPRING_VERIFIER_ADAPTER_ID,
    argv: [fixture.verifier.command, ...fixture.verifier.args],
    status: exitCode === 0 && !timedOut ? "passed" : "failed",
    exit_code: exitCode,
    signal,
    timed_out: timedOut,
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
