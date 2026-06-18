import * as vscode from "vscode";
import { loadManifest } from "./skillOps";
import {
  listInstalledSkills,
  computeUsageStats,
  formatTokenCount,
} from "./usageStats";
import { formatCompactUsd, tierForSkill, sumInstallCostEstimate } from "./skillCost";
import { listSkillStatuses } from "./skillOps";
import {
  configFromVsCodeSettings as contextFocusFromSettings,
  CONTEXT_FOCUS_LABELS,
  ContextFocusLevel,
} from "./contextFocusConfig";
import {
  configFromVsCodeSettings as practicalFocusFromSettings,
  PRACTICAL_FOCUS_LABELS,
  PracticalFocusLevel,
} from "./practicalFocusConfig";
import { BudgetMode, budgetUsagePercent, configFromVsCodeSettings } from "./budgetConfig";
import { isFeatureEnabled } from "./featureFlags";
import { localDateKey } from "./localDate";
import { getCurrentBranch, isGitWorkspace } from "./branchProfiles";
import { agentProfilesFeatureActive, detectHostAgentId, hostAgentLabel } from "./agentSkillProfiles";
import { assessAttributionHealth } from "./attributionHealth";
import { getWorkspaceHookStatus } from "./hookOps";
import { buildGlobalTrustBadge, formatGlobalTrustStatusBar } from "./attributionTrust";
import { budgetProgressBar, remainingDailyBudgetUsd } from "./todayCostSnapshot";
import { spendPrefixForCreditSummary, computeCreditUsageFromRoots, claudeProjectsDir, DayUsage } from "./usageCost";
import { computeSkillInefficiencyStats } from "./skillFeedback";

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

const BUDGET_MODE_CYCLE: BudgetMode[] = ["economy", "normal", "unlimited"];
export const BUDGET_MODE_LABEL: Record<BudgetMode, string> = {
  economy: "Economy",
  normal: "Normal",
  unlimited: "Unlimited",
};

export function refreshStatusBar(
  libraryDir: string,
  statusBarItem: vscode.StatusBarItem,
  target: string | undefined
): void {
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

export function refreshCreditStatusBar(
  libraryDir: string,
  creditStatusBarItem: vscode.StatusBarItem,
  target?: string
): void {
  const manifest = loadManifest(libraryDir);
  const config = configFromVsCodeSettings(manifest);
  const summary = computeCreditUsageFromRoots([claudeProjectsDir()], 1, target);
  const today = localDateKey();
  const todayRow = summary.byDay.find((d: DayUsage) => d.date === today);
  const totalTokens = todayRow
    ? todayRow.inputTokens + todayRow.outputTokens + todayRow.cacheCreationTokens + todayRow.cacheReadTokens
    : 0;
  const totalCost = todayRow?.cost ?? 0;
  const spendPrefix = spendPrefixForCreditSummary(summary);
  const pct = budgetUsagePercent(totalCost, config);

  if (totalTokens === 0) {
    creditStatusBarItem.text = "$(credit-card) Claude: no usage today";
    creditStatusBarItem.tooltip =
      "No recorded Claude Code token usage today. Estimates use published API rates for reference (Pro/Max plans are flat-rate).\n\nClick for the full usage report.";
  } else {
    const budgetSuffix =
      config.dailyBudgetUsd > 0 && pct !== null
        ? ` | ${budgetProgressBar(pct)} ${Math.round(pct)}% of ${formatCompactUsd(config.dailyBudgetUsd)}`
        : "";
    const costLabel = spendPrefix === "API" ? "API" : spendPrefix === "Mixed" ? "Mixed" : "Est.";
    creditStatusBarItem.text = `$(credit-card) ${costLabel} ${formatCompactUsd(totalCost)} today | ${formatTokenCount(totalTokens)}${budgetSuffix}`;
    const remaining = remainingDailyBudgetUsd(config);
    const basisNote =
      spendPrefix === "API"
        ? "Priced from transcript usage at published API rates."
        : spendPrefix === "Mixed"
          ? "Mix of API usage lines and size-based estimates."
          : "Size-based estimate — no usage metadata in today's transcripts.";
    creditStatusBarItem.tooltip =
      `${costLabel} usage today: ${formatTokenCount(totalTokens)} tokens (~${formatCompactUsd(totalCost)}).` +
      (remaining !== null ? ` ~${formatCompactUsd(remaining)} budget remaining.` : "") +
      ` ${basisNote} Not an actual bill.\n\nClick for the full usage report.`;
  }
  creditStatusBarItem.command = "claudeSkills.showUsageStats";
  creditStatusBarItem.show();
}

export function refreshTrustStatusBar(
  libraryDir: string,
  trustStatusBarItem: vscode.StatusBarItem,
  target?: string
): void {
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

export function refreshBudgetModeStatusBar(
  libraryDir: string,
  budgetModeStatusBarItem: vscode.StatusBarItem
): void {
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

export function refreshContextFocusStatusBar(
  contextFocusStatusBarItem: vscode.StatusBarItem
): void {
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

export function refreshPracticalFocusStatusBar(
  practicalFocusStatusBarItem: vscode.StatusBarItem
): void {
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

export function refreshUsageStatusBar(
  libraryDir: string,
  usageStatusBarItem: vscode.StatusBarItem,
  target?: string
): void {
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
    usageStatusBarItem.tooltip = "Click for the per-skill usage and KPI report.";
  }
  usageStatusBarItem.command = "claudeSkills.showUsageStats";
  usageStatusBarItem.show();
}

export const BUDGET_MODE_CYCLE_EXPORT = BUDGET_MODE_CYCLE;
