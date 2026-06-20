import * as vscode from "vscode";
import { BudgetMode } from "./budgetConfig";
import {
  CONTEXT_FOCUS_LABELS,
  ContextFocusLevel,
  nextContextFocusLevel,
  syncContextFocusConfigToDisk,
} from "./contextFocusConfig";
import {
  PRACTICAL_FOCUS_LABELS,
  PracticalFocusLevel,
  nextPracticalFocusLevel,
  syncPracticalFocusConfigToDisk,
} from "./practicalFocusConfig";
import { resetEmergencyCutoff } from "./emergencyCutoff";
import { revertMcpOptimizer } from "./mcpAutoOptimizer";
import { notifyUserSuccess } from "./userNotify";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BUDGET_MODE_CYCLE: BudgetMode[] = ["economy", "normal", "unlimited"];
const BUDGET_MODE_LABEL: Record<BudgetMode, string> = {
  economy: "Economy",
  normal: "Normal",
  unlimited: "Unlimited",
};

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface BudgetCommandDeps {
  context: vscode.ExtensionContext;
  libraryDir: string;
  getTarget: () => string | undefined;
  log: (line: string) => void;
  refreshAll: () => void;
  maybeRevealOutputPanel: () => void;
  applyBudgetSettings: (libraryDir: string, logLines: boolean) => void;
}

// ---------------------------------------------------------------------------
// Command registrations
// ---------------------------------------------------------------------------

export function registerBudgetCommands(deps: BudgetCommandDeps): vscode.Disposable[] {
  const { context, libraryDir, getTarget, log, refreshAll, maybeRevealOutputPanel, applyBudgetSettings } = deps;

  return [
    vscode.commands.registerCommand("claudeSkills.disableMcpOptimizer", () => {
      maybeRevealOutputPanel();
      revertMcpOptimizer(context, log);
    }),

    vscode.commands.registerCommand("claudeSkills.cycleBudgetMode", async () => {
      const cfg = vscode.workspace.getConfiguration("claudeSkills.budget");
      const current = cfg.get<BudgetMode>("mode", "normal");
      const next = BUDGET_MODE_CYCLE[(BUDGET_MODE_CYCLE.indexOf(current) + 1) % BUDGET_MODE_CYCLE.length];
      await cfg.update("mode", next, vscode.ConfigurationTarget.Global);
      applyBudgetSettings(libraryDir, true);
      refreshAll();
      maybeRevealOutputPanel();
      log(`\n=== Budget mode -> ${BUDGET_MODE_LABEL[next]} ===`);
      void notifyUserSuccess(`Claude Skills: budget mode set to ${BUDGET_MODE_LABEL[next]}.`);
    }),

    vscode.commands.registerCommand("claudeSkills.cycleContextFocusLevel", async () => {
      const cfg = vscode.workspace.getConfiguration("claudeSkills.contextFocus");
      const enabled = cfg.get<boolean>("enabled", true);
      if (!enabled) {
        await cfg.update("enabled", true, vscode.ConfigurationTarget.Global);
        await cfg.update("level", "balanced", vscode.ConfigurationTarget.Global);
        syncContextFocusConfigToDisk();
        refreshAll();
        void notifyUserSuccess("Claude Skills: context focus enabled (Balanced).");
        return;
      }
      const current = cfg.get<ContextFocusLevel>("level", "balanced");
      const next = nextContextFocusLevel(current);
      if (current === "strict-local" && next === "knowledge") {
        await cfg.update("enabled", false, vscode.ConfigurationTarget.Global);
        syncContextFocusConfigToDisk();
        refreshAll();
        maybeRevealOutputPanel();
        log("\n=== Context focus -> disabled ===");
        void notifyUserSuccess("Claude Skills: context focus disabled.");
        return;
      }
      await cfg.update("level", next, vscode.ConfigurationTarget.Global);
      syncContextFocusConfigToDisk();
      refreshAll();
      maybeRevealOutputPanel();
      log(`\n=== Context focus -> ${CONTEXT_FOCUS_LABELS[next]} ===`);
      void notifyUserSuccess(`Claude Skills: context focus set to ${CONTEXT_FOCUS_LABELS[next]}.`);
    }),

    vscode.commands.registerCommand("claudeSkills.openContextFocusSettings", async () => {
      await vscode.commands.executeCommand("workbench.action.openSettings", "claudeSkills.contextFocus");
    }),

    vscode.commands.registerCommand("claudeSkills.cyclePracticalFocusLevel", async () => {
      const cfg = vscode.workspace.getConfiguration("claudeSkills.practicalFocus");
      const enabled = cfg.get<boolean>("enabled", false);
      if (!enabled) {
        await cfg.update("enabled", true, vscode.ConfigurationTarget.Global);
        await cfg.update("level", "architecture-first", vscode.ConfigurationTarget.Global);
        syncPracticalFocusConfigToDisk();
        refreshAll();
        void notifyUserSuccess(
          "Claude Skills: practical focus enabled (Architecture-first). Install deployment-practical skill for full checklist."
        );
        return;
      }
      const current = cfg.get<PracticalFocusLevel>("level", "architecture-first");
      const next = nextPracticalFocusLevel(current);
      if (current === "deploy-ready" && next === "exploratory") {
        await cfg.update("enabled", false, vscode.ConfigurationTarget.Global);
        syncPracticalFocusConfigToDisk();
        refreshAll();
        maybeRevealOutputPanel();
        log("\n=== Practical focus -> disabled ===");
        void notifyUserSuccess("Claude Skills: practical/deployment focus disabled.");
        return;
      }
      await cfg.update("level", next, vscode.ConfigurationTarget.Global);
      syncPracticalFocusConfigToDisk();
      refreshAll();
      maybeRevealOutputPanel();
      log(`\n=== Practical focus -> ${PRACTICAL_FOCUS_LABELS[next]} ===`);
      void notifyUserSuccess(`Claude Skills: practical focus set to ${PRACTICAL_FOCUS_LABELS[next]}.`);
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
