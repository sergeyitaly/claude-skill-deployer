import * as vscode from "vscode";
import {
  readProjectProfile,
  formatProjectProfileSummary,
} from "./projectProfile";

export function refreshProjectTierStatusBar(
  projectTierStatusBarItem: vscode.StatusBarItem,
  target?: string
): void {
  if (!target) {
    projectTierStatusBarItem.hide();
    return;
  }
  const profile = readProjectProfile(target);
  if (!profile) {
    projectTierStatusBarItem.hide();
    return;
  }
  projectTierStatusBarItem.text = "$(briefcase) Project Profile";
  projectTierStatusBarItem.tooltip = formatProjectProfileSummary(profile);
  projectTierStatusBarItem.command = "claudeSkills.chooseProjectProfile";
  projectTierStatusBarItem.show();
}
