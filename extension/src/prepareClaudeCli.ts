import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { generateForAllAgents } from "./agentOps";
import {
  installCostControlHooks,
  installOfficialSkillsSessionHook,
  installProfileInitSessionHook,
} from "./hookOps";
import { installLibraryToGlobal } from "./skillOps";
import { syncCliConfigToWorkspace } from "./cliConfig";
import { ensureLearningDir } from "./usageStats";
import { hookBaseUrl } from "./hookServer";

const LEGACY_BRANCH_SYNC_HOOK = "branch-sync.js";
const GIT_HOOK_MARKER = "claude-skills branch-sync";

export interface PrepareClaudeCliResult {
  globalLibrary: boolean;
  workspaceSkills: boolean;
  costControlHooks: string;
  profileInitHooks: string;
  officialSkillsHook?: string;
  cliConfig: boolean;
  gitBranchHook: boolean;
}

function gitHooksDir(target: string): string | undefined {
  const gitDir = path.join(target, ".git");
  if (!fs.existsSync(gitDir)) {
    return undefined;
  }
  return fs.statSync(gitDir).isDirectory() ? path.join(gitDir, "hooks") : undefined;
}

function stripBranchSyncBlock(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let skipNext = false;
  for (const line of lines) {
    if (line.startsWith(`# ${GIT_HOOK_MARKER}`)) { skipNext = true; continue; }
    if (skipNext) {
      skipNext = false;
      if (line.includes(LEGACY_BRANCH_SYNC_HOOK) || line.includes("/hook/branch-sync")) continue;
    }
    result.push(line);
  }
  return result.join("\n").trimEnd();
}

/** Install post-checkout hook that POSTs to the extension HTTP server for branch-sync. */
export function installGitBranchSyncHook(target: string): boolean {
  const hooksDir = gitHooksDir(target);
  if (!hooksDir) return false;
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, "post-checkout");
  const url = `${hookBaseUrl()}/hook/branch-sync?agent=claude&cwd=${encodeURIComponent(target)}`;
  const hookBlock = `# ${GIT_HOOK_MARKER}\ncurl -sf -X POST -H "Content-Type: application/json" --data '{}' "${url}" || true\n`;

  if (!fs.existsSync(hookPath)) {
    fs.writeFileSync(hookPath, `#!/bin/sh\n${hookBlock}`, { mode: 0o755 });
    return true;
  }

  const existing = fs.readFileSync(hookPath, "utf-8");
  if (existing.includes(url)) return false; // already up-to-date

  const cleaned = existing.includes(GIT_HOOK_MARKER)
    ? stripBranchSyncBlock(existing)
    : existing.trimEnd();
  fs.writeFileSync(hookPath, `${cleaned}\n\n${hookBlock}`, { mode: 0o755 });
  return true;
}

export function isGitBranchSyncHookInstalled(target: string): boolean {
  const hooksDir = gitHooksDir(target);
  const hookPath = hooksDir ? path.join(hooksDir, "post-checkout") : undefined;
  if (!hookPath || !fs.existsSync(hookPath)) {
    return false;
  }
  return fs.readFileSync(hookPath, "utf-8").includes(GIT_HOOK_MARKER);
}

/** One-shot workspace setup for Claude Code CLI (IDE extension not required at runtime). */
export async function prepareForClaudeCli(
  extensionPath: string,
  libraryDir: string,
  target: string,
  opts?: { installGitHook?: boolean; officialSkillsHook?: boolean }
): Promise<PrepareClaudeCliResult> {
  ensureLearningDir(target);

  const globalResults = installLibraryToGlobal(libraryDir, false, false);
  const globalLibrary = globalResults.some((r) => r.status === "installed" || r.status === "skipped-exists");

  const workspaceResults = generateForAllAgents(libraryDir, target, {
    all: false,
    force: false,
    dryRun: false,
  });
  const workspaceSkills = workspaceResults.some(
    (r) => r.status === "installed" || r.status === "written" || r.status === "skipped-exists"
  );

  const costControlHooks = installCostControlHooks(extensionPath, target);
  const profileInitHooks = installProfileInitSessionHook(extensionPath, target, libraryDir);

  let officialSkillsHook: string | undefined;
  const wantOfficial =
    opts?.officialSkillsHook ??
    vscode.workspace.getConfiguration("claudeSkills").get<boolean>("officialSkillsCheckOnSession", true);
  if (wantOfficial) {
    officialSkillsHook = installOfficialSkillsSessionHook(extensionPath, target);
  }

  syncCliConfigToWorkspace(target, libraryDir);

  const installGitHook = opts?.installGitHook ?? true;
  const gitBranchHook = installGitHook ? installGitBranchSyncHook(target) : false;

  return {
    globalLibrary,
    workspaceSkills,
    costControlHooks,
    profileInitHooks,
    officialSkillsHook,
    cliConfig: true,
    gitBranchHook,
  };
}

export function formatPrepareClaudeCliSummary(result: PrepareClaudeCliResult): string {
  const lines = [
    "Prepared workspace for Claude CLI (headless):",
    `  Global library: ${result.globalLibrary ? "ok" : "check ~/.claude/skills"}`,
    `  Workspace skills: ${result.workspaceSkills ? "ok" : "none detected"}`,
    `  Cost control hooks: ${result.costControlHooks}`,
    `  Profile-init hooks: ${result.profileInitHooks}`,
  ];
  if (result.officialSkillsHook) {
    lines.push(`  Official skills hook: ${result.officialSkillsHook}`);
  }
  lines.push(`  CLI config: ${result.cliConfig ? "written .claude/learning/cli-config.json" : "skipped"}`);
  lines.push(
    `  Git branch hook: ${result.gitBranchHook ? "installed post-checkout" : "already present or not a git repo"}`
  );
  lines.push("", "You can close the IDE and use `claude` in the terminal — hooks apply skills automatically.");
  return lines.join("\n");
}
