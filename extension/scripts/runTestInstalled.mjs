/**
 * @vscode/test-electron against the installed extension folder (not dev tree).
 */
import * as path from "node:path";
import * as os from "node:os";
import { runTests } from "@vscode/test-electron";

const repoExtension = path.resolve(import.meta.dirname, "..");
const installedExt = path.join(
  os.homedir(),
  ".cursor",
  "extensions",
  "serhiivoinolovych.claude-skill-deployer-1.0.33"
);
const extensionTestsPath = path.join(repoExtension, "out", "test", "integration", "index.js");
const testWorkspace = path.join(repoExtension, "src", "test", "integration", "fixtures", "smoke-workspace");

await runTests({
  extensionDevelopmentPath: installedExt,
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
