import * as vscode from "vscode";
import { loadManifest } from "./skillOps";
import { formatTokenCount } from "./usageStats";
import { formatCompactUsd } from "./skillCost";
import { budgetUsagePercent, configFromVsCodeSettings } from "./budgetConfig";
import { localDateKey } from "./localDate";
import { budgetProgressBar, remainingDailyBudgetUsd, writeTodayCostSnapshot } from "./todayCostSnapshot";
import { spendPrefixForCreditSummary, DayUsage } from "./usageCost";
import { computeEnabledAgentsCreditUsage } from "./agentOps";
import { computeApiScore } from "./agentPerformanceIndex";
import { Manifest } from "./skillOps";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Module-level state — initialised once from extension.ts activate()
// ---------------------------------------------------------------------------

let _apiScoreStatusBarItem: vscode.StatusBarItem | undefined;  // was _statusBarItem
let _creditStatusBarItem: vscode.StatusBarItem | undefined;
let _attributionAlertBarItem: vscode.StatusBarItem | undefined; // new — conditional

// Kept for interface compatibility; hidden on init
let _usageStatusBarItem: vscode.StatusBarItem | undefined;
let _projectTierStatusBarItem: vscode.StatusBarItem | undefined;
let _workspaceFolderStatusBarItem: vscode.StatusBarItem | undefined;

let _getTarget: (() => string | undefined) | undefined;
let _libraryDir = "";

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export interface StatusBarItems {
  statusBarItem: vscode.StatusBarItem;           // repurposed as API Score bar
  usageStatusBarItem: vscode.StatusBarItem;      // hidden in v1.1
  creditStatusBarItem: vscode.StatusBarItem;
  projectTierStatusBarItem: vscode.StatusBarItem; // hidden in v1.1
  workspaceFolderStatusBarItem: vscode.StatusBarItem; // hidden in v1.1
  attributionAlertBarItem?: vscode.StatusBarItem; // new in v1.1
}

export function initStatusBars(
  items: StatusBarItems,
  libraryDir: string,
  getTarget: () => string | undefined,
): void {
  _apiScoreStatusBarItem      = items.statusBarItem;
  _usageStatusBarItem         = items.usageStatusBarItem;
  _creditStatusBarItem        = items.creditStatusBarItem;
  _projectTierStatusBarItem   = items.projectTierStatusBarItem;
  _workspaceFolderStatusBarItem = items.workspaceFolderStatusBarItem;
  _attributionAlertBarItem    = items.attributionAlertBarItem;
  _libraryDir = libraryDir;
  _getTarget  = getTarget;

  // Hide bars retired in v1.1 — info moved to Executive Summary in dashboard
  _usageStatusBarItem?.hide();
  _projectTierStatusBarItem?.hide();
  _workspaceFolderStatusBarItem?.hide();
}

// ---------------------------------------------------------------------------
// Bar 1: API Score (replaces skills-count bar)
// ---------------------------------------------------------------------------

export function refreshApiScoreStatusBar(): void {
  if (!_apiScoreStatusBarItem || !_getTarget) return;
  const target = _getTarget();
  if (!target) {
    _apiScoreStatusBarItem.hide();
    return;
  }

  let apiScore = { score: 0, grade: "F" as string, breakdown: {} as Record<string, number> };
  try {
    const manifest = loadManifest(_libraryDir);
    apiScore = computeApiScore(target, manifest);
  } catch {
    // Manifest may not be ready on first activation
    _apiScoreStatusBarItem.text = "$(cloud-download) CSM Setup";
    _apiScoreStatusBarItem.tooltip = "Claude Skills Manager: click to run Setup Wizard.";
    _apiScoreStatusBarItem.command = "claudeSkills.startOnboarding";
    _apiScoreStatusBarItem.show();
    return;
  }

  const { score, grade } = apiScore;
  const icon = score >= 80 ? "$(sparkle)" : score >= 50 ? "$(graph)" : "$(warning)";
  _apiScoreStatusBarItem.text = `${icon} API ${grade} (${score})`;

  const topIssue = getTopIssueFromBreakdown(apiScore.breakdown);
  _apiScoreStatusBarItem.tooltip =
    `Agent Performance Index: ${score}/100 (${grade}).\n` +
    `Attribution: ${apiScore.breakdown.attribution ?? 0}% · Prediction: ${apiScore.breakdown.precision ?? 0}% · ` +
    `Learning: ${apiScore.breakdown.learningRate ?? 0}%\n` +
    (topIssue ? `Top issue: ${topIssue}\n` : "") +
    `\nClick to open the Intelligence Dashboard.`;
  _apiScoreStatusBarItem.command = score >= 50 ? "claudeSkills.showCostDashboard" : "claudeSkills.startOnboarding";
  _apiScoreStatusBarItem.show();
}

/** @deprecated Use refreshApiScoreStatusBar — kept as alias for callers in extension.ts */
export function refreshStatusBar(): void {
  refreshApiScoreStatusBar();
}

function getTopIssueFromBreakdown(breakdown: Record<string, number>): string {
  const weights: [string, string][] = [
    ["attribution",     "Attribution low — run Reset Mis-attributed Cost Data"],
    ["precision",       "Prediction precision low — stop-word or catch-all proposals"],
    ["learningRate",    "Learning rate low — more skill invocations needed"],
    ["skillEfficiency", "ROI low — archive unused skills"],
    ["taskCompletion",  "Skill failures detected — check runs.jsonl"],
  ];
  for (const [key, msg] of weights) {
    if ((breakdown[key] ?? 100) < 50) return msg;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Bar 2: Cost Today (simplified — token count moved to tooltip)
// ---------------------------------------------------------------------------

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
  writeTodayCostSnapshot(target, totalCost, totalTokens);

  if (totalTokens === 0) {
    _creditStatusBarItem.text = "$(credit-card) —";
    _creditStatusBarItem.tooltip =
      "No AI usage recorded today.\n\nClick for the full usage report.";
  } else {
    const remaining = remainingDailyBudgetUsd(config, target);
    const overBudget = pct !== null && pct >= 80;
    const icon = overBudget ? "$(warning)" : "$(credit-card)";
    const costLabel = spendPrefix === "API" ? "" : spendPrefix === "Mixed" ? "~" : "~";
    // Simplified: only show cost; token detail in tooltip
    if (overBudget && config.dailyBudgetUsd > 0) {
      _creditStatusBarItem.text = `${icon} ${costLabel}${formatCompactUsd(totalCost)} / ${formatCompactUsd(config.dailyBudgetUsd)}`;
    } else {
      _creditStatusBarItem.text = `${icon} ${costLabel}${formatCompactUsd(totalCost)}`;
    }
    const basisNote =
      spendPrefix === "API"
        ? "API-measured (transcript usage lines)."
        : spendPrefix === "Mixed"
          ? "Mix of API usage + size estimates."
          : "Size-based estimate. Not an actual bill.";
    _creditStatusBarItem.tooltip =
      `Today: ${formatCompactUsd(totalCost)} · ${formatTokenCount(totalTokens)} tokens.\n` +
      (remaining !== null ? `Budget remaining: ~${formatCompactUsd(remaining)}.\n` : "") +
      `${basisNote}\n\nClick for full usage report.`;
  }
  _creditStatusBarItem.command = "claudeSkills.showCostDashboard";
  _creditStatusBarItem.show();
}

// ---------------------------------------------------------------------------
// Bar 3: Attribution Alert (conditional — only when confidence < 80%)
// ---------------------------------------------------------------------------

export function refreshAttributionAlertBar(target?: string): void {
  if (!_attributionAlertBarItem) return;
  if (!target) {
    _attributionAlertBarItem.hide();
    return;
  }

  const trustFile = path.join(target, ".claude", "learning", "attribution-trust.json");
  let scorePct = 1.0;
  try {
    const raw = JSON.parse(fs.readFileSync(trustFile, "utf-8")) as { scorePct?: number };
    scorePct = raw.scorePct ?? 1.0;
  } catch {
    _attributionAlertBarItem.hide();
    return;
  }

  const pct = Math.round(scorePct);
  if (pct >= 80) {
    _attributionAlertBarItem.hide();
    return;
  }

  const icon = pct < 30 ? "$(error)" : "$(warning)";
  const urgency = pct < 30 ? "!" : "";
  _attributionAlertBarItem.text = `${icon} ATTR ${pct}%${urgency}`;
  _attributionAlertBarItem.tooltip =
    pct < 30
      ? `Attribution broken (${pct}%). Run Reset Mis-attributed Cost Data immediately.\nPer-skill costs are unreliable until fixed.\n\nClick to reset.`
      : `Attribution confidence ${pct}% (target: ≥80%).\nPer-skill costs may not be fully reliable.\n\nClick to reset mis-attributed data.`;
  _attributionAlertBarItem.command = "claudeSkills.resetAttribution";
  _attributionAlertBarItem.show();
}

// ---------------------------------------------------------------------------
// Legacy no-ops — kept so callers in extension.ts don't break
// ---------------------------------------------------------------------------

export function refreshUsageStatusBar(): void {
  _usageStatusBarItem?.hide();
}

export function refreshProjectTierStatusBar(_target?: string): void {
  _projectTierStatusBarItem?.hide();
}
