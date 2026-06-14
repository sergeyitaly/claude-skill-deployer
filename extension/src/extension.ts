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
  invalidateDetectionCache,
  disableWorkspaceSkill,
  enableWorkspaceSkill,
  isSkillCommittedOnBranch,
  setSkillOverride,
} from "./skillOps";
import { SkillItem, SkillsProvider } from "./skillsProvider";
import {
  computeCrossAgentUsage,
  computeSuggestedSkills,
  computeUsageStats,
  enrichUsageStatsWithAttribution,
  ensureLearningDir,
  formatUsageReport,
  formatUsageReportHtml,
  listInstalledSkills,
  runAgentLabel,
} from "./usageStats";
import { computeSkillInefficiencyStats } from "./skillFeedback";
import { readTaskSkillProposals, resolveTaskSkillProposals, ensureWorkspaceTaskProposals } from "./taskSkillProposals";
import {
  evaluateHighUsageSkillProposalAlert,
  maybePromptHighUsageSkillProposals,
} from "./skillProposalAlert";
import {
  agentCapabilityLines,
  agentMirrorsNeedSync,
  formatAgentInstallSummary,
  generateForAllAgents,
  installLibraryToAllAgents,
  installSkillToAllWorkspaceAgents,
  invalidateWorkspaceSyncFingerprint,
  mirrorLearningArtifacts,
  computeEnabledAgentsCreditUsage,
  removeSkillFromAllWorkspaceAgents,
  shouldSyncGlobalToAll,
  shouldSyncWorkspaceToAll,
  syncWorkspaceSkillsToAllAgents,
} from "./agentOps";
import {
  autoInstallAttributionHooksEnabled,
  ensureAttributionHooksActive,
  propagateWorkspaceSkillChange,
} from "./workspaceSkillSync";
import { ensureWorkspaceCachesWarm, warmupWorkspaceCaches } from "./cacheWarmup";
import { registerSyncStatusBar } from "./syncFeedback";
import { markPreToggleFingerprint } from "./syncPredict";
import {
  markTypingActivity,
  markUserInteraction,
  markClick,
  registerUserActivityListeners,
} from "./userInteraction";
import {
  notifyBackground,
  notifySuggestion,
  notifyUserSuccess,
  notifyUserWarn,
} from "./userNotify";
import { recordPerf } from "./perfTelemetry";
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
import {
  CONTEXT_FOCUS_LABELS,
  ContextFocusLevel,
  configFromVsCodeSettings as contextFocusFromSettings,
  nextContextFocusLevel,
  syncContextFocusConfigToDisk,
} from "./contextFocusConfig";
import {
  PRACTICAL_FOCUS_LABELS,
  PracticalFocusLevel,
  configFromVsCodeSettings as practicalFocusFromSettings,
  nextPracticalFocusLevel,
  syncPracticalFocusConfigToDisk,
} from "./practicalFocusConfig";
import { clearBudgetTrackingForSkill, syncAndApplyBudgetMode } from "./budgetOps";
import {
  agentProfilesFeatureActive,
  detectHostAgentId,
  formatAgentSkillSetsReport,
  hostAgentLabel,
  maybeApplyHostAgentSkillSet,
  maybeSaveHostAgentSetWithBranchProfile,
  promptSwitchAgentSkillSet,
  saveAgentSkillSet,
} from "./agentSkillProfiles";
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
import {
  areAttributionHooksConfigured,
  getWorkspaceHookStatus,
  installAttributionHooks,
  installCostControlHooks,
  installOfficialSkillsSessionHook,
} from "./hookOps";
import { syncCliConfigToWorkspace } from "./cliConfig";
import { setActiveProjectProfileContext } from "./activeProjectProfile";
import {
  buildProjectProfile,
  buildProjectProfileWithRemoteProbe,
  formatProjectProfileSummary,
  PROFILE_TYPE_LABELS,
  ProjectProfileFile,
  projectProfileApplyTierEnabled,
  readProjectProfile,
  refreshProjectProfileContext,
  setLockedProjectProfileTier,
  effectiveLockedTier,
  writeProjectProfile,
} from "./projectProfile";
import {
  formatProjectProfileNotifyMessage,
  formatProjectProfileStatusBarText,
  formatProjectProfileStatusBarTooltip,
  formatProjectProfileSummaryBlock,
  formatProjectProfileTierComparisonTable,
} from "./projectProfileDisplay";
import {
  applyUserProjectPlan,
  buildProjectPlanQuickPickItems,
  formatDetectedTierSummary,
  maybePromptProjectTierOnFirstDetect,
} from "./projectProfilePrompt";
import { formatPrepareClaudeCliSummary, prepareForClaudeCli } from "./prepareClaudeCli";
import { localDateKey } from "./localDate";
import * as crypto from "node:crypto";
import {
  checkOfficialSkillUpdates,
  formatOfficialSkillsSessionContext,
  resolveSkillsLibraryDir,
  workspaceUsesOfficialSkillUpdater,
} from "./officialSkillsSync";
import {
  applyTeamBranchProfile,
  exportTeamBranchProfile,
  formatTeamProfileReport,
} from "./teamBranchProfiles";
import { AttributionCollector } from "./attributionCollector";
import { resetMisattributedData } from "./attributionReset";
import { generateLatestSessionBreakdown } from "./sessionBreakdown";
import { generateOptimizationSuggestions, formatSuggestionsReport } from "./costOptimizer";
import { formatCostDashboardHtml, formatCostDashboardText, formatTeamEconomicsPanelsHtml, getOrBuildDashboardMainBody } from "./costDashboard";
import { tryReadValidDashboardSnapshot } from "./dashboardSnapshotCache";
import { applyOptimizationSuggestions, applySingleOptimizationSuggestion } from "./autoOptimizer";
import { checkPredictiveCostAlert } from "./costPredictor";
import { installGitPostCommitHook } from "./commitCost";
import { isAutoOptimizeEnabled, runAutoOptimizePass } from "./autoOptimizer";
import { isFeatureEnabled, featureFlagLines, FeatureKey, FEATURE_DESCRIPTIONS } from "./featureFlags";
import { checkEmergencyCutoff, resetEmergencyCutoff } from "./emergencyCutoff";
import { syncCommunityBenchmarks, updateLocalBenchmarks, uploadAnonymizedStats } from "./communityBenchmarks";
import { getOrComputeTeamEconomicsBundle } from "./teamEconomicsCache";
import { yieldToEventLoop } from "./eventLoop";
import { listArchivedSkills, restoreArchivedSkill } from "./skillArchival";
import { estimateAndCommentPR } from "./prCostEstimate";
import { SkillSortMode } from "./skillRoi";
import {
  checkFirstTimeGlobalSetup,
  detectGitRepository,
  integrationTestMode,
  promptGetStarted,
} from "./criticalFixes";
import { showOnboardingTour } from "./onboarding";
import { showOnboardingWizard } from "./onboardingWizard";
import { formatHookStatusPlain } from "./workspaceHookStatus";
import { assessAttributionHealth } from "./attributionHealth";
import { buildUsageSkillConfidenceMap } from "./attributionConfidence";
import { buildGlobalTrustBadge, formatGlobalTrustStatusBar } from "./attributionTrust";
import {
  lifecycleAlertsEnabled,
  lifecycleAutoSuggestEnabled,
  listOutdatedSkills,
  listSkillVersionStatuses,
  upgradeOutdatedSkills,
} from "./skillLifecycle";
import { readSkillStatsIndex } from "./runsIndex";
import { setPricingContext } from "./costRates";
import { runCostPipeline, runCostPipelineSync } from "./costPipeline";
import {
  scheduleCostPipelineSync,
} from "./costPipelineScheduler";
import { buildSystemModeContext } from "./systemMode";
import { readPipelineCycle } from "./pipelineCycle";
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
  executeSkillSetResolution,
  formatSkillSetResolverPlan,
  planSkillSetResolution,
  startSkillSetResolverScheduler,
} from "./skillSetResolver";
import {
  isMultiRootWorkspace,
  pickWorkspaceTarget,
  registerWorkspaceTargetListeners,
  resolveWorkspaceTarget,
  workspaceFolderLabel,
} from "./workspaceTarget";
import { OptimizationType } from "./costOptimizer";
import {
  applyLocalProfileInit,
  autoApplyProfileFileEnabled,
  ensureProfileInitSessionReady,
  findMissingRequiredProfileSkills,
  maybeApplyDeterministicProfileInit,
  maybePromptProfileInitOnNewBranch,
  mergeProfileInitSkills,
  profileInitEnabled,
  profileInitRequestPending,
  promptForPosition,
  readUserPosition,
  recoverRequiredProfileSkills,
  recoverRequiredSkillsOnNewBranchEnabled,
  refreshSkillsCatalog,
  startProfileInitFlow,
} from "./profileInit";
import {
  applyProposedSkillsLocally,
  applyTaskProposalsIfPending,
  processSessionSkillApplyRequest,
  SESSION_APPLY_REQUEST_REL,
} from "./sessionSkillApply";
import { applyTaskSkillFocusFromProposals } from "./taskSkillFocus";
import { PROPOSALS_FILE_RELATIVE } from "./taskSkillProposals";
import { createRefreshScheduler, shouldRunWorkspaceState } from "./workspaceRefresh";

let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let usageStatusBarItem: vscode.StatusBarItem;
let creditStatusBarItem: vscode.StatusBarItem;
let trustStatusBarItem: vscode.StatusBarItem;
let budgetModeStatusBarItem: vscode.StatusBarItem;
let contextFocusStatusBarItem: vscode.StatusBarItem;
let practicalFocusStatusBarItem: vscode.StatusBarItem;
let projectTierStatusBarItem: vscode.StatusBarItem;
let workspaceFolderStatusBarItem: vscode.StatusBarItem;
let usagePanel: vscode.WebviewPanel | undefined;
let costDashboardPanel: vscode.WebviewPanel | undefined;
let costDashboardMessageSub: vscode.Disposable | undefined;

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

/** Open the output panel when the user opts in (setting) or clicks "Open Output". */
function revealOutputPanel(): void {
  outputChannel.show(true);
}

function maybeRevealOutputPanel(): void {
  if (vscode.workspace.getConfiguration("claudeSkills").get<boolean>("revealOutputPanel", false)) {
    revealOutputPanel();
  }
}

/** Phase-2 dashboard: fill main + team panels when fast-phase used a loading slot or stale snapshot. */
async function enhanceCostDashboardPanel(
  target: string,
  libraryDir: string,
  pipeline: import("./costPipeline").CostPipelineResult,
  panel: vscode.WebviewPanel,
  hadMainSnapshot: boolean
): Promise<void> {
  if (!hadMainSnapshot) {
    await yieldToEventLoop();
    const main = getOrBuildDashboardMainBody(target, libraryDir, pipeline);
    panel.webview.postMessage({ command: "dashboardMainHtml", html: main.mainBodyHtml });
  }
  await pushTeamEconomicsToDashboard(target, libraryDir, panel);
}

/** Phase-2 team economics slot only. */
async function pushTeamEconomicsToDashboard(
  target: string,
  libraryDir: string,
  panel: vscode.WebviewPanel
): Promise<void> {
  const built = buildCostAttribution(target, libraryDir);
  const { attribution, staleEqualSplit } = resolveDisplayAttribution(built, target);
  const health = assessAttributionHealth(target, libraryDir);
  const modeCtx = buildSystemModeContext(health, target, readPipelineCycle(target));
  if (!modeCtx.canShowPerSkillCosts || staleEqualSplit || !isFeatureEnabled("teamCostSharing")) {
    panel.webview.postMessage({ command: "teamEconomicsHtml", html: "" });
    return;
  }
  await yieldToEventLoop();
  const manifest = loadManifest(libraryDir);
  const bundle = getOrComputeTeamEconomicsBundle(target, libraryDir, manifest, attribution);
  panel.webview.postMessage({
    command: "teamEconomicsHtml",
    html: formatTeamEconomicsPanelsHtml(bundle, true),
  });
}

function branchChangeOpts(extensionPath: string, libraryDir: string, target: string) {
  if (!profileInitEnabled()) {
    return undefined;
  }
  return {
    onNewBranchWithoutProfile: (branch: string) =>
      maybePromptProfileInitOnNewBranch(extensionPath, libraryDir, target, branch, log),
    mergeProfileSkills: mergeProfileInitSkills,
    recoverRequiredSkills: async (
      branch: string,
      context: { isFirstSync: boolean; hasSavedProfile: boolean }
    ): Promise<boolean> => {
      if (!recoverRequiredSkillsOnNewBranchEnabled()) {
        return false;
      }
      const shouldRecover =
        !context.hasSavedProfile || (context.isFirstSync && findMissingRequiredProfileSkills(target).length > 0);
      if (!shouldRecover) {
        return false;
      }
      const { recovered, reEnabled, skipped } = recoverRequiredProfileSkills(libraryDir, target);
      if (recovered.length > 0 || reEnabled.length > 0) {
        log(
          `Required platform skills for \`${branch}\`: restored ${recovered.join(", ") || "(none)"}` +
            (reEnabled.length ? `; re-enabled ${reEnabled.join(", ")}` : "") +
            (skipped.length ? `; skipped (not in library): ${skipped.join(", ")}` : "") +
            "."
        );
        return true;
      }
      return false;
    },
  };
}

async function maybeNotifyOfficialSkillUpdates(target: string): Promise<void> {
  if (!vscode.workspace.getConfiguration("claudeSkills").get<boolean>("officialSkillsCheckOnSession", true)) {
    return;
  }
  if (!workspaceUsesOfficialSkillUpdater(target)) {
    return;
  }
  const libraryDir = resolveSkillsLibraryDir(target);
  if (!libraryDir) {
    return;
  }
  try {
    const result = await checkOfficialSkillUpdates(libraryDir);
    if (result.unchanged || result.checkError) {
      return;
    }
    const newCount = result.candidates.filter((c) => c.kind === "new").length;
    const updatedCount = result.candidates.filter((c) => c.kind === "updated").length;
    const choice = await notifySuggestion(
      `Official Anthropic skills have updates (${newCount} new, ${updatedCount} updates).`,
      ["Check now", "Dismiss"],
      { dedupeKey: `official-skills|${target}`, log }
    );
    if (choice === "Check now") {
      await vscode.commands.executeCommand("claudeSkills.checkOfficialSkillUpdates");
    }
  } catch (err) {
    log(`Official skills check failed: ${(err as Error).message}`);
  }
}

function syncBranchProfileContext(target: string | undefined): void {
  const git = target ? isGitWorkspace(target) : false;
  const enabled = branchProfilesFeatureActive() && git;
  void vscode.commands.executeCommand("setContext", "claudeSkills.isGitRepo", git);
  void vscode.commands.executeCommand("setContext", "claudeSkills.branchProfilesEnabled", enabled);
  void vscode.commands.executeCommand(
    "setContext",
    "claudeSkills.agentProfilesEnabled",
    agentProfilesFeatureActive() && git
  );
}

function refreshProjectTierStatusBar(target?: string) {
  if (!target) {
    projectTierStatusBarItem.hide();
    return;
  }
  const profile = readProjectProfile(target);
  if (!profile) {
    projectTierStatusBarItem.hide();
    return;
  }
  projectTierStatusBarItem.text = formatProjectProfileStatusBarText(profile);
  projectTierStatusBarItem.tooltip = formatProjectProfileStatusBarTooltip(profile);
  projectTierStatusBarItem.command = "claudeSkills.showProjectProfile";
  projectTierStatusBarItem.show();
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
  const hostSuffix = agentProfilesFeatureActive() ? ` · ${hostAgentLabel(detectHostAgentId())}` : "";
  if (pending.length === 0) {
    statusBarItem.text = `$(check) Claude Skills${branchSuffix}${hostSuffix}`;
    statusBarItem.tooltip =
      `All relevant Claude skills are installed for this workspace${branch ? ` (branch: ${branch})` : ""}${hostSuffix ? `\nActive IDE profile: ${hostAgentLabel(detectHostAgentId())}` : ""}.`;
  } else {
    statusBarItem.text = `$(lightbulb) Claude Skills: ${pending.length} suggested${branchSuffix}${hostSuffix}`;
    statusBarItem.tooltip =
      `${pending.length} relevant skill(s) not yet installed:\n` +
      pending.map((s) => `- ${s.name}`).join("\n") +
      (branch ? `\n\nBranch: ${branch} (skill profile stored in ~/.claude/learning/branch-profiles.json).` : "") +
      "\n\nClick to install.";
  }
  statusBarItem.command = "claudeSkills.generateForWorkspace";
  statusBarItem.show();
}

function refreshCreditStatusBar(libraryDir: string, target?: string) {
  const manifest = loadManifest(libraryDir);
  const config = configFromVsCodeSettings(manifest);
  const summary = computeEnabledAgentsCreditUsage(libraryDir, 1, target);
  const today = localDateKey();
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

function refreshTrustStatusBar(libraryDir: string, target?: string) {
  if (!target) {
    trustStatusBarItem.hide();
    return;
  }
  const health = assessAttributionHealth(target, libraryDir);
  const hookStatus = getWorkspaceHookStatus(target, libraryDir);
  const badge = buildGlobalTrustBadge(health, hookStatus);
  trustStatusBarItem.text = formatGlobalTrustStatusBar(badge);
  trustStatusBarItem.tooltip = `${badge.label} (${badge.scorePct}%)\n\n${badge.detail}\n\nTranscripts and split attribution are probabilistic — not an API invoice.\n\nClick for the usage report.`;
  trustStatusBarItem.command = "claudeSkills.showUsageStats";
  trustStatusBarItem.show();
}

let lastOutdatedAlertCheckMs = 0;
const OUTDATED_ALERT_INTERVAL_MS = 10 * 60 * 1000;

async function maybePromptOutdatedSkillUpgrades(libraryDir: string, target: string): Promise<void> {
  if (!lifecycleAlertsEnabled() || !lifecycleAutoSuggestEnabled()) {
    return;
  }
  const now = Date.now();
  if (now - lastOutdatedAlertCheckMs < OUTDATED_ALERT_INTERVAL_MS) {
    return;
  }
  lastOutdatedAlertCheckMs = now;
  const outdated = listOutdatedSkills(libraryDir, target);
  if (outdated.length === 0) {
    return;
  }
  const preview = outdated
    .slice(0, 3)
    .map((s) => `${s.name} (${s.installedVersion} → ${s.catalogVersion})`)
    .join(", ");
  const suffix = outdated.length > 3 ? ` +${outdated.length - 3} more` : "";
  const choice = await notifySuggestion(
    `Claude Skills: ${outdated.length} outdated skill(s) — ${preview}${suffix}. Upgrade from the library?`,
    ["Upgrade all", "Show report", "Dismiss"],
    { dedupeKey: `outdated-skills|${target}`, log }
  );
  if (choice === "Upgrade all") {
    await vscode.commands.executeCommand("claudeSkills.upgradeOutdatedSkills");
  } else if (choice === "Show report") {
    await vscode.commands.executeCommand("claudeSkills.showUsageStats");
  }
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

function refreshContextFocusStatusBar() {
  if (!isFeatureEnabled("contextFocus")) {
    contextFocusStatusBarItem.hide();
    return;
  }
  const config = contextFocusFromSettings();
  if (!config.enabled) {
    contextFocusStatusBarItem.text = "$(eye-closed) Focus: off";
    contextFocusStatusBarItem.tooltip =
      "Context focus is disabled. Enable in settings to inject grounding that balances local workspace context vs general LLM knowledge.\n\nClick to cycle focus level.";
    contextFocusStatusBarItem.command = "claudeSkills.cycleContextFocusLevel";
    contextFocusStatusBarItem.show();
    return;
  }
  const label = CONTEXT_FOCUS_LABELS[config.level];
  contextFocusStatusBarItem.text = `$(target) ${label}`;
  contextFocusStatusBarItem.tooltip =
    `Context focus: ${label}. ${config.autoEscalateOnSessionSize ? "Auto-tightens on large sessions." : "Fixed level."}\n\nClick to cycle (Knowledge-forward -> Balanced -> Local-first -> Strict local).`;
  contextFocusStatusBarItem.command = "claudeSkills.cycleContextFocusLevel";
  contextFocusStatusBarItem.show();
}

function refreshPracticalFocusStatusBar() {
  if (!isFeatureEnabled("practicalFocus")) {
    practicalFocusStatusBarItem.hide();
    return;
  }
  const config = practicalFocusFromSettings();
  if (!config.enabled) {
    practicalFocusStatusBarItem.text = "$(light-bulb) Practical: off";
    practicalFocusStatusBarItem.tooltip =
      "Practical/deployment focus is off. Enable to favor concrete architecture and first-try deploy steps over theoretical advice.\n\nClick to enable (starts at Architecture-first).";
    practicalFocusStatusBarItem.command = "claudeSkills.cyclePracticalFocusLevel";
    practicalFocusStatusBarItem.show();
    return;
  }
  const label = PRACTICAL_FOCUS_LABELS[config.level];
  practicalFocusStatusBarItem.text = `$(rocket) ${label}`;
  practicalFocusStatusBarItem.tooltip =
    `Practical focus: ${label}. Favors provisionable architecture over hand-wavy theory.\n\nClick to cycle (Exploratory -> Balanced -> Architecture-first -> Deploy-ready).`;
  practicalFocusStatusBarItem.command = "claudeSkills.cyclePracticalFocusLevel";
  practicalFocusStatusBarItem.show();
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
  const inefficient = computeSkillInefficiencyStats(target, listInstalledSkills(target)).length;

  if (tracked.length === 0 && inefficient === 0) {
    usageStatusBarItem.text = "$(graph) Skill usage: no data";
    usageStatusBarItem.tooltip =
      "No recorded skill runs yet (.claude/learning/runs.jsonl). Use the self-learning skill to start tracking outcomes.\n\nClick for the full report.";
  } else {
    const active = stats.filter((s) => s.rating === "active").length;
    const parts: string[] = [];
    if (tracked.length > 0) {
      parts.push(`${active} active`);
    }
    if (issues > 0) {
      parts.push(`${issues} to review`);
    }
    if (inefficient > 0) {
      parts.push(`${inefficient} inefficient`);
    }
    usageStatusBarItem.text = `$(graph) Skill usage: ${parts.join(", ")}`;
    const cross = computeCrossAgentUsage(stats);
    let tooltip = "Click for the per-skill usage and KPI report.";
    if (cross.activeAgents.length > 1) {
      tooltip += `\nAgents with skill invocations: ${cross.activeAgents.map(runAgentLabel).join(", ")}.`;
    }
    if (cross.multiAgentSkills.length > 0) {
      tooltip += `\n${cross.multiAgentSkills.length} skill(s) used across multiple agents on this workspace.`;
    }
    usageStatusBarItem.tooltip = tooltip;
  }
  usageStatusBarItem.command = "claudeSkills.showUsageStats";
  usageStatusBarItem.show();
}

let lastHighUsageAlertCheckMs = 0;
const HIGH_USAGE_ALERT_INTERVAL_MS = 5 * 60 * 1000;

export function activate(context: vscode.ExtensionContext) {
  const libraryDir = path.join(context.extensionPath, "skills_library");

  outputChannel = vscode.window.createOutputChannel("Claude Skills");
  context.subscriptions.push(outputChannel);

  const provider = new SkillsProvider(libraryDir, getWorkspaceTarget);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBarItem);

  usageStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  context.subscriptions.push(usageStatusBarItem);

  creditStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  context.subscriptions.push(creditStatusBarItem);

  trustStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97.5);
  context.subscriptions.push(trustStatusBarItem);

  budgetModeStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
  context.subscriptions.push(budgetModeStatusBarItem);

  contextFocusStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 96);
  context.subscriptions.push(contextFocusStatusBarItem);

  practicalFocusStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 95);
  context.subscriptions.push(practicalFocusStatusBarItem);

  projectTierStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97.25);
  context.subscriptions.push(projectTierStatusBarItem);

  workspaceFolderStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 94);
  context.subscriptions.push(workspaceFolderStatusBarItem);

  registerSyncStatusBar(context);
  registerUserActivityListeners(context);

  const onUserInteraction = () => {
    markUserInteraction();
    const t = getWorkspaceTarget();
    if (t) {
      ensureWorkspaceCachesWarm(t, libraryDir);
    }
  };

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(() => {
      markTypingActivity();
      onUserInteraction();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => onUserInteraction())
  );

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

  async function applyProposalSkillNames(target: string, names: string[]): Promise<string[]> {
    const result = applyProposedSkillsLocally(libraryDir, target, names);
    if (result.installed.length > 0 || result.overridesApplied > 0) {
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, {
        saveBranchProfile: true,
        forceAgentSync: true,
      });
    }
    return result.installed;
  }

  function scheduleHighUsageSkillProposalCheck(target: string): void {
    const now = Date.now();
    if (now - lastHighUsageAlertCheckMs < HIGH_USAGE_ALERT_INTERVAL_MS) {
      return;
    }
    lastHighUsageAlertCheckMs = now;
    void maybePromptHighUsageSkillProposals(target, libraryDir, (names) => applyProposalSkillNames(target, names));
  }

  let lastWorkspaceStateAt = 0;
  let lastProjectProfileLogged: string | undefined;
  let lastProjectProfileNotified: string | undefined;

  const refreshAllImpl = (opts: { workspaceState: boolean; forceTree: boolean }) => {
    const target = getWorkspaceTarget();
    setPricingContext(target);
    const {
      profile: projectProfile,
      changed: projectProfileChanged,
      tierChanged: projectProfileTierChanged,
      isFirstDetect: projectProfileFirstDetect,
    } = refreshProjectProfileContext(target);
    if (projectProfile) {
      refreshProjectTierStatusBar(target);
      if (opts.workspaceState) {
        const profileLogKey = `${target}|${projectProfile.profileType}`;
        if (profileLogKey !== lastProjectProfileLogged) {
          lastProjectProfileLogged = profileLogKey;
          log(`Project profile: ${PROFILE_TYPE_LABELS[projectProfile.profileType]} — ${projectProfile.rationale}`);
        }
        const notifyTierChange = (profile: typeof projectProfile) => {
          if (effectiveLockedTier(readProjectProfile(target!), target)) {
            log(`Project profile tier: ${PROFILE_TYPE_LABELS[profile.profileType]} (locked — notification suppressed).`);
            return;
          }
          const key = `${target}|${profile.profileType}`;
          if (key === lastProjectProfileNotified) {
            return;
          }
          lastProjectProfileNotified = key;
          void notifySuggestion(formatProjectProfileNotifyMessage(profile), ["View details", "Change tier"], {
            dedupeKey: `tier|${key}`,
            log,
          }).then((pick) => {
            if (pick === "View details") {
              void vscode.commands.executeCommand("claudeSkills.showProjectProfile");
            } else if (pick === "Change tier") {
              void vscode.commands.executeCommand("claudeSkills.chooseProjectProfile");
            }
          });
        };
        if (projectProfileChanged && projectProfileFirstDetect && target) {
          void maybePromptProjectTierOnFirstDetect(context, target, true).then((finalProfile) => {
            refreshProjectTierStatusBar(target);
            const initialType = projectProfile.profileType;
            const tierChangedByUser = finalProfile.profileType !== initialType;
            const explicitPlan =
              finalProfile.userPlan !== undefined && finalProfile.userPlan !== "accept-detected";
            if (tierChangedByUser || explicitPlan) {
              lastProjectProfileLogged = `${target}|${finalProfile.profileType}`;
              log(`Project profile: user chose ${PROFILE_TYPE_LABELS[finalProfile.profileType]}`);
              notifyTierChange(finalProfile);
            }
            refreshAllImpl({ workspaceState: false, forceTree: false });
          });
        } else if (projectProfileChanged && projectProfileTierChanged) {
          notifyTierChange(projectProfile);
        }
      }
    } else {
      refreshProjectTierStatusBar(undefined);
    }
    if (integrationTestMode()) {
      provider.refresh();
      return;
    }
    if (target && isFeatureEnabled("attributionCollector")) {
      AttributionCollector.setActiveTarget(target, libraryDir);
    }
    syncBranchProfileContext(target);
    if (refreshScheduler.isTreeVisible() || opts.forceTree) {
      provider.refresh();
    }
    refreshStatusBar(libraryDir);
    refreshUsageStatusBar(libraryDir);
    refreshCreditStatusBar(libraryDir, target);
    refreshTrustStatusBar(libraryDir, target);
    refreshBudgetModeStatusBar(libraryDir);
    refreshContextFocusStatusBar();
    refreshPracticalFocusStatusBar();
    refreshProjectTierStatusBar(target);
    refreshWorkspaceFolderStatusBar();
    if (target && opts.workspaceState && shouldSyncWorkspaceToAll() && agentMirrorsNeedSync(target, libraryDir)) {
      const synced = syncWorkspaceSkillsToAllAgents(libraryDir, target);
      if (synced.length > 0) {
        log(`Auto-synced ${synced.length} skill mirror(s) to cursor/kiro/copilot.`);
      }
    }
    if (!target) {
      return;
    }

    if (isFeatureEnabled("costIntelligence") || isFeatureEnabled("attributionCollector")) {
      scheduleCostPipelineSync(target, libraryDir);
    }
    if (isFeatureEnabled("budgetControls")) {
      void checkEmergencyCutoff(target, libraryDir);
    }
    if (autoInstallAttributionHooksEnabled() && !areAttributionHooksConfigured(target, context.extensionPath)) {
      ensureAttributionHooksActive(context.extensionPath, target, log);
    }

    if (!shouldRunWorkspaceState(lastWorkspaceStateAt, { workspaceState: opts.workspaceState })) {
      return;
    }
    lastWorkspaceStateAt = Date.now();

    if (profileInitEnabled()) {
      try {
        refreshSkillsCatalog(target, libraryDir);
        if (profileInitRequestPending(target)) {
          if (maybeApplyDeterministicProfileInit(libraryDir, target)) {
            propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, {
              saveBranchProfile: true,
              forceAgentSync: true,
            });
          } else {
            ensureProfileInitSessionReady(context.extensionPath, libraryDir, target, log);
          }
        }
      } catch (err) {
        log(`Skill catalog refresh failed: ${(err as Error).message}`);
      }
    }
    if (isFeatureEnabled("deterministicTaskProposals")) {
      const manifest = loadManifest(libraryDir);
      const proposalRefresh = ensureWorkspaceTaskProposals(target, manifest);
        if (proposalRefresh.refreshed) {
          log(`Task proposals refreshed locally (${proposalRefresh.file?.proposals.length ?? 0} skills).`);
        }
      }
      const focusApply = applyTaskSkillFocusFromProposals(libraryDir, target);
      if (focusApply.applied && focusApply.focus) {
        log(
          `Task skill focus: ${focusApply.focus.activeSkills.length} active, ${focusApply.focus.ignoredSkills.length} ignored for this task.`
        );
      }
      scheduleHighUsageSkillProposalCheck(target);
    syncCliConfigToWorkspace(target, libraryDir);
    const sessionApply = processSessionSkillApplyRequest(libraryDir, target);
    if (sessionApply.applied && sessionApply.result && sessionApply.request) {
      const { result, request } = sessionApply;
      if (result.installed.length > 0 || result.overridesApplied > 0) {
        log(
          `\n=== Session skill apply (${request.source}) ===\n` +
            `+${result.installed.length} installed, ${result.overridesApplied} enabled locally` +
            (result.installed.length ? `: ${result.installed.join(", ")}` : "")
        );
        propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, {
          saveBranchProfile: true,
          forceAgentSync: true,
        });
      }
    }
    const taskApply = applyTaskProposalsIfPending(libraryDir, target);
    if (taskApply.applied && taskApply.result) {
      const { result } = taskApply;
      if (result.installed.length > 0 || result.overridesApplied > 0) {
        log(
          `\n=== Task proposals auto-apply (local workspace) ===\n` +
            `+${result.installed.length} installed, ${result.overridesApplied} enabled locally` +
            (result.installed.length ? `: ${result.installed.join(", ")}` : "")
        );
        propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, {
          saveBranchProfile: true,
          forceAgentSync: true,
        });
        notifyBackground(
          `Task proposals auto-applied (${result.installed.length} installed, ${result.overridesApplied} enabled).`,
          log
        );
      }
    }
    void maybePromptOutdatedSkillUpgrades(libraryDir, target);
  };

  const refreshScheduler = createRefreshScheduler(refreshAllImpl);

  const refreshLight = () => {
    refreshScheduler.schedule({});
  };

  const refreshAll = (opts?: { workspaceState?: boolean; forceTree?: boolean }) => {
    refreshScheduler.schedule({
      workspaceState: opts?.workspaceState ?? true,
      forceTree: opts?.forceTree ?? true,
    });
  };

  const treeView = vscode.window.createTreeView("claudeSkillsView", {
    treeDataProvider: provider,
  });
  context.subscriptions.push(
    treeView,
    treeView.onDidChangeVisibility((e) => {
      refreshScheduler.setTreeVisible(e.visible);
      if (e.visible) {
        refreshAll({ forceTree: true, workspaceState: false });
      }
    }),
    treeView.onDidChangeCheckboxState(async (e) => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        refreshLight();
        return;
      }
      const tToggle = performance.now();
      markClick();
      ensureWorkspaceCachesWarm(target, libraryDir);
      markPreToggleFingerprint(target);
      const toggled: string[] = [];
      for (const [item, state] of e.items) {
        if (!(item instanceof SkillItem)) {
          continue;
        }
        const name = item.status.name;
        const enabled = state === vscode.TreeItemCheckboxState.Checked;
        provider.setOptimisticEnabled(name, enabled);
        toggled.push(name);
        const sourceRoot = item.status.availableInGlobal ? globalSkillsDir() : libraryDir;
        if (enabled) {
          ensureLearningDir(target);
          const action = enableWorkspaceSkill(target, name, sourceRoot, libraryDir);
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
      }
      recordPerf("toggle-ui", performance.now() - tToggle, { skills: toggled.length });
      if (toggled.length > 0) {
        for (const name of toggled) {
          provider.setSkillSyncing(name, true);
        }
        invalidateWorkspaceSyncFingerprint(target);
        propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, {
          saveBranchProfile: true,
          userTriggered: true,
          skillNames: toggled,
          showFeedback: true,
          onComplete: () => {
            for (const name of toggled) {
              provider.setSkillSyncing(name, false);
              provider.flashSkillSynced(name);
              provider.clearOptimistic(name);
            }
            refreshLight();
          },
        });
      }
    })
  );

  registerWorkspaceTargetListeners(() => refreshAll(), context);

  applyBudgetSettings(libraryDir, false);
  if (isFeatureEnabled("contextFocus")) {
    syncContextFocusConfigToDisk();
  }
  if (isFeatureEnabled("practicalFocus")) {
    syncPracticalFocusConfigToDisk();
  }
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

  refreshLight();

  if (initialTarget && !integrationTestMode()) {
    setTimeout(() => {
      warmupWorkspaceCaches(initialTarget, libraryDir);
    }, 1000);
    setTimeout(() => {
      propagateWorkspaceSkillChange(context.extensionPath, initialTarget, libraryDir, log, {
        saveBranchProfile: false,
      });
    }, 3000);
    void maybeNotifyOfficialSkillUpdates(initialTarget);
  }

  if (initialTarget && !integrationTestMode()) {
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
        void runAutoOptimizePass(initialTarget, libraryDir);
      }, 30 * 60 * 1000);
      context.subscriptions.push({ dispose: () => clearInterval(autoOptTimer) });
    }
    if (isFeatureEnabled("predictiveAlerts")) {
      setTimeout(() => {
        const target = getWorkspaceTarget();
        if (target) {
          void checkPredictiveCostAlert(target, libraryDir);
        }
      }, 8000);
    }
    if (isFeatureEnabled("communityBenchmarks")) {
      void syncCommunityBenchmarks();
    }
    startWeeklyReportScheduler(context, getWorkspaceTarget, libraryDir, log);
    startSkillSetResolverScheduler(context, getWorkspaceTarget, libraryDir, log, refreshAll, () => {
      const target = getWorkspaceTarget();
      if (target) {
        propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, { forceAgentSync: true });
      }
    });
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeSkills.budget")) {
        applyBudgetSettings(libraryDir, false);
        refreshAll();
      }
      if (e.affectsConfiguration("claudeSkills.skillFeedback")) {
        lastHighUsageAlertCheckMs = 0;
        refreshAll();
      }
      if (e.affectsConfiguration("claudeSkills.contextFocus") && isFeatureEnabled("contextFocus")) {
        syncContextFocusConfigToDisk();
        refreshAll();
      }
      if (e.affectsConfiguration("claudeSkills.practicalFocus") && isFeatureEnabled("practicalFocus")) {
        syncPracticalFocusConfigToDisk();
        refreshAll();
      }
      if (e.affectsConfiguration("claudeSkills.features")) {
        if (e.affectsConfiguration("claudeSkills.features.contextFocus")) {
          syncContextFocusConfigToDisk();
        }
        if (e.affectsConfiguration("claudeSkills.features.practicalFocus")) {
          syncPracticalFocusConfigToDisk();
        }
        refreshAll();
      }
      if (e.affectsConfiguration("claudeSkills.projectProfile")) {
        const target = getWorkspaceTarget();
        if (target) {
          refreshProjectProfileContext(target);
        }
        refreshAll();
      }
    })
  );

  context.subscriptions.push(
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

    vscode.commands.registerCommand("claudeSkills.installLibraryToGlobal", async () => {
      const syncAll = shouldSyncGlobalToAll();
      maybeRevealOutputPanel();
      if (syncAll) {
        const results = installLibraryToAllAgents(libraryDir, false, false);
        log(`\n=== Install skill library -> all enabled agents ===`);
        log(formatAgentInstallSummary(results));
        const installed = results.filter((r) => r.status === "installed" || r.status === "written").length;
        void notifyUserSuccess(
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
        void notifyUserSuccess(
          `Claude Skills: installed ${installed}, skipped ${skipped} (already present) -- see "Claude Skills" output for details.`
        );
      }
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.installLibraryToAllAgents", async () => {
      const results = installLibraryToAllAgents(libraryDir, false, false);
      maybeRevealOutputPanel();
      log(`\n=== Install skill library -> all enabled agents ===`);
      log(formatAgentInstallSummary(results));
      const installed = results.filter((r) => r.status === "installed" || r.status === "written").length;
      void notifyUserSuccess(
        `Claude Skills: installed ${installed} skill(s) across enabled agents.`
      );
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.generateForWorkspace", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      ensureLearningDir(target);
      maybeRevealOutputPanel();
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
      void notifyUserSuccess(
        `Claude Skills: installed ${installed} skill(s) for this workspace -- see "Claude Skills" output for details.`
      );
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, { forceAgentSync: true });
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.generateAllForWorkspace", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      ensureLearningDir(target);
      maybeRevealOutputPanel();
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
      void notifyUserSuccess(
        `Claude Skills: installed ${installed} skill(s) (full library) -- see "Claude Skills" output for details.`
      );
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, { forceAgentSync: true });
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.previewForWorkspace", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const results = generateForWorkspace(libraryDir, target, {
        all: false,
        force: false,
        dryRun: true,
      });
      revealOutputPanel();
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
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
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
        maybeRevealOutputPanel();
        const results = installSkillToAllWorkspaceAgents(libraryDir, target, skillName, sourceRoot, force, false);
        log(`\n=== Install ${skillName} -> all enabled agents ===`);
        log(formatAgentInstallSummary(results));
        const installed = results.filter((r) => r.status === "installed" || r.status === "written").length;
        void notifyUserSuccess(`Claude Skills: ${skillName} installed to ${installed} agent path(s).`);
      } else {
        const destRoot = path.join(target, ".claude", "skills");
        let status = copySkill(skillName, sourceRoot, destRoot, false, false, { libraryDir });
        if (status === "skipped-exists") {
          const choice = await vscode.window.showWarningMessage(
            `${skillName} is already installed in this workspace. Overwrite?`,
            "Overwrite",
            "Cancel"
          );
          if (choice !== "Overwrite") {
            return;
          }
          status = copySkill(skillName, sourceRoot, destRoot, true, false, { libraryDir });
        }
        ensureLearningDir(target);
        maybeRevealOutputPanel();
        log(`\n=== Install ${skillName} -> ${destRoot} ===`);
        log(`${skillName}: ${status} (from ${sourceRoot})`);
        void notifyUserSuccess(`Claude Skills: ${skillName} -> ${status}`);
      }
      try {
        propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, { forceAgentSync: true });
      } catch (err) {
        const msg = (err as Error).message;
        log(`Workspace sync warning (hooks/mirrors): ${msg}`);
        vscode.window.showWarningMessage(
          `Claude Skills: ${skillName} installed, but hook sync hit a file lock. Reload the window and retry if needed.`
        );
      }
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.disableSkillLocally", async (item?: SkillItem) => {
      const target = getWorkspaceTarget();
      if (!target || !item) {
        return;
      }
      setSkillOverride(target, item.status.name, "off");
      log(`${item.status.name}: disabled locally (.claude/settings.local.json) - shared .claude/skills/ unchanged`);
      invalidateWorkspaceSyncFingerprint(target);
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, {
        userTriggered: true,
        skillNames: [item.status.name],
      });
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
      invalidateWorkspaceSyncFingerprint(target);
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, {
        userTriggered: true,
        skillNames: [item.status.name],
      });
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
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      ensureLearningDir(target);
      const manifest = loadManifest(libraryDir);
      const mirrored = mirrorLearningArtifacts(target, libraryDir);
      await AttributionCollector.getInstance(target, libraryDir).collect(true);
      persistCostAttribution(target, libraryDir);
      const built = buildCostAttribution(target, libraryDir);
      const { attribution } = resolveDisplayAttribution(built, target);
      const health = assessAttributionHealth(target, libraryDir);
      const stats = enrichUsageStatsWithAttribution(readSkillStatsIndex(target, manifest), attribution);
      const suggested = computeSuggestedSkills(target, manifest);
      const installedNames = listInstalledSkills(target);
      const inefficiency = computeSkillInefficiencyStats(target, installedNames);
      const savedProposals = readTaskSkillProposals(target);
      const taskProposals = resolveTaskSkillProposals(target, manifest);
      const creditUsage = computeEnabledAgentsCreditUsage(libraryDir, 14, target);
      const skillConfidence = buildUsageSkillConfidenceMap(
        target,
        stats.map((s) => s.name)
      );
      const hookStatus = getWorkspaceHookStatus(target, libraryDir);
      const globalTrust = buildGlobalTrustBadge(health, hookStatus);
      const versionStatuses = listSkillVersionStatuses(libraryDir, target);
      const reportOpts = {
        skillConfidence,
        workspaceConfidence: {
          score: health.confidenceScore,
          level: health.confidenceLevel,
          summary: health.summary,
          v2Coverage: 0,
        },
        globalTrust,
        versionStatuses,
        manifest,
        inefficiency,
        taskProposals,
        taskSummary: savedProposals?.taskSummary,
      };

      revealOutputPanel();
      log(`\n=== Skill usage report for ${target} ===`);
      log(formatUsageReport(stats, suggested, target, creditUsage, reportOpts));
      log(
        formatAttributionReport(
          built.skills,
          built.agentTotals,
          built.base_context,
          built.transcriptSkills,
          built.unattributed,
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
        const agent = getOptimalAgent(topSkill.name, attribution);
        log(formatRoutingSuggestion(topSkill.name, attribution, agent));
      }
      if (mirrored.length > 0) {
        log(`\nMirrored learning artifacts to: ${mirrored.join(", ")}`);
      }
      log("\n## Enabled AI agents\n");
      log(agentCapabilityLines(libraryDir).join("\n"));
      log("\n## Workspace hooks\n");
      log(formatHookStatusPlain(getWorkspaceHookStatus(target, libraryDir)));

      const html = formatUsageReportHtml(
        stats,
        suggested,
        target,
        creditUsage,
        hookStatus,
        reportOpts
      );
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

    vscode.commands.registerCommand("claudeSkills.applyTaskSkillProposals", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const manifest = loadManifest(libraryDir);
      const proposals = resolveTaskSkillProposals(target, manifest);
      const toInstall = proposals.filter((p) => !p.installed);
      if (toInstall.length === 0) {
        void notifyUserSuccess(
          "Claude Skills: no uninstalled suggested skills — run skill-feedback-adaptation on a new task first."
        );
        return;
      }
      const installed = await applyProposalSkillNames(
        target,
        proposals.map((p) => p.name)
      );
      refreshAll();
      if (installed.length > 0) {
        void notifyUserSuccess(
          `Claude Skills: installed ${installed.length} suggested skill(s): ${installed.join(", ")}.`
        );
      } else {
        void notifyUserSuccess("Claude Skills: could not install suggested skills.");
      }
    }),

    vscode.commands.registerCommand("claudeSkills.upgradeOutdatedSkills", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const outdated = listOutdatedSkills(libraryDir, target);
      if (outdated.length === 0) {
        void notifyUserSuccess("Claude Skills: all installed skills match the library catalog version.");
        return;
      }
      const upgraded = await upgradeOutdatedSkills(libraryDir, target);
      if (upgraded.length > 0) {
        propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, {
          saveBranchProfile: true,
          forceAgentSync: true,
        });
        refreshAll();
        void notifyUserSuccess(
          `Claude Skills: upgraded ${upgraded.length} skill(s): ${upgraded.join(", ")}.`
        );
      } else {
        void notifyUserSuccess("Claude Skills: no skills were upgraded (cancelled or missing from library).");
      }
    }),

    vscode.commands.registerCommand("claudeSkills.installSessionWatchHook", async () => {
      await vscode.commands.executeCommand("claudeSkills.installCostControlHooks");
    }),

    vscode.commands.registerCommand("claudeSkills.installAttributionHooks", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      try {
        const status = installAttributionHooks(context.extensionPath, target);
        maybeRevealOutputPanel();
        log(`\n=== Attribution v2 hooks (PostToolUse Skill|Read) -> ${target} ===`);
        log(status);
        void notifyUserSuccess(`Claude Skills: attribution hooks ${status}.`);
      } catch (err) {
        recordError();
        vscode.window.showWarningMessage(`Claude Skills: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("claudeSkills.installCostControlHooks", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      try {
        applyBudgetSettings(libraryDir, true);
        if (isFeatureEnabled("contextFocus")) {
          syncContextFocusConfigToDisk();
        }
        if (isFeatureEnabled("practicalFocus")) {
          syncPracticalFocusConfigToDisk();
        }
        const status = installCostControlHooks(context.extensionPath, target);
        maybeRevealOutputPanel();
        log(`\n=== Cost control hooks -> ${target} ===`);
        log(status);
        log(`Budget config synced to ~/.claude/learning/budget.json`);
        if (isFeatureEnabled("contextFocus")) {
          log(`Context focus config synced to ~/.claude/learning/context-focus.json`);
        }
        if (isFeatureEnabled("practicalFocus")) {
          log(`Practical focus config synced to ~/.claude/learning/practical-focus.json`);
        }
        if (status === "installed") {
          void notifyUserSuccess(
            "Claude Skills: cost control hooks enabled (session size, budget, context focus, practical focus) for this workspace."
          );
        } else if (status === "updated") {
          void notifyUserSuccess("Claude Skills: cost control hooks updated for this workspace.");
        } else {
          void notifyUserSuccess("Claude Skills: cost control hooks were already enabled (files refreshed).");
        }
      } catch (err) {
        recordError();
        vscode.window.showWarningMessage(`Claude Skills: could not enable cost control hooks - ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("claudeSkills.installOfficialSkillsSessionHook", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      try {
        const status = installOfficialSkillsSessionHook(context.extensionPath, target);
        maybeRevealOutputPanel();
        log(`\n=== Official skills SessionStart hook -> ${target} ===`);
        log(status);
        void notifyUserSuccess(`Claude Skills: official skills session hook ${status}.`);
      } catch (err) {
        recordError();
        vscode.window.showWarningMessage(`Claude Skills: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("claudeSkills.checkOfficialSkillUpdates", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const libraryDir = resolveSkillsLibraryDir(target);
      if (!libraryDir) {
        vscode.window.showWarningMessage(
          "Claude Skills: no skills_library/ found in this workspace (official updater targets the library folder)."
        );
        return;
      }
      try {
        const result = await checkOfficialSkillUpdates(libraryDir);
        maybeRevealOutputPanel();
        log(`\n=== Official Anthropic skills check -> ${libraryDir} ===`);
        if (result.checkError) {
          log(result.checkError);
          vscode.window.showWarningMessage(`Claude Skills: ${result.checkError}`);
          return;
        }
        if (result.unchanged) {
          log(`Up to date (HEAD ${result.remoteSha?.slice(0, 12) ?? "unknown"}).`);
          void notifyUserSuccess("Claude Skills: official Anthropic skills are up to date.");
          return;
        }
        const sessionContext = formatOfficialSkillsSessionContext(result);
        log(sessionContext);
        log("\nIn Claude Code, ask the agent to follow skill-official-updater to pull selected skills.");
        installOfficialSkillsSessionHook(context.extensionPath, target);
        void notifySuggestion(
          "Official skill updates available — see output. Ask Claude Code to run skill-official-updater.",
          ["Open Output"],
          { log }
        ).then((sel) => {
          if (sel === "Open Output") {
            revealOutputPanel();
          }
        });
      } catch (err) {
        recordError();
        vscode.window.showWarningMessage(`Claude Skills: ${(err as Error).message}`);
      }
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

    vscode.commands.registerCommand("claudeSkills.saveBranchProfile", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const profile = saveBranchProfile(target, libraryDir);
      maybeRevealOutputPanel();
      if (!profile) {
        log("\n=== Save branch profile ===\nNot a git repo or branch profiles disabled.");
        vscode.window.showWarningMessage("Claude Skills: could not save branch profile (git branch required).");
        return;
      }
      log(`\n=== Save branch profile -> ${profile.branch} ===`);
      log(`${profile.skills.length} skill(s), ${Object.keys(profile.skillOverrides).length} override(s)`);
      maybeSaveHostAgentSetWithBranchProfile(target);
      void notifyUserSuccess(
        `Claude Skills: saved skill profile for branch "${profile.branch}" (${profile.skills.length} skills).`
      );
    }),

    vscode.commands.registerCommand("claudeSkills.saveAgentSkillSet", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const agent = detectHostAgentId();
      const saved = saveAgentSkillSet(target, agent);
      maybeRevealOutputPanel();
      if (!saved) {
        log("\n=== Save IDE skill set ===\nGit branch required or agent profiles disabled.");
        vscode.window.showWarningMessage("Claude Skills: could not save IDE skill set.");
        return;
      }
      log(`\n=== Save IDE skill set -> ${hostAgentLabel(agent)} (${saved.branch}) ===`);
      log(`${saved.skills.length} skill(s), ${Object.keys(saved.skillOverrides).length} override(s)`);
      void notifyUserSuccess(
        `Claude Skills: saved ${hostAgentLabel(agent)} skill set for "${saved.branch}" (${saved.skills.length} skills).`
      );
    }),

    vscode.commands.registerCommand("claudeSkills.switchAgentSkillSet", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const result = await promptSwitchAgentSkillSet(libraryDir, target, log);
      if (!result) {
        return;
      }
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, {
        saveBranchProfile: false,
      });
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.showAgentSkillSets", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        return;
      }
      revealOutputPanel();
      log(`\n=== IDE / agent skill sets ===\n${formatAgentSkillSetsReport(target)}`);
    }),

    vscode.commands.registerCommand("claudeSkills.exportTeamBranchProfile", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const profile = exportTeamBranchProfile(target, libraryDir);
      if (!profile) {
        vscode.window.showWarningMessage("Claude Skills: not on a git branch or could not capture profile.");
        return;
      }
      maybeRevealOutputPanel();
      log(`\n=== Export team branch profile ===\n${formatTeamProfileReport(target)}`);
      void notifyUserSuccess(
        `Claude Skills: wrote team profile (.claude/skills-profile.json) — commit to git.`
      );
    }),

    vscode.commands.registerCommand("claudeSkills.applyTeamBranchProfile", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const result = applyTeamBranchProfile(libraryDir, target);
      if (!result) {
        vscode.window.showWarningMessage("Claude Skills: no team profile entry for this branch.");
        return;
      }
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, { forceAgentSync: true });
      refreshAll();
      void notifyUserSuccess(
        `Claude Skills: applied team profile (+${result.installed.length}, -${result.removed.length}).`
      );
    }),

    vscode.commands.registerCommand("claudeSkills.showTeamBranchProfiles", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        return;
      }
      revealOutputPanel();
      log(`\n=== Team branch profiles (git) ===\n${formatTeamProfileReport(target)}`);
    }),

    vscode.commands.registerCommand("claudeSkills.setPosition", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const position = await promptForPosition(target);
      if (position) {
        void notifyUserSuccess(`Claude Skills: position saved as ${position.label} (local only).`);
      }
    }),

    vscode.commands.registerCommand("claudeSkills.refreshSkillCatalog", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const catalog = refreshSkillsCatalog(target, libraryDir);
      maybeRevealOutputPanel();
      log(`\n=== Skill catalog refreshed ===\n${catalog.skills.length} skill(s) -> .claude/learning/skills-catalog.json`);
      void notifyUserSuccess(
        `Claude Skills: refreshed skill catalog (${catalog.skills.length} skills).`
      );
    }),

    vscode.commands.registerCommand("claudeSkills.initProfile", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const branch = getCurrentBranch(target);
      if (!branch) {
        vscode.window.showWarningMessage("Claude Skills: init profile requires a git branch.");
        return;
      }
      maybeRevealOutputPanel();
      await startProfileInitFlow(context.extensionPath, libraryDir, target, branch, log);
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, {
        saveBranchProfile: false,
      });
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.prepareForClaudeCli", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      try {
        const result = await prepareForClaudeCli(context.extensionPath, libraryDir, target);
        maybeRevealOutputPanel();
        const summary = formatPrepareClaudeCliSummary(result);
        log(`\n=== Prepare for Claude CLI ===\n${summary}`);
        void notifyUserSuccess(
          "Claude Skills: workspace ready for Claude CLI — you can close the IDE and use `claude` in the terminal."
        );
        refreshAll();
      } catch (err) {
        recordError();
        vscode.window.showWarningMessage(`Claude Skills: prepare for Claude CLI failed — ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("claudeSkills.applyLocalProfile", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const { result, init, invalid, hostAgentSkillSet } = applyLocalProfileInit(libraryDir, target);
      if (!init || !result) {
        const pending = readUserPosition(target);
        vscode.window.showWarningMessage(
          pending
            ? "Claude Skills: no pending profile.local.json with skills to apply."
            : "Claude Skills: write .claude/profile.local.json first (use profile-init skill)."
        );
        return;
      }
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, { forceAgentSync: true });
      refreshAll();
      maybeRevealOutputPanel();
      log(
        `\n=== Applied local profile ===\nBranch: ${init.branch}, role: ${init.roleLabel}\n` +
          `Installed: ${result.installed.join(", ") || "(none)"}\n` +
          (hostAgentSkillSet
            ? `IDE skill set (${hostAgentLabel(hostAgentSkillSet.agent)}): ${hostAgentSkillSet.skills.length} skill(s) saved.\n`
            : "") +
          (invalid.length ? `Skipped unknown: ${invalid.join(", ")}\n` : "")
      );
      void notifyUserSuccess(
        `Claude Skills: applied profile for ${init.branch} (+${result.installed.length} skill(s)).`
      );
    }),

    vscode.commands.registerCommand("claudeSkills.applyBranchProfile", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
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
      maybeRevealOutputPanel();
      log(`\n=== Apply branch profile -> ${branch} ===`);
      log(`Installed: ${result.installed.join(", ") || "(none)"}`);
      log(`Removed: ${result.removed.join(", ") || "(none)"}`);
      log(`Overrides applied: ${result.overridesApplied}`);
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, { forceAgentSync: true });
      refreshAll();
      void notifyUserSuccess(
        `Claude Skills: applied "${branch}" profile (+${result.installed.length}, -${result.removed.length}).`
      );
    }),

    vscode.commands.registerCommand("claudeSkills.showAgentCapabilities", async () => {
      revealOutputPanel();
      log("\n=== Enabled AI agent targets ===");
      log(agentCapabilityLines(libraryDir).join("\n"));
      log("\nConfigure via Settings -> claudeSkills.agents.enabled");
      log("Agent paths defined in skills_library/agents.json");
    }),

    vscode.commands.registerCommand("claudeSkills.syncWorkspaceToAgents", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      if (!shouldSyncWorkspaceToAll()) {
        vscode.window.showWarningMessage(
          "Claude Skills: enable claudeSkills.features.multiAgent and claudeSkills.agents.syncWorkspaceToAll."
        );
        return;
      }
      maybeRevealOutputPanel();
      log("\n=== Sync workspace skills to all enabled agents ===");
      const { agentPathsUpdated } = propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, {
        forceAgentSync: true,
        saveBranchProfile: false,
      });
      void notifyUserSuccess(
        `Claude Skills: synced workspace skills to ${agentPathsUpdated} agent path(s) — see output.`
      );
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.showBranchProfiles", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      if (!branchProfilesFeatureActive()) {
        vscode.window.showWarningMessage("Claude Skills: branch profiles are disabled in feature toggles.");
        return;
      }
      const report = formatBranchProfilesReport(target);
      revealOutputPanel();
      log(`\n=== Branch skill profiles ===`);
      log(report);
      const preview = report.split("\n").slice(0, 6).join("\n");
      void notifySuggestion(
        preview.length > 120 ? `${preview.slice(0, 117)}...` : preview,
        ["Open Output"],
        { log }
      ).then((choice) => {
        if (choice === "Open Output") {
          revealOutputPanel();
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
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      ensureLearningDir(target);
      const pipeline = await runCostPipeline(target, libraryDir, {
        collect: isFeatureEnabled("attributionCollector"),
        forceCollect: true,
      });
      persistCostAttribution(target, libraryDir);
      const built = buildCostAttribution(target, libraryDir);
      const merged = { ...built.skills, ...built.transcriptSkills };
      updateLocalBenchmarks(merged);
      void uploadAnonymizedStats(merged);
      const dashboardNonce = crypto.randomBytes(16).toString("base64");
      const hadMainSnapshot = Boolean(tryReadValidDashboardSnapshot(target, pipeline));
      const html = formatCostDashboardHtml(target, libraryDir, dashboardNonce, pipeline, {
        fastPhase: true,
        includeTeamEconomics: false,
      });
      if (!costDashboardPanel) {
        costDashboardPanel = vscode.window.createWebviewPanel(
          "claudeSkillsCostDashboard",
          "Claude Skills Cost Intelligence",
          vscode.ViewColumn.Active,
          { enableScripts: true, retainContextWhenHidden: true }
        );
        costDashboardMessageSub?.dispose();
        costDashboardMessageSub = costDashboardPanel.webview.onDidReceiveMessage(
          async (msg: { command?: string; skill?: string; type?: string }) => {
            const ws = getWorkspaceTarget();
            if (!ws) {
              return;
            }
            if (msg.command === "applyOptimizations") {
              const health = assessAttributionHealth(ws, libraryDir);
              const modeCtx = buildSystemModeContext(health, ws, readPipelineCycle(ws));
              if (!modeCtx.canApplyOptimizations) {
                vscode.window.showWarningMessage(
                  modeCtx.banner ?? "Claude Skills: optimizations paused until attribution pipeline is ready."
                );
                return;
              }
              await vscode.commands.executeCommand("claudeSkills.applyOptimizations");
            } else if (msg.command === "applySuggestion" && msg.skill && msg.type) {
              const health = assessAttributionHealth(ws, libraryDir);
              const modeCtx = buildSystemModeContext(health, ws, readPipelineCycle(ws));
              if (!modeCtx.canApplyOptimizations) {
                vscode.window.showWarningMessage(
                  modeCtx.banner ?? "Claude Skills: optimizations paused until attribution pipeline is ready."
                );
                return;
              }
              const result = await applySingleOptimizationSuggestion(
                ws,
                libraryDir,
                msg.skill,
                msg.type as OptimizationType
              );
              if (result.applied.length > 0) {
                propagateWorkspaceSkillChange(context.extensionPath, ws, libraryDir, log);
                refreshAll();
                const refreshNonce = crypto.randomBytes(16).toString("base64");
                const refreshPipeline = runCostPipelineSync(ws, libraryDir);
                const hadSnap = Boolean(tryReadValidDashboardSnapshot(ws, refreshPipeline));
                costDashboardPanel!.webview.html = formatCostDashboardHtml(
                  ws,
                  libraryDir,
                  refreshNonce,
                  refreshPipeline,
                  { fastPhase: true, includeTeamEconomics: false }
                );
                void enhanceCostDashboardPanel(ws, libraryDir, refreshPipeline, costDashboardPanel!, hadSnap);
                void notifyUserSuccess(`Claude Skills: ${result.applied[0]}`);
              } else {
                vscode.window.showWarningMessage(`Claude Skills: could not apply suggestion for ${msg.skill}.`);
              }
            } else if (msg.command === "exportReport") {
              await vscode.commands.executeCommand("claudeSkills.exportCostReport");
            } else if (msg.command === "openBudget") {
              await vscode.commands.executeCommand("claudeSkills.openBudgetSettings");
            }
          }
        );
        costDashboardPanel.onDidDispose(() => {
          costDashboardMessageSub?.dispose();
          costDashboardMessageSub = undefined;
          costDashboardPanel = undefined;
        });
      }
      costDashboardPanel.webview.html = html;
      costDashboardPanel.reveal(vscode.ViewColumn.Active);
      void enhanceCostDashboardPanel(target, libraryDir, pipeline, costDashboardPanel, hadMainSnapshot);
      log(`\n${formatCostDashboardText(target, libraryDir)}`);
    }),

    vscode.commands.registerCommand("claudeSkills.showOptimizationSuggestions", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const suggestions = generateOptimizationSuggestions(target, libraryDir);
      revealOutputPanel();
      log("\n=== Cost optimization suggestions ===");
      log(formatSuggestionsReport(suggestions).join("\n"));
      if (suggestions.length === 0) {
        void notifyUserSuccess("Claude Skills: no optimization suggestions yet.");
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
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const health = assessAttributionHealth(target, libraryDir);
      const modeCtx = buildSystemModeContext(health, target, readPipelineCycle(target));
      if (!modeCtx.canApplyOptimizations) {
        vscode.window.showWarningMessage(
          modeCtx.banner ?? `Claude Skills: ${health.summary}`
        );
        return;
      }
      const suggestions = generateOptimizationSuggestions(target, libraryDir);
      const result = await applyOptimizationSuggestions(target, libraryDir, suggestions);
      maybeRevealOutputPanel();
      log("\n=== Apply optimizations ===");
      log(result.applied.join("\n") || "(none applied)");
      if (result.skipped.length > 0) {
        log(`Skipped: ${result.skipped.join(", ")}`);
      }
      refreshAll();
      void notifyUserSuccess(
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
        void notifyUserSuccess(`Cost report saved to ${uri.fsPath}`, log);
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
      refreshAll();
      maybeRevealOutputPanel();
      log(`\n=== Feature ${pick.key} -> ${next ? "on" : "off"} ===`);
      log(featureFlagLines().join("\n"));
      void notifyUserSuccess(`Claude Skills: ${pick.key} is now ${next ? "enabled" : "disabled"}. Reload window to apply some changes.`);
    }),

    vscode.commands.registerCommand("claudeSkills.showProjectProfile", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        return;
      }
      const profile = readProjectProfile(target) ?? buildProjectProfile(target);
      revealOutputPanel();
      log(`\n${formatProjectProfileTierComparisonTable(target, profile.profileType)}`);
      log(`\n${formatProjectProfileSummaryBlock(profile)}`);
      const view = formatProjectProfileNotifyMessage(profile);
      void notifySuggestion(view, ["Change tier"], { dedupeKey: `show-profile|${target}`, log }).then((pick) => {
        if (pick === "Change tier") {
          void vscode.commands.executeCommand("claudeSkills.chooseProjectProfile");
        }
      });
    }),

    vscode.commands.registerCommand("claudeSkills.detectProjectProfile", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        return;
      }
      const existing = readProjectProfile(target);
      const locked = effectiveLockedTier(existing, target);
      if (locked) {
        const action = await vscode.window.showWarningMessage(
          `Project tier is locked to ${PROFILE_TYPE_LABELS[locked]}. Re-detect will clear your manual plan.`,
          "Change tier",
          "Re-detect anyway",
          "Cancel"
        );
        if (action === "Change tier") {
          void vscode.commands.executeCommand("claudeSkills.chooseProjectProfile");
          return;
        }
        if (action !== "Re-detect anyway") {
          return;
        }
        await setLockedProjectProfileTier(target, "");
      }
      const profile = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Claude Skills: probing remote git for tier estimate",
          cancellable: false,
        },
        async () => buildProjectProfileWithRemoteProbe(target)
      );
      const detectedProfile: ProjectProfileFile = {
        ...profile,
        userPlan: "accept-detected",
        manualOverride: undefined,
      };
      writeProjectProfile(target, detectedProfile);
      refreshProjectProfileContext(target);
      refreshAll();
      revealOutputPanel();
      log(`\n=== Project profile detected ===\n${formatProjectProfileTierComparisonTable(target, detectedProfile.profileType)}`);
      log(`\n${formatProjectProfileSummaryBlock(detectedProfile)}`);
      void notifySuggestion(formatProjectProfileNotifyMessage(detectedProfile), ["View details"], {
        dedupeKey: `detect-profile|${target}`,
        log,
      });
    }),

    vscode.commands.registerCommand("claudeSkills.chooseProjectProfile", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        return;
      }
      const current = readProjectProfile(target);
      const detected = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Claude Skills: probing remote git (extension-only tier estimate)",
          cancellable: false,
        },
        async () => buildProjectProfileWithRemoteProbe(target)
      );
      log(`\n${formatProjectProfileTierComparisonTable(target, current?.profileType ?? detected.profileType)}`);
      const pick = await vscode.window.showQuickPick(
        buildProjectPlanQuickPickItems(detected, current?.userPlan),
        {
          title: "Choose project plan (remote git + local repo analyzed)",
          placeHolder: formatDetectedTierSummary(detected).replace(/\n/g, " · "),
          ignoreFocusOut: true,
        }
      );
      if (!pick) {
        return;
      }
      let lockedProfile: ProjectProfileFile;
      if (pick.id === "accept-detected") {
        await setLockedProjectProfileTier(target, "");
        lockedProfile = {
          ...detected,
          userPlan: "accept-detected",
          manualOverride: undefined,
          appliedAt: new Date().toISOString(),
        };
        writeProjectProfile(target, lockedProfile);
      } else {
        lockedProfile = await applyUserProjectPlan(target, detected, pick.id);
      }
      setActiveProjectProfileContext(
        lockedProfile.enabledFeatures,
        projectProfileApplyTierEnabled(target)
      );
      refreshProjectTierStatusBar(target);
      refreshAll({ workspaceState: false, forceTree: true });
      if (lockedProfile) {
        revealOutputPanel();
        log(`\n=== Project profile plan confirmed ===\n${formatProjectProfileSummaryBlock(lockedProfile)}`);
        void notifySuggestion(formatProjectProfileNotifyMessage(lockedProfile), ["View details"], {
          dedupeKey: `plan-confirmed|${target}|${lockedProfile.profileType}`,
          log,
        }).then((action) => {
          if (action === "View details") {
            void vscode.commands.executeCommand("claudeSkills.showProjectProfile");
          }
        });
      }
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
      void notifyUserSuccess(`Claude Skills: skill sort -> ${next}`);
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
        void notifyUserSuccess("No archived skills to restore.", log);
        return;
      }
      const pick = await vscode.window.showQuickPick(archived, { title: "Restore archived skill" });
      if (pick && restoreArchivedSkill(target, pick, libraryDir)) {
        refreshAll();
        void notifyUserSuccess(`Restored skill: ${pick}`, log);
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

    vscode.commands.registerCommand("claudeSkills.configureWeeklyReportEmail", async () => {
      const target = getWorkspaceTarget();
      const message = await configureWeeklyReportEmail(context, target);
      maybeRevealOutputPanel();
      log(`\n=== Configure weekly report email ===\n${message}`);
      void notifyUserSuccess(message.split("\n")[0] ?? message, log);
    }),

    vscode.commands.registerCommand("claudeSkills.sendWeeklyReport", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      maybeRevealOutputPanel();
      log("\n=== Send weekly AI usage report ===");
      const result = await deliverWeeklyReport(context, target, libraryDir);
      if (result.email.ok) {
        log(`Email sent to ${result.email.to}`);
        void notifyUserSuccess(`Claude Skills: weekly report emailed to ${result.email.to}.`);
      } else {
        log(`Email failed: ${result.email.error ?? "n/a"}`);
        vscode.window.showWarningMessage(
          result.email.error ?? "Weekly report could not be sent. Run Configure Weekly Report Email."
        );
      }
    }),

    vscode.commands.registerCommand("claudeSkills.previewSkillSetResolver", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const plan = planSkillSetResolution(target, libraryDir);
      revealOutputPanel();
      log("\n=== Skill set resolver preview ===");
      log(formatSkillSetResolverPlan(plan).join("\n"));
      void notifyUserSuccess(
        `Claude Skills: would install ${plan.toInstall.length}, remove ${plan.toRemove.length}, archive ${plan.toArchive.length} — see output.`
      );
    }),

    vscode.commands.registerCommand("claudeSkills.runSkillSetResolver", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const plan = planSkillSetResolution(target, libraryDir);
      if (plan.toInstall.length === 0 && plan.toRemove.length === 0 && plan.toArchive.length === 0) {
        void notifyUserSuccess("Claude Skills: skill set already matches this workspace.");
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Install ${plan.toInstall.length}, remove ${plan.toRemove.length}, archive ${plan.toArchive.length} skill(s)?`,
        { modal: true },
        "Run"
      );
      if (confirm !== "Run") {
        return;
      }
      maybeRevealOutputPanel();
      log("\n=== Skill set resolver ===");
      const result = executeSkillSetResolution(target, libraryDir);
      log(formatSkillSetResolverPlan(result.plan).join("\n"));
      if (result.installed.length > 0) {
        log(`Installed: ${result.installed.join(", ")}`);
      }
      if (result.removed.length > 0) {
        log(`Removed: ${result.removed.join(", ")}`);
      }
      if (result.archived.length > 0) {
        log(`Archived: ${result.archived.join(", ")}`);
      }
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, { forceAgentSync: true });
      refreshAll();
      void notifyUserSuccess(
        `Claude Skills: installed ${result.installed.length}, removed ${result.removed.length}, archived ${result.archived.length}.`
      );
    }),

    vscode.commands.registerCommand("claudeSkills.resetAttribution", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
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
      runCostPipelineSync(target, libraryDir);
      persistCostAttribution(target, libraryDir);
      refreshAll();
      void notifyUserSuccess(
        `Claude Skills: removed ${result.removedRuns} transcript estimate row(s); kept ${result.keptRuns} hook/self-learning run(s). Reopen Usage Report to refresh.`
      );
    }),

    vscode.commands.registerCommand("claudeSkills.installCommitCostHook", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      try {
        const status = installGitPostCommitHook(target, context.extensionPath);
        void notifyUserSuccess(`Claude Skills: commit cost hook ${status}.`);
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
  const debouncedRefresh = debounce(() => {
    const target = getWorkspaceTarget();
    if (target) {
      invalidateDetectionCache(target);
    }
    refreshLight();
  }, 5000);
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
      invalidateDetectionCache(target);
      invalidateWorkspaceSyncFingerprint(target);
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log);
      refreshLight();
    }
  }, 3000);

  const skillsWatcher = vscode.workspace.createFileSystemWatcher("**/.claude/skills/**");
  skillsWatcher.onDidCreate(debouncedAgentSync);
  skillsWatcher.onDidDelete(debouncedAgentSync);
  skillsWatcher.onDidChange(debouncedAgentSync);
  context.subscriptions.push(skillsWatcher);

  const localSettingsWatcher = vscode.workspace.createFileSystemWatcher("**/.claude/settings.local.json");
  localSettingsWatcher.onDidChange(debouncedAgentSync);
  localSettingsWatcher.onDidCreate(debouncedAgentSync);
  context.subscriptions.push(localSettingsWatcher);

  const debouncedProfileApply = debounce(() => {
    if (!autoApplyProfileFileEnabled()) {
      return;
    }
    const target = getWorkspaceTarget();
    if (!target) {
      return;
    }
    const { result, init, invalid, hostAgentSkillSet } = applyLocalProfileInit(libraryDir, target);
    if (!result || !init) {
      return;
    }
    log(
      `\n=== Auto-applied profile.local.json ===\nBranch: ${init.branch}, +${result.installed.length} skill(s)` +
        (hostAgentSkillSet
          ? `; ${hostAgentLabel(hostAgentSkillSet.agent)} skill set updated (${hostAgentSkillSet.skills.length} skills)`
          : "") +
        (invalid.length ? `; skipped unknown: ${invalid.join(", ")}` : "")
    );
    propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, { forceAgentSync: true });
    refreshAll();
    notifyBackground(
      `Profile applied for ${init.branch} (${result.installed.length} skill(s) installed).`,
      log
    );
  }, 800);

  const profileLocalWatcher = vscode.workspace.createFileSystemWatcher("**/.claude/profile.local.json");
  profileLocalWatcher.onDidChange(debouncedProfileApply);
  profileLocalWatcher.onDidCreate(debouncedProfileApply);
  context.subscriptions.push(profileLocalWatcher);

  const debouncedSessionSkillApply = debounce(() => {
    const target = getWorkspaceTarget();
    if (!target) {
      return;
    }
    const sessionApply = processSessionSkillApplyRequest(libraryDir, target);
    if (sessionApply.applied && sessionApply.result) {
      log(
        `\n=== Session skill apply (hook) ===\n` +
          `+${sessionApply.result.installed.length} installed, ${sessionApply.result.overridesApplied} enabled locally`
      );
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, {
        saveBranchProfile: true,
        forceAgentSync: true,
      });
      refreshAll();
    }
  }, 600);

  const sessionApplyWatcher = vscode.workspace.createFileSystemWatcher(`**/${SESSION_APPLY_REQUEST_REL.replace(/\\/g, "/")}`);
  sessionApplyWatcher.onDidChange(debouncedSessionSkillApply);
  sessionApplyWatcher.onDidCreate(debouncedSessionSkillApply);
  context.subscriptions.push(sessionApplyWatcher);

  const debouncedTaskProposalsApply = debounce(() => {
    const target = getWorkspaceTarget();
    if (!target) {
      return;
    }
    const taskApply = applyTaskProposalsIfPending(libraryDir, target);
    if (taskApply.applied && taskApply.result) {
      log(
        `\n=== Task proposals auto-apply (file change) ===\n` +
          `+${taskApply.result.installed.length} installed, ${taskApply.result.overridesApplied} enabled locally`
      );
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, {
        saveBranchProfile: true,
        forceAgentSync: true,
      });
      refreshAll();
    }
  }, 600);

  const proposalsWatcher = vscode.workspace.createFileSystemWatcher(
    `**/${PROPOSALS_FILE_RELATIVE.replace(/\\/g, "/")}`
  );
  proposalsWatcher.onDidChange(debouncedTaskProposalsApply);
  proposalsWatcher.onDidCreate(debouncedTaskProposalsApply);
  context.subscriptions.push(proposalsWatcher);

  for (const learningGlob of ["**/.claude/learning/runs.jsonl", "**/.claude/learning/cost-attribution.json"]) {
    const learningWatcher = vscode.workspace.createFileSystemWatcher(learningGlob);
    learningWatcher.onDidChange(() => {
      const target = getWorkspaceTarget();
      if (target) {
        scheduleCostPipelineSync(target, libraryDir);
      }
    });
    learningWatcher.onDidCreate(() => {
      const target = getWorkspaceTarget();
      if (target) {
        scheduleCostPipelineSync(target, libraryDir);
      }
    });
    context.subscriptions.push(learningWatcher);
  }

  const gitExt = vscode.extensions.getExtension("vscode.git");
  if (gitExt) {
    const gitDisposables: vscode.Disposable[] = [];
    const debouncedRepoChange = debounce((repoRoot: string) => {
      void (async () => {
        const target = getWorkspaceTarget();
        if (!target || !target.startsWith(repoRoot)) {
          return;
        }
        invalidateDetectionCache(target);
        const teamResult = applyTeamBranchProfile(libraryDir, target);
        if (teamResult) {
          log(`Applied team git profile (baseline): +${teamResult.installed.length}, -${teamResult.removed.length}`);
        }
        await handleBranchChange(libraryDir, target, log, branchChangeOpts(context.extensionPath, libraryDir, target));
        const agentApplied = maybeApplyHostAgentSkillSet(libraryDir, target, log);
        propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, {
          saveBranchProfile: !agentApplied,
        });
        refreshAll({ workspaceState: true, forceTree: true });
      })();
    }, 400);
    const onRepoChange = (repoRoot: string) => {
      debouncedRepoChange(repoRoot);
    };
    const subscribeGit = () => {
      try {
        const api = gitExt.exports.getAPI(1);
        for (const repo of api.repositories) {
          gitDisposables.push(
            repo.state.onDidChange(() => {
              void onRepoChange(repo.rootUri.fsPath);
            })
          );
        }
        gitDisposables.push(
          api.onDidOpenRepository((repo: { state: { onDidChange: (cb: () => void) => vscode.Disposable }; rootUri: { fsPath: string } }) => {
            gitDisposables.push(
              repo.state.onDidChange(() => {
                void onRepoChange(repo.rootUri.fsPath);
              })
            );
          })
        );
      } catch (err) {
        log(`Git API unavailable: ${(err as Error).message}`);
      }
    };
    const runInitialBranchSync = () => {
      try {
        setGitApiCache(gitExt.exports.getAPI(1));
      } catch (err) {
        setGitApiCache(undefined);
        log(`Git API cache init failed: ${(err as Error).message}`);
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
          await handleBranchChange(libraryDir, target, log, branchChangeOpts(context.extensionPath, libraryDir, target));
          const agentApplied = maybeApplyHostAgentSkillSet(libraryDir, target, log);
          propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, {
            saveBranchProfile: !agentApplied,
          });
          refreshAll();
        })();
      }
    };
    if (gitExt.isActive) {
      runInitialBranchSync();
    } else {
      void Promise.resolve(gitExt.activate()).then(runInitialBranchSync).catch((err: Error) => {
        log(`Git extension activation failed: ${err.message}`);
      });
    }
    context.subscriptions.push({ dispose: () => gitDisposables.forEach((d) => d.dispose()) });
  }
}

function debounce<T extends unknown[]>(fn: (...args: T) => void, ms: number): (...args: T) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: T) => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function deactivate() {
  AttributionCollector.stopAll();
}
