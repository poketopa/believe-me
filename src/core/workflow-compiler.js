import { assertSha256Hex, assertString } from "../contracts/common.js";
import { usageError } from "../contracts/errors.js";
import { validateRunSpec } from "../contracts/run-spec.js";
import { validateSkillManifest } from "../contracts/skill-manifest.js";
import { validateWorkflowPlan } from "../contracts/workflow-plan.js";
import { sha256CanonicalJSONLine } from "./hash.js";

export const WORKFLOW_STEP_IDS = Object.freeze([
  "snapshot",
  "execute",
  "verify",
  "receipt",
]);

function assertSourceSnapshot(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw usageError("sourceSnapshot must be an object.");
  }
  assertSha256Hex(value.sha256, "sourceSnapshot.sha256");
}

function assertExecutorAdmitted(manifest, runSpec) {
  if (!manifest.executor_kinds.includes(runSpec.executor_kind)) {
    throw usageError("RunSpec executor_kind is not admitted by SkillManifest.", {
      executor_kind: runSpec.executor_kind,
      manifest_id: manifest.manifest_id,
      admitted_executor_kinds: manifest.executor_kinds,
    });
  }
}

function compileSteps() {
  return WORKFLOW_STEP_IDS.map((id, index) => ({
    id,
    order: index + 1,
  }));
}

export function compileWorkflowPlan({
  skillManifest,
  runSpec,
  sourceSnapshot,
  inputSha256,
  runSpecSha256,
  runId,
  routeSelection,
}) {
  assertString(runId, "runId");
  assertSha256Hex(inputSha256, "inputSha256");
  assertSha256Hex(runSpecSha256, "runSpecSha256");
  const manifest = validateSkillManifest(skillManifest);
  const spec = validateRunSpec(runSpec);
  assertSourceSnapshot(sourceSnapshot);
  assertExecutorAdmitted(manifest, spec);

  const plan = {
    schema_version: { major: 1 },
    run_id: runId,
    manifest_sha256: sha256CanonicalJSONLine(manifest),
    source_snapshot_sha256: sourceSnapshot.sha256,
    executor_kind: spec.executor_kind,
    steps: compileSteps(),
    expected_result: {
      input_sha256: inputSha256,
      status: "completed",
      min_changes: 1,
      run_spec_sha256: runSpecSha256,
    },
  };
  if (routeSelection !== undefined) {
    plan.route_selection = routeSelection;
  }
  return validateWorkflowPlan(plan);
}
