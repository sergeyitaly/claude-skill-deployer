/**
 * Command Registry Module
 * Centralizes all Claude Skills command registrations for better maintainability.
 * Extracted from extension.ts to improve code organization.
 */

import * as vscode from "vscode";
import { globalSkillsDir } from "./skillOps";
import { invalidateDetectionCache } from "./skillOps";
import { disableWorkspaceSkill, enableWorkspaceSkill, copySkill, generateForWorkspace } from "./skillOps";
import { setSkillOverride } from "./skillOps";
import { listSkillStatuses, loadManifest } from "./skillOps";
import {
  computeUsageStats,
  formatUsageReport,
  formatUsageReportHtml,
  enrichUsageStatsWithAttribution,
  listInstalledSkills,
  computeCrossAgentUsage,
  computeSuggestedSkills,
  ensureLearningDir,
  formatTokenCount,
  runAgentLabel,
} from "./usageStats";
import { computeSkillInefficiencyStats } from "./skillFeedback";
import { readTaskSkillProposals, resolveTaskSkillProposals, ensureWorkspaceTaskProposals } from "./taskSkillProposals";
import {
  evaluateHighUsageSkillProposalAlert,
  maybePromptHighUsageSkillProposals,
} from "./skillProposalAlert";
import {
  formatAgentInstallSummary,
  agentCapabilityLines,
  generateForAllAgents,
  installLibraryToAllAgents,
  installSkillToAllWorkspaceAgents,
  removeSkillFromAllWorkspaceAgents,
  shouldSyncGlobalToAll,
  shouldSyncWorkspaceToAll,
  syncWorkspaceSkillsToAllAgents,
  agentMirrorsNeedSync,
  invalidateWorkspaceSyncFingerprint,
  mirrorLearningArtifacts,
  computeEnabledAgentsCreditUsage,
} from "./agentOps";
import { propagateWorkspaceSkillChange, ensureAttributionHooksActive, autoInstallAttributionHooksEnabled } from "./workspaceSkillSync";
import { applyHostOnlyTierMirrorCleanup } from "./agentMirrorSync";
import { ensureWorkspaceCachesWarm, warmupWorkspaceCaches } from "./cacheWarmup";
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
import { BudgetMode, budgetUsagePercent, configFromVsCodeSettings, syncBudgetConfigToDisk } from "./budgetConfig";
import {
  CONTEXT_FOCUS_LABELS,
  ContextFocusLevel,
  configFromVsCodeSettings as contextFocusFromSettings,
  nextContextFocusLevel,
  syncContextFocusConfigToDisk,
} from "./contextFocusConfig";
import { syncAttributionTrustConfig } from "./attributionTrustConfig";
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
  loadBranchProfile,
  saveBranchProfile,
} from "./branchProfiles";
import {
  getWorkspaceHookStatus,
  installAttributionHooks,
  installCostControlHooks,
  installMcpForceHook,
  installMcpGateHook,
  installCliLoopGuardHook,
  removeCliLoopGuardHook,
  isCliLoopGuardConfigured,
  installDirCacheGuardHook,
  removeDirCacheGuardHook,
  isDirCacheGuardConfigured,
  installOfficialSkillsSessionHook,
  removeMcpForceHooks,
  installFileSplitAdvisorHook,
  isFileSplitAdvisorConfigured,
} from "./hookOps";
import {
  buildProjectProfile,
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
  buildProjectProfileWithRemoteProbe,
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
import { computeEfficiencyMetrics, formatEfficiencyReport, TelemetryScope } from "./efficiencyMetrics";
import { clearMcpLogs, workspaceMcpLogPath, summarizeMcpUsage, summarizeCrossSessionPatterns } from "./mcpUsageLog";
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
import { promptGetStarted, integrationTestMode } from "./criticalFixes";
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
import { scheduleCostPipelineSync } from "./costPipelineScheduler";
import { buildSystemModeContext } from "./systemMode";
import { readPipelineCycle } from "./pipelineCycle";
import { ErrorRecovery, repairIssues, scanForIssues } from "./errorRecovery";
import { recordActivation, recordError, recordFeatureUse } from "./analytics";
import { runV1Migration } from "./migration";
import { autoMigrateProxyIfActive, revertMcpOptimizer } from "./mcpAutoOptimizer";
import { applyMcpAutoFixesForTarget } from "./mcpAutoFix";
import { startMcpForceWatchdog } from "./mcpForceWatchdog";
import { checkMcpHealth } from "./mcpHealth";
import {
  enableOfficialFilesystemServer,
  disableOfficialFilesystemServer,
  refreshFilesystemAllowedDirs,
  getFilesystemMcpServerStatus,
  needsFilesystemMcpSetup,
  syncFilesystemServerBinary,
} from "./mcpOfficial";
import { enableOfficialCliServer, disableOfficialCliServer, getCliMcpServerStatus, needsCliMcpSetup, refreshCliConfig, syncCliServerBinary } from "./mcpCli";
import {
  enableMcpForcePermissions,
  injectMcpForceClaude,
  isMcpForceActive,
  removeMcpForceClaudeBlock,
  revertMcpForcePermissions,
} from "./mcpForce";
import { notifyUserSuccess, notifyUserWarn, notifySuggestion, notifyBackground } from "./userNotify";
import { resolveWorkspaceTarget } from "./workspaceTarget";
import {
  planSkillSetResolution,
  formatSkillSetResolverPlan,
  executeSkillSetResolution,
} from "./skillSetResolver";
import { installLibraryToGlobal } from "./skillOps";

/**
 * Registers all Claude Skills extension commands.
 * This centralizes command registration logic for better maintainability.
 */
export function registerAllCommands(
  context: vscode.ExtensionContext,
  libraryDir: string,
  getWorkspaceTarget: () => string | undefined,
  log: (line: string) => void,
  revealOutputPanel: () => void,
  maybeRevealOutputPanel: () => void,
  refreshAll: () => void,
  refreshLight: () => void
): void {
  // Push all command registrations to context.subscriptions
  context.subscriptions.push(
    // All commands will be inserted here in the next step
    // The old implementation from extension.ts lines 1500-3328 will replace this comment
  );
}
