import * as path from "node:path";
import * as vscode from "vscode";
import { notificationLevel, notifySuggestion } from "./userNotify";
import { assessAttributionHealth } from "./attributionQuality";
import { formatConfidenceBadge } from "./attributionQuality";
import { computeEnabledAgentsCreditUsage } from "./agentOps";
import { readBudgetConfig } from "./budgetConfig";
import { localDateKey } from "./localDate";
import { CreditUsageSummary } from "./usageCost";

/** Minimum prior-week spend before WoW % is shown or used for projection. */
export const MIN_PRIOR_WEEK_USD = 5;

/** Minimum days with spend in the prior 7-day window for a reliable comparison. */
export const MIN_PRIOR_WEEK_DAYS = 2;

/** Cap displayed WoW change so sparse data cannot produce absurd percentages. */
export const MAX_TREND_PCT = 200;

export interface CostTrend {
  direction: "up" | "down" | "flat";
  percentage: number;
  lastWeekUsd: number;
  priorWeekUsd: number;
  /** False when prior window is too sparse/small to compare week-over-week. */
  reliable: boolean;
}

export interface WeeklyCostWindow {
  lastWeekUsd: number;
  priorWeekUsd: number;
  lastWeekDaysWithSpend: number;
  priorWeekDaysWithSpend: number;
}

export function weeklyCostFromSummary(summary: CreditUsageSummary): WeeklyCostWindow {
  const days = [...summary.byDay].sort((a, b) => b.date.localeCompare(a.date));
  const lastWeekDays = days.slice(0, 7);
  const priorWeekDays = days.slice(7, 14);
  const daysWithSpend = (rows: typeof days) => rows.filter((d) => d.cost > 0.001).length;
  return {
    lastWeekUsd: lastWeekDays.reduce((s, d) => s + d.cost, 0),
    priorWeekUsd: priorWeekDays.reduce((s, d) => s + d.cost, 0),
    lastWeekDaysWithSpend: daysWithSpend(lastWeekDays),
    priorWeekDaysWithSpend: daysWithSpend(priorWeekDays),
  };
}

function priorWeekIsReliable(window: WeeklyCostWindow): boolean {
  return window.priorWeekUsd >= MIN_PRIOR_WEEK_USD && window.priorWeekDaysWithSpend >= MIN_PRIOR_WEEK_DAYS;
}

/** WoW trend from a credit-usage summary (newest 7 days vs previous 7). */
export function calculateTrendFromSummary(summary: CreditUsageSummary): CostTrend {
  const window = weeklyCostFromSummary(summary);
  const { lastWeekUsd, priorWeekUsd } = window;

  if (!priorWeekIsReliable(window) || priorWeekUsd <= 0) {
    return { direction: "flat", percentage: 0, lastWeekUsd, priorWeekUsd, reliable: false };
  }

  const change = ((lastWeekUsd - priorWeekUsd) / priorWeekUsd) * 100;
  const capped = Math.max(-MAX_TREND_PCT, Math.min(MAX_TREND_PCT, change));
  let direction: CostTrend["direction"] = "flat";
  if (capped > 5) {
    direction = "up";
  } else if (capped < -5) {
    direction = "down";
  }
  return {
    direction,
    percentage: Math.round(capped),
    lastWeekUsd,
    priorWeekUsd,
    reliable: true,
  };
}

/** Workspace-scoped trend from enabled agent transcripts (matches Cost Dashboard credits). */
export function calculateTrend(target: string, libraryDir: string): CostTrend {
  const summary = computeEnabledAgentsCreditUsage(libraryDir, 14, target);
  return calculateTrendFromSummary(summary);
}

/**
 * Next-week estimate: continue last 7d pace; if reliably trending up, add one capped increment
 * of absolute growth (never compound WoW % on top of itself).
 */
export function predictWeeklyCostFromTrend(trend: CostTrend): number {
  if (!trend.reliable || trend.direction !== "up") {
    return trend.lastWeekUsd;
  }
  const growth = Math.max(0, trend.lastWeekUsd - trend.priorWeekUsd);
  return trend.lastWeekUsd + Math.min(growth, trend.lastWeekUsd * 0.5);
}

export function predictWeeklyCost(target: string, libraryDir: string): number {
  return predictWeeklyCostFromTrend(calculateTrend(target, libraryDir));
}

export function weeklyBudgetUsd(): number {
  const daily = readBudgetConfig().dailyBudgetUsd;
  if (daily <= 0) {
    return 0;
  }
  const override = vscode.workspace.getConfiguration("claudeSkills.optimizer").get<number>("weeklyBudgetUsd", 0);
  return override > 0 ? override : daily * 7;
}

export function formatTrendLabel(trend: CostTrend): string {
  if (!trend.reliable) {
    return trend.lastWeekUsd > 0 ? "Insufficient prior-week data" : "Stable week-over-week";
  }
  if (trend.direction === "up") {
    return `Up ${trend.percentage}% vs prior week`;
  }
  if (trend.direction === "down") {
    return `Down ${Math.abs(trend.percentage)}% vs prior week`;
  }
  return "Stable week-over-week";
}

let lastAlertKey = "";

export async function checkPredictiveCostAlert(target: string, libraryDir: string): Promise<string | null> {
  const trend = calculateTrend(target, libraryDir);
  const health = assessAttributionHealth(target, libraryDir);
  const budget = weeklyBudgetUsd();
  if (budget <= 0) {
    return null;
  }

  const projected = predictWeeklyCostFromTrend(trend);
  const overBudget = trend.lastWeekUsd > budget * 1.2 || projected > budget * 1.2;
  const meaningfulUptrend = trend.reliable && trend.direction === "up" && trend.percentage > 20;

  if (!overBudget && !meaningfulUptrend) {
    return null;
  }

  if (health.confidenceLevel === "low" && !overBudget) {
    return null;
  }

  if (notificationLevel() === "silent") {
    return null;
  }
  if (notificationLevel() === "minimal" && !overBudget) {
    return null;
  }

  const alertKey = `${localDateKey()}|${path.normalize(target)}`;
  if (lastAlertKey === alertKey) {
    return null;
  }
  lastAlertKey = alertKey;

  const confPart = ` (${Math.round(health.confidenceScore * 100)}% ${formatConfidenceBadge(health.confidenceLevel)})`;
  const trendPart = trend.reliable && trend.direction === "up"
    ? ` Costs trending up ${trend.percentage}%.`
    : "";
  const msg =
    `Estimated workspace spend last 7 days: $${trend.lastWeekUsd.toFixed(2)}` +
    ` (projected ~$${projected.toFixed(2)}; weekly budget: $${budget.toFixed(2)}${confPart}).${trendPart} ` +
    `Open Cost Dashboard to review optimizations?`;

  const choice = await notifySuggestion(msg, ["Open Dashboard", "Dismiss"], {
    dedupeKey: alertKey,
  });
  if (choice === "Open Dashboard") {
    await vscode.commands.executeCommand("claudeSkills.showCostDashboard");
  }
  return msg;
}
