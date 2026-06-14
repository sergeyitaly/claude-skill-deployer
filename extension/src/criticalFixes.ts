import * as fs from "node:fs";
import * as vscode from "vscode";
import { globalSkillsDir } from "./skillOps";
import { isGitWorkspace } from "./branchProfiles";
import { notificationLevel } from "./userNotify";

const GLOBAL_SETUP_PROMPTED = "claudeSkills.globalSetupPrompted";

function integrationTestMode(): boolean {
  return process.env.CLAUDE_SKILLS_INTEGRATION_TEST === "1";
}

export { integrationTestMode };

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

/** Friendly first-run prompt when ~/.claude/skills/ is missing. */
export async function checkFirstTimeGlobalSetup(context: vscode.ExtensionContext): Promise<void> {
  if (integrationTestMode()) {
    return;
  }
  const globalPath = globalSkillsDir();
  if (directoryExists(globalPath)) {
    return;
  }
  if (context.globalState.get<boolean>(GLOBAL_SETUP_PROMPTED, false)) {
    return;
  }
  if (notificationLevel() !== "normal") {
    void context.globalState.update(GLOBAL_SETUP_PROMPTED, true);
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    "Welcome to Claude Skills Manager! Install the skill library to ~/.claude/skills to get started.",
    "Install Now",
    "Later"
  );
  if (choice === "Install Now") {
    void context.globalState.update(GLOBAL_SETUP_PROMPTED, true);
    await vscode.commands.executeCommand("claudeSkills.installLibraryToGlobal");
  } else if (choice === "Later") {
    void context.globalState.update(GLOBAL_SETUP_PROMPTED, true);
  }
}

/** Prompt 3-minute setup on first extension activation. */
export async function promptGetStarted(context: vscode.ExtensionContext): Promise<void> {
  if (integrationTestMode()) {
    return;
  }
  if (context.globalState.get<boolean>("claudeSkills.hasRunBefore", false)) {
    return;
  }

  if (notificationLevel() !== "normal") {
    void context.globalState.update("claudeSkills.hasRunBefore", true);
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    "Install the right AI skills for this repo? Open the setup wizard (2 minutes).",
    "Get Started",
    "Later"
  );
  if (choice === "Get Started") {
    await vscode.commands.executeCommand("claudeSkills.startOnboarding");
  }
}
