import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

export function isolateGradleUserHome(label) {
  const previous = process.env.GRADLE_USER_HOME;
  const gradleUserHome = mkdtempSync(join(tmpdir(), `believeme-gradle-${label}-`));
  process.env.GRADLE_USER_HOME = gradleUserHome;

  after(() => {
    if (previous === undefined) {
      delete process.env.GRADLE_USER_HOME;
    } else {
      process.env.GRADLE_USER_HOME = previous;
    }
    rmSync(gradleUserHome, { recursive: true, force: true });
  });

  return gradleUserHome;
}
