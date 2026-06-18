import * as vscode from "vscode";
import { findProjectRoot } from "./projectProfile";

export function refreshWorkspaceFolderStatusBar(
  workspaceFolderStatusBarItem: vscode.StatusBarItem
): void {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    workspaceFolderStatusBarItem.hide();
    return;
  }
  if (workspaceFolders.length === 1) {
    // Single workspace folder
    const path = workspaceFolders[0].uri.fsPath;
    const projectRoot = findProjectRoot(path);
    workspaceFolderStatusBarItem.text = `$(folder) ${projectRoot}`;
    workspaceFolderStatusBarItem.tooltip = `Current workspace: ${projectRoot}\n\nThis folder is used to find skill profiles, cost data, and learning records.\n\nClick to switch workspace folder.`;
    workspaceFolderStatusBarItem.command = "claudeSkills.switchWorkspaceFolder";
    workspaceFolderStatusBarItem.show();
    return;
  }
  // Multi-folder workspace
  const currentPath = workspaceFolders[0].uri.fsPath;
  const projectRoot = findProjectRoot(currentPath);
  workspaceFolderStatusBarItem.text = `$(folder) ${projectRoot} (1 of ${workspaceFolders.length})`;
  workspaceFolderStatusBarItem.tooltip =
    `Current workspace (multi-folder mode): ${projectRoot}\n` +
    `Other folders:\n` +
    workspaceFolders
      .slice(1)
      .map((f) => `  - ${f.uri.fsPath}`)
      .join("\n") +
    `\n\nClick to switch active workspace folder.`;
  workspaceFolderStatusBarItem.command = "claudeSkills.switchWorkspaceFolder";
  workspaceFolderStatusBarItem.show();
}
