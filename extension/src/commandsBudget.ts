import * as vscode from "vscode";
import { resetEmergencyCutoff } from "./emergencyCutoff";
import { revertMcpOptimizer } from "./mcpAutoOptimizer";

export interface BudgetCommandDeps {
  context: vscode.ExtensionContext;
  getTarget: () => string | undefined;
  log: (line: string) => void;
  refreshAll: () => void;
  maybeRevealOutputPanel: () => void;
}

export function registerBudgetCommands(deps: BudgetCommandDeps): vscode.Disposable[] {
  const { context, getTarget, refreshAll, maybeRevealOutputPanel } = deps;

  return [
    vscode.commands.registerCommand("claudeSkills.disableMcpOptimizer", () => {
      maybeRevealOutputPanel();
      revertMcpOptimizer(context, deps.log);
    }),

    vscode.commands.registerCommand("claudeSkills.openContextFocusSettings", async () => {
      await vscode.commands.executeCommand("workbench.action.openSettings", "claudeSkills.contextFocus");
    }),

    vscode.commands.registerCommand("claudeSkills.openPracticalFocusSettings", async () => {
      await vscode.commands.executeCommand("workbench.action.openSettings", "claudeSkills.practicalFocus");
    }),

    vscode.commands.registerCommand("claudeSkills.openBudgetSettings", async () => {
      await vscode.commands.executeCommand("workbench.action.openSettings", "claudeSkills.budget");
    }),

    vscode.commands.registerCommand("claudeSkills.resetEmergencyCutoff", async () => {
      await resetEmergencyCutoff(getTarget());
      refreshAll();
    }),
  ];
}
