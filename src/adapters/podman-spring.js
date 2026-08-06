import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import {
  validateHermeticBoundary,
  validateHermeticBoundaryRefusal,
} from "../contracts/hermetic-boundary.js";
import { infraError, safetyRefusal, usageError } from "../contracts/errors.js";

const LINUX_PODMAN_PATH = "/usr/bin/podman";
const DARWIN_PODMAN_PATHS = Object.freeze([
  "/opt/homebrew/bin/podman",
  "/usr/local/bin/podman",
]);
const PODMAN_VERSION_PATTERN = /^podman version ([0-9]+(?:\.[0-9]+){1,3})\n?$/u;
const SAFE_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,62}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const WRAPPER_COMMAND = "./gradlew";
const WRAPPER_ARGS = Object.freeze(["--no-daemon", "--console=plain", "-q", "test"]);
const RUN_FLAGS = Object.freeze([
  "--cap-drop",
  "--env",
  "--init",
  "--name",
  "--network",
  "--pids-limit",
  "--pull",
  "--read-only",
  "--rm",
  "--security-opt",
  "--tmpfs",
  "--userns",
  "--volume",
  "--workdir",
]);
const CLEANUP_PROBES = Object.freeze([
  { args: ["rm", "--help"], required: ["--force", "--ignore"] },
  { args: ["ps", "--help"], required: ["--filter", "--format"] },
  { args: ["network", "exists", "--help"], required: [] },
  { args: ["network", "rm", "--help"], required: [] },
]);
const SERVICE_PROBES = Object.freeze([
  { args: ["network", "create", "--help"], required: ["--internal"] },
  { args: ["exec", "--help"], required: [] },
]);
const HOST_ENV = Object.freeze({ LC_ALL: "C", PATH: "/usr/bin:/bin" });
const SERVICE_ENV = Object.freeze({
  POSTGRES_DB: "verifier",
  POSTGRES_USER: "verifier",
  POSTGRES_PASSWORD: "verifier-password",
});

function refusal(code, hostPlatform, message) {
  return validateHermeticBoundaryRefusal({
    schema_version: { major: 1 },
    status: "refused",
    code,
    backend_kind: "rootless-oci",
    host_platform: hostPlatform,
    message,
  });
}

function refuse(code, hostPlatform, message) {
  throw safetyRefusal("Hermetic Spring OCI backend refused before execution.", {
    refusal: refusal(code, hostPlatform, message),
  });
}

function execFileBounded(execFileImpl, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, {
      encoding: "utf8",
      env: HOST_ENV,
      timeout: options.timeout ?? 3_000,
      maxBuffer: options.maxBuffer ?? 64 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function probe(execFileImpl, command, args, options = {}) {
  try {
    const output = await execFileBounded(execFileImpl, command, args, options);
    if (options.allowStderr !== true && output.stderr !== "") return null;
    return output.stdout;
  } catch {
    return null;
  }
}

function podmanRuntimeIdentity(stdout) {
  const match = PODMAN_VERSION_PATTERN.exec(stdout ?? "");
  return match === null ? null : `podman-${match[1]}`;
}

function executableIdentity(stats) {
  return Object.freeze({
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    size: stats.size.toString(),
    modified_ns: stats.mtimeNs.toString(),
  });
}

function sameExecutableIdentity(left, right) {
  return left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modified_ns === right.modified_ns;
}

async function executableRecord(path) {
  const resolved = await realpath(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (resolved === null) return null;
  const stats = await lstat(resolved, { bigint: true }).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (
    stats === null ||
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    (stats.mode & 0o111n) === 0n
  ) {
    return null;
  }
  return Object.freeze({
    executable: resolved,
    file_identity: executableIdentity(stats),
  });
}

function candidatePaths(hostPlatform, executable) {
  if (executable !== undefined) {
    if (!isAbsolute(executable)) {
      throw usageError("Podman inspection requires an absolute executable.", {
        field: "executable",
      });
    }
    return [executable];
  }
  if (hostPlatform === "linux") return [LINUX_PODMAN_PATH];
  if (hostPlatform === "darwin") return [...DARWIN_PODMAN_PATHS];
  return [];
}

function parsePodmanInfo(stdout) {
  try {
    const info = JSON.parse(stdout);
    const os = info?.host?.os ?? info?.host?.OS;
    const rootless = info?.host?.security?.rootless ?? info?.host?.rootless;
    return os === "linux" && rootless === true;
  } catch {
    return false;
  }
}

function parseMachineInspect(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const machines = Array.isArray(parsed) ? parsed : [parsed];
    return machines.some((machine) =>
      (machine?.State ?? machine?.state) === "running" &&
      (machine?.Rootful ?? machine?.rootful) === false);
  } catch {
    return false;
  }
}

async function hasHelpProbes(execFileImpl, executable, probes) {
  for (const { args, required } of probes) {
    const output = await probe(execFileImpl, executable, args);
    if (output === null || required.some((flag) => !output.includes(flag))) {
      return false;
    }
  }
  return true;
}

export async function inspectPodmanBackend(options = {}) {
  const hostPlatform = options.hostPlatform ?? process.platform;
  const execFileImpl = options.execFileImpl ?? execFile;
  if (hostPlatform !== "linux" && hostPlatform !== "darwin") {
    return Object.freeze({ available: false });
  }
  if (typeof execFileImpl !== "function") {
    throw usageError("Podman inspection requires execFile.", { field: "execFileImpl" });
  }

  for (const path of candidatePaths(hostPlatform, options.executable)) {
    const record = await executableRecord(path);
    if (record === null) continue;
    const versionOutput = await probe(execFileImpl, record.executable, ["--version"]);
    const runtimeIdentity = podmanRuntimeIdentity(versionOutput);
    const infoOutput = await probe(execFileImpl, record.executable, [
      "info",
      "--format",
      "json",
    ]);
    if (
      runtimeIdentity === null ||
      infoOutput === null ||
      !parsePodmanInfo(infoOutput)
    ) {
      continue;
    }
    if (hostPlatform === "darwin") {
      const machineOutput = await probe(execFileImpl, record.executable, [
        "machine",
        "inspect",
        "--format",
        "json",
      ]);
      if (machineOutput === null || !parseMachineInspect(machineOutput)) continue;
    }
    const runHelp = await probe(execFileImpl, record.executable, ["run", "--help"]);
    if (runHelp === null || RUN_FLAGS.some((flag) => !runHelp.includes(flag))) {
      continue;
    }
    if (!await hasHelpProbes(execFileImpl, record.executable, CLEANUP_PROBES)) {
      return Object.freeze({
        available: false,
        unavailable_reason: "cleanup_unavailable",
      });
    }
    const serviceNetworkAvailable = await hasHelpProbes(
      execFileImpl,
      record.executable,
      SERVICE_PROBES,
    );
    if (!serviceNetworkAvailable && options.requireServiceNetwork === true) {
      continue;
    }
    return Object.freeze({
      available: true,
      executable: record.executable,
      runtime_identity: runtimeIdentity,
      host_platform: hostPlatform,
      file_identity: record.file_identity,
      service_network_available: serviceNetworkAvailable,
    });
  }

  return Object.freeze({ available: false });
}

function validateInspection(value) {
  if (value?.available === false) return value;
  if (
    value?.available !== true ||
    typeof value.executable !== "string" ||
    !isAbsolute(value.executable) ||
    typeof value.runtime_identity !== "string"
  ) {
    throw usageError("Podman backend inspector returned an invalid capability record.");
  }
  if (
    value.file_identity === undefined ||
    value.file_identity === null ||
    typeof value.file_identity !== "object" ||
    ["device", "inode", "size", "modified_ns"].some(
      (field) => typeof value.file_identity[field] !== "string",
    )
  ) {
    throw usageError("Podman backend inspector returned an invalid file identity.");
  }
  return value;
}

async function assertExecutableUnchanged(inspected, hostPlatform) {
  const stats = await lstat(inspected.executable, { bigint: true }).catch(() => null);
  if (
    stats === null ||
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    !sameExecutableIdentity(inspected.file_identity, executableIdentity(stats))
  ) {
    refuse(
      "runtime_identity_mismatch",
      hostPlatform,
      "The Podman executable changed after capability inspection.",
    );
  }
}

function verifyFixture(fixture) {
  if (
    fixture?.verifier?.command !== WRAPPER_COMMAND ||
    !Array.isArray(fixture.verifier.args) ||
    fixture.verifier.args.length !== WRAPPER_ARGS.length ||
    fixture.verifier.args.some((arg, index) => arg !== WRAPPER_ARGS[index])
  ) {
    throw usageError("Spring Podman invocation requires the canonical verifier fixture.");
  }
}

function makeName(nameFactory, role) {
  const value = typeof nameFactory === "function"
    ? nameFactory(role)
    : `believe-me-${role}-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  if (typeof value !== "string" || !SAFE_NAME_PATTERN.test(value)) {
    throw usageError("nameFactory must return a bounded Podman-safe name.", {
      field: role,
    });
  }
  return value;
}

async function requireLocalImage(execFileImpl, executable, digest, hostPlatform) {
  if (!DIGEST_PATTERN.test(digest)) {
    refuse("image_unavailable", hostPlatform, "The OCI image digest is not immutable.");
  }
  try {
    await execFileBounded(execFileImpl, executable, ["image", "exists", digest], {
      timeout: 2_000,
      maxBuffer: 4_096,
    });
  } catch {
    refuse("image_unavailable", hostPlatform, "The required OCI image is not present locally.");
  }
}

function verifierEnvArgs(networkMode, serviceName) {
  const env = {
    CI: "true",
    HOME: "/workspace",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    TMPDIR: "/tmp",
    GRADLE_USER_HOME: "/tmp/gradle",
    GRADLE_OPTS: "-Dorg.gradle.offline=true -Dorg.gradle.daemon=false",
  };
  if (networkMode === "isolated-service") {
    Object.assign(env, {
      SPRING_DATASOURCE_URL: `jdbc:postgresql://${serviceName}:5432/verifier`,
      SPRING_DATASOURCE_USERNAME: SERVICE_ENV.POSTGRES_USER,
      SPRING_DATASOURCE_PASSWORD: SERVICE_ENV.POSTGRES_PASSWORD,
    });
  }
  return Object.freeze(Object.entries(env).flatMap(([key, value]) => [
    "--env",
    `${key}=${value}`,
  ]));
}

function verifierRunArgs({ root, name, network, serviceName, imageDigest, fixture }) {
  return Object.freeze([
    "run",
    "--name", name,
    "--rm",
    "--init",
    "--pull=never",
    "--network", network,
    "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=256m",
    "--cap-drop", "all",
    "--security-opt", "no-new-privileges",
    "--userns", "keep-id",
    "--pids-limit", "512",
    "--volume", `${root}:/workspace:rw`,
    "--workdir", "/workspace",
    ...verifierEnvArgs(network === "none" ? "none" : "isolated-service", serviceName),
    imageDigest,
    fixture.verifier.command,
    ...fixture.verifier.args,
  ]);
}

function serviceRunArgs({ name, networkName, imageDigest }) {
  return Object.freeze([
    "run",
    "--detach",
    "--name", name,
    "--pull=never",
    "--network", networkName,
    "--read-only",
    "--tmpfs", "/var/lib/postgresql/data:rw,nosuid,nodev,size=256m",
    "--tmpfs", "/run:rw,nosuid,nodev,noexec,size=32m",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=32m",
    "--cap-drop", "all",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "256",
    "--env", `POSTGRES_DB=${SERVICE_ENV.POSTGRES_DB}`,
    "--env", `POSTGRES_USER=${SERVICE_ENV.POSTGRES_USER}`,
    "--env", `POSTGRES_PASSWORD=${SERVICE_ENV.POSTGRES_PASSWORD}`,
    imageDigest,
  ]);
}

async function runPodman(execFileImpl, executable, args, message, options = {}) {
  try {
    return await execFileBounded(execFileImpl, executable, args, options);
  } catch (error) {
    throw infraError(message, {
      cause_name: error.name,
      cause_code: error.code ?? null,
      podman_subcommand: args.slice(0, 2).join(" "),
    });
  }
}

async function prepareService({
  execFileImpl,
  executable,
  networkName,
  serviceName,
  serviceImageDigest,
}) {
  let networkCreated = false;
  let serviceCreated = false;
  try {
    await runPodman(
      execFileImpl,
      executable,
      ["network", "create", "--internal", networkName],
      "Podman isolated service network could not be created.",
    );
    networkCreated = true;
    await runPodman(
      execFileImpl,
      executable,
      serviceRunArgs({ name: serviceName, networkName, imageDigest: serviceImageDigest }),
      "Podman PostgreSQL service could not be started.",
    );
    serviceCreated = true;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await probe(execFileImpl, executable, [
        "exec",
        serviceName,
        "pg_isready",
        "-U",
        SERVICE_ENV.POSTGRES_USER,
        "-d",
        SERVICE_ENV.POSTGRES_DB,
      ], { timeout: 2_000 }) !== null) {
        return;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    throw infraError("Podman PostgreSQL service did not become ready.", {
      podman_subcommand: "exec pg_isready",
    });
  } catch (error) {
    await cleanupPreparedService({
      execFileImpl,
      executable,
      networkName,
      serviceName,
      networkCreated,
      serviceCreated,
    });
    throw error;
  }
}

async function cleanupPreparedService({
  execFileImpl,
  executable,
  networkName,
  serviceName,
  networkCreated,
  serviceCreated,
}) {
  if (serviceCreated) {
    await runPodman(
      execFileImpl,
      executable,
      ["rm", "--force", "--ignore", serviceName],
      "Podman service cleanup after preparation failure failed.",
      { timeout: 5_000 },
    );
  }
  if (networkCreated) {
    await runPodman(
      execFileImpl,
      executable,
      ["network", "rm", networkName],
      "Podman network cleanup after preparation failure failed.",
      { timeout: 5_000 },
    );
  }
}

async function removeContainerIfNamed(execFileImpl, executable, name, message) {
  await runPodman(
    execFileImpl,
    executable,
    ["rm", "--force", "--ignore", name],
    message,
    { timeout: 5_000 },
  );
}

async function verifyNoResidue(execFileImpl, executable, names) {
  for (const name of [names.verifierName, names.serviceName].filter(Boolean)) {
    const output = await runPodman(
      execFileImpl,
      executable,
      ["ps", "--all", "--filter", `name=^${name}$`, "--format", "{{.Names}}"],
      "Podman cleanup residue inspection failed.",
    );
    if (output.stdout.trim() !== "") {
      throw safetyRefusal("Podman cleanup left container residue.", {
        refusal: refusal(
          "cleanup_unavailable",
          names.hostPlatform,
          "Podman cleanup left verifier residue.",
        ),
      });
    }
  }
  if (names.networkName !== undefined) {
    try {
      await execFileBounded(
        execFileImpl,
        executable,
        ["network", "exists", names.networkName],
        { timeout: 2_000, maxBuffer: 4_096 },
      );
      throw safetyRefusal("Podman cleanup left network residue.", {
        refusal: refusal(
          "cleanup_unavailable",
          names.hostPlatform,
          "Podman cleanup left service network residue.",
        ),
      });
    } catch (error) {
      if (error?.code === "safety_refusal") throw error;
      if (error?.code === 1) return;
      throw infraError("Podman cleanup network residue inspection failed.", {
        cause_name: error.name,
        cause_code: error.code ?? null,
      });
    }
  }
}

function cleanupFunction(execFileImpl, executable, names) {
  return async function cleanup() {
    await removeContainerIfNamed(
      execFileImpl,
      executable,
      names.verifierName,
      "Podman verifier cleanup failed.",
    );
    if (names.serviceName !== undefined) {
      await removeContainerIfNamed(
        execFileImpl,
        executable,
        names.serviceName,
        "Podman service cleanup failed.",
      );
    }
    if (names.networkName !== undefined) {
      await runPodman(
        execFileImpl,
        executable,
        ["network", "rm", names.networkName],
        "Podman network cleanup failed.",
        { timeout: 5_000 },
      );
    }
    await verifyNoResidue(execFileImpl, executable, names);
    return Object.freeze({ residue: false });
  };
}

export async function preparePodmanSpringInvocation({
  boundary,
  hostPlatform = process.platform,
  inspectBackend = inspectPodmanBackend,
  root,
  fixture,
  execFileImpl = execFile,
  nameFactory,
} = {}) {
  const frozen = validateHermeticBoundary(boundary);
  if (hostPlatform !== "linux" && hostPlatform !== "darwin") {
    refuse(
      "platform_unsupported",
      hostPlatform,
      "Podman hermetic Spring verification requires a supported host.",
    );
  }
  if (frozen.platform.host !== hostPlatform) {
    refuse(
      "platform_unsupported",
      hostPlatform,
      "The host platform does not match the frozen hermetic boundary.",
    );
  }
  if (frozen.backend.kind !== "rootless-oci") {
    refuse(
      "backend_unsupported",
      hostPlatform,
      "The requested hermetic backend is not supported for Spring verification.",
    );
  }
  if (typeof inspectBackend !== "function" || typeof execFileImpl !== "function") {
    throw usageError("Podman preparation requires inspectBackend and execFile.");
  }
  if (typeof root !== "string" || !isAbsolute(root)) {
    throw usageError("Podman Spring invocation requires an absolute fixture root.", {
      field: "root",
    });
  }
  verifyFixture(fixture);

  const inspected = validateInspection(await inspectBackend({ hostPlatform, execFileImpl }));
  if (!inspected.available) {
    if (inspected.unavailable_reason === "cleanup_unavailable") {
      refuse(
        "cleanup_unavailable",
        hostPlatform,
        "The configured Podman backend cannot guarantee cleanup.",
      );
    }
    refuse("backend_missing", hostPlatform, "The configured Podman backend is unavailable.");
  }
  if (
    inspected.host_platform !== undefined &&
    inspected.host_platform !== hostPlatform
  ) {
    refuse("platform_unsupported", hostPlatform, "The Podman backend host does not match.");
  }
  if (inspected.runtime_identity !== frozen.backend.runtime_identity) {
    refuse(
      "runtime_identity_mismatch",
      hostPlatform,
      "The Podman runtime identity does not match frozen authority.",
    );
  }
  await assertExecutableUnchanged(inspected, hostPlatform);
  await requireLocalImage(execFileImpl, inspected.executable, frozen.backend.image_digest, hostPlatform);

  const verifierName = makeName(nameFactory, "verifier");
  const names = { verifierName, hostPlatform };
  let network = "none";
  if (frozen.network.mode === "isolated-service") {
    if (inspected.service_network_available === false) {
      refuse(
        "network_policy_unsupported",
        hostPlatform,
        "The configured Podman backend cannot prepare isolated service networking.",
      );
    }
    names.serviceName = makeName(nameFactory, "service");
    names.networkName = makeName(nameFactory, "network");
    await requireLocalImage(
      execFileImpl,
      inspected.executable,
      frozen.backend.service_image_digest,
      hostPlatform,
    );
    await prepareService({
      execFileImpl,
      executable: inspected.executable,
      networkName: names.networkName,
      serviceName: names.serviceName,
      serviceImageDigest: frozen.backend.service_image_digest,
    });
    network = names.networkName;
  } else if (frozen.network.mode !== "none") {
    refuse(
      "network_policy_unsupported",
      hostPlatform,
      "The requested network policy is not supported by the Podman backend.",
    );
  }

  const env = Object.freeze({
    LC_ALL: "C",
    PATH: `${dirname(inspected.executable)}:/usr/bin:/bin`,
  });
  return Object.freeze({
    command: inspected.executable,
    args: verifierRunArgs({
      root,
      name: verifierName,
      network,
      serviceName: names.serviceName,
      imageDigest: frozen.backend.image_digest,
      fixture,
    }),
    env,
    cleanup: cleanupFunction(execFileImpl, inspected.executable, names),
  });
}
