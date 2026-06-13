import * as path from "node:path";
import Mocha from "mocha";

/** VS Code extension host entry — loaded by @vscode/test-electron. */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "tdd", timeout: 90_000 });
  mocha.addFile(path.join(__dirname, "smoke.integration.js"));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} integration test(s) failed.`));
        return;
      }
      resolve();
    });
  });
}
