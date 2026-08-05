import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { infraError, usageError } from "../contracts/errors.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const TERMINATION_GRACE_MS = 250;
const disabledFeatures = Object.freeze([
  "shell_tool",
  "unified_exec",
  "skill_search",
  "plugins",
  "apps",
  "browser_use",
  "computer_use",
  "in_app_browser",
  "multi_agent",
]);
const secretEnvNamePattern =
  /(secret|credential|token|password|passwd|auth|api[_-]?key|cookie|session)/iu;
const admittedEnvNames = new Set([
  "ALL_PROXY",
  "CODEX_HOME",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LC_ALL",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "PATH",
  "SSL_CERT_FILE",
  "TERM",
  "TMPDIR",
]);
const proxyEnvNames = new Set([
  "ALL_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
]);

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function appendBounded(current, chunk, maxBytes) {
  const next = Buffer.concat([current, Buffer.from(chunk)]);
  if (next.length <= maxBytes) {
    return { value: next, overflowed: false };
  }
  return { value: next.subarray(0, maxBytes), overflowed: true };
}

export function sanitizeCodexEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => {
    if (!admittedEnvNames.has(name) || secretEnvNamePattern.test(name)) {
      return false;
    }
    if (!proxyEnvNames.has(name)) {
      return true;
    }
    if (String(value).includes("@")) {
      return false;
    }
    try {
      const proxy = new URL(value);
      return proxy.username === "" && proxy.password === "";
    } catch {
      return true;
    }
  }));
}

export function createIsolatedCodexHome(env = process.env) {
  const sourceHome = env.CODEX_HOME ?? (
    typeof env.HOME === "string" ? join(env.HOME, ".codex") : null
  );
  if (sourceHome === null) {
    throw infraError("Codex authentication home is unavailable.");
  }
  const sourceAuth = join(resolve(sourceHome), "auth.json");
  let sourceStats;
  try {
    sourceStats = lstatSync(sourceAuth);
  } catch (error) {
    throw infraError("Codex authentication is unavailable. Run 'codex login'.", {
      cause_code: error.code ?? null,
    });
  }
  if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
    throw infraError("Codex auth.json must be a regular non-symlink file.");
  }
  const sourceAuthBefore = sha256(readFileSync(sourceAuth));
  const isolatedHome = mkdtempSync(join(tmpdir(), "vah-codex-home-"));
  chmodSync(isolatedHome, 0o700);
  const isolatedAuth = join(isolatedHome, "auth.json");
  try {
    copyFileSync(sourceAuth, isolatedAuth);
    chmodSync(isolatedAuth, 0o600);
  } catch (error) {
    rmSync(isolatedHome, { recursive: true, force: true });
    throw infraError("Codex authentication could not be isolated.", {
      cause_code: error.code ?? null,
    });
  }
  return Object.freeze({
    env: Object.freeze({
      ...sanitizeCodexEnv(env),
      CODEX_HOME: isolatedHome,
      HOME: isolatedHome,
    }),
    cleanup() {
      let sourceAuthUnchanged = false;
      try {
        sourceAuthUnchanged = sha256(readFileSync(sourceAuth)) === sourceAuthBefore;
      } finally {
        rmSync(isolatedHome, { recursive: true, force: true });
      }
      return Object.freeze({
        cleaned: !existsSync(isolatedHome),
        source_auth_unchanged: sourceAuthUnchanged,
      });
    },
  });
}

export function codexExecCommand({
  executable = "codex",
  workspace,
  model,
  reasoningEffort,
} = {}) {
  if (typeof executable !== "string" || executable.length === 0) {
    throw usageError("Codex executable must be a non-empty string.");
  }
  if (typeof workspace !== "string" || workspace.length === 0) {
    throw usageError("Codex workspace must be a non-empty string.");
  }
  if (model !== undefined && (typeof model !== "string" || model.length === 0)) {
    throw usageError("Codex model must be a non-empty string when provided.");
  }
  if (
    reasoningEffort !== undefined &&
    (typeof reasoningEffort !== "string" || reasoningEffort.length === 0)
  ) {
    throw usageError("Codex reasoning effort must be a non-empty string.");
  }

  const command = [
    executable,
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--skip-git-repo-check",
  ];
  for (const feature of disabledFeatures) {
    command.push("--disable", feature);
  }
  command.push(
    "--json",
    "--sandbox",
    "workspace-write",
    "-c",
    'approval_policy="never"',
    "-c",
    'web_search="disabled"',
  );
  if (model !== undefined) {
    command.push("--model", model);
  }
  if (reasoningEffort !== undefined) {
    command.push("-c", `model_reasoning_effort=${reasoningEffort}`);
  }
  command.push("-C", resolve(workspace), "-");
  return Object.freeze(command);
}

export function createCodexCliTransport({
  executable = "codex",
  model,
  reasoningEffort,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxCaptureBytes = DEFAULT_MAX_CAPTURE_BYTES,
  env = process.env,
  spawnImpl = spawn,
  processKill = process.kill,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw usageError("Codex timeout must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(maxCaptureBytes) || maxCaptureBytes <= 0) {
    throw usageError("Codex output limit must be a positive safe integer.");
  }
  if (typeof spawnImpl !== "function" || typeof processKill !== "function") {
    throw usageError("Codex process dependencies must be functions.");
  }

  return async function codexCliTransport({ prompt, workspace }) {
    if (typeof prompt !== "string" || prompt.length === 0) {
      throw usageError("Codex prompt must be a non-empty string.");
    }
    const command = codexExecCommand({
      executable,
      workspace,
      model,
      reasoningEffort,
    });
    const [program, ...args] = command;
    const isolatedHome = createIsolatedCodexHome(env);

    return new Promise((resolveTransport) => {
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let outputOverflowed = false;
      let timedOut = false;
      let cleanupError = null;
      let settled = false;
      let timeout = null;
      let forceKillTimer = null;
      const processGroupEnabled = process.platform !== "win32";
      let child;

      function signalProcessTree(signal) {
        if (!processGroupEnabled || !child?.pid) {
          return child?.kill(signal) ?? false;
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

      function terminateWithGrace() {
        signalProcessTree("SIGTERM");
        forceKillTimer ??= setTimeout(() => {
          if (processTreeExists()) {
            signalProcessTree("SIGKILL");
          }
        }, TERMINATION_GRACE_MS);
      }

      function processTreeExists() {
        if (!processGroupEnabled || !child?.pid) {
          return child?.exitCode === null && child?.signalCode === null;
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
          return 0;
        }
        signalProcessTree("SIGTERM");
        await wait(TERMINATION_GRACE_MS);
        if (processTreeExists()) {
          signalProcessTree("SIGKILL");
          await wait(TERMINATION_GRACE_MS);
        }
        return processTreeExists() ? 1 : 0;
      }

      async function finish(exitCode, signal, error = null) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        clearTimeout(forceKillTimer);
        let processResidueCount = await cleanProcessTree();
        let homeCleanup;
        try {
          homeCleanup = isolatedHome.cleanup();
        } catch {
          homeCleanup = { cleaned: false, source_auth_unchanged: false };
        }
        if (!homeCleanup.cleaned || !homeCleanup.source_auth_unchanged) {
          processResidueCount += 1;
          cleanupError ??= "isolated_codex_home_cleanup_failed";
        }
        resolveTransport(Object.freeze({
          command,
          events: stdout,
          stderr,
          exit_code: exitCode,
          signal,
          timed_out: timedOut,
          output_overflowed: outputOverflowed,
          process_residue_count: processResidueCount,
          cleanup_error: cleanupError,
          error,
          configuration: Object.freeze({
            model: model ?? null,
            reasoning_effort: reasoningEffort ?? null,
            sandbox: "workspace-write",
            approval_policy: "never",
            web_search: "disabled",
            shell_tools: "disabled",
            codex_home_isolation: "ephemeral_auth_copy",
          }),
        }));
      }

      try {
        child = spawnImpl(program, args, {
          cwd: resolve(workspace),
          env: isolatedHome.env,
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          detached: processGroupEnabled,
        });
      } catch (error) {
        void finish(null, null, error.message);
        return;
      }

      timeout = setTimeout(() => {
        timedOut = true;
        terminateWithGrace();
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        const appended = appendBounded(stdout, chunk, maxCaptureBytes);
        stdout = appended.value;
        outputOverflowed ||= appended.overflowed;
        if (appended.overflowed) {
          terminateWithGrace();
        }
      });
      child.stderr.on("data", (chunk) => {
        const appended = appendBounded(stderr, chunk, maxCaptureBytes);
        stderr = appended.value;
        outputOverflowed ||= appended.overflowed;
        if (appended.overflowed) {
          terminateWithGrace();
        }
      });
      child.on("error", (error) => {
        void finish(null, null, error.message);
      });
      child.on("close", (code, signal) => {
        void finish(code, signal);
      });
      child.stdin.on("error", (error) => {
        void finish(null, null, error.message);
      });
      child.stdin.end(prompt, "utf8");
    });
  };
}

export { DEFAULT_MAX_CAPTURE_BYTES, DEFAULT_TIMEOUT_MS };
