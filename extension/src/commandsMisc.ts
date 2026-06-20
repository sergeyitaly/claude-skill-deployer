import * as vscode from "vscode";
import { isFeatureEnabled, featureFlagLines, FeatureKey, FEATURE_DESCRIPTIONS } from "./featureFlags";
import { pickWorkspaceTarget, workspaceFolderLabel } from "./workspaceTarget";
import { scanForIssues, repairIssues } from "./errorRecovery";
import { showOnboardingTour } from "./onboarding";
import { showOnboardingWizard } from "./onboardingWizard";
import { recordFeatureUse } from "./analytics";
import { notifyUserSuccess, notifyUserWarn } from "./userNotify";

export interface MiscCommandDeps {
  context: vscode.ExtensionContext;
  libraryDir: string;
  getTarget: () => string | undefined;
  log: (line: string) => void;
  refreshAll: (opts?: { workspaceState?: boolean; forceTree?: boolean }) => void;
  revealOutputPanel: () => void;
  maybeRevealOutputPanel: () => void;
}

export function registerMiscCommands(deps: MiscCommandDeps): vscode.Disposable[] {
  const {
    context,
    libraryDir,
    getTarget,
    log,
    refreshAll,
    revealOutputPanel,
    maybeRevealOutputPanel,
  } = deps;

  return [
    vscode.commands.registerCommand("claudeSkills.refresh", refreshAll),

    vscode.commands.registerCommand("claudeSkills.showOutput", () => {
      revealOutputPanel();
    }),

    vscode.commands.registerCommand("claudeSkills.pickWorkspaceFolder", async () => {
      const picked = await pickWorkspaceTarget();
      if (picked) {
        refreshAll();
        void notifyUserSuccess(`Claude Skills: active folder — ${workspaceFolderLabel(picked) ?? picked}`);
      }
    }),

    vscode.commands.registerCommand("claudeSkills.openExtensionSettings", async () => {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "@ext:serhiivoinolovych.claude-skill-deployer"
      );
    }),

    vscode.commands.registerCommand("claudeSkills.manageFeatures", async () => {
      const cfg = vscode.workspace.getConfiguration("claudeSkills.features");
      const keys: FeatureKey[] = [
        "autoOptimizer",
        "communityBenchmarks",
        "prCostEstimate",
      ];
      const pick = await vscode.window.showQuickPick(
        keys.map((k) => ({
          label: k,
          description: isFeatureEnabled(k) ? "enabled" : "disabled",
          detail: FEATURE_DESCRIPTIONS[k],
          key: k,
        })),
        { title: "Toggle Claude Skills feature", placeHolder: "Select a feature to flip on/off" }
      );
      if (!pick) {
        return;
      }
      const next = !isFeatureEnabled(pick.key);
      await cfg.update(pick.key, next, vscode.ConfigurationTarget.Global);
      refreshAll();
      maybeRevealOutputPanel();
      log(`\n=== Feature ${pick.key} -> ${next ? "on" : "off"} ===`);
      log(featureFlagLines().join("\n"));
      void notifyUserSuccess(`Claude Skills: ${pick.key} is now ${next ? "enabled" : "disabled"}. Reload window to apply some changes.`);
    }),

    vscode.commands.registerCommand("claudeSkills.repairData", async () => {
      const target = getTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const issues = scanForIssues(target);
      if (issues.length === 0) {
        void notifyUserSuccess("Claude Skills: no data issues detected.");
        return;
      }
      const fixed = await repairIssues(target, issues);
      void notifyUserSuccess(`Claude Skills: repaired ${fixed.length} issue(s).`);
    }),

    vscode.commands.registerCommand("claudeSkills.startOnboarding", async () => {
      recordFeatureUse("onboarding");
      await showOnboardingWizard(context, libraryDir, getTarget, refreshAll);
    }),

    vscode.commands.registerCommand("claudeSkills.startOnboardingTour", async () => {
      recordFeatureUse("onboarding");
      await showOnboardingTour(context);
    }),
  ];
}
