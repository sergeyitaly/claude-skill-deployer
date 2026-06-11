import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  copySkill,
  generateForWorkspace,
  globalSkillsDir,
  installLibraryToGlobal,
  listSkillStatuses,
  loadManifest,
  disableWorkspaceSkill,
  enableWorkspaceSkill,
  isSkillCommittedOnBranch,
  setSkillOverride,
} from "./skillOps";
import { SkillItem, SkillsProvider } from "./skillsProvider";
import { computeSuggestedSkills, computeUsageStats, ensureLearningDir, formatUsageReport, formatUsageReportHtml } from "./usageStats";
import {
  agentCapabilityLines,
  formatAgentInstallSummary,
  generateForAllAgents,
  installLibraryToAllAgents,
  installSkillToAllWorkspaceAgents,
  mirrorLearningArtifacts,
  computeEnabledAgentsCreditUsage,
  removeSkillFromAllWorkspaceAgents,
  shouldSyncGlobalToAll,
  shouldSyncWorkspaceToAll,
} from "./agentOps";
import { propagateWorkspaceSkillChange } from "./workspaceSkillSync";
import {
  buildCostAttribution,
  formatAttributionReport,
  persistCostAttribution,
  resolveDisplayAttribution,
} from "./costAttribution";
import { getOptimalAgent, formatRoutingSuggestion } from "./costRouter";
import { budgetProgressBar, remainingDailyBudgetUsd, writeTodayCostSnapshot } from "./todayCostSnapshot";
import { computeCreditUsage } from "./usageCost";
import { formatCompactUsd, sumInstallCostEstimate, tierForSkill } from "./skillCost";
import { formatTokenCount } from "./usageStats";
import { BudgetMode, budgetUsagePercent, configFromVsCodeSettings, syncBudgetConfigToDisk } from "./budgetConfig";
import { clearBudgetTrackingForSkill, syncAndApplyBudgetMode } from "./budgetOps";
import {
  applyBranchProfile,
  branchProfilesFeatureActive,
  formatBranchProfilesReport,
  getCurrentBranch,
  handleBranchChange,
  initBranchTracking,
  isGitWorkspace,
  loadBranchProfile,
  saveBranchProfile,
  setGitApiCache,
} from "./branchProfiles";
import { installAttributionHooks, installCostControlHooks, installSessionWatchHook } from "./hookOps";
import {
  applyTeamBranchProfile,
  exportTeamBranchProfile,
  formatTeamProfileReport,
} from "./teamBranchProfiles";
import { AttributionCollector } from "./attributionCollector";
import { resetMisattributedData } from "./attributionReset";
import { generateLatestSessionBreakdown } from "./sessionBreakdown";
import { generateOptimizationSuggestions, formatSuggestionsReport } from "./costOptimizer";
import { formatCostDashboardHtml, formatCostDashboardText } from "./costDashboard";
import { applyOptimizationSuggestions, applySingleOptimizationSuggestion } from "./autoOptimizer";
import { checkPredictiveCostAlert } from "./costPredictor";
import { installGitPostCommitHook } from "./commitCost";
import { isAutoOptimizeEnabled, applyOptimizationSuggestions as applyAutoOptimizations, runArchivalPass } from "./autoOptimizer";
import { isFeatureEnabled, featureFlagLines, FeatureKey } from "./featureFlags";
import { checkEmergencyCutoff, resetEmergencyCutoff } from "./emergencyCutoff";
import { syncCommunityBenchmarks, updateLocalBenchmarks, uploadAnonymizedStats } from "./communityBenchmarks";
import { attributeCostToAuthors } from "./teamCostSharing";
import { listArchivedSkills, restoreArchivedSkill } from "./skillArchival";
import { estimateAndCommentPR } from "./prCostEstimate";
import { SkillSortMode } from "./skillRoi";
import {
  checkFirstTimeGlobalSetup,
  detectGitRepository,
  promptGetStarted,
} from "./criticalFixes";
import { showOnboardingTour } from "./onboarding";
import { showOnboardingWizard } from "./onboardingWizard";
import { assessAttributionHealth } from "./attributionHealth";
import { ErrorRecovery, repairIssues, scanForIssues } from "./errorRecovery";
import { recordActivation, recordError, recordFeatureUse } from "./analytics";
import { runV1Migration } from "./migration";
import {
  configureWeeklyReportEmail,
  deliverWeeklyReport,
  readWeeklyReportConfig,
  startWeeklyReportScheduler,
} from "./weeklyReport";
import {
  isMultiRootWorkspace,
  pickWorkspaceTarget,
  registerWorkspaceTargetListeners,
  resolveWorkspaceTarget,
  workspaceFolderLabel,
} from "./workspaceTarget";
import { OptimizationType } from "./costOptimizer";

let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let usageStatusBarItem: vscode.StatusBarItem;
let creditStatusBarItem: vscode.StatusBarItem;
let budgetModeStatusBarItem: vscode.StatusBarItem;
let workspaceFolderStatusBarItem: vscode.StatusBarItem;
let usagePanel: vscode.WebviewPanel | undefined;
let costDashboardPanel: vscode.WebviewPanel | undefined;

const BUDGET_MODE_CYCLE: BudgetMode[] = ["economy", "normal", "unlimited"];
const BUDGET_MODE_LABEL: Record<BudgetMode, string> = {
  economy: "Economy",
  normal: "Normal",
  unlimited: "Unlimited",
};

function getWorkspaceTarget(): string | undefined {
  return resolveWorkspaceTarget();
}

function log(line: string) {
  outputChannel.appendLine(line);
}

function syncBranchProfileContext(target: string | undefined): void {
  const git = target ? isGitWorkspace(target) : false;
  const enabled = branchProfilesFeatureActive() && git;
  void vscode.commands.executeCommand("setContext", "claudeSkills.isGitRepo", git);
  void vscode.commands.executeCommand("setContext", "claudeSkills.branchProfilesEnabled", enabled);
}

function refreshStatusBar(libraryDir: string) {
  const target = getWorkspaceTarget();
  if (!target) {
    statusBarItem.hide();
    return;
  }
  const statuses = listSkillStatuses(libraryDir, target);
  const pending = statuses.filter((s) => s.isRelevant && !s.installedInWorkspace);
  const branch = getCurrentBranch(target);
  const branchSuffix = branch ? ` [${branch}]` : "";
  if (pending.length === 0) {
    statusBarItem.text = `$(check) Claude Skills${branchSuffix}`;
    statusBarItem.tooltip =
      `All relevant Claude skills are installed for this workspace${branch ? ` (branch: ${branch})` : ""}.`;
  } else {
    statusBarItem.text = `$(lightbulb) Claude Skills: ${pending.length} suggested${branchSuffix}`;
    statusBarItem.tooltip =
      `${pending.length} relevant skill(s) not yet installed:\n` +
      pending.map((s) => `- ${s.name}`).join("\n") +
      (branch ? `\n\nBranch: ${branch} (skill profile stored in ~/.claude/learning/branch-profiles.json).` : "") +
      "\n\nClick to install.";
  }
  statusBarItem.command = "claudeSkills.generateForWorkspace";
  statusBarItem.show();
}

function refreshCreditStatusBar(libraryDir: string) {
  const manifest = loadManifest(libraryDir);
  const config = configFromVsCodeSettings(manifest);
  const summary = computeEnabledAgentsCreditUsage(libraryDir, 1);
  const today = new Date().toISOString().slice(0, 10);
  const todayRow = summary.byDay.find((d) => d.date === today);
  const totalTokens = todayRow
    ? todayRow.inputTokens + todayRow.outputTokens + todayRow.cacheCreationTokens + todayRow.cacheReadTokens
    : 0;
  const totalCost = todayRow?.cost ?? 0;
  const pct = budgetUsagePercent(totalCost, config);
  writeTodayCostSnapshot(totalCost, totalTokens);

  if (totalTokens === 0) {
    creditStatusBarItem.text = "$(credit-card) Claude: no usage today";
    creditStatusBarItem.tooltip =
      "No recorded Claude Code token usage today. Estimates use published API rates for reference (Pro/Max plans are flat-rate).\n\nClick for the full usage report.";
  } else {
    const budgetSuffix =
      config.dailyBudgetUsd > 0 && pct !== null
        ? ` | ${budgetProgressBar(pct)} ${Math.round(pct)}% of ${formatCompactUsd(config.dailyBudgetUsd)}`
        : "";
    creditStatusBarItem.text = `$(credit-card) Est. ${formatCompactUsd(totalCost)} today | ${formatTokenCount(totalTokens)}${budgetSuffix}`;
    const remaining = remainingDailyBudgetUsd(config);
    creditStatusBarItem.tooltip =
      `Estimated usage today: ${formatTokenCount(totalTokens)} tokens (~${formatCompactUsd(totalCost)}).` +
      (remaining !== null ? ` ~${formatCompactUsd(remaining)} budget remaining.` : "") +
      " Based on session transcripts, not an actual bill.\n\nClick for the full usage report.";
  }
  creditStatusBarItem.command = "claudeSkills.showUsageStats";
  creditStatusBarItem.show();
}

function refreshBudgetModeStatusBar(libraryDir: string) {
  const manifest = loadManifest(libraryDir);
  const config = configFromVsCodeSettings(manifest);
  const mode = config.mode;
  const icon = mode === "economy" ? "$(leaf)" : mode === "unlimited" ? "$(rocket)" : "$(shield)";
  budgetModeStatusBarItem.text = `${icon} ${BUDGET_MODE_LABEL[mode]}`;
  budgetModeStatusBarItem.tooltip =
    `Budget mode: ${BUDGET_MODE_LABEL[mode]}. Daily cap: ${config.dailyBudgetUsd > 0 ? formatCompactUsd(config.dailyBudgetUsd) : "off"}. ` +
    `${config.highTierSkills.length} high-tier skill(s) tracked.\n\nClick to cycle mode (Economy -> Normal -> Unlimited).`;
  budgetModeStatusBarItem.command = "claudeSkills.cycleBudgetMode";
  budgetModeStatusBarItem.show();
}

function applyBudgetSettings(libraryDir: string, logLines: boolean): void {
  const target = getWorkspaceTarget();
  const manifest = loadManifest(libraryDir);
  const mode = configFromVsCodeSettings(manifest).mode;
  syncBudgetConfigToDisk(manifest);
  const { disabled, restored } = syncAndApplyBudgetMode(libraryDir, target, mode);
  if (logLines) {
    if (disabled.length > 0) {
      log(`Budget: disabled ${disabled.length} high-tier skill(s) locally (${disabled.join(", ")})`);
    }
    if (restored.length > 0) {
      log(`Budget: restored ${restored.length} skill(s) (${restored.join(", ")})`);
    }
  }
}

function refreshUsageStatusBar(libraryDir: string) {
  const target = getWorkspaceTarget();
  if (!target) {
    usageStatusBarItem.hide();
    return;
  }
  const manifest = loadManifest(libraryDir);
  const stats = computeUsageStats(target, manifest);
  const tracked = stats.filter((s) => s.runs > 0);
  const issues = stats.filter((s) => s.rating === "needs-attention" || s.rating === "unused").length;

  if (tracked.length === 0) {
    usageStatusBarItem.text = "$(graph) Skill usage: no data";
    usageStatusBarItem.tooltip =
      "No recorded skill runs yet (.claude/learning/runs.jsonl). Use the self-learning skill to start tracking outcomes.\n\nClick for the full report.";
  } else {
    const active = stats.filter((s) => s.rating === "active").length;
    const issuesSuffix = issues > 0 ? `, ${issues} to review` : "";
    usageStatusBarItem.text = `$(graph) Skill usage: ${active} active${issuesSuffix}`;
    usageStatusBarItem.tooltip = "Click for the per-skill usage and KPI report.";
  }
  usageStatusBarItem.command = "claudeSkills.showUsageStats";
  usageStatusBarItem.show();
}

export function activate(context: vscode.ExtensionContext) {
  const libraryDir = path.join(context.extensionPath, "skills_library");

  outputChannel = vscode.window.createOutputChannel("Claude Skills");
  context.subscriptions.push(outputChannel);

  const provider = new SkillsProvider(libraryDir, getWorkspaceTarget);
  const treeView = vscode.window.createTreeView("claudeSkillsView", {
    treeDataProvider: provider,
  });
  // Checkbox = "enabled for this workspace": check it to install the skill
  // into <workspace>/.claude/skills/, uncheck to remove it from there.
  context.subscriptions.push(
    treeView,
    treeView.onDidChangeCheckboxState(async (e) => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        refreshAll();
        return;
      }
      for (const [item, state] of e.items) {
        if (!(item instanceof SkillItem)) {
          continue;
        }
        const name = item.status.name;
        const sourceRoot = item.status.availableInGlobal ? globalSkillsDir() : libraryDir;
        if (state === vscode.TreeItemCheckboxState.Checked) {
          ensureLearningDir(target);
          const action = enableWorkspaceSkill(target, name, sourceRoot);
          if (action === "local-on") {
            log(`${name}: re-enabled locally (skillOverrides cleared, shared files unchanged)`);
          } else if (action === "installed") {
            log(
              `${name}: enabled for you${isSkillCommittedOnBranch(target, name) ? "" : " (personal-only — added to .git/info/exclude)"}`
            );
          }
        } else {
          const action = disableWorkspaceSkill(target, name);
          if (action === "local-off") {
            log(`${name}: disabled locally (.claude/settings.local.json) — branch .claude/skills/ unchanged`);
          } else if (action === "removed") {
            log(`${name}: removed personal-only install from workspace`);
          } else {
            log(`${name}: already disabled`);
          }
        }
        propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, {
          saveBranchProfile: true,
        });
      }
      refreshAll();
    })
  );

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBarItem);

  usageStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  context.subscriptions.push(usageStatusBarItem);

  creditStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  context.subscriptions.push(creditStatusBarItem);

  budgetModeStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
  context.subscriptions.push(budgetModeStatusBarItem);

  workspaceFolderStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 96);
  context.subscriptions.push(workspaceFolderStatusBarItem);

  const refreshWorkspaceFolderStatusBar = () => {
    const target = getWorkspaceTarget();
    if (!isMultiRootWorkspace() || !target) {
      workspaceFolderStatusBarItem.hide();
      return;
    }
    const label = workspaceFolderLabel(target) ?? "workspace";
    workspaceFolderStatusBarItem.text = `$(root-folder) ${label}`;
    workspaceFolderStatusBarItem.tooltip = `${target}\n\nClick to pick the active folder for skills, cost, and profiles.`;
    workspaceFolderStatusBarItem.command = "claudeSkills.pickWorkspaceFolder";
    workspaceFolderStatusBarItem.show();
  };

  const refreshAll = () => {
    const target = getWorkspaceTarget();
    if (target && isFeatureEnabled("attributionCollector")) {
      AttributionCollector.setActiveTarget(target, libraryDir);
    }
    syncBranchProfileContext(target);
    provider.refresh();
    refreshStatusBar(libraryDir);
    refreshUsageStatusBar(libraryDir);
    refreshCreditStatusBar(libraryDir);
    refreshBudgetModeStatusBar(libraryDir);
    refreshWorkspaceFolderStatusBar();
    if (target) {
      void checkEmergencyCutoff(target);
    }
  };

  registerWorkspaceTargetListeners(() => refreshAll(), context);

  applyBudgetSettings(libraryDir, false);
  const initialTarget = getWorkspaceTarget();

  void (async () => {
    recordActivation();
    await runV1Migration(context, initialTarget);
    const isGit = detectGitRepository(context, initialTarget);
    syncBranchProfileContext(initialTarget);
    if (isFeatureEnabled("branchProfiles") && isGit) {
      initBranchTracking(initialTarget);
    }
    await checkFirstTimeGlobalSetup(context);
    const recovery = new ErrorRecovery();
    await recovery.repairCommonIssues(initialTarget);
    await promptGetStarted(context);
  })();

  refreshAll();

  if (initialTarget) {
    propagateWorkspaceSkillChange(context.extensionPath, initialTarget, libraryDir, log, {
      saveBranchProfile: false,
    });
  }

  if (initialTarget) {
    if (isFeatureEnabled("attributionCollector")) {
      const collector = AttributionCollector.getInstance(initialTarget, libraryDir);
      collector.start();
      context.subscriptions.push({ dispose: () => collector.stop() });
    }
    if (isFeatureEnabled("autoOptimizer")) {
      const autoOptTimer = setInterval(() => {
        if (!isAutoOptimizeEnabled()) {
          return;
        }
        if (!assessAttributionHealth(initialTarget, libraryDir).reliable) {
          return;
        }
        const suggestions = generateOptimizationSuggestions(initialTarget, libraryDir).filter(
          (s) => s.type === "disable" || s.type === "unused"
        );
        if (suggestions.length > 0) {
          void applyAutoOptimizations(initialTarget, libraryDir, suggestions.slice(0, 3), { auto: true });
        }
        void runArchivalPass(initialTarget, libraryDir);
      }, 30 * 60 * 1000);
      context.subscriptions.push({ dispose: () => clearInterval(autoOptTimer) });
    }
    if (isFeatureEnabled("predictiveAlerts")) {
      setTimeout(() => {
        void checkPredictiveCostAlert();
      }, 8000);
    }
    if (isFeatureEnabled("communityBenchmarks")) {
      void syncCommunityBenchmarks();
    }
    startWeeklyReportScheduler(context, getWorkspaceTarget, libraryDir, log);
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeSkills.budget")) {
        applyBudgetSettings(libraryDir, true);
        refreshAll();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSkills.refresh", refreshAll),

    vscode.commands.registerCommand("claudeSkills.pickWorkspaceFolder", async () => {
      const picked = await pickWorkspaceTarget();
      if (picked) {
        refreshAll();
        vscode.window.showInformationMessage(`Claude Skills: active folder — ${workspaceFolderLabel(picked) ?? picked}`);
      }
    }),

    vscode.commands.registerCommand("claudeSkills.installLibraryToGlobal", async () => {
      const syncAll = shouldSyncGlobalToAll();
      outputChannel.show(true);
      if (syncAll) {
        const results = installLibraryToAllAgents(libraryDir, false, false);
        log(`\n=== Install skill library -> all enabled agents ===`);
        log(formatAgentInstallSummary(results));
        const installed = results.filter((r) => r.status === "installed" || r.status === "written").length;
        vscode.window.showInformationMessage(
          `Claude Skills: installed ${installed} skill(s) across enabled agents -- see output for details.`
        );
      } else {
        const results = installLibraryToGlobal(libraryDir, false, false);
        log(`\n=== Install skill library -> ${globalSkillsDir()} ===`);
        for (const r of results) {
          log(`${r.skill}: ${r.status}`);
        }
        const installed = results.filter((r) => r.status === "installed").length;
        const skipped = results.filter((r) => r.status === "skipped-exists").length;
        vscode.window.showInformationMessage(
          `Claude Skills: installed ${installed}, skipped ${skipped} (already present) -- see "Claude Skills" output for details.`
        );
      }
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.installLibraryToAllAgents", async () => {
      const results = installLibraryToAllAgents(libraryDir, false, false);
      outputChannel.show(true);
      log(`\n=== Install skill library -> all enabled agents ===`);
      log(formatAgentInstallSummary(results));
      const installed = results.filter((r) => r.status === "installed" || r.status === "written").length;
      vscode.window.showInformationMessage(
        `Claude Skills: installed ${installed} skill(s) across enabled agents.`
      );
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.generateForWorkspace", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      ensureLearningDir(target);
      outputChannel.show(true);
      let installed = 0;
      if (shouldSyncWorkspaceToAll()) {
        const results = generateForAllAgents(libraryDir, target, { all: false, force: false, dryRun: false });
        log(`\n=== Install relevant skills -> all enabled agents ===`);
        if (results.length === 0) {
          log("No relevant skills detected for this workspace.");
        } else {
          log(formatAgentInstallSummary(results));
        }
        installed = results.filter((r) => r.status === "installed" || r.status === "written").length;
      } else {
        const results = generateForWorkspace(libraryDir, target, {
          all: false,
          force: false,
          dryRun: false,
        });
        log(`\n=== Install relevant skills -> ${path.join(target, ".claude", "skills")} ===`);
        if (results.length === 0) {
          log("No relevant skills detected for this workspace.");
        }
        for (const r of results) {
          const reason = r.reason ? `  (matched: ${r.reason})` : "";
          log(`${r.skill}: ${r.status}${reason}`);
        }
        installed = results.filter((r) => r.status === "installed").length;
      }
      vscode.window.showInformationMessage(
        `Claude Skills: installed ${installed} skill(s) for this workspace -- see "Claude Skills" output for details.`
      );
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log);
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.generateAllForWorkspace", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      ensureLearningDir(target);
      outputChannel.show(true);
      let installed = 0;
      if (shouldSyncWorkspaceToAll()) {
        const results = generateForAllAgents(libraryDir, target, { all: true, force: false, dryRun: false });
        log(`\n=== Install ALL skills -> all enabled agents ===`);
        log(formatAgentInstallSummary(results));
        installed = results.filter((r) => r.status === "installed" || r.status === "written").length;
      } else {
        const results = generateForWorkspace(libraryDir, target, {
          all: true,
          force: false,
          dryRun: false,
        });
        log(`\n=== Install ALL skills -> ${path.join(target, ".claude", "skills")} ===`);
        for (const r of results) {
          log(`${r.skill}: ${r.status}`);
        }
        installed = results.filter((r) => r.status === "installed").length;
      }
      vscode.window.showInformationMessage(
        `Claude Skills: installed ${installed} skill(s) (full library) -- see "Claude Skills" output for details.`
      );
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log);
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.previewForWorkspace", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      const results = generateForWorkspace(libraryDir, target, {
        all: false,
        force: false,
        dryRun: true,
      });
      outputChannel.show(true);
      log(`\n=== Preview (dry run) for ${target} ===`);
      if (results.length === 0) {
        log("No relevant skills detected for this workspace.");
      }
      for (const r of results) {
        const reason = r.reason ? `  (matched: ${r.reason})` : "";
        log(`${r.skill}: ${r.status}${reason}`);
      }
      if (results.length > 0) {
        const manifest = loadManifest(libraryDir);
        const tiers = results.map((r) => tierForSkill(manifest.skills[r.skill]?.cost_estimate));
        const { totalTokens, totalCostUsd } = sumInstallCostEstimate(tiers);
        log(
          `\nEstimated context impact: ${results.length} skill(s) -> ~${formatTokenCount(totalTokens)} tokens/session (~${formatCompactUsd(totalCostUsd)} at Sonnet-class API rates).`
        );
      }
    }),

    vscode.commands.registerCommand("claudeSkills.installSkillToWorkspace", async (item?: SkillItem) => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      if (!item) {
        return;
      }
      const sourceRoot = item.status.availableInGlobal ? globalSkillsDir() : libraryDir;
      const skillName = item.status.name;
      let force = false;

      if (shouldSyncWorkspaceToAll()) {
        const claudeDest = path.join(target, ".claude", "skills", skillName);
        if (fs.existsSync(claudeDest)) {
          const choice = await vscode.window.showWarningMessage(
            `${skillName} is already installed in this workspace. Overwrite?`,
            "Overwrite",
            "Cancel"
          );
          if (choice !== "Overwrite") {
            return;
          }
          force = true;
        }
        ensureLearningDir(target);
        outputChannel.show(true);
        const results = installSkillToAllWorkspaceAgents(libraryDir, target, skillName, sourceRoot, force, false);
        log(`\n=== Install ${skillName} -> all enabled agents ===`);
        log(formatAgentInstallSummary(results));
        const installed = results.filter((r) => r.status === "installed" || r.status === "written").length;
        vscode.window.showInformationMessage(`Claude Skills: ${skillName} installed to ${installed} agent path(s).`);
      } else {
        const destRoot = path.join(target, ".claude", "skills");
        let status = copySkill(skillName, sourceRoot, destRoot, false, false);
        if (status === "skipped-exists") {
          const choice = await vscode.window.showWarningMessage(
            `${skillName} is already installed in this workspace. Overwrite?`,
            "Overwrite",
            "Cancel"
          );
          if (choice !== "Overwrite") {
            return;
          }
          status = copySkill(skillName, sourceRoot, destRoot, true, false);
        }
        ensureLearningDir(target);
        outputChannel.show(true);
        log(`\n=== Install ${skillName} -> ${destRoot} ===`);
        log(`${skillName}: ${status} (from ${sourceRoot})`);
        vscode.window.showInformationMessage(`Claude Skills: ${skillName} -> ${status}`);
      }
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log);
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.disableSkillLocally", async (item?: SkillItem) => {
      const target = getWorkspaceTarget();
      if (!target || !item) {
        return;
      }
      setSkillOverride(target, item.status.name, "off");
      log(`${item.status.name}: disabled locally (.claude/settings.local.json) - shared .claude/skills/ unchanged`);
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log);
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.enableSkillLocally", async (item?: SkillItem) => {
      const target = getWorkspaceTarget();
      if (!target || !item) {
        return;
      }
      setSkillOverride(target, item.status.name, undefined);
      clearBudgetTrackingForSkill(target, item.status.name);
      log(`${item.status.name}: re-enabled locally (removed override from .claude/settings.local.json)`);
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log);
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.openSkill", async (item?: SkillItem) => {
      if (!item) {
        return;
      }
      const target = getWorkspaceTarget();
      const filePath = item.resolveSkillFilePath(globalSkillsDir(), target);
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc, { preview: true });
    }),

    vscode.commands.registerCommand("claudeSkills.showUsageStats", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      ensureLearningDir(target);
      const manifest = loadManifest(libraryDir);
      const stats = computeUsageStats(target, manifest);
      const suggested = computeSuggestedSkills(target, manifest);
      const creditUsage = computeEnabledAgentsCreditUsage(libraryDir);
      const mirrored = mirrorLearningArtifacts(target, libraryDir);
      await AttributionCollector.getInstance(target, libraryDir).collect(true);
      persistCostAttribution(target, libraryDir);
      const attribution = buildCostAttribution(target, libraryDir);

      outputChannel.show(true);
      log(`\n=== Skill usage report for ${target} ===`);
      log(formatUsageReport(stats, suggested, target, creditUsage));
      log(
        formatAttributionReport(
          attribution.skills,
          attribution.agentTotals,
          attribution.base_context,
          attribution.transcriptSkills,
          attribution.unattributed,
          target
        ).join("\n")
      );
      const sessionBreakdown = generateLatestSessionBreakdown(target);
      if (sessionBreakdown) {
        log("\n## Session cost breakdown (latest)\n");
        log(sessionBreakdown);
      }
      const topSkill = stats.filter((s) => s.runs > 0).sort((a, b) => b.runs - a.runs)[0];
      if (topSkill) {
        const agent = getOptimalAgent(topSkill.name, attribution.skills);
        log(formatRoutingSuggestion(topSkill.name, attribution.skills, agent));
      }
      if (mirrored.length > 0) {
        log(`\nMirrored learning artifacts to: ${mirrored.join(", ")}`);
      }
      log("\n## Enabled AI agents\n");
      log(agentCapabilityLines(libraryDir).join("\n"));

      const html = formatUsageReportHtml(stats, suggested, target, creditUsage);
      if (usagePanel) {
        usagePanel.webview.html = html;
        usagePanel.reveal(vscode.ViewColumn.Active);
      } else {
        usagePanel = vscode.window.createWebviewPanel(
          "claudeSkillsUsage",
          "Claude Skills Usage",
          vscode.ViewColumn.Active,
          {}
        );
        usagePanel.webview.html = html;
        usagePanel.onDidDispose(() => {
          usagePanel = undefined;
        });
      }
    }),

    vscode.commands.registerCommand("claudeSkills.installSessionWatchHook", async () => {
      await vscode.commands.executeCommand("claudeSkills.installCostControlHooks");
    }),

    vscode.commands.registerCommand("claudeSkills.installAttributionHooks", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      try {
        const status = installAttributionHooks(context.extensionPath, target);
        outputChannel.show(true);
        log(`\n=== Attribution v2 hooks (PostToolUse Skill|Read) -> ${target} ===`);
        log(status);
        vscode.window.showInformationMessage(`Claude Skills: attribution hooks ${status}.`);
      } catch (err) {
        recordError();
        vscode.window.showWarningMessage(`Claude Skills: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("claudeSkills.installCostControlHooks", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      try {
        applyBudgetSettings(libraryDir, true);
        const status = installCostControlHooks(context.extensionPath, target);
        outputChannel.show(true);
        log(`\n=== Cost control hooks -> ${target} ===`);
        log(status);
        log(`Budget config synced to ~/.claude/learning/budget.json`);
        if (status === "installed") {
          vscode.window.showInformationMessage(
            "Claude Skills: cost control hooks enabled (session size + daily budget) for this workspace."
          );
        } else if (status === "updated") {
          vscode.window.showInformationMessage("Claude Skills: cost control hooks updated for this workspace.");
        } else {
          vscode.window.showInformationMessage("Claude Skills: cost control hooks were already enabled (files refreshed).");
        }
      } catch (err) {
        recordError();
        vscode.window.showWarningMessage(`Claude Skills: could not enable cost control hooks - ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("claudeSkills.cycleBudgetMode", async () => {
      const cfg = vscode.workspace.getConfiguration("claudeSkills.budget");
      const current = cfg.get<BudgetMode>("mode", "normal");
      const next = BUDGET_MODE_CYCLE[(BUDGET_MODE_CYCLE.indexOf(current) + 1) % BUDGET_MODE_CYCLE.length];
      await cfg.update("mode", next, vscode.ConfigurationTarget.Global);
      applyBudgetSettings(libraryDir, true);
      refreshAll();
      outputChannel.show(true);
      log(`\n=== Budget mode -> ${BUDGET_MODE_LABEL[next]} ===`);
      vscode.window.showInformationMessage(`Claude Skills: budget mode set to ${BUDGET_MODE_LABEL[next]}.`);
    }),

    vscode.commands.registerCommand("claudeSkills.openBudgetSettings", async () => {
      await vscode.commands.executeCommand("workbench.action.openSettings", "claudeSkills.budget");
    }),

    vscode.commands.registerCommand("claudeSkills.saveBranchProfile", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      const profile = saveBranchProfile(target, libraryDir);
      outputChannel.show(true);
      if (!profile) {
        log("\n=== Save branch profile ===\nNot a git repo or branch profiles disabled.");
        vscode.window.showWarningMessage("Claude Skills: could not save branch profile (git branch required).");
        return;
      }
      log(`\n=== Save branch profile -> ${profile.branch} ===`);
      log(`${profile.skills.length} skill(s), ${Object.keys(profile.skillOverrides).length} override(s)`);
      vscode.window.showInformationMessage(
        `Claude Skills: saved skill profile for branch "${profile.branch}" (${profile.skills.length} skills).`
      );
    }),

    vscode.commands.registerCommand("claudeSkills.exportTeamBranchProfile", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      const profile = exportTeamBranchProfile(target, libraryDir);
      if (!profile) {
        vscode.window.showWarningMessage("Claude Skills: not on a git branch or could not capture profile.");
        return;
      }
      outputChannel.show(true);
      log(`\n=== Export team branch profile ===\n${formatTeamProfileReport(target)}`);
      vscode.window.showInformationMessage(
        `Claude Skills: wrote team profile (.claude/skills-profile.json) — commit to git.`
      );
    }),

    vscode.commands.registerCommand("claudeSkills.applyTeamBranchProfile", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      const result = applyTeamBranchProfile(libraryDir, target);
      if (!result) {
        vscode.window.showWarningMessage("Claude Skills: no team profile entry for this branch.");
        return;
      }
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log);
      refreshAll();
      vscode.window.showInformationMessage(
        `Claude Skills: applied team profile (+${result.installed.length}, -${result.removed.length}).`
      );
    }),

    vscode.commands.registerCommand("claudeSkills.showTeamBranchProfiles", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        return;
      }
      outputChannel.show(true);
      log(`\n=== Team branch profiles (git) ===\n${formatTeamProfileReport(target)}`);
    }),

    vscode.commands.registerCommand("claudeSkills.applyBranchProfile", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      const branch = getCurrentBranch(target);
      if (!branch) {
        vscode.window.showWarningMessage("Claude Skills: not on a named git branch.");
        return;
      }
      const profile = loadBranchProfile(target, branch);
      if (!profile) {
        vscode.window.showWarningMessage(`Claude Skills: no saved profile for branch "${branch}".`);
        return;
      }
      const result = applyBranchProfile(libraryDir, target, profile);
      outputChannel.show(true);
      log(`\n=== Apply branch profile -> ${branch} ===`);
      log(`Installed: ${result.installed.join(", ") || "(none)"}`);
      log(`Removed: ${result.removed.join(", ") || "(none)"}`);
      log(`Overrides applied: ${result.overridesApplied}`);
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log);
      refreshAll();
      vscode.window.showInformationMessage(
        `Claude Skills: applied "${branch}" profile (+${result.installed.length}, -${result.removed.length}).`
      );
    }),

    vscode.commands.registerCommand("claudeSkills.showAgentCapabilities", async () => {
      outputChannel.show(true);
      log("\n=== Enabled AI agent targets ===");
      log(agentCapabilityLines(libraryDir).join("\n"));
      log("\nConfigure via Settings -> claudeSkills.agents.enabled");
      log("Agent paths defined in skills_library/agents.json");
    }),

    vscode.commands.registerCommand("claudeSkills.syncWorkspaceToAgents", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      if (!shouldSyncWorkspaceToAll()) {
        vscode.window.showWarningMessage(
          "Claude Skills: enable claudeSkills.features.multiAgent and claudeSkills.agents.syncWorkspaceToAll."
        );
        return;
      }
      outputChannel.show(true);
      log("\n=== Sync workspace skills to all enabled agents ===");
      const { agentPathsUpdated } = propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, {
        forceAgentSync: true,
        saveBranchProfile: false,
      });
      vscode.window.showInformationMessage(
        `Claude Skills: synced workspace skills to ${agentPathsUpdated} agent path(s) — see output.`
      );
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.showBranchProfiles", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      if (!branchProfilesFeatureActive()) {
        vscode.window.showWarningMessage("Claude Skills: branch profiles are disabled in feature toggles.");
        return;
      }
      const report = formatBranchProfilesReport(target);
      outputChannel.show(true);
      log(`\n=== Branch skill profiles ===`);
      log(report);
      const preview = report.split("\n").slice(0, 6).join("\n");
      vscode.window.showInformationMessage(
        preview.length > 120 ? `${preview.slice(0, 117)}...` : preview,
        "Open Output"
      ).then((choice) => {
        if (choice === "Open Output") {
          outputChannel.show(true);
        }
      });
    }),

    vscode.commands.registerCommand("claudeSkills.showCostDashboard", async () => {
      recordFeatureUse("costDashboard");
      if (!isFeatureEnabled("costIntelligence")) {
        vscode.window.showWarningMessage("Claude Skills: cost intelligence is disabled (claudeSkills.features.costIntelligence).");
        return;
      }
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      ensureLearningDir(target);
      if (isFeatureEnabled("attributionCollector")) {
        await AttributionCollector.getInstance(target, libraryDir).collect(true);
      }
      persistCostAttribution(target, libraryDir);
      const built = buildCostAttribution(target, libraryDir);
      const merged = { ...built.skills, ...built.transcriptSkills };
      updateLocalBenchmarks(merged);
      void uploadAnonymizedStats(merged);
      const html = formatCostDashboardHtml(target, libraryDir);
      if (costDashboardPanel) {
        costDashboardPanel.webview.html = html;
        costDashboardPanel.reveal(vscode.ViewColumn.Active);
      } else {
        costDashboardPanel = vscode.window.createWebviewPanel(
          "claudeSkillsCostDashboard",
          "Claude Skills Cost Intelligence",
          vscode.ViewColumn.Active,
          { enableScripts: true }
        );
        costDashboardPanel.webview.html = html;
        costDashboardPanel.webview.onDidReceiveMessage(async (msg: { command?: string; skill?: string; type?: string }) => {
          if (msg.command === "applyOptimizations") {
            await vscode.commands.executeCommand("claudeSkills.applyOptimizations");
          } else if (msg.command === "applySuggestion" && msg.skill && msg.type) {
            const health = assessAttributionHealth(target, libraryDir);
            if (!health.reliable) {
              vscode.window.showWarningMessage(`Claude Skills: ${health.summary}`);
              return;
            }
            const result = await applySingleOptimizationSuggestion(
              target,
              libraryDir,
              msg.skill,
              msg.type as OptimizationType
            );
            if (result.applied.length > 0) {
              propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log);
              refreshAll();
              costDashboardPanel!.webview.html = formatCostDashboardHtml(target, libraryDir);
              vscode.window.showInformationMessage(`Claude Skills: ${result.applied[0]}`);
            } else {
              vscode.window.showWarningMessage(`Claude Skills: could not apply suggestion for ${msg.skill}.`);
            }
          } else if (msg.command === "exportReport") {
            await vscode.commands.executeCommand("claudeSkills.exportCostReport");
          } else if (msg.command === "openBudget") {
            await vscode.commands.executeCommand("claudeSkills.openBudgetSettings");
          }
        });
        costDashboardPanel.onDidDispose(() => {
          costDashboardPanel = undefined;
        });
      }
      outputChannel.show(true);
      log(`\n${formatCostDashboardText(target, libraryDir)}`);
    }),

    vscode.commands.registerCommand("claudeSkills.showOptimizationSuggestions", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      const suggestions = generateOptimizationSuggestions(target, libraryDir);
      outputChannel.show(true);
      log("\n=== Cost optimization suggestions ===");
      log(formatSuggestionsReport(suggestions).join("\n"));
      if (suggestions.length === 0) {
        vscode.window.showInformationMessage("Claude Skills: no optimization suggestions yet.");
      } else {
        const apply = await vscode.window.showInformationMessage(
          `${suggestions.length} optimization suggestion(s) — apply selected?`,
          "Apply",
          "Dismiss"
        );
        if (apply === "Apply") {
          await vscode.commands.executeCommand("claudeSkills.applyOptimizations");
        }
      }
    }),

    vscode.commands.registerCommand("claudeSkills.applyOptimizations", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      const health = assessAttributionHealth(target, libraryDir);
      if (!health.reliable) {
        vscode.window.showWarningMessage(`Claude Skills: ${health.summary}`);
        return;
      }
      const suggestions = generateOptimizationSuggestions(target, libraryDir);
      const result = await applyOptimizationSuggestions(target, libraryDir, suggestions);
      outputChannel.show(true);
      log("\n=== Apply optimizations ===");
      log(result.applied.join("\n") || "(none applied)");
      if (result.skipped.length > 0) {
        log(`Skipped: ${result.skipped.join(", ")}`);
      }
      refreshAll();
      vscode.window.showInformationMessage(
        `Claude Skills: applied ${result.applied.length} optimization(s).`
      );
    }),

    vscode.commands.registerCommand("claudeSkills.exportCostReport", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        return;
      }
      const health = assessAttributionHealth(target, libraryDir);
      const text = [
        formatCostDashboardText(target, libraryDir),
        "",
        ...formatSuggestionsReport(generateOptimizationSuggestions(target, libraryDir), {
          attributionSummary: health.reliable
            ? undefined
            : `Per-skill attribution not reliable yet: ${health.summary}`,
        }),
      ].join("\n");
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(target, "claude-skills-cost-report.txt")),
        filters: { Text: ["txt", "md"] },
      });
      if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf-8"));
        vscode.window.showInformationMessage(`Cost report saved to ${uri.fsPath}`);
      }
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
      ];
      const pick = await vscode.window.showQuickPick(
        keys.map((k) => ({
          label: k,
          description: isFeatureEnabled(k) ? "enabled" : "disabled",
          key: k,
        })),
        { title: "Toggle Claude Skills feature", placeHolder: "Select a feature to flip on/off" }
      );
      if (!pick) {
        return;
      }
      const next = !isFeatureEnabled(pick.key);
      await cfg.update(pick.key, next, vscode.ConfigurationTarget.Global);
      outputChannel.show(true);
      log(`\n=== Feature ${pick.key} -> ${next ? "on" : "off"} ===`);
      log(featureFlagLines().join("\n"));
      vscode.window.showInformationMessage(`Claude Skills: ${pick.key} is now ${next ? "enabled" : "disabled"}. Reload window to apply some changes.`);
    }),

    vscode.commands.registerCommand("claudeSkills.resetEmergencyCutoff", async () => {
      await resetEmergencyCutoff(getWorkspaceTarget());
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.cycleSkillSort", async () => {
      const cfg = vscode.workspace.getConfiguration("claudeSkills.search");
      const modes: SkillSortMode[] = ["relevance", "lowest_cost", "highest_roi", "best_value"];
      const current = cfg.get<SkillSortMode>("sortBy", "relevance");
      const next = modes[(modes.indexOf(current) + 1) % modes.length];
      await cfg.update("sortBy", next, vscode.ConfigurationTarget.Workspace);
      provider.refresh();
      vscode.window.showInformationMessage(`Claude Skills: skill sort -> ${next}`);
    }),

    vscode.commands.registerCommand("claudeSkills.estimatePRCost", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        return;
      }
      const pr = await vscode.window.showInputBox({ prompt: "PR number", placeHolder: "42" });
      if (!pr) {
        return;
      }
      await estimateAndCommentPR(target, libraryDir, parseInt(pr, 10));
    }),

    vscode.commands.registerCommand("claudeSkills.restoreArchivedSkill", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        return;
      }
      const archived = listArchivedSkills(target);
      if (archived.length === 0) {
        vscode.window.showInformationMessage("No archived skills to restore.");
        return;
      }
      const pick = await vscode.window.showQuickPick(archived, { title: "Restore archived skill" });
      if (pick && restoreArchivedSkill(target, pick)) {
        refreshAll();
        vscode.window.showInformationMessage(`Restored skill: ${pick}`);
      }
    }),

    vscode.commands.registerCommand("claudeSkills.startOnboarding", async () => {
      recordFeatureUse("onboarding");
      await showOnboardingWizard(context, libraryDir, getWorkspaceTarget, refreshAll);
    }),

    vscode.commands.registerCommand("claudeSkills.startOnboardingTour", async () => {
      recordFeatureUse("onboarding");
      await showOnboardingTour(context);
    }),

    vscode.commands.registerCommand("claudeSkills.repairData", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      const issues = scanForIssues(target);
      if (issues.length === 0) {
        vscode.window.showInformationMessage("Claude Skills: no data issues detected.");
        return;
      }
      const fixed = await repairIssues(target, issues);
      vscode.window.showInformationMessage(`Claude Skills: repaired ${fixed.length} issue(s).`);
    }),

    vscode.commands.registerCommand("claudeSkills.configureWeeklyReportEmail", async () => {
      const target = getWorkspaceTarget();
      const message = await configureWeeklyReportEmail(context, target);
      outputChannel.show(true);
      log(`\n=== Configure weekly report email ===\n${message}`);
      vscode.window.showInformationMessage(message.split("\n")[0] ?? message);
    }),

    vscode.commands.registerCommand("claudeSkills.sendWeeklyReport", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      outputChannel.show(true);
      log("\n=== Send weekly AI usage report ===");
      const result = await deliverWeeklyReport(context, target, libraryDir);
      if (result.email.ok) {
        log(`Email sent to ${result.email.to}`);
        vscode.window.showInformationMessage(`Claude Skills: weekly report emailed to ${result.email.to}.`);
      } else {
        log(`Email failed: ${result.email.error ?? "n/a"}`);
        vscode.window.showWarningMessage(
          result.email.error ?? "Weekly report could not be sent. Run Configure Weekly Report Email."
        );
      }
    }),

    vscode.commands.registerCommand("claudeSkills.resetAttribution", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        "Reset mis-attributed cost data? This removes collector-generated transcript rows and clears transcriptSkills so attribution can be re-collected.",
        { modal: true },
        "Reset"
      );
      if (confirm !== "Reset") {
        return;
      }
      const result = resetMisattributedData(target);
      await AttributionCollector.getInstance(target, libraryDir).collect(true);
      persistCostAttribution(target, libraryDir);
      vscode.window.showInformationMessage(
        `Claude Skills: removed ${result.removedRuns} mis-attributed run(s); kept ${result.keptRuns}. Re-collection started.`
      );
    }),

    vscode.commands.registerCommand("claudeSkills.installCommitCostHook", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      try {
        const status = installGitPostCommitHook(target, context.extensionPath);
        vscode.window.showInformationMessage(`Claude Skills: commit cost hook ${status}.`);
      } catch (err) {
        vscode.window.showWarningMessage(`Claude Skills: ${(err as Error).message}`);
      }
    })
  );

  const detectionWatchGlobs = [
    "**/.gitlab-ci.yml",
    "**/.github/workflows/**",
    "**/*.tf",
    "**/*.tfvars",
    "**/package.json",
    "**/pyproject.toml",
    "**/requirements.txt",
    "**/*.kql",
    "**/aidlc-state.md",
    "**/terraform/**",
  ];
  const debouncedRefresh = debounce(() => refreshAll(), 2000);
  for (const glob of detectionWatchGlobs) {
    const w = vscode.workspace.createFileSystemWatcher(glob);
    w.onDidCreate(debouncedRefresh);
    w.onDidDelete(debouncedRefresh);
    w.onDidChange(debouncedRefresh);
    context.subscriptions.push(w);
  }

  const debouncedAgentSync = debounce(() => {
    const target = getWorkspaceTarget();
    if (target) {
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log);
    }
  }, 1500);

  const skillsWatcher = vscode.workspace.createFileSystemWatcher("**/.claude/skills/**");
  skillsWatcher.onDidCreate(debouncedAgentSync);
  skillsWatcher.onDidDelete(debouncedAgentSync);
  skillsWatcher.onDidChange(debouncedAgentSync);
  context.subscriptions.push(skillsWatcher);

  const localSettingsWatcher = vscode.workspace.createFileSystemWatcher("**/.claude/settings.local.json");
  localSettingsWatcher.onDidChange(debouncedAgentSync);
  localSettingsWatcher.onDidCreate(debouncedAgentSync);
  context.subscriptions.push(localSettingsWatcher);

  const gitExt = vscode.extensions.getExtension("vscode.git");
  if (gitExt) {
    const subscribeGit = () => {
      try {
        const api = gitExt.exports.getAPI(1);
        for (const repo of api.repositories) {
          repo.state.onDidChange(async () => {
            const target = getWorkspaceTarget();
            if (!target || !target.startsWith(repo.rootUri.fsPath)) {
              return;
            }
            const teamResult = applyTeamBranchProfile(libraryDir, target);
            if (teamResult) {
              log(`Applied team git profile (baseline): +${teamResult.installed.length}, -${teamResult.removed.length}`);
            }
            await handleBranchChange(libraryDir, target, log);
            propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log);
            refreshAll();
          });
        }
        api.onDidOpenRepository((repo: { state: { onDidChange: (cb: () => void) => void }; rootUri: { fsPath: string } }) => {
          repo.state.onDidChange(async () => {
            const target = getWorkspaceTarget();
            if (!target || !target.startsWith(repo.rootUri.fsPath)) {
              return;
            }
            const teamResult = applyTeamBranchProfile(libraryDir, target);
            if (teamResult) {
              log(`Applied team git profile (baseline): +${teamResult.installed.length}, -${teamResult.removed.length}`);
            }
            await handleBranchChange(libraryDir, target, log);
            propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log);
            refreshAll();
          });
        });
      } catch {
        // git API unavailable
      }
    };
    const runInitialBranchSync = () => {
      try {
        setGitApiCache(gitExt.exports.getAPI(1));
      } catch {
        setGitApiCache(undefined);
      }
      subscribeGit();
      const target = getWorkspaceTarget();
      syncBranchProfileContext(target);
      if (target) {
        void (async () => {
          const teamResult = applyTeamBranchProfile(libraryDir, target);
          if (teamResult) {
            log(`Applied team git profile (baseline): +${teamResult.installed.length}, -${teamResult.removed.length}`);
          }
          await handleBranchChange(libraryDir, target, log);
          propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, {
            saveBranchProfile: false,
          });
        })();
      }
    };
    if (gitExt.isActive) {
      runInitialBranchSync();
    } else {
      gitExt.activate().then(runInitialBranchSync);
    }
  }
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(fn, ms);
  };
}

export function deactivate() {
  AttributionCollector.stopAll();
}
