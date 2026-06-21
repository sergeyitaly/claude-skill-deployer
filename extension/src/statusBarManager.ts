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
import { budgetUsagePercent, configFromVsCodeSettings } from "./budgetConfig";
import { localDateKey } from "./localDate";
import { getCurrentBranch } from "./branchProfiles";
import { agentProfilesFeatureActive, detectHostAgentId, hostAgentLabel } from "./agentSkillProfiles";

import { budgetProgressBar, remainingDailyBudgetUsd, writeTodayCostSnapshot } from "./todayCostSnapshot";
import { spendPrefixForCreditSummary, DayUsage } from "./usageCost";
import { computeEnabledAgentsCreditUsage } from "./agentOps";
import { computeSkillInefficiencyStats } from "./skillFeedback";
import { readProjectProfile } from "./projectProfile";
import {
  formatProjectProfileStatusBarText,
  formatProjectProfileStatusBarTooltip,
} from "./projectProfile";

// ---------------------------------------------------------------------------
// Module-level state — initialised once from extension.ts activate()
// ---------------------------------------------------------------------------

let _statusBarItem: vscode.StatusBarItem | undefined;
let _usageStatusBarItem: vscode.StatusBarItem | undefined;
let _creditStatusBarItem: vscode.StatusBarItem | undefined;

let _projectTierStatusBarItem: vscode.StatusBarItem | undefined;
let _workspaceFolderStatusBarItem: vscode.StatusBarItem | undefined;

let _getTarget: (() => string | undefined) | undefined;
let _libraryDir = "";



// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export interface StatusBarItems {
  statusBarItem: vscode.StatusBarItem;
  usageStatusBarItem: vscode.StatusBarItem;
  creditStatusBarItem: vscode.StatusBarItem;
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
