# Third-party notices

No application source from the two friends' inspiration projects has been
copied into this repository. Selected Codex transport and event-boundary code
from the owner's existing harness has now been adapted as recorded below.

Before adapting or copying source, record:

- source repository and immutable commit;
- original file or component;
- copied or adapted behavior;
- local modifications;
- upstream license and copyright notice;
- date and form of any additional permission.

Current design references:

- `jyt6640/persona-harness` — Apache-2.0;
- `bhoon716/skill-forge` — MIT;
- the owner's existing harness repository — licensing to be resolved per reused
  component before publication.

Behavior-only reference added for the canonical fixture:

- owner harness commit `dc958f858882f10e11644326296690b8670ae7b5`;
- requirement `studies/portfolio-semantic-evaluator-v1/phase3-preprovider-fake-validation-20260724T014000Z/reviewer-packages/P3-M04/package.json`;
- local fixture `test/fixtures/roomescape-cancel-booking-penalty`;
- implementation form: clean-room from the written requirement; no Java source
  copied or adapted.

Owner-authorized adapted source:

- source workspace: the owner's existing `harness` repository, base HEAD
  `dc958f858882f10e11644326296690b8670ae7b5`; the referenced package files were
  uncommitted working-tree material at the time of adaptation;
- original components and exact source SHA-256 values:
  - `packages/spring-usecase-harness/lib/repair/codex-events.js` —
    `3908694de09832f34ccbb17ea7d36166959ba35de09d793dbd03abd4f15121b3`;
  - `packages/spring-usecase-harness/lib/repair/codex-transport.js` —
    `74fac420b62f34f41454f869c0e54a93a6e640cab8ebb6098a7cafd77ede92b6`;
  - `packages/spring-usecase-harness/lib/security/secrets.js` —
    `2db117560cabbf7cf6b1d93435cbbbcabb178c74f45cfe09e1f47ea26b59ca77`;
- local derivatives: `src/adapters/codex-events.js`,
  `src/adapters/codex-transport.js`, and `src/core/secrets.js`;
- adapted behavior: bounded JSONL parsing, terminal/usage checks, isolated
  Codex authentication, fixed non-shell process execution, timeout/output
  bounds, process cleanup, and high-confidence credential detection;
- local modifications: rewritten for the executor-neutral contracts, official
  `workspace-write` flags, generic workspace-diff result derivation, typed
  harness errors, receipt-bound event bytes, and the npm package API;
- upstream package license at adaptation time: `UNLICENSED`/all rights reserved;
- additional permission: the source owner explicitly authorized code reuse for
  this portfolio harness in the project-planning conversation;
- adaptation date: 2026-08-05.

Vendored build tooling:

- Gradle Wrapper 9.2.1 scripts and JAR under
  `test/fixtures/roomescape-cancel-booking-penalty/`;
- generated with the official Gradle `wrapper` task and otherwise unmodified;
- wrapper JAR SHA-256
  `423cb469ccc0ecc31f0e4e1c309976198ccb734cdcbb7029d4bda0f18f57e8d9`;
- Gradle is Copyright © 2015-2026 the original authors and licensed under
  Apache License 2.0: <https://github.com/gradle/gradle/blob/master/LICENSE>.
