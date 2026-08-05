import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import {
  codexExecCommand,
  createCodexCliTransport,
  createIsolatedCodexHome,
  sanitizeCodexEnv,
} from "../../../src/adapters/codex-transport.js";

function missingProcess() {
  const error = new Error("missing process");
  error.code = "ESRCH";
  throw error;
}

function eventStream() {
  return [
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "done" },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 0,
        total_tokens: 2,
      },
    }),
    "",
  ].join("\n");
}

function fakeSpawn(captured, output = eventStream()) {
  return (program, args, options) => {
    const child = new EventEmitter();
    child.pid = 42_001;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    let prompt = "";
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        prompt += chunk.toString("utf8");
        callback();
      },
      final(callback) {
        captured.prompt = prompt;
        callback();
        queueMicrotask(() => {
          child.stdout.end(output);
          child.stderr.end("");
          child.exitCode = 0;
          child.emit("close", 0, null);
        });
      },
    });
    captured.program = program;
    captured.args = args;
    captured.options = options;
    captured.isolatedHome = options.env.CODEX_HOME;
    captured.auth = readFileSync(join(options.env.CODEX_HOME, "auth.json"), "utf8");
    return child;
  };
}

function authHome() {
  const root = mkdtempSync(join(tmpdir(), "vah-codex-auth-"));
  writeFileSync(join(root, "auth.json"), '{"fixture":"auth"}\n', {
    encoding: "utf8",
    mode: 0o600,
  });
  return root;
}

test("Codex command is fixed, non-interactive, and prompt-free", () => {
  const workspace = resolve("/tmp/vah-codex-workspace");
  const command = codexExecCommand({
    workspace,
    model: "test-model",
    reasoningEffort: "low",
  });
  assert.deepEqual(command, [
    "codex",
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--skip-git-repo-check",
    "--disable",
    "shell_tool",
    "--disable",
    "unified_exec",
    "--disable",
    "skill_search",
    "--disable",
    "plugins",
    "--disable",
    "apps",
    "--disable",
    "browser_use",
    "--disable",
    "computer_use",
    "--disable",
    "in_app_browser",
    "--disable",
    "multi_agent",
    "--json",
    "--sandbox",
    "workspace-write",
    "-c",
    'approval_policy="never"',
    "-c",
    'web_search="disabled"',
    "--model",
    "test-model",
    "-c",
    "model_reasoning_effort=low",
    "-C",
    workspace,
    "-",
  ]);
  assert.equal(command.includes("task prompt"), false);
  assert.equal(command.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  assert.equal(command.includes("--add-dir"), false);
});

test("Codex environment and auth home isolate credentials", () => {
  assert.deepEqual(sanitizeCodexEnv({
    PATH: "/usr/bin",
    HOME: "/home/user",
    HTTPS_PROXY: "https://proxy",
    HTTP_PROXY: "user:password@proxy:8080",
    ALL_PROXY: "socks5://user%40example:password@proxy",
    OPENAI_API_KEY: "must-not-pass",
    API_TOKEN: "must-not-pass",
  }), {
    PATH: "/usr/bin",
    HOME: "/home/user",
    HTTPS_PROXY: "https://proxy",
  });

  const sourceHome = authHome();
  try {
    const isolated = createIsolatedCodexHome({
      PATH: "/usr/bin",
      CODEX_HOME: sourceHome,
    });
    assert.notEqual(isolated.env.CODEX_HOME, sourceHome);
    assert.equal(readFileSync(
      join(isolated.env.CODEX_HOME, "auth.json"),
      "utf8",
    ), '{"fixture":"auth"}\n');
    const cleanup = isolated.cleanup();
    assert.equal(cleanup.cleaned, true);
    assert.equal(cleanup.source_auth_unchanged, true);
    assert.equal(existsSync(isolated.env.CODEX_HOME), false);
  } finally {
    rmSync(sourceHome, { recursive: true, force: true });
  }
});

test("Codex transport uses stdin, shell false, bounded env, and verified cleanup", async () => {
  const sourceHome = authHome();
  const captured = {};
  try {
    const transport = createCodexCliTransport({
      env: {
        PATH: "/usr/bin",
        CODEX_HOME: sourceHome,
        OPENAI_API_KEY: "must-not-pass",
      },
      spawnImpl: fakeSpawn(captured),
      processKill: missingProcess,
    });
    const result = await transport({
      prompt: "task prompt",
      workspace: "/tmp/vah-codex-workspace",
    });
    assert.equal(captured.program, "codex");
    assert.equal(captured.args.at(-1), "-");
    assert.equal(captured.prompt, "task prompt");
    assert.equal(captured.options.shell, false);
    assert.equal(captured.options.env.OPENAI_API_KEY, undefined);
    assert.equal(captured.auth, '{"fixture":"auth"}\n');
    assert.equal(existsSync(captured.isolatedHome), false);
    assert.equal(result.exit_code, 0);
    assert.equal(result.process_residue_count, 0);
    assert.match(result.events.toString("utf8"), /turn\.completed/u);
  } finally {
    rmSync(sourceHome, { recursive: true, force: true });
  }
});

test("Codex transport bounds output and cleans auth after spawn failure", async () => {
  const sourceHome = authHome();
  try {
    const overflow = createCodexCliTransport({
      env: { PATH: "/usr/bin", CODEX_HOME: sourceHome },
      maxCaptureBytes: 8,
      spawnImpl: fakeSpawn({}, "0123456789"),
      processKill: missingProcess,
    });
    const overflowed = await overflow({ prompt: "task", workspace: "/tmp/work" });
    assert.equal(overflowed.output_overflowed, true);
    assert.equal(overflowed.events.byteLength, 8);

    let isolatedPath;
    const failed = createCodexCliTransport({
      env: { PATH: "/usr/bin", CODEX_HOME: sourceHome },
      spawnImpl(_program, _args, options) {
        isolatedPath = options.env.CODEX_HOME;
        const error = new Error("ENOENT");
        error.code = "ENOENT";
        throw error;
      },
      processKill: missingProcess,
    });
    const failure = await failed({ prompt: "task", workspace: "/tmp/work" });
    assert.equal(failure.exit_code, null);
    assert.equal(failure.error, "ENOENT");
    assert.equal(existsSync(isolatedPath), false);
  } finally {
    rmSync(sourceHome, { recursive: true, force: true });
  }
});

test("Codex transport marks timeout and terminates the process group", async () => {
  const sourceHome = authHome();
  let child;
  let alive = true;
  try {
    const transport = createCodexCliTransport({
      env: { PATH: "/usr/bin", CODEX_HOME: sourceHome },
      timeoutMs: 5,
      spawnImpl() {
        child = new EventEmitter();
        child.pid = 42_002;
        child.exitCode = null;
        child.signalCode = null;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        child.kill = () => true;
        return child;
      },
      processKill(_pid, signal) {
        if (signal === 0) {
          if (alive) return;
          return missingProcess();
        }
        if (alive) {
          alive = false;
          queueMicrotask(() => {
            child.signalCode = signal;
            child.emit("close", null, signal);
          });
        }
      },
    });
    const result = await transport({ prompt: "task", workspace: "/tmp/work" });
    assert.equal(result.timed_out, true);
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.process_residue_count, 0);
  } finally {
    rmSync(sourceHome, { recursive: true, force: true });
  }
});

test("Codex transport terminates the process group on parent abort", async () => {
  const sourceHome = authHome();
  const controller = new AbortController();
  let child;
  let alive = true;
  const signals = [];
  try {
    const transport = createCodexCliTransport({
      env: { PATH: "/usr/bin", CODEX_HOME: sourceHome },
      timeoutMs: 10_000,
      spawnImpl() {
        child = new EventEmitter();
        child.pid = 42_003;
        child.exitCode = null;
        child.signalCode = null;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        child.kill = () => true;
        return child;
      },
      processKill(_pid, signal) {
        if (signal === 0) {
          if (alive) return;
          return missingProcess();
        }
        signals.push(signal);
        if (alive) {
          alive = false;
          queueMicrotask(() => {
            child.signalCode = signal;
            child.emit("close", null, signal);
          });
        }
      },
    });
    const running = transport({
      prompt: "task",
      workspace: "/tmp/work",
      signal: controller.signal,
    });
    controller.abort();
    const result = await running;
    assert.equal(result.timed_out, false);
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.process_residue_count, 0);
    assert.deepEqual(signals, ["SIGTERM"]);
  } finally {
    rmSync(sourceHome, { recursive: true, force: true });
  }
});
