import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

const MIGRATION_KEY = "claudeSkills.migratedToV1";

function copyDir(src: string, dest: string): void {
  if (!fs.existsSync(src)) {
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

/** Backup workspace .claude/learning on first v1.0 activation. */
export async function runV1Migration(
  context: vscode.ExtensionContext,
  target: string | undefined
): Promise<void> {
  if (context.globalState.get<boolean>(MIGRATION_KEY, false)) {
    return;
  }
  await context.globalState.update(MIGRATION_KEY, true);

  if (!target) {
    return;
  }

  const learningDir = path.join(target, ".claude", "learning");
  if (!fs.existsSync(learningDir)) {
    return;
  }

  const backupRoot = path.join(target, ".claude", "backup-v0.7");
  if (fs.existsSync(backupRoot)) {
    return;
  }

  try {
    copyDir(learningDir, path.join(backupRoot, "learning"));
    void vscode.window.showInformationMessage(
      `Claude Skills v1.0: backed up learning data to ${backupRoot}`
    );
  } catch {
    // non-fatal
  }
}
