import * as vscode from "vscode";
import { loadManifest, listSkillStatuses } from "./skillOps";
import {
  listInstalledSkills,
  computeUsageStats,
  computeCrossAgentUsage,
  formatTokenCount,
  runAgentLabel,
} from "./usageStats";
import { formatCompactUsd } from "./skillCost";
import {
  configFromVsCodeSettings as contextFocusFromSettings,
  CONTEXT_FOCUS_LABELS,
} from "./contextFocusConfig";
import {
  configFromVsCodeSettings as practicalFocusFromSettings,
  PRACTICAL_FOCUS_LABELS,
} from "./practicalFocusConfig";
import { BudgetMode, budgetUsagePercent, configFromVsCodeSettings } from "./budgetConfig";
import { localDateKey } from "./localDate";
import { getCurrentBranch } from "./branchProfiles";
import { agentProfilesFeatureActive, detectHostAgentId, hostAgentLabel } from "./agentSkillProfiles";
import { assessAttributionHealth } from "./attributionQuality";
import { getWorkspaceHookStatus } from "./hookOps";
import { buildGlobalTrustBadge, formatGlobalTrustStatusBar } from "./attributionQuality";
import { budgetProgressBar, remainingDailyBudgetUsd, writeTodayCostSnapshot } from "./todayCostSnapshot";
import { spendPrefixForCreditSummary, DayUsage } from "./usageCost";
import { computeEnabledAgentsCreditUsage } from "./agentOps";
import { computeSkillInefficiencyStats } from "./skillFeedback";
import { readProjectProfile } from "./projectProfile";
import {
  formatProjectProfileStatusBarText,
  formatProjectProfileStatusBarTooltip,
} from "./projectProfileDisplay";

// ---------------------------------------------------------------------------
// Module-level state — initialised once from extension.ts activate()
// ---------------------------------------------------------------------------

let _statusBarItem: vscode.StatusBarItem | undefined;
let _usageStatusBarItem: vscode.StatusBarItem | undefined;
let _creditStatusBarItem: vscode.StatusBarItem | undefined;
let _trustStatusBarItem: vscode.StatusBarItem | undefined;
let _budgetModeStatusBarItem: vscode.StatusBarItem | undefined;
let _contextFocusStatusBarItem: vscode.StatusBarItem | undefined;
let _practicalFocusStatusBarItem: vscode.StatusBarItem | undefined;
let _projectTierStatusBarItem: vscode.StatusBarItem | undefined;
let _workspaceFolderStatusBarItem: vscode.StatusBarItem | undefined;

let _getTarget: (() => string | undefined) | undefined;
let _libraryDir = "";

export const BUDGET_MODE_CYCLE: BudgetMode[] = ["economy", "normal", "unlimited"];
export const BUDGET_MODE_LABEL: Record<BudgetMode, string> = {
  economy: "Economy",
  normal: "Normal",
  unlimited: "Unlimited",
};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export interface StatusBarItems {
  statusBarItem: vscode.StatusBarItem;
  usageStatusBarItem: vscode.StatusBarItem;
  creditStatusBarItem: vscode.StatusBarItem;
  trustStatusBarItem: vscode.StatusBarItem;
  budgetModeStatusBarItem: vscode.StatusBarItem;
  contextFocusStatusBarItem: vscode.StatusBarItem;
  practicalFocusStatusBarItem: vscode.StatusBarItem;
  projectTierStatusBarItem: vscode.StatusBarItem;
  workspaceFolderStatusBarItem: vscode.StatusBarItem;
}

export function initStatusBars(
  items: StatusBarItems,
  libraryDir: string,
  getTarget: () => string | undefined,
): void {
  _statusBarItem              = items.statusBarItem;
  _usageStatusBarItem         = items.usageStatusBarItem;
  _creditStatusBarItem        = items.creditStatusBarItem;
  _trustStatusBarItem         = items.trustStatusBarItem;
  _budgetModeStatusBarItem    = items.budgetModeStatusBarItem;
  _contextFocusStatusBarItem  = items.contextFocusStatusBarItem;
  _practicalFocusStatusBarItem = items.practicalFocusStatusBarItem;
  _projectTierStatusBarItem   = items.projectTierStatusBarItem;
  _workspaceFolderStatusBarItem = items.workspaceFolderStatusBarItem;
  _libraryDir = libraryDir;
  _getTarget  = getTarget;
}

// ---------------------------------------------------------------------------
// Refresh functions
// ---------------------------------------------------------------------------

export function refreshStatusBar(): void {
  if (!_statusBarItem || !_getTarget) return;
  const target = _getTarget();
  if (!target) {
    _statusBarItem.hide();
    return;
  }
  const statuses = listSkillStatuses(_libraryDir, target);
  const pending = statuses.filter((s) => s.isRelevant && !s.installedInWorkspace);
  const branch = getCurrentBranch(target);
  const branchSuffix = branch ? ` [${branch}]` : "";
  const hostSuffix = agentProfilesFeatureActive() ? ` · ${hostAgentLabel(detectHostAgentId())}` : "";
  if (pending.length === 0) {
    _statusBarItem.text = `$(check) Claude Skills${branchSuffix}${hostSuffix}`;
    _statusBarItem.tooltip =
      `All relevant Claude skills are installed for this workspace${branch ? ` (branch: ${branch})` : ""}${hostSuffix ? `\nActive IDE profile: ${hostAgentLabel(detectHostAgentId())}` : ""}.`;
  } else {
    _statusBarItem.text = `$(lightbulb) Claude Skills: ${pending.length} suggested${branchSuffix}${hostSuffix}`;
    _statusBarItem.tooltip =
      `${pending.length} relevant skill(s) not yet installed:\n` +
      pending.map((s) => `- ${s.name}`).join("\n") +
      (branch ? `\n\nBranch: ${branch} (skill profile stored in ~/.claude/learning/branch-profiles.json).` : "") +
      "\n\nClick to install.";
  }
  _statusBarItem.command = "claudeSkills.generateForWorkspace";
  _statusBarItem.show();
}

export function refreshCreditStatusBar(target?: string): void {
  if (!_creditStatusBarItem) return;
  const manifest = loadManifest(_libraryDir);
  const config = configFromVsCodeSettings(manifest);
  const summary = computeEnabledAgentsCreditUsage(_libraryDir, 1, target);
  const today = localDateKey();
  const todayRow = summary.byDay.find((d: DayUsage) => d.date === today);
  const totalTokens = todayRow
    ? todayRow.inputTokens + todayRow.outputTokens + todayRow.cacheCreationTokens + todayRow.cacheReadTokens
    : 0;
  const totalCost = todayRow?.cost ?? 0;
  const spendPrefix = spendPrefixForCreditSummary(summary);
  const pct = budgetUsagePercent(totalCost, config);
  writeTodayCostSnapshot(totalCost, totalTokens);

  if (totalTokens === 0) {
    _creditStatusBarItem.text = "$(credit-card) Claude: no usage today";
    _creditStatusBarItem.tooltip =
      "No recorded Claude Code token usage today. Estimates use published API rates for reference (Pro/Max plans are flat-rate).\n\nClick for the full usage report.";
  } else {
    const budgetSuffix =
      config.dailyBudgetUsd > 0 && pct !== null
        ? ` | ${budgetProgressBar(pct)} ${Math.round(pct)}% of ${formatCompactUsd(config.dailyBudgetUsd)}`
        : "";
    const costLabel = spendPrefix === "API" ? "API" : spendPrefix === "Mixed" ? "Mixed" : "Est.";
    _creditStatusBarItem.text = `$(credit-card) ${costLabel} ${formatCompactUsd(totalCost)} today | ${formatTokenCount(totalTokens)}${budgetSuffix}`;
    const remaining = remainingDailyBudgetUsd(config);
    const basisNote =
      spendPrefix === "API"
        ? "Priced from transcript usage at published API rates."
        : spendPrefix === "Mixed"
          ? "Mix of API usage lines and size-based estimates."
          : "Size-based estimate — no usage metadata in today's transcripts.";
    _creditStatusBarItem.tooltip =
      `${costLabel} usage today: ${formatTokenCount(totalTokens)} tokens (~${formatCompactUsd(totalCost)}).` +
      (remaining !== null ? ` ~${formatCompactUsd(remaining)} budget remaining.` : "") +
      ` ${basisNote} Not an actual bill.\n\nClick for the full usage report.`;
  }
  _creditStatusBarItem.command = "claudeSkills.showUsageStats";
  _creditStatusBarItem.show();
}

export function refreshTrustStatusBar(target?: string): void {
  if (!_trustStatusBarItem) return;
  if (!target) {
    _trustStatusBarItem.hide();
    return;
  }
  const health = assessAttributionHealth(target, _libraryDir);
  const hookStatus = getWorkspaceHookStatus(target, _libraryDir);
  const badge = buildGlobalTrustBadge(health, hookStatus);
  _trustStatusBarItem.text = formatGlobalTrustStatusBar(badge);
  _trustStatusBarItem.tooltip = `${badge.label} (${badge.scorePct}%)\n\n${badge.detail}\n\nTranscripts and split attribution are probabilistic — not an API invoice.\n\nClick for the usage report.`;
  _trustStatusBarItem.command = "claudeSkills.showUsageStats";
  _trustStatusBarItem.show();
}

export function refreshBudgetModeStatusBar(): void {
  if (!_budgetModeStatusBarItem) return;
  const manifest = loadManifest(_libraryDir);
  const config = configFromVsCodeSettings(manifest);
  const mode = config.mode;
  const icon = mode === "economy" ? "$(leaf)" : mode === "unlimited" ? "$(rocket)" : "$(shield)";
  _budgetModeStatusBarItem.text = `${icon} ${BUDGET_MODE_LABEL[mode]}`;
  _budgetModeStatusBarItem.tooltip =
    `Budget mode: ${BUDGET_MODE_LABEL[mode]}. Daily cap: ${config.dailyBudgetUsd > 0 ? formatCompactUsd(config.dailyBudgetUsd) : "off"}. ` +
    `${config.highTierSkills.length} high-tier skill(s) tracked.\n\nClick to cycle mode (Economy -> Normal -> Unlimited).`;
  _budgetModeStatusBarItem.command = "claudeSkills.cycleBudgetMode";
  _budgetModeStatusBarItem.show();
}

export function refreshContextFocusStatusBar(): void {
  if (!_contextFocusStatusBarItem) return;
  const config = contextFocusFromSettings();
  if (!config.enabled) {
    _contextFocusStatusBarItem.text = "$(eye-closed) Focus: off";
    _contextFocusStatusBarItem.tooltip =
      "Context focus is disabled. Enable in settings to inject grounding that balances local workspace context vs general LLM knowledge.\n\nClick to cycle focus level.";
    _contextFocusStatusBarItem.command = "claudeSkills.cycleContextFocusLevel";
    _contextFocusStatusBarItem.show();
    return;
  }
  const label = CONTEXT_FOCUS_LABELS[config.level];
  _contextFocusStatusBarItem.text = `$(target) ${label}`;
  _contextFocusStatusBarItem.tooltip =
    `Context focus: ${label}. ${config.autoEscalateOnSessionSize ? "Auto-tightens on large sessions." : "Fixed level."}\n\nClick to cycle (Knowledge-forward -> Balanced -> Local-first -> Strict local).`;
  _contextFocusStatusBarItem.command = "claudeSkills.cycleContextFocusLevel";
  _contextFocusStatusBarItem.show();
}

export function refreshPracticalFocusStatusBar(): void {
  if (!_practicalFocusStatusBarItem) return;
  const config = practicalFocusFromSettings();
  if (!config.enabled) {
    _practicalFocusStatusBarItem.text = "$(light-bulb) Practical: off";
    _practicalFocusStatusBarItem.tooltip =
      "Practical/deployment focus is off. Enable to favor concrete architecture and first-try deploy steps over theoretical advice.\n\nClick to enable (starts at Architecture-first).";
    _practicalFocusStatusBarItem.command = "claudeSkills.cyclePracticalFocusLevel";
    _practicalFocusStatusBarItem.show();
    return;
  }
  const label = PRACTICAL_FOCUS_LABELS[config.level];
  _practicalFocusStatusBarItem.text = `$(rocket) ${label}`;
  _practicalFocusStatusBarItem.tooltip =
    `Practical focus: ${label}. Favors provisionable architecture over hand-wavy theory.\n\nClick to cycle (Exploratory -> Balanced -> Architecture-first -> Deploy-ready).`;
  _practicalFocusStatusBarItem.command = "claudeSkills.cyclePracticalFocusLevel";
  _practicalFocusStatusBarItem.show();
}

export function refreshUsageStatusBar(): void {
  if (!_usageStatusBarItem || !_getTarget) return;
  const target = _getTarget();
  if (!target) {
    _usageStatusBarItem.hide();
    return;
  }
  const manifest = loadManifest(_libraryDir);
  const stats = computeUsageStats(target, manifest);
  const tracked = stats.filter((s) => s.runs > 0);
  const issues = stats.filter((s) => s.rating === "needs-attention" || s.rating === "unused").length;
  const inefficient = computeSkillInefficiencyStats(target, listInstalledSkills(target)).length;

  if (tracked.length === 0 && inefficient === 0) {
    _usageStatusBarItem.text = "$(graph) Skill usage: no data";
    _usageStatusBarItem.tooltip =
      "No recorded skill runs yet (.claude/learning/runs.jsonl). Use the self-learning skill to start tracking outcomes.\n\nClick for the full report.";
  } else {
    const active = stats.filter((s) => s.rating === "active").length;
    const parts: string[] = [];
    if (tracked.length > 0) parts.push(`${active} active`);
    if (issues > 0) parts.push(`${issues} to review`);
    if (inefficient > 0) parts.push(`${inefficient} inefficient`);
    _usageStatusBarItem.text = `$(graph) Skill usage: ${parts.join(", ")}`;
    const cross = computeCrossAgentUsage(stats);
    let tooltip = "Click for the per-skill usage and KPI report.";
    if (cross.activeAgents.length > 1) {
      tooltip += `\nAgents with skill invocations: ${cross.activeAgents.map(runAgentLabel).join(", ")}.`;
    }
    if (cross.multiAgentSkills.length > 0) {
      tooltip += `\n${cross.multiAgentSkills.length} skill(s) used across multiple agents on this workspace.`;
    }
    _usageStatusBarItem.tooltip = tooltip;
  }
  _usageStatusBarItem.command = "claudeSkills.showUsageStats";
  _usageStatusBarItem.show();
}

export function refreshProjectTierStatusBar(target?: string): void {
  if (!_projectTierStatusBarItem) return;
  if (!target) {
    _projectTierStatusBarItem.hide();
    return;
  }
  const profile = readProjectProfile(target);
  if (!profile) {
    _projectTierStatusBarItem.hide();
    return;
  }
  _projectTierStatusBarItem.text = formatProjectProfileStatusBarText(profile);
  _projectTierStatusBarItem.tooltip = formatProjectProfileStatusBarTooltip(profile);
  _projectTierStatusBarItem.command = "claudeSkills.chooseProjectProfile";
  _projectTierStatusBarItem.show();
}
