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
import { isFeatureEnabled, featureFlagLines, FeatureKey, FEATURE_DESCRIPTIONS } from "./featureFlags";
import { SkillSortMode } from "./skillRoi";
import { notifyUserSuccess } from "./userNotify";
import { ExtensionSharedContext } from "./extensionSharedContext";

const BUDGET_MODE_CYCLE: BudgetMode[] = ["economy", "normal", "unlimited"];
const BUDGET_MODE_LABEL: Record<BudgetMode, string> = {
  economy: "Economy (limited context / fast models only)",
  normal: "Normal",
  unlimited: "Unlimited",
};

export function registerSettingsCommands(shared: ExtensionSharedContext): void {
  const {
    context, libraryDir, log, getWorkspaceTarget,
    refreshAll, maybeRevealOutputPanel, provider,
    applyBudgetSettings, cleanupExcessAgentMirrorsForTier,
  } = shared;

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSkills.cycleBudgetMode", async () => {
      const cfg = vscode.workspace.getConfiguration("claudeSkills.budget");
      const current = cfg.get<BudgetMode>("mode", "normal");
      const next = BUDGET_MODE_CYCLE[(BUDGET_MODE_CYCLE.indexOf(current) + 1) % BUDGET_MODE_CYCLE.length];
      await cfg.update("mode", next, vscode.ConfigurationTarget.Global);
      applyBudgetSettings(true);
      refreshAll();
      maybeRevealOutputPanel();
      log(`\n=== Budget mode -> ${BUDGET_MODE_LABEL[next]} ===`);
      void notifyUserSuccess(`Claude Skills: budget mode set to ${BUDGET_MODE_LABEL[next]}.`);
    }),

    vscode.commands.registerCommand("claudeSkills.cycleContextFocusLevel", async () => {
      if (!isFeatureEnabled("contextFocus")) {
        vscode.window.showWarningMessage("Claude Skills: context focus is disabled in feature toggles.");
        return;
      }
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
      if (!isFeatureEnabled("practicalFocus")) {
        vscode.window.showWarningMessage("Claude Skills: practical/deployment focus is disabled in feature toggles.");
        return;
      }
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

    vscode.commands.registerCommand("claudeSkills.openExtensionSettings", async () => {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "@ext:serhiivoinolovych.claude-skill-deployer"
      );
    }),

    vscode.commands.registerCommand("claudeSkills.cycleSkillSort", async () => {
      const cfg = vscode.workspace.getConfiguration("claudeSkills.search");
      const modes: SkillSortMode[] = ["relevance", "lowest_cost", "highest_roi", "best_value"];
      const current = cfg.get<SkillSortMode>("sortBy", "relevance");
      const next = modes[(modes.indexOf(current) + 1) % modes.length];
      await cfg.update("sortBy", next, vscode.ConfigurationTarget.Workspace);
      provider.refresh();
      void notifyUserSuccess(`Claude Skills: skill sort -> ${next}`);
    }),

    vscode.commands.registerCommand("claudeSkills.manageFeatures", async () => {
      const cfg = vscode.workspace.getConfiguration("claudeSkills.features");
      const keys: FeatureKey[] = [
        "budgetControls",
        "branchProfiles",
        "multiAgent",
        "attributionCollector",
        "costIntelligence",
        "autoOptimizer",
        "predictiveAlerts",
        "communityBenchmarks",
        "teamCostSharing",
        "skillArchival",
        "emergencyCutoff",
        "prCostEstimate",
        "costAwareSearch",
        "skillSetResolver",
        "contextFocus",
        "practicalFocus",
        "sessionSkillAdaptation",
        "autoApplyTaskProposals",
        "deterministicTaskProposals",
        "taskSkillFocus",
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
      if (pick.key === "contextFocus") {
        syncContextFocusConfigToDisk();
      }
      if (pick.key === "practicalFocus") {
        syncPracticalFocusConfigToDisk();
      }
      if (pick.key === "multiAgent" && !next) {
        const t = getWorkspaceTarget();
        if (t) {
          cleanupExcessAgentMirrorsForTier(t);
        }
      }
      refreshAll();
      maybeRevealOutputPanel();
      log(`\n=== Feature ${pick.key} -> ${next ? "on" : "off"} ===`);
      log(featureFlagLines().join("\n"));
      void notifyUserSuccess(`Claude Skills: ${pick.key} is now ${next ? "enabled" : "disabled"}. Reload window to apply some changes.`);
    })
  );
}
