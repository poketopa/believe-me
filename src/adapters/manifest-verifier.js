import { runCommandVerifier } from "./command-verifier.js";
import { runSpringVerifier } from "./spring-verifier.js";
import { validateSkillManifest } from "../contracts/skill-manifest.js";
import { usageError } from "../contracts/errors.js";
import { verifierSpecFromManifest } from "../contracts/verifier.js";
import { validateHermeticBoundary } from "../contracts/hermetic-boundary.js";

function workspaceFromRequest(request) {
  const root = request?.workspaceRoot ?? request?.projectRoot;
  if (typeof root !== "string" || root.length === 0) {
    throw usageError("Manifest verifier requires workspaceRoot or projectRoot.");
  }
  return root;
}

export function createManifestVerifier(manifest, options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw usageError("Manifest verifier options must be an object.");
  }
  const validatedManifest = validateSkillManifest(manifest);
  const spec = verifierSpecFromManifest(validatedManifest);
  const hermeticBoundary = options.hermeticBoundary === undefined
    ? undefined
    : validateHermeticBoundary(options.hermeticBoundary);
  const commandRunner = options.runCommandVerifier ?? runCommandVerifier;
  const springRunner = options.runSpringVerifier ?? runSpringVerifier;
  if (typeof commandRunner !== "function" || typeof springRunner !== "function") {
    throw usageError("Manifest verifier runners must be functions.");
  }

  if (spec.adapter_id === "command-verifier") {
    return async (request) => commandRunner({
      projectRoot: workspaceFromRequest(request),
      spec,
      signal: request.signal,
      ...(hermeticBoundary === undefined ? {} : {
        hermeticBoundary,
        inspectBackend: options.inspectBackend,
        hostPlatform: options.hostPlatform,
      }),
    });
  }
  return async (request) => springRunner({
    fixtureRoot: workspaceFromRequest(request),
    signal: request.signal,
    ...(hermeticBoundary === undefined ? {} : {
      hermeticBoundary,
      inspectBackend: options.inspectSpringBackend,
      hostPlatform: options.hostPlatform,
      backendExecFile: options.backendExecFile,
      nameFactory: options.nameFactory,
    }),
  });
}
