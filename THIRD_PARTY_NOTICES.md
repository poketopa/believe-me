# Third-party notices

No application source from the three inspiration projects has been copied into
this repository.

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

Vendored build tooling:

- Gradle Wrapper 9.2.1 scripts and JAR under
  `test/fixtures/roomescape-cancel-booking-penalty/`;
- generated with the official Gradle `wrapper` task and otherwise unmodified;
- wrapper JAR SHA-256
  `423cb469ccc0ecc31f0e4e1c309976198ccb734cdcbb7029d4bda0f18f57e8d9`;
- Gradle is Copyright © 2015-2026 the original authors and licensed under
  Apache License 2.0: <https://github.com/gradle/gradle/blob/master/LICENSE>.
