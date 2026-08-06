import {
  assertRouteSelectionMatchesLaunch,
  launchPolicyAliases,
  validateAdaptiveSessionLaunch,
} from "../contracts/adaptive-session-launch.js";
import { validateCodexTaskInput } from "../contracts/codex-executor.js";
import { infraError } from "../contracts/errors.js";
import { createCodexExecutor } from "./codex-executor.js";
import { createCodexCliTransport } from "./codex-transport.js";

export function createAdaptiveCodexRegistry(launchOrOptions, selection = undefined, deps = {}) {
  const options = selection === undefined &&
    launchOrOptions !== null &&
    typeof launchOrOptions === "object" &&
    Object.hasOwn(launchOrOptions, "launch")
    ? launchOrOptions
    : { launch: launchOrOptions, selection, ...deps };
  const {
    createTransport = createCodexCliTransport,
    createExecutor = createCodexExecutor,
  } = options;
  if (typeof createTransport !== "function" || typeof createExecutor !== "function") {
    throw infraError("Codex registry dependencies are unavailable.");
  }
  const frozenLaunch = validateAdaptiveSessionLaunch(options.launch);
  const frozenSelection = options.selection === undefined
    ? null
    : assertRouteSelectionMatchesLaunch(options.selection, frozenLaunch);
  const aliases = launchPolicyAliases(frozenLaunch);
  return Object.freeze({
    "codex-cli": Object.freeze({
      executor_kind: "codex",
      model_ids: aliases.model_ids,
      reasoning_efforts: aliases.reasoning_efforts,
      executor_input_validator: validateCodexTaskInput,
      create_executor(selectionForRoute = frozenSelection) {
        const boundSelection = assertRouteSelectionMatchesLaunch(
          selectionForRoute,
          frozenLaunch,
        );
        return createExecutor({
          transport: createTransport({
            model: boundSelection.model_id,
            reasoningEffort: boundSelection.reasoning_effort,
          }),
        });
      },
    }),
  });
}
