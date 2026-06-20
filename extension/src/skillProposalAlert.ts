import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { notificationLevel, notifyBackground } from "./userNotify";
import { computeEnabledAgentsCreditUsage } from "./agentOps";
import { getCurrentBranch } from "./branchProfiles";
import { configFromVsCodeSettings } from "./budgetConfig";
import { formatCompactUsd } from "./skillCost";
import { loadManifest, Manifest } from "./skillOps";
import { readCachedEnrichedRuns } from "./runsStore";
import { writeJsonAtomic } from "./fileWriteCoordination";
import {
  readTaskSkillProposals,
  resolveTaskSkillProposals,
  TaskSkillProposal,
} from "./taskSkillProposals";

export interface SkillProposalAlertConfig {
  enabled: boolean;
  /** Branch/task spend must reach this % of monthly credits before prompting. */
  monthlyCreditThresholdPercent: number;
  /** Monthly credit budget in USD. 0 = derive from daily budget Ã— 30 or workspace 30d spend. */
  monthlyCreditsUsd: number;
}

export interface ScopeUsage {
  scope: "branch" | "task";
  label: string;
  costUsd: number;
  tokens: number;
  usagePercent: number;
}

export interface HighUsageAlertEvaluation {
  scope: ScopeUsage;
  monthlyBaselineUsd: number;
  baselineSource: "setting" | "daily-budget" | "workspace-30d";
  proposals: TaskSkillProposal[];
  toInstall: TaskSkillProposal[];
}

const STATE_REL = path.join(".claude", "learning", "skill-proposal-alert-state.json");

interface AlertState {
  version: 1;
  /** YYYY-MM */
  month: string;
  /** branch name or task hash already prompted */
  notifiedKeys: string[];
}

function monthKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function statePath(target: string): string {
  return path.join(target, STATE_REL);
}

function readAlertState(target: string): AlertState {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(target), "utf-8")) as AlertState;
    if (parsed.version === 1 && parsed.month === monthKey()) {
      return parsed;
    }
  } catch {
    // fresh month or missing file
  }
  return { version: 1, month: monthKey(), notifiedKeys: [] };
}

function writeAlertState(target: string, state: AlertState): void {
  writeJsonAtomic(statePath(target), state);
}

export function skillProposalAlertConfig(): SkillProposalAlertConfig {
  const cfg = vscode.workspace.getConfiguration("claudeSkills.skillFeedback");
  return {
    enabled: cfg.get<boolean>("promptOnHighUsage", true),
    monthlyCreditThresholdPercent: cfg.get<number>("monthlyCreditThresholdPercent", 50),
    monthlyCreditsUsd: cfg.get<number>("monthlyCreditsUsd", 0),
  };
}

function runsInMonth(target: string, month: string): ReturnType<typeof readCachedEnrichedRuns> {
  return readCachedEnrichedRuns(target).filter((r) => r.ts.slice(0, 7) === month);
}

function sumUsage(runs: ReturnType<typeof readCachedEnrichedRuns>): { costUsd: number; tokens: number } {
  let costUsd = 0;
  let tokens = 0;
  for (const r of runs) {
    costUsd += r.cost ?? 0;
    tokens += r.tokens ?? 0;
  }
  return { costUsd, tokens };
}

function branchMonthlyUsage(target: string, branch: string | null, month: string): { costUsd: number; tokens: number } {
  if (!branch) {
    return { costUsd: 0, tokens: 0 };
  }
  const runs = runsInMonth(target, month).filter((r) => r.branch === branch || r.branch == null);
  return sumUsage(runs);
}

function taskScopedUsage(
  target: string,
  sinceIso: string,
  branch: string | null,
  month: string
): { costUsd: number; tokens: number } {
  const sinceMs = new Date(sinceIso).getTime();
  const runs = runsInMonth(target, month).filter((r) => {
    if (new Date(r.ts).getTime() < sinceMs) {
      return false;
    }
    if (!branch) {
      return true;
    }
    return r.branch === branch || r.branch == null;
  });
  return sumUsage(runs);
}

function resolveMonthlyBaselineUsd(
  target: string,
  libraryDir: string,
  manifest: Manifest,
  alertCfg: SkillProposalAlertConfig
): { baselineUsd: number; source: HighUsageAlertEvaluation["baselineSource"] } {
  if (alertCfg.monthlyCreditsUsd > 0) {
    return { baselineUsd: alertCfg.monthlyCreditsUsd, source: "setting" };
  }
  const budget = configFromVsCodeSettings(manifest);
  if (budget.dailyBudgetUsd > 0) {
    return { baselineUsd: budget.dailyBudgetUsd * 30, source: "daily-budget" };
  }
  const workspaceMonthly = computeEnabledAgentsCreditUsage(libraryDir, 30, target);
  const baseline = workspaceMonthly.totalCost > 0 ? workspaceMonthly.totalCost : 1;
  return { baselineUsd: baseline, source: "workspace-30d" };
}

function usagePercent(spentUsd: number, baselineUsd: number): number {
  if (baselineUsd <= 0) {
    return 0;
  }
  return Math.round((spentUsd / baselineUsd) * 100);
}

function taskNotifyKey(taskSummary: string, generatedAt: string): string {
  return `task:${crypto.createHash("sha1").update(`${taskSummary}|${generatedAt}`).digest("hex").slice(0, 12)}`;
}

export function evaluateHighUsageSkillProposalAlert(
  target: string,
  libraryDir: string
): HighUsageAlertEvaluation | null {
  const alertCfg = skillProposalAlertConfig();
  if (!alertCfg.enabled) {
    return null;
  }

  const manifest = loadManifest(libraryDir);
  const month = monthKey();
  const branch = getCurrentBranch(target) ?? null;
  const { baselineUsd, source } = resolveMonthlyBaselineUsd(target, libraryDir, manifest, alertCfg);
  const threshold = alertCfg.monthlyCreditThresholdPercent;

  const branchUsage = branchMonthlyUsage(target, branch, month);
  const branchPct = usagePercent(branchUsage.costUsd, baselineUsd);

  let bestScope: ScopeUsage | null = null;
  if (branch && branchPct >= threshold && (branchUsage.costUsd > 0 || branchUsage.tokens > 0)) {
    bestScope = {
      scope: "branch",
      label: branch,
      costUsd: branchUsage.costUsd,
      tokens: branchUsage.tokens,
      usagePercent: branchPct,
    };
  }

  const taskFile = readTaskSkillProposals(target);
  if (taskFile && taskFile.generatedAt.slice(0, 7) === month) {
    const taskUsage = taskScopedUsage(target, taskFile.generatedAt, branch, month);
    const taskPct = usagePercent(taskUsage.costUsd, baselineUsd);
    if (taskPct >= threshold && (taskUsage.costUsd > 0 || taskUsage.tokens > 0)) {
      if (!bestScope || taskPct > bestScope.usagePercent) {
        bestScope = {
          scope: "task",
          label: taskFile.taskSummary,
          costUsd: taskUsage.costUsd,
          tokens: taskUsage.tokens,
          usagePercent: taskPct,
        };
      }
    }
  }

  if (!bestScope) {
    return null;
  }

  const proposals = resolveTaskSkillProposals(target, manifest);
  const toInstall = proposals.filter((p) => !p.installed);
  if (toInstall.length === 0) {
    return null;
  }

  return {
    scope: bestScope,
    monthlyBaselineUsd: baselineUsd,
    baselineSource: source,
    proposals,
    toInstall,
  };
}

export function shouldNotifyHighUsageAlert(target: string, evaluation: HighUsageAlertEvaluation): boolean {
  const state = readAlertState(target);
  const branch = getCurrentBranch(target);
  const keys: string[] = [];
  if (branch) {
    keys.push(`branch:${branch}`);
  }
  const taskFile = readTaskSkillProposals(target);
  if (taskFile) {
    keys.push(taskNotifyKey(taskFile.taskSummary, taskFile.generatedAt));
  }
  if (keys.length === 0) {
    keys.push(`scope:${evaluation.scope.scope}:${evaluation.scope.label}`);
  }
  return keys.some((k) => !state.notifiedKeys.includes(k));
}

export function markHighUsageAlertNotified(target: string): void {
  const state = readAlertState(target);
  const branch = getCurrentBranch(target);
  const keys = new Set(state.notifiedKeys);
  if (branch) {
    keys.add(`branch:${branch}`);
  }
  const taskFile = readTaskSkillProposals(target);
  if (taskFile) {
    keys.add(taskNotifyKey(taskFile.taskSummary, taskFile.generatedAt));
  }
  writeAlertState(target, { version: 1, month: monthKey(), notifiedKeys: [...keys] });
}

let promptInFlight = false;

export async function maybePromptHighUsageSkillProposals(
  target: string,
  libraryDir: string,
  applyProposals: (names: string[]) => Promise<string[]>
): Promise<void> {
  if (promptInFlight) {
    return;
  }
  const evaluation = evaluateHighUsageSkillProposalAlert(target, libraryDir);
  if (!evaluation || !shouldNotifyHighUsageAlert(target, evaluation)) {
    return;
  }
  if (notificationLevel() === "silent") {
    return;
  }

  promptInFlight = true;
  try {
    const { scope, toInstall, monthlyBaselineUsd } = evaluation;
    const scopeLabel = scope.scope === "branch" ? `branch "${scope.label}"` : `task "${scope.label}"`;
    const installPreview = toInstall
      .slice(0, 4)
      .map((p) => p.name)
      .join(", ");
    const more = toInstall.length > 4 ? ` +${toInstall.length - 4} more` : "";

    const choice = await vscode.window.showWarningMessage(
      `High token use on ${scopeLabel}: ~${scope.usagePercent}% of monthly credits (${formatCompactUsd(scope.costUsd)} of ${formatCompactUsd(monthlyBaselineUsd)}). Apply ${toInstall.length} suggested skill(s) to improve efficiency? (${installPreview}${more})`,
      "Apply suggested skills",
      "View usage report",
      "Not now"
    );

    markHighUsageAlertNotified(target);

    if (choice === "Apply suggested skills") {
      const installed = await applyProposals(toInstall.map((p) => p.name));
      if (installed.length > 0) {
        notifyBackground(`Installed ${installed.length} suggested skill(s): ${installed.join(", ")}.`);
      }
    } else if (choice === "View usage report") {
      await vscode.commands.executeCommand("claudeSkills.showUsageStats");
    }
  } finally {
    promptInFlight = false;
  }
}
