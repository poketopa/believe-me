import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";

const REPO_ROOT = process.cwd();
const SCRIPT = resolve("scripts/check-release.js");
const CI_WORKFLOW = resolve(".github/workflows/ci.yml");
const PUBLISH_WORKFLOW = resolve(".github/workflows/publish.yml");
const temporaryRoots = new Set();

after(async () => {
  await Promise.all([...temporaryRoots].map((root) =>
    rm(root, { recursive: true, force: true })));
});

function runReleaseCheck(args = [], cwd = REPO_ROOT) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd,
      env: process.env,
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

function parseSingleJsonLine(result) {
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.endsWith("\n"), true);
  assert.equal(result.stdout.slice(0, -1).includes("\n"), false);
  return JSON.parse(result.stdout);
}

async function readProjectJson(root, path) {
  return JSON.parse(await readFile(join(root, path), "utf8"));
}

async function writeProjectJson(root, path, value) {
  await writeFile(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
}

async function writeProduct(root, { name, version }) {
  await writeFile(
    join(root, "src/product.js"),
    `export const product = Object.freeze({\n  name: ${JSON.stringify(name)},\n  version: ${JSON.stringify(version)},\n});\n`,
  );
}

async function copyProject() {
  const root = await mkdtemp(join(tmpdir(), "vah-release-"));
  temporaryRoots.add(root);
  for (const path of [
    "bin",
    "src",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "package.json",
    "package-lock.json",
  ]) {
    await cp(join(REPO_ROOT, path), join(root, path), { recursive: true, force: true });
  }
  return root;
}

async function preparePublishableProject() {
  const root = await copyProject();
  const packageJson = await readProjectJson(root, "package.json");
  packageJson.version = "1.2.3";
  packageJson.private = false;
  await writeProjectJson(root, "package.json", packageJson);

  const packageLock = await readProjectJson(root, "package-lock.json");
  packageLock.version = "1.2.3";
  packageLock.packages[""].version = "1.2.3";
  await writeProjectJson(root, "package-lock.json", packageLock);
  await writeProduct(root, { name: packageJson.name, version: "1.2.3" });
  return root;
}

async function assertFailure({ mutate, args = ["--tag", "v1.2.3", "--publish"], code, field }) {
  const root = await preparePublishableProject();
  await mutate(root);
  const result = await runReleaseCheck(args, root);
  const payload = parseSingleJsonLine(result);
  assert.equal(result.code, 1);
  assert.equal(payload.status, "error");
  assert.equal(payload.publishable, false);
  assert.equal(payload.publicationBlocked, true);
  assert.equal(payload.errors.some((error) => error.code === code), true, JSON.stringify(payload.errors));
  assert.equal(payload.errors.some((error) => error.field === field), true, JSON.stringify(payload.errors));
  assert.doesNotMatch(result.stdout, /Error:|at .*check-release|stack/i);
}

test("current release checkout reports development mode without publishing", async () => {
  const result = await runReleaseCheck();
  const payload = parseSingleJsonLine(result);
  assert.equal(result.code, 0);
  assert.deepEqual(payload, {
    status: "ok",
    mode: "development",
    publishable: false,
    publicationBlocked: true,
    tag: null,
    metadata: {
      package: {
        name: "@poketopa/believe-me",
        version: "0.1.0",
        private: false,
      },
      lock: {
        name: "@poketopa/believe-me",
        version: "0.1.0",
        rootVersion: "0.1.0",
      },
      product: {
        name: "@poketopa/believe-me",
        version: "0.1.0",
      },
    },
    requiredFiles: {
      expected: ["README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"],
      missing: [],
    },
    pack: {
      checked: false,
      files: [],
      unsafe: [],
    },
    errors: [],
  });
});

test("publish mode succeeds only when tag, metadata, files, privacy, and pack are clean", async () => {
  const root = await preparePublishableProject();
  const result = await runReleaseCheck(["--tag", "v1.2.3", "--publish"], root);
  const payload = parseSingleJsonLine(result);
  assert.equal(result.code, 0);
  assert.equal(payload.status, "ok");
  assert.equal(payload.mode, "publish");
  assert.equal(payload.publishable, true);
  assert.equal(payload.publicationBlocked, false);
  assert.deepEqual(payload.tag, { input: "v1.2.3", version: "1.2.3" });
  assert.equal(payload.pack.checked, true);
  assert.equal(payload.pack.files.includes("package.json"), true);
  assert.equal(payload.pack.files.includes("src/product.js"), true);
  assert.equal(payload.pack.files.includes("README.md"), true);
  assert.equal(payload.pack.files.includes("LICENSE"), true);
  assert.equal(payload.pack.files.includes("THIRD_PARTY_NOTICES.md"), true);
  assert.deepEqual(payload.pack.unsafe, []);
});

test("malformed publish tag fails before pack checks", async () => {
  await assertFailure({
    args: ["--tag", "1.2.3", "--publish"],
    mutate: async () => {},
    code: "tag_invalid",
    field: "tag",
  });
});

test("tag and package version drift fails", async () => {
  await assertFailure({
    args: ["--tag", "v1.2.4", "--publish"],
    mutate: async () => {},
    code: "tag.version_mismatch",
    field: "tag.version",
  });
});

test("package name drift from runtime product fails", async () => {
  await assertFailure({
    mutate: async (root) => {
      await writeProduct(root, { name: "other-agent-harness", version: "1.2.3" });
    },
    code: "name.product_mismatch",
    field: "name.product",
  });
});

test("empty metadata fails even when all sources agree", async () => {
  const root = await copyProject();
  const packageJson = await readProjectJson(root, "package.json");
  packageJson.name = "";
  await writeProjectJson(root, "package.json", packageJson);
  const packageLock = await readProjectJson(root, "package-lock.json");
  packageLock.packages[""].name = "";
  await writeProjectJson(root, "package-lock.json", packageLock);
  await writeProduct(root, { name: "", version: packageJson.version });

  const result = await runReleaseCheck([], root);
  const payload = parseSingleJsonLine(result);
  assert.equal(result.code, 1);
  assert.equal(payload.errors.some((error) =>
    error.code === "metadata_invalid" && error.field === "name.package"), true);
});

test("package version drift from package lock fails", async () => {
  await assertFailure({
    mutate: async (root) => {
      const packageLock = await readProjectJson(root, "package-lock.json");
      packageLock.packages[""].version = "1.2.4";
      await writeProjectJson(root, "package-lock.json", packageLock);
    },
    code: "version.lock_mismatch",
    field: "version.lock",
  });
});

test("package version drift from package-lock root fails", async () => {
  await assertFailure({
    mutate: async (root) => {
      const packageLock = await readProjectJson(root, "package-lock.json");
      packageLock.version = "1.2.4";
      await writeProjectJson(root, "package-lock.json", packageLock);
    },
    code: "version.lockfile_mismatch",
    field: "version.lockfile",
  });
});

test("package version drift from runtime product fails", async () => {
  await assertFailure({
    mutate: async (root) => {
      await writeProduct(root, { name: "@poketopa/believe-me", version: "1.2.4" });
    },
    code: "version.product_mismatch",
    field: "version.product",
  });
});

test("private package refuses publish mode", async () => {
  await assertFailure({
    mutate: async (root) => {
      const packageJson = await readProjectJson(root, "package.json");
      packageJson.private = true;
      await writeProjectJson(root, "package.json", packageJson);
    },
    code: "private_publish_blocked",
    field: "package.private",
  });
});

test("missing required publish files are reported exactly", async () => {
  const root = await preparePublishableProject();
  await rm(join(root, "LICENSE"));
  const result = await runReleaseCheck(["--tag", "v1.2.3", "--publish"], root);
  const payload = parseSingleJsonLine(result);
  assert.equal(result.code, 1);
  assert.deepEqual(payload.requiredFiles.missing, ["LICENSE"]);
  assert.deepEqual(payload.errors.find((error) => error.code === "required_files_missing"), {
    code: "required_files_missing",
    field: "files.required",
    expected: ["README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"],
    actual: ["LICENSE"],
  });
});

test("required publish files must not be symlinks to external content", async () => {
  const externalRoot = await mkdtemp(join(tmpdir(), "vah-release-external-"));
  temporaryRoots.add(externalRoot);
  const externalReadme = join(externalRoot, "README.md");
  await writeFile(externalReadme, "unreviewed external content\n");

  await assertFailure({
    mutate: async (root) => {
      await rm(join(root, "README.md"));
      await symlink(externalReadme, join(root, "README.md"));
    },
    code: "required_files_invalid",
    field: "files.required",
  });
});

test("required publish paths must be regular files", async () => {
  await assertFailure({
    mutate: async (root) => {
      await rm(join(root, "LICENSE"));
      await mkdir(join(root, "LICENSE"));
    },
    code: "required_files_invalid",
    field: "files.required",
  });
});

test("required notices cannot be present locally but absent from the packed artifact", async () => {
  await assertFailure({
    mutate: async (root) => {
      const packageJson = await readProjectJson(root, "package.json");
      packageJson.files = packageJson.files.filter((path) => path !== "THIRD_PARTY_NOTICES.md");
      await writeProjectJson(root, "package.json", packageJson);
    },
    code: "required_packed_files_missing",
    field: "pack.files",
  });
});

test("npm publish lifecycle scripts are rejected before pack validation", async () => {
  await assertFailure({
    mutate: async (root) => {
      const packageJson = await readProjectJson(root, "package.json");
      packageJson.scripts.prepack = "node mutate-package.js";
      await writeProjectJson(root, "package.json", packageJson);
    },
    code: "publish_lifecycle_scripts_blocked",
    field: "package.scripts",
  });
});

test("unsafe files included by npm pack fail publish validation", async () => {
  await assertFailure({
    mutate: async (root) => {
      await mkdir(join(root, "src/state"), { recursive: true });
      await writeFile(join(root, "src/state/run.json"), "{}\n");
      await writeFile(join(root, "src/.env"), "TOKEN=redacted\n");
    },
    code: "unsafe_packed_files",
    field: "pack.files",
  });
});

test("unexpected arguments are sanitized and never echoed", async () => {
  const result = await runReleaseCheck(["--secret-value"]);
  const payload = parseSingleJsonLine(result);
  assert.equal(result.code, 1);
  assert.equal(payload.errors[0].actual, "Error");
  assert.doesNotMatch(result.stdout, /secret-value/);
});

test("publish workflow is a release-only guarded OIDC contract", async () => {
  const workflow = await readFile(PUBLISH_WORKFLOW, "utf8");
  assert.match(workflow, /^"on":\n  release:\n    types:\n      - published$/mu);
  assert.doesNotMatch(
    workflow,
    /^\s*(push|pull_request|pull_request_target|workflow_dispatch|repository_dispatch|schedule):/mu,
  );
  assert.match(
    workflow,
    /^    if: \$\{\{ vars\.NPM_PUBLISH_ENABLED == 'true' \}\}$/mu,
  );
  assert.match(workflow, /^    environment: npm$/mu);
  assert.match(workflow, /^    runs-on: ubuntu-latest$/mu);
  assert.match(workflow, /^permissions: \{\}$/mu);
  assert.match(
    workflow,
    /^    permissions:\n      contents: read\n      id-token: write$/mu,
  );
  assert.doesNotMatch(workflow, /contents:\s*write/iu);
  assert.doesNotMatch(workflow, /(NODE_AUTH_TOKEN|NPM_TOKEN|npm[_-]?token)/u);
});

test("publish workflow pins actions, freezes the event commit, and does not retain credentials", async () => {
  const workflow = await readFile(PUBLISH_WORKFLOW, "utf8");
  const usesLines = workflow.match(/^\s+-?\s*uses:\s*[^\n]+$/gmu) ?? [];
  assert.equal(usesLines.length, 2);
  for (const line of usesLines) {
    assert.match(line, /@[a-f0-9]{40}(?:\s+#\s+v\d+)?$/u);
  }
  assert.match(
    workflow,
    /^concurrency:\n  group: npm-publish-\$\{\{ github\.event\.release\.tag_name \}\}\n  cancel-in-progress: false$/mu,
  );
  assert.match(workflow, /^          ref: \$\{\{ github\.sha \}\}$/mu);
  assert.doesNotMatch(
    workflow,
    /^          ref: \$\{\{ github\.event\.release\.tag_name \}\}$/mu,
  );
  assert.match(workflow, /^          fetch-depth: 0$/mu);
  assert.match(workflow, /^          persist-credentials: false$/mu);
  assert.doesNotMatch(workflow, /^\s*run:.*\$\{\{/mu);
});

test("publish workflow proves main ancestry and validates before one final publish", async () => {
  const workflow = await readFile(PUBLISH_WORKFLOW, "utf8");
  const commands = [
    "git merge-base --is-ancestor \"$GITHUB_SHA\" origin/main",
    "run: npm ci --ignore-scripts",
    "run: npm run check",
    "run: npm test",
    "RELEASE_TAG: ${{ github.event.release.tag_name }}",
    "run: npm run release:check -- --tag \"$RELEASE_TAG\" --publish",
    "run: npm run pack:check",
    "run: npm publish --access public",
  ];
  const positions = commands.map((command) => workflow.indexOf(command));
  assert.equal(positions.every((position) => position >= 0), true, JSON.stringify(positions));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
  assert.equal(workflow.match(/run: npm publish --access public/gu)?.length, 1);
  assert.equal(workflow.trimEnd().endsWith("run: npm publish --access public"), true);
});

test("the standalone pack check cannot execute npm lifecycle scripts", async () => {
  const packageJson = await readProjectJson(REPO_ROOT, "package.json");
  assert.equal(packageJson.scripts["pack:check"], "npm pack --dry-run --ignore-scripts");
});

test("ordinary CI continuously exercises the release validator", async () => {
  const workflow = await readFile(CI_WORKFLOW, "utf8");
  assert.equal(workflow.match(/run: npm run release:check/gu)?.length, 1);
  const install = workflow.indexOf("run: npm ci");
  const syntax = workflow.indexOf("run: npm run check");
  const release = workflow.indexOf("run: npm run release:check");
  const tests = workflow.indexOf("run: npm test");
  const pack = workflow.indexOf("run: npm run pack:check");
  assert.deepEqual(
    [install, syntax, release, tests, pack],
    [...[install, syntax, release, tests, pack]].sort((left, right) => left - right),
  );
  assert.equal([install, syntax, release, tests, pack].every((position) => position >= 0), true);
});
