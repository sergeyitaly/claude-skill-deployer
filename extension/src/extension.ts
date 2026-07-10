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
import { applyHostOnlyTierMirrorCleanup } from "./agentMirrorSync";
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
  notificationLevel,
  notifyBackground,
  notifySuggestion,
  notifyUserSuccess,
  notifyUserWarn,
} from "./userNotify";
import { startExtensionAutoUpdate } from "./extensionAutoUpdate";
import { recordPerf } from "./perfTelemetry";
import {
  buildCostAttribution,
  formatAttributionReport,
  persistCostAttribution,
  resolveDisplayAttribution,
} from "./costAttribution";
import { getOptimalAgent, formatRoutingSuggestion } from "./costRouter";
import { budgetProgressBar, remainingDailyBudgetUsd, writeTodayCostSnapshot } from "./todayCostSnapshot";
import { computeCreditUsage, spendPrefixForCreditSummary } from "./usageCost";
import { formatCompactUsd, sumInstallCostEstimate, tierForSkill } from "./skillCost";
import { autoReconcileCursorCostsFromDownloads, reconcileCursorCosts } from "./cursorUsageImport";
import { formatTokenCount } from "./usageStats";
import { BudgetMode, budgetUsagePercent, configFromVsCodeSettings, syncBudgetConfigToDisk } from "./budgetConfig";
import {
  CONTEXT_FOCUS_LABELS,
  ContextFocusLevel,
  configFromVsCodeSettings as contextFocusFromSettings,
  nextContextFocusLevel,
  syncContextFocusConfigToDisk,
} from "./contextFocusConfig";
import { syncAttributionTrustConfig } from "./attributionQuality";
import { processTaskDriftReproposal } from "./taskDriftReproposal";
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
  installMcpForceHook,
  installMcpGateHook,
  installCliLoopGuardHook,
  removeCliLoopGuardHook,
  installDirCacheGuardHook,
  removeDirCacheGuardHook,
  installOfficialSkillsSessionHook,
  installTerminalWatchHook,
  removeMcpForceHooks,
} from "./hookOps";
import { startHookServer, stopHookServer } from "./hookServer";
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
  hostOnlyMirrorModeForTarget,
  syncLockedTierSettingToProfile,
  writeProjectProfile,
} from "./projectProfile";
import {
  formatProjectProfileNotifyMessage,
  formatProjectProfileStatusBarText,
  formatProjectProfileStatusBarTooltip,
  formatProjectProfileSummaryBlock,
  formatProjectProfileTierComparisonTable,
} from "./projectProfile";
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
import { resetMisattributedData } from "./costAttribution";
import { generateLatestSessionBreakdown } from "./sessionBreakdown";
import { computeEfficiencyMetrics, formatEfficiencyReport } from "./efficiencyMetrics";
import { clearMcpLogs, workspaceMcpLogPath, summarizeMcpUsage, summarizeCrossSessionPatterns, MCP_USAGE_LOG_PATH } from "./mcpUsageLog";
import { initMcpStatusBars, refreshMcpStatusBars, refreshCliMcpStatusBar } from "./mcpStatusBars";
import { registerDashboardCommands } from "./commandsDashboard";
import { registerLearningDashboardCommands } from "./commandsLearningDashboard";
import { registerEnrichmentCommands } from "./commandsEnrichment";
import { registerMcpCommands } from "./commandsMcp";
import { registerSkillsCommands } from "./commandsSkills";
import { registerUsageCommands } from "./commandsUsage";
import { registerHooksCommands } from "./commandsHooks";
import { registerBudgetCommands } from "./commandsBudget";
import { registerProfileCommands } from "./commandsProfile";
import { registerTaskSkillsCommands } from "./commandsTaskSkills";
import { registerMiscCommands } from "./commandsMisc";
import {
  initStatusBars,
  refreshStatusBar,
  refreshCreditStatusBar,
  refreshProjectTierStatusBar,
  refreshAttributionAlertBar,
  StatusBarItems,
} from "./statusBarManager";
import { generateOptimizationSuggestions, formatSuggestionsReport } from "./costOptimizer";
import { formatCostDashboardHtml, formatCostDashboardText, formatTeamEconomicsPanelsHtml, getOrBuildDashboardMainBody } from "./costDashboard";
import { tryReadValidDashboardSnapshot } from "./dashboardPrecompute";
import { applyOptimizationSuggestions, applySingleOptimizationSuggestion } from "./autoOptimizer";
import { checkPredictiveCostAlert } from "./costPredictor";

import { isFeatureEnabled, featureFlagLines, FeatureKey, FEATURE_DESCRIPTIONS } from "./featureFlags";
import { checkEmergencyCutoff, resetEmergencyCutoff } from "./emergencyCutoff";
import { getOrComputeTeamEconomicsBundle } from "./dashboardPrecompute";
import { yieldToEventLoop } from "./eventLoop";
import { listArchivedSkills, restoreArchivedSkill } from "./skillArchival";
import { SkillSortMode } from "./skillRoi";
function integrationTestMode(): boolean {
  return process.env.CLAUDE_SKILLS_INTEGRATION_TEST === "1";
}

function detectGitRepository(ctx: vscode.ExtensionContext, target?: string): boolean {
  const isGit = target ? isGitWorkspace(target) : false;
  void ctx.globalState.update("claudeSkills.isGitRepo", isGit);
  return isGit;
}

async function checkFirstTimeGlobalSetup(ctx: vscode.ExtensionContext): Promise<void> {
  if (integrationTestMode()) return;
  const globalPath = globalSkillsDir();
  if (fs.existsSync(globalPath) && fs.statSync(globalPath).isDirectory()) return;
  if (ctx.globalState.get<boolean>("claudeSkills.globalSetupPrompted", false)) return;
  if (notificationLevel() !== "normal") {
    void ctx.globalState.update("claudeSkills.globalSetupPrompted", true);
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    "Welcome to Claude Skills Manager! Install the skill library to ~/.claude/skills to get started.",
    "Install Now",
    "Later"
  );
  if (choice === "Install Now") {
    void ctx.globalState.update("claudeSkills.globalSetupPrompted", true);
    await vscode.commands.executeCommand("claudeSkills.installLibraryToGlobal");
  } else if (choice === "Later") {
    void ctx.globalState.update("claudeSkills.globalSetupPrompted", true);
  }
}

async function promptGetStarted(ctx: vscode.ExtensionContext): Promise<void> {
  if (integrationTestMode()) return;
  if (ctx.globalState.get<boolean>("claudeSkills.hasRunBefore", false)) return;
  if (notificationLevel() !== "normal") {
    void ctx.globalState.update("claudeSkills.hasRunBefore", true);
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
import { showOnboardingTour } from "./onboarding";
import { showOnboardingWizard } from "./onboardingWizard";
import { formatHookStatusPlain } from "./workspaceHookStatus";
import { assessAttributionHealth } from "./attributionQuality";
import { buildUsageSkillConfidenceMap } from "./attributionQuality";
import { buildGlobalTrustBadge, formatGlobalTrustStatusBar } from "./attributionQuality";
import {
  lifecycleAlertsEnabled,
  lifecycleAutoSuggestEnabled,
  listOutdatedSkills,
  listSkillVersionStatuses,
  upgradeOutdatedSkills,
} from "./skillLifecycle";
import { autoUpgradeTrustedSkills } from "./safeAutoUpgrade";
import { readSkillStatsIndex } from "./runsStore";
import { setPricingContext } from "./costRates";
import { runCostPipeline, runCostPipelineSync } from "./costPipeline";
import {
  scheduleCostPipelineSync,
} from "./costPipelineScheduler";
import { buildSystemModeContext } from "./attributionQuality";
import { readPipelineCycle } from "./pipelineCycle";
import { ErrorRecovery, repairIssues, scanForIssues } from "./errorRecovery";
import { recordActivation, recordError, recordFeatureUse } from "./analytics";
import { autoMigrateProxyIfActive, revertMcpOptimizer } from "./mcpAutoOptimizer";
import { applyMcpAutoFixesForTarget } from "./mcpAutoFix";
import { startMcpForceWatchdog } from "./mcpForceWatchdog";
import { checkMcpHealth } from "./mcpHealth";
import { ensureFilesystemMcpActive, enableOfficialFilesystemServer, disableOfficialFilesystemServer, getFilesystemMcpServerStatus, syncFilesystemServerBinary, ensureCopilotFilesystemConfigReady } from "./mcpOfficial";
import { enableOfficialCliServer, disableOfficialCliServer, getCliMcpServerStatus, needsCliMcpSetup, refreshCliConfig, syncCliServerBinary, ensureCopilotCliConfigReady } from "./mcpCli";
import {
  enableMcpForcePermissions,
  injectMcpForceClaude,
  isMcpForceActive,
  removeMcpForceClaudeBlock,
  revertMcpForcePermissions,
} from "./mcpForce";
import { checkAndShowKpiAlert } from "./kpiAlert";
import { getAuditExecutor, initializeAuditExecutor } from "./auditExecution";
import { initializeAuditScheduler } from "./backgroundAuditScheduler";

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
import { bootstrapWorkspaceForHostAgent, formatHostBootstrapLog } from "./hostAgentBootstrap";
import { bootstrapBranchSkillSet, branchSkillBootstrapEnabled } from "./branchSkillBootstrap";
import { runCostDisciplinePass } from "./costDiscipline";
import { createRefreshScheduler, shouldRunWorkspaceState } from "./workspaceRefresh";

let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let usageStatusBarItem: vscode.StatusBarItem;
let creditStatusBarItem: vscode.StatusBarItem;

let projectTierStatusBarItem: vscode.StatusBarItem;
let workspaceFolderStatusBarItem: vscode.StatusBarItem;
let mcpHealthStatusBarItem: vscode.StatusBarItem;
let mcpKpiStatusBarItem: vscode.StatusBarItem;
let mcpCliStatusBarItem: vscode.StatusBarItem;
let auditStatusBarItem: vscode.StatusBarItem;
let usagePanel: vscode.WebviewPanel | undefined;




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



function branchChangeOpts(extensionPath: string, libraryDir: string, target: string) {
  const bootstrap = branchSkillBootstrapEnabled();
  const profileInit = profileInitEnabled();
  if (!bootstrap && !profileInit) {
    return undefined;
  }

  const opts: Parameters<typeof handleBranchChange>[3] = {
    onNewBranchWithoutProfile: async (branch: string) => {
      if (bootstrap) {
        const boot = bootstrapBranchSkillSet(libraryDir, target, branch);
        if (boot.bootstrapped) {
          log(
            `Branch bootstrap (${boot.flavor ?? "general"}): ${boot.skills.length} focused skill(s)` +
              (boot.installed.length ? ` — installed ${boot.installed.join(", ")}` : "") +
              "."
          );
          if (!profileInit) {
            return;
          }
        }
      }
      if (profileInit) {
        await maybePromptProfileInitOnNewBranch(extensionPath, libraryDir, target, branch, log);
      }
    },
  };

  if (profileInit) {
    opts.mergeProfileSkills = mergeProfileInitSkills;
    opts.recoverRequiredSkills = async (
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
    };
  }

  return opts;
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





function maybeAutoEnableMcpForce(target: string): void {
  if (!vscode.workspace.getConfiguration("claudeSkills.mcpForce").get<boolean>("enableOnStartup", false)) {
    return;
  }
  if (isMcpForceActive(target)) {
    return;
  }
  const permResult = enableMcpForcePermissions(target);
  if (!permResult.ok) {
    log(`MCP Force Mode auto-enable skipped: ${permResult.reason}`);
    return;
  }
  const injectResult = injectMcpForceClaude(target);
  if (!injectResult.ok) {
    log(`MCP Force Mode CLAUDE.md inject skipped: ${injectResult.reason}`);
  }
  log("MCP Force Mode: auto-enabled on startup.");
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

  const silentlyUpgraded = await autoUpgradeTrustedSkills(libraryDir, target);
  if (silentlyUpgraded.length > 0) {
    log(`Claude Skills: auto-upgraded ${silentlyUpgraded.length} trusted skill(s) silently — ${silentlyUpgraded.join(", ")}.`);
  }

  const outdated = listOutdatedSkills(libraryDir, target).filter((s) => !silentlyUpgraded.includes(s.name));
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



let lastHighUsageAlertCheckMs = 0;
const HIGH_USAGE_ALERT_INTERVAL_MS = 5 * 60 * 1000;

export function activate(context: vscode.ExtensionContext) {
  const libraryDir = path.join(context.extensionPath, "skills_library");

  outputChannel = vscode.window.createOutputChannel("Claude Skills");
  context.subscriptions.push(outputChannel);

  // Initialize audit framework executor
  initializeAuditExecutor();

  const provider = new SkillsProvider(libraryDir, getWorkspaceTarget);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBarItem);

  usageStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  context.subscriptions.push(usageStatusBarItem);

  creditStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  context.subscriptions.push(creditStatusBarItem);


  projectTierStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97.25);
  context.subscriptions.push(projectTierStatusBarItem);

workspaceFolderStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 94);
   context.subscriptions.push(workspaceFolderStatusBarItem);

   // v1.1: attribution alert bar — conditional, only visible when attribution < 80%
   const attributionAlertBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
   context.subscriptions.push(attributionAlertBarItem);

   mcpHealthStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 93);
   context.subscriptions.push(mcpHealthStatusBarItem);

   mcpKpiStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 92);
   context.subscriptions.push(mcpKpiStatusBarItem);

   mcpCliStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 91.5);
   context.subscriptions.push(mcpCliStatusBarItem);
   
   auditStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 91);
   context.subscriptions.push(auditStatusBarItem);
   
   initMcpStatusBars(mcpHealthStatusBarItem, mcpKpiStatusBarItem, mcpCliStatusBarItem);
   initStatusBars(
     {
       statusBarItem,
       usageStatusBarItem,
       creditStatusBarItem,
       projectTierStatusBarItem,
       workspaceFolderStatusBarItem,
       attributionAlertBarItem,
     } satisfies StatusBarItems,
     libraryDir,
     getWorkspaceTarget,
   );

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
    // User-consented installs (Apply Suggested Skills command / high-usage prompt) are
    // "manual" acceptances in the adoption funnel; background applies stay "auto".
    const result = applyProposedSkillsLocally(libraryDir, target, names, "manual");
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
  let lastCostDisciplineLogged: string | undefined;
  const mirrorCleanupCheckedTargets = new Set<string>();
  const cursorUsageImportCheckedTargets = new Set<string>();

  function checkCursorUsageImportFromDownloads(target: string): void {
    if (!vscode.workspace.getConfiguration("claudeSkills.budget").get<boolean>("cursorUsageImportEnabled", true)) {
      return;
    }
    const watchFolder = vscode.workspace.getConfiguration("claudeSkills.budget").get<string>("cursorUsageImportFolder", "");
    try {
      const entries = autoReconcileCursorCostsFromDownloads(target, watchFolder || undefined);
      for (const { file, result } of entries) {
        if (result.rowsUpdated > 0) {
          log(
            `Cursor usage CSV "${path.basename(file)}" reconciled ${result.rowsUpdated} run(s) on ${result.matchedDates.join(", ")}: ${formatCompactUsd(result.estimatedTotalUsd)} -> ${formatCompactUsd(result.reconciledTotalUsd)}.`
          );
        } else {
          log(`Cursor usage CSV "${path.basename(file)}" had no matching runs in runs.jsonl (dates: ${result.unmatchedCsvDates.join(", ") || "none"}).`);
        }
      }
    } catch (err) {
      recordError();
      log(`Cursor usage CSV auto-import failed: ${(err as Error).message}`);
    }
  }

  function cleanupExcessAgentMirrorsForTier(target: string): void {
    const { pruned } = applyHostOnlyTierMirrorCleanup(target, libraryDir, log);
    if (pruned.length > 0) {
      syncCliConfigToWorkspace(target, libraryDir);
      void notifyUserSuccess(
        `Claude Skills: removed ${pruned.length} excess agent mirror path(s) for host-only tier.`
      );
    }
  }

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
      if (!mirrorCleanupCheckedTargets.has(target!) && hostOnlyMirrorModeForTarget(target!)) {
        mirrorCleanupCheckedTargets.add(target!);
        cleanupExcessAgentMirrorsForTier(target!);
      }
      if (opts.workspaceState && !cursorUsageImportCheckedTargets.has(target!)) {
        cursorUsageImportCheckedTargets.add(target!);
        checkCursorUsageImportFromDownloads(target!);
      }
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
              cleanupExcessAgentMirrorsForTier(target);
              notifyTierChange(finalProfile);
            }
            refreshAllImpl({ workspaceState: false, forceTree: false });
          });
        } else if (projectProfileChanged && projectProfileTierChanged) {
          cleanupExcessAgentMirrorsForTier(target!);
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
    if (target) {
      AttributionCollector.setActiveTarget(target, libraryDir);
    }
    syncBranchProfileContext(target);
    if (refreshScheduler.isTreeVisible() || opts.forceTree) {
      provider.refresh();
    }
    refreshStatusBar();
    refreshCreditStatusBar(target);
    refreshProjectTierStatusBar(target);
    refreshAttributionAlertBar(target);
    refreshWorkspaceFolderStatusBar();
    refreshMcpStatusBars(getWorkspaceTarget());
    refreshCliMcpStatusBar();
    usageStatusBarItem.hide();
    if (target && opts.workspaceState && shouldSyncWorkspaceToAll() && agentMirrorsNeedSync(target, libraryDir)) {
      const synced = syncWorkspaceSkillsToAllAgents(libraryDir, target);
      if (synced.length > 0) {
        log(`Auto-synced ${synced.length} skill mirror(s) to cursor/kiro/copilot.`);
      }
    }
    if (!target) {
      return;
    }

    scheduleCostPipelineSync(target, libraryDir);
    syncAttributionTrustConfig(target, libraryDir);
    void checkEmergencyCutoff(target, libraryDir);
    if (autoInstallAttributionHooksEnabled() && !areAttributionHooksConfigured(target, context.extensionPath)) {
      ensureAttributionHooksActive(context.extensionPath, target, log);
    }
    installTerminalWatchHook(context.extensionPath, target);

    if (!shouldRunWorkspaceState(lastWorkspaceStateAt, { workspaceState: opts.workspaceState })) {
      return;
    }
    lastWorkspaceStateAt = Date.now();

    checkAndShowKpiAlert(
      () => void vscode.commands.executeCommand("claudeSkills.showCostDashboard")
    );

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
    {
      const manifest = loadManifest(libraryDir);
      const drift = processTaskDriftReproposal(target, libraryDir, manifest);
      if (drift.reproposed && drift.evaluation) {
        log(
          `Task drift: refreshed skill proposals (${drift.triggers.join(", ")} — ${drift.evaluation.reason}).`
        );
        const settings = vscode.workspace.getConfiguration("claudeSkills.skillFeedback");
        if (settings.get<boolean>("taskDriftNotifyUser", true)) {
          notifyBackground(
            `Task scope drifted — skill set refreshed (${drift.triggers.join(", ")}).`,
            log
          );
        }
      }
      const proposalRefresh = ensureWorkspaceTaskProposals(target, manifest);
      if (proposalRefresh.refreshed) {
        log(`Task proposals refreshed locally (${proposalRefresh.file?.proposals.length ?? 0} skills).`);
      }
      void (async () => {
            const focusApply = applyTaskSkillFocusFromProposals(libraryDir, target);
        if (focusApply.applied && focusApply.focus) {
          log(
            `Task skill focus: ${focusApply.focus.activeSkills.length} active, ${focusApply.focus.ignoredSkills.length} ignored for this task.`
          );
        }
        const discipline = runCostDisciplinePass(libraryDir, target);
        const disciplineKey = `${target}|${JSON.stringify(discipline)}`;
        if (disciplineKey !== lastCostDisciplineLogged) {
          lastCostDisciplineLogged = disciplineKey;
          if (discipline.hostBootstrapMessage) {
            log(discipline.hostBootstrapMessage);
          }
          if (discipline.budgetDisabled.length > 0) {
            log(`Budget tier gating: disabled ${discipline.budgetDisabled.join(", ")} (${discipline.reason ?? "budget"}).`);
          }
          if (discipline.prunedIrrelevant.length > 0) {
            log(`Relevant-only prune: removed ${discipline.prunedIrrelevant.join(", ")}.`);
          }
          if (discipline.mirroredArtifacts.length > 0) {
            log(`Mirrored cost-discipline artifacts: ${discipline.mirroredArtifacts.join(", ")}.`);
          }
          if (discipline.agentPathsUpdated > 0) {
            log(`Propagated focused skill set to ${discipline.agentPathsUpdated} Cursor/Kiro/Copilot path(s).`);
          }
        }
        scheduleHighUsageSkillProposalCheck(target);
      })();
    }
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
  syncContextFocusConfigToDisk();
  syncPracticalFocusConfigToDisk();
  const initialTarget = getWorkspaceTarget();

  // Sync MCP server binaries and ensure Copilot's config files exist unconditionally —
  // before any workspace-folder guard. Copilot is registered via contributes.mcpServers
  // and its server processes start as soon as the user opens a chat, regardless of
  // whether a workspace folder is open. Without these config files the server processes
  // crash immediately and Copilot cannot use any MCP tools.
  {
    const earlyWorkspaceDirs = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    syncFilesystemServerBinary(context.extensionPath, log);
    syncCliServerBinary(context.extensionPath, log);
    ensureCopilotFilesystemConfigReady(earlyWorkspaceDirs, log);
    ensureCopilotCliConfigReady(earlyWorkspaceDirs, log);
  }

  void (async () => {
    recordActivation();
    const isGit = detectGitRepository(context, initialTarget);

    syncBranchProfileContext(initialTarget);
    if (isGit) {
      initBranchTracking(initialTarget);
    }
    await checkFirstTimeGlobalSetup(context);
    const recovery = new ErrorRecovery();
    await recovery.repairCommonIssues(initialTarget);
    await promptGetStarted(context);
    autoMigrateProxyIfActive(context, log);
  })();

  void startHookServer();

  refreshLight();

  startExtensionAutoUpdate(context, log);

  if (initialTarget && !integrationTestMode()) {
    const hostBoot = bootstrapWorkspaceForHostAgent(libraryDir, initialTarget);
    const hostBootLog = formatHostBootstrapLog(hostBoot);
    if (hostBootLog) {
      log(hostBootLog);
    }
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
    // Auto-start local MCP servers on extension activation.
    setTimeout(() => {
      try {
        if (!getWorkspaceTarget()) return;
        const workspaceDirs = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];

        // Filesystem MCP server — always ensure active on every startup.
        // ensureFilesystemMcpActive refreshes allowed dirs and silently re-adds
        // the server entry to any agent config that lost it, without notifications.
        void ensureFilesystemMcpActive(context.extensionPath, workspaceDirs, log).then(() => {
          if (initialTarget) {
            // Always call through (not gated by presence) so a stale-port entry from a
            // prior fallback-port session gets rewritten, not just a missing entry filled in.
            const dirCacheGuardStatus = installDirCacheGuardHook(initialTarget);
            if (dirCacheGuardStatus !== "already-configured") {
              log(`Dir cache guard hook ${dirCacheGuardStatus}.`);
            }
          }
          refreshMcpStatusBars(getWorkspaceTarget());
          if (initialTarget) maybeAutoEnableMcpForce(initialTarget);

        });

        // CLI MCP server — binary already synced at activation; handle agent-config setup.
        if (needsCliMcpSetup()) {
          void enableOfficialCliServer(context.extensionPath, workspaceDirs, log).then(() => {
            log(`CLI MCP server: auto-started and configured.`);
            if (initialTarget) {
              const cliLoopGuardStatus = installCliLoopGuardHook(initialTarget);
              if (cliLoopGuardStatus !== "already-configured") {
                log(`CLI loop-guard hook ${cliLoopGuardStatus}.`);
              }
            }
            refreshCliMcpStatusBar();
          }).catch((err: unknown) => {
            log(`CLI MCP server setup failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        } else {
          refreshCliConfig(workspaceDirs, log);
          if (initialTarget) {
            const cliLoopGuardStatus = installCliLoopGuardHook(initialTarget);
            if (cliLoopGuardStatus !== "already-configured") {
              log(`CLI loop-guard hook ${cliLoopGuardStatus}.`);
            }
          }
          log(`CLI MCP server: already configured — agents can connect.`);
          refreshCliMcpStatusBar();
        }
      } catch (err) {
        log(`MCP server auto-start failed: ${(err as Error).message}`);
      }
    }, 5000);

    const collector = AttributionCollector.getInstance(initialTarget, libraryDir);
    collector.start();
    context.subscriptions.push({ dispose: () => collector.stop() });
    setTimeout(() => {
      const target = getWorkspaceTarget();
      if (target) {
        void checkPredictiveCostAlert(target, libraryDir);
      }
    }, 8000);

    startSkillSetResolverScheduler(context, getWorkspaceTarget, libraryDir, log, refreshAll, () => {
      const target = getWorkspaceTarget();
      if (target) {
        propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, { forceAgentSync: true });
      }
    });

    // Initialize background audit scheduler to run compliance checks daily
    if (initialTarget && !integrationTestMode()) {
      try {
        const executor = getAuditExecutor();
        const auditScheduler = initializeAuditScheduler(executor, initialTarget, libraryDir);
        context.subscriptions.push(auditScheduler);
        log('Audit scheduler initialized — will run daily compliance checks.');
      } catch (err) {
        log(`Failed to initialize audit scheduler: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Watchdog: if MCP force mode is active but MCP server becomes unreachable,
    // auto-revert permissions to prevent agents from being deadlocked.
    context.subscriptions.push(
      startMcpForceWatchdog(getWorkspaceTarget, log, () => {
        provider.refreshMcpServerStatus();
        refreshMcpStatusBars(getWorkspaceTarget());
      })
    );
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
      if (e.affectsConfiguration("claudeSkills.contextFocus")) {
        syncContextFocusConfigToDisk();
        refreshAll();
      }
      if (e.affectsConfiguration("claudeSkills.practicalFocus")) {
        syncPracticalFocusConfigToDisk();
        refreshAll();
      }
      if (e.affectsConfiguration("claudeSkills.costIntelligence")) {
        const target = getWorkspaceTarget();
        if (target) {
          syncAttributionTrustConfig(target, libraryDir);
        }
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
          if (e.affectsConfiguration("claudeSkills.projectProfile.lockedTier")) {
            syncLockedTierSettingToProfile(target);
          }
          refreshProjectProfileContext(target);
          cleanupExcessAgentMirrorsForTier(target);
        }
        refreshAll();
      }

    })
  );



  context.subscriptions.push(
    ...registerMiscCommands({
      context,
      libraryDir,
      getTarget: getWorkspaceTarget,
      log,
      refreshAll,
      revealOutputPanel,
      maybeRevealOutputPanel,
    }),
    ...registerSkillsCommands({
      context,
      libraryDir,
      getTarget: getWorkspaceTarget,
      log,
      refreshAll,
      revealOutputPanel,
      maybeRevealOutputPanel,
      refreshProvider: () => provider.refreshMcpServerStatus(),
    }),
    ...registerUsageCommands({
      context,
      libraryDir,
      getTarget: getWorkspaceTarget,
      log,
      refreshAll,
      revealOutputPanel,
      maybeRevealOutputPanel,
    }),
    ...registerHooksCommands({
      context,
      libraryDir,
      getTarget: getWorkspaceTarget,
      log,
      maybeRevealOutputPanel,
      applyBudgetSettings,
    }),
    ...registerBudgetCommands({
      context,
      getTarget: getWorkspaceTarget,
      log,
      refreshAll,
      maybeRevealOutputPanel,
    }),
    ...registerProfileCommands({
      context,
      libraryDir,
      getTarget: getWorkspaceTarget,
      log,
      refreshAll,
      revealOutputPanel,
      maybeRevealOutputPanel,
      refreshProjectTierStatusBar,
      cleanupExcessAgentMirrorsForTier,
    }),
    ...registerTaskSkillsCommands({
      context,
      libraryDir,
      getTarget: getWorkspaceTarget,
      log,
      refreshAll,
      applyProposalSkillNames,
    }),
    ...registerMcpCommands({
      context,
      getTarget: getWorkspaceTarget,
      log,
      revealOutputPanel,
      maybeRevealOutputPanel,
      refreshProvider: () => provider.refreshMcpServerStatus(),
    }),
    ...registerDashboardCommands({
      context,
      libraryDir,
      getTarget: getWorkspaceTarget,
      log,
      refreshAll,
      revealOutputPanel,
      maybeRevealOutputPanel,
    }),
    ...registerEnrichmentCommands({
      context,
      libraryDir,
      getTarget: getWorkspaceTarget,
      log,
      refreshAll,
    }),
    ...registerLearningDashboardCommands({
      context,
      getTarget: getWorkspaceTarget,
      log,
    }),
    vscode.commands.registerCommand('claude-skills.runAuditNow', async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn('Claude Skills: open a workspace folder first.');
        return;
      }
      const executor = getAuditExecutor();
      if (!executor) {
        void notifyUserWarn('Audit framework not initialized.');
        return;
      }
      try {
        void notifyBackground('Running compliance audit...', log);
        executor.clearCache();
        const result = await executor.executeAudit(target, libraryDir);
        if (result) {
          if (result.overallStatus === 'pass') {
            void notifyUserSuccess(`Audit passed: ${result.compliance.length} checks passed.`);
          } else if (result.overallStatus === 'warn') {
            void notifyUserWarn(`Audit completed with warnings: ${result.compliance.length} checks.`);
          } else {
            void notifyUserWarn(`Audit failed: Review compliance results.`);
          }
          await vscode.commands.executeCommand('claude-skills.viewAuditReport');
        } else {
          void notifyUserWarn('Audit returned no result.');
        }
      } catch (err) {
        void notifyUserWarn(`Audit failed: ${(err as Error).message}`);
        log(`Audit execution error: ${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand('claude-skills.viewAuditReport', async () => {
      // Compliance audit results are shown inline in the Cost Intelligence
      // dashboard's "Telemetry & Export" panel — no separate report file.
      await vscode.commands.executeCommand('claudeSkills.showCostDashboard');
    }),
    vscode.commands.registerCommand('claude-skills.clearAuditHistory', async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn('Claude Skills: open a workspace folder first.');
        return;
      }
      const historyPath = `${target}/.claude/learning/auditHistory.jsonl`;
      if (fs.existsSync(historyPath)) {
        fs.unlinkSync(historyPath);
        void notifyUserSuccess('Audit history cleared.');
        log('Audit history cleared.');
      }
    }),
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

  // runs.jsonl is where the PostToolUse skill-invoke hook records every tool/skill
  // call (including off-profile invokes) — it must also feed refreshAll() so
  // processTaskDriftReproposal (task-scope drift re-proposal) actually re-evaluates
  // when a new call lands, not just incidentally on unrelated file changes.
  for (const learningGlob of ["**/.claude/learning/runs.jsonl", "**/.claude/learning/cost-attribution.json"]) {
    const learningWatcher = vscode.workspace.createFileSystemWatcher(learningGlob);
    learningWatcher.onDidChange(() => {
      const target = getWorkspaceTarget();
      if (target) {
        scheduleCostPipelineSync(target, libraryDir);
        refreshAll({ workspaceState: true, forceTree: false });
      }
    });
    learningWatcher.onDidCreate(() => {
      const target = getWorkspaceTarget();
      if (target) {
        scheduleCostPipelineSync(target, libraryDir);
        refreshAll({ workspaceState: true, forceTree: false });
      }
    });
    context.subscriptions.push(learningWatcher);
  }

  // MCP KPI live update — watch both the workspace log (via VS Code watcher) and
  // the global log (via fs.watch on the directory) so the status bar reflects
  // agent activity within ~2s of a tool call being logged.
  const debouncedMcpKpiRefresh = debounce(() => {
    refreshMcpStatusBars(getWorkspaceTarget());
  }, 2000);

  const mcpWorkspaceLogWatcher = vscode.workspace.createFileSystemWatcher("**/.claude/mcp-usage.jsonl");
  mcpWorkspaceLogWatcher.onDidChange(debouncedMcpKpiRefresh);
  mcpWorkspaceLogWatcher.onDidCreate(debouncedMcpKpiRefresh);
  context.subscriptions.push(mcpWorkspaceLogWatcher);

  // Global log lives outside the workspace — watch its parent directory.
  try {
    const globalLogDir = path.dirname(MCP_USAGE_LOG_PATH);
    const globalLogName = path.basename(MCP_USAGE_LOG_PATH);
    if (fs.existsSync(globalLogDir)) {
      const globalMcpWatcher = fs.watch(globalLogDir, { persistent: false }, (_event, filename) => {
        if (filename === globalLogName) {
          debouncedMcpKpiRefresh();
        }
      });
      context.subscriptions.push({ dispose: () => globalMcpWatcher.close() });
    }
  } catch {
    // Non-fatal — workspace watcher covers the common case.
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
  void stopHookServer();
}