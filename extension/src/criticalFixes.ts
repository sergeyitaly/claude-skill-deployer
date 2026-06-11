import * as fs from "node:fs";
import * as vscode from "vscode";
import { globalSkillsDir } from "./skillOps";
import { isGitWorkspace } from "./branchProfiles";

const GLOBAL_SETUP_PROMPTED = "claudeSkills.globalSetupPrompted";

export function directoryExists(dir: string): boolean {
  try {
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Record whether the workspace is a git repo (branch profiles / PR features). */
export function detectGitRepository(context: vscode.ExtensionContext, target?: string): boolean {
  const isGit = target ? isGitWorkspace(target) : false;
  void context.globalState.update("claudeSkills.isGitRepo", isGit);
  return isGit;
}

export function isGitRepo(context: vscode.ExtensionContext): boolean {
  return context.globalState.get<boolean>("claudeSkills.isGitRepo", false);
}

/** Friendly first-run prompt when ~/.claude/skills/ is missing. */
export async function checkFirstTimeGlobalSetup(context: vscode.ExtensionContext): Promise<void> {
  const globalPath = globalSkillsDir();
  if (directoryExists(globalPath)) {
    return;
  }
  if (context.globalState.get<boolean>(GLOBAL_SETUP_PROMPTED, false)) {
    return;
  }
  void context.globalState.update(GLOBAL_SETUP_PROMPTED, true);

  const choice = await vscode.window.showInformationMessage(
    "Welcome to Claude Skills Manager! Install the skill library to ~/.claude/skills to get started.",
    "Install Now",
    "Later"
  );
  if (choice === "Install Now") {
    await vscode.commands.executeCommand("claudeSkills.installLibraryToGlobal");
  }
}

/** Prompt 3-minute setup on first extension activation. */
export async function promptGetStarted(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>("claudeSkills.hasRunBefore", false)) {
    return;
  }
  void context.globalState.update("claudeSkills.hasRunBefore", true);

  const choice = await vscode.window.showInformationMessage(
    "Ready to save on Claude credits? Complete a quick setup tour.",
    "Get Started",
    "Later"
  );
  if (choice === "Get Started") {
    await vscode.commands.executeCommand("claudeSkills.startOnboarding");
  }
}
