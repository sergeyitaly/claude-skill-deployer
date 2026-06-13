import * as assert from "node:assert";
import * as path from "node:path";
import * as vscode from "vscode";
import { listSkillStatuses } from "../../skillOps";

const EXTENSION_ID = "serhiivoinolovych.claude-skill-deployer";

suite("Extension smoke", () => {
  test("activates, refresh command runs, bundled skills load", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} should be present`);

    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "integration test requires a workspace folder");

    await vscode.commands.executeCommand("claudeSkills.refresh");
    assert.ok(ext.isActive, "extension should activate after refresh");

    const libraryDir = path.join(ext.extensionPath, "skills_library");
    const statuses = listSkillStatuses(libraryDir, folder.uri.fsPath);
    assert.ok(statuses.length > 0, "skills library should expose at least one skill");
  });
});
