import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { directoryExists } from "./criticalFixes";

export interface RecoveryIssue {
  file?: string;
  action: "backup-and-repair" | "create-skills-dir" | "create-learning-dir";
  message: string;
}

function isCorruptedJson(filePath: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  try {
    JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return false;
  } catch {
    return true;
  }
}

function isCorruptedJsonl(filePath: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      JSON.parse(trimmed);
    } catch {
      return true;
    }
  }
  return false;
}

function backupFile(filePath: string): void {
  const backup = `${filePath}.bak-${Date.now()}`;
  fs.copyFileSync(filePath, backup);
}

export function scanForIssues(target: string): RecoveryIssue[] {
  const issues: RecoveryIssue[] = [];
  const learningDir = path.join(target, ".claude", "learning");
  const skillsDir = path.join(target, ".claude", "skills");

  const globalBudget = path.join(os.homedir(), ".claude", "learning", "budget.json");
  if (isCorruptedJson(globalBudget)) {
    issues.push({ file: globalBudget, action: "backup-and-repair", message: "Corrupted global budget.json" });
  }

  const runsPath = path.join(learningDir, "runs.jsonl");
  if (isCorruptedJsonl(runsPath)) {
    issues.push({ file: runsPath, action: "backup-and-repair", message: "Corrupted runs.jsonl" });
  }

  if (!directoryExists(skillsDir)) {
    issues.push({ action: "create-skills-dir", message: "Missing .claude/skills directory" });
  }

  return issues;
}

export async function repairIssues(target: string, issues: RecoveryIssue[]): Promise<string[]> {
  const fixed: string[] = [];
  for (const issue of issues) {
    if (issue.action === "backup-and-repair" && issue.file) {
      backupFile(issue.file);
      if (issue.file.endsWith(".json")) {
        fs.writeFileSync(issue.file, "{}\n", "utf-8");
      } else if (issue.file.endsWith(".jsonl")) {
        const valid = fs
          .readFileSync(issue.file, "utf-8")
          .split("\n")
          .filter((line) => {
            const t = line.trim();
            if (!t) {
              return false;
            }
            try {
              JSON.parse(t);
              return true;
            } catch {
              return false;
            }
          });
        fs.writeFileSync(issue.file, valid.join("\n") + (valid.length ? "\n" : ""), "utf-8");
      }
      fixed.push(issue.message);
    }
    if (issue.action === "create-skills-dir") {
      fs.mkdirSync(path.join(target, ".claude", "skills"), { recursive: true });
      fixed.push(issue.message);
    }
  }
  return fixed;
}

export class ErrorRecovery {
  async repairCommonIssues(target: string | undefined): Promise<void> {
    if (!target) {
      return;
    }
    const issues = scanForIssues(target);
    if (issues.length === 0) {
      return;
    }

    const detail = issues.map((i) => `- ${i.message}`).join("\n");
    const action = await vscode.window.showWarningMessage(
      `Found ${issues.length} Claude Skills data issue(s). Repair automatically?`,
      { modal: false, detail },
      "Repair Automatically",
      "Show Details",
      "Dismiss"
    );

    if (action === "Show Details") {
      await vscode.window.showInformationMessage(detail, { modal: true });
      return;
    }
    if (action === "Repair Automatically") {
      const fixed = await repairIssues(target, issues);
      vscode.window.showInformationMessage(`Claude Skills: repaired ${fixed.length} issue(s).`);
    }
  }
}
