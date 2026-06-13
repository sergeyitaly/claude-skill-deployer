import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "../../..");
  const extensionTestsPath = path.resolve(__dirname, "./index");
  const testWorkspace = path.resolve(
    extensionDevelopmentPath,
    "src/test/integration/fixtures/smoke-workspace"
  );

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    extensionTestsEnv: {
      CLAUDE_SKILLS_INTEGRATION_TEST: "1",
    },
    launchArgs: [
      testWorkspace,
      "--disable-extensions",
      "--disable-workspace-trust",
      "--skip-release-notes",
      "--skip-welcome",
    ],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
