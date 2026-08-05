import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

function run(command, args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      ...options,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolveResult({ code, signal, stdout, stderr });
    });
  });
}

test("npm tarball installs with a working executable", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "vah-package-"));
  const installRoot = await mkdtemp(join(tmpdir(), "vah-install-"));
  await writeFile(join(installRoot, "package.json"), `${JSON.stringify({
    name: "verifiable-agent-harness-install-smoke",
    private: true,
    version: "0.0.0",
  })}\n`);

  const packed = await run(
    "npm",
    ["pack", "--json", "--pack-destination", packageRoot],
    { cwd: process.cwd(), env: process.env },
  );
  assert.equal(packed.signal, null);
  assert.equal(packed.code, 0, packed.stderr);
  const [{ filename }] = JSON.parse(packed.stdout);
  const tarball = resolve(packageRoot, filename);

  const installed = await run(
    "npm",
    ["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: installRoot, env: process.env },
  );
  assert.equal(installed.signal, null);
  assert.equal(installed.code, 0, installed.stderr);

  const executable = join(
    installRoot,
    "node_modules",
    ".bin",
    "verifiable-agent-harness",
  );
  await mkdir(join(installRoot, "project"));
  const version = await run(executable, ["--version"], {
    cwd: join(installRoot, "project"),
    env: process.env,
  });
  assert.equal(version.signal, null);
  assert.equal(version.code, 0, version.stderr);
  assert.equal(version.stderr, "");
  assert.equal(version.stdout, "0.0.0-development\n");

  const benchmarkApi = await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { summarizeBenchmarkPairs, runPairedBenchmark } from 'verifiable-agent-harness'; console.log(typeof summarizeBenchmarkPairs, typeof runPairedBenchmark);",
    ],
    { cwd: installRoot, env: process.env },
  );
  assert.equal(benchmarkApi.signal, null);
  assert.equal(benchmarkApi.code, 0, benchmarkApi.stderr);
  assert.equal(benchmarkApi.stderr, "");
  assert.equal(benchmarkApi.stdout, "function function\n");
});
