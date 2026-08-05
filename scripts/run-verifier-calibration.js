import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJSONLine,
  runCommandVerifier,
  runVerifierMutationCalibration,
  writeMutationCalibrationLedger,
} from "../src/index.js";
import { buildVerifierMutationCorpus } from
  "../test/fixtures/verifier-mutation-corpus.js";

const defaultOutput = fileURLToPath(new URL(
  "../benchmarks/calibration/verifier-mutation-corpus-v1/calibration.jsonl",
  import.meta.url,
));
const outputPath = resolve(process.argv[2] ?? defaultOutput);
const { registry, fixtureRoots } = await buildVerifierMutationCorpus();
const completed = await runVerifierMutationCalibration({
  registry,
  fixtureRoots,
  async verifier({ workspaceRoot, mutation }) {
    return runCommandVerifier({
      projectRoot: workspaceRoot,
      spec: {
        schema_version: { major: 1 },
        adapter_id: mutation.verifier.adapter_id,
        command: mutation.verifier.command,
        args: mutation.verifier.args,
        timeout_ms: mutation.verifier.timeout_ms,
        max_output_bytes: mutation.verifier.max_output_bytes,
      },
    });
  },
});
const written = await writeMutationCalibrationLedger({
  path: outputPath,
  registry: completed.registry,
  observations: completed.observations,
});
process.stdout.write(canonicalJSONLine({
  status: "ok",
  path: written.path,
  sha256: written.sha256,
  summary: written.summary,
}));
