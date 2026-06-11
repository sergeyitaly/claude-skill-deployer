import * as vscode from "vscode";
import { readBudgetConfig } from "./budgetConfig";
import { computeCreditUsage } from "./usageCost";

export interface CostTrend {
  direction: "up" | "down" | "flat";
  percentage: number;
  lastWeekUsd: number;
  priorWeekUsd: number;
}

export function weeklyCostFromSummary(daysBack = 14): { lastWeekUsd: number; priorWeekUsd: number } {
  const summary = computeCreditUsage(daysBack);
  const days = [...summary.byDay].sort((a, b) => b.date.localeCompare(a.date));
  const lastWeek = days.slice(0, 7).reduce((s, d) => s + d.cost, 0);
  const priorWeek = days.slice(7, 14).reduce((s, d) => s + d.cost, 0);
  return { lastWeekUsd: lastWeek, priorWeekUsd: priorWeek };
}

export function calculateTrend(): CostTrend {
  const { lastWeekUsd, priorWeekUsd } = weeklyCostFromSummary(14);
  if (priorWeekUsd <= 0) {
    return { direction: "flat", percentage: 0, lastWeekUsd, priorWeekUsd };
  }
  const change = ((lastWeekUsd - priorWeekUsd) / priorWeekUsd) * 100;
  let direction: CostTrend["direction"] = "flat";
  if (change > 5) {
    direction = "up";
  } else if (change < -5) {
    direction = "down";
  }
  return { direction, percentage: Math.round(change), lastWeekUsd, priorWeekUsd };
}

export function predictWeeklyCost(): number {
  const trend = calculateTrend();
  if (trend.direction === "up" && trend.percentage > 0) {
    return trend.lastWeekUsd * (1 + trend.percentage / 100);
  }
  return trend.lastWeekUsd;
}

export function weeklyBudgetUsd(): number {
  const daily = readBudgetConfig().dailyBudgetUsd;
  if (daily <= 0) {
    return 0;
  }
  const override = vscode.workspace.getConfiguration("claudeSkills.optimizer").get<number>("weeklyBudgetUsd", 0);
  return override > 0 ? override : daily * 7;
}

let lastAlertDate = "";

export async function checkPredictiveCostAlert(): Promise<string | null> {
  const trend = calculateTrend();
  const budget = weeklyBudgetUsd();
  if (budget <= 0) {
    return null;
  }

  if (trend.direction !== "up" || trend.percentage <= 20) {
    return null;
  }

  const projected = predictWeeklyCost();
  if (projected <= budget * 1.2) {
    return null;
  }

  const today = new Date().toISOString().slice(0, 10);
  if (lastAlertDate === today) {
    return null;
  }
  lastAlertDate = today;

  const msg =
    `Costs trending up ${trend.percentage}%. Projected: $${projected.toFixed(2)} (weekly budget: $${budget.toFixed(2)}). ` +
    `Open Cost Dashboard to review optimizations?`;

  const choice = await vscode.window.showWarningMessage(msg, "Open Dashboard", "Dismiss");
  if (choice === "Open Dashboard") {
    await vscode.commands.executeCommand("claudeSkills.showCostDashboard");
  }
  return msg;
}
