import * as vscode from "vscode";
import { AgentId } from "./agentOps";
import { assessAttributionHealth } from "./attributionHealth";
import {
  AgentAttribution,
  buildCostAttribution,
  cheapestAgentForSkill,
  resolveDisplayAttribution,
  SkillAttributionMap,
} from "./costAttribution";
import { getProfileTip, updateCostProfileFromAttribution } from "./costProfiles";
import { tierForSkill } from "./skillCost";
import { loadManifest, Manifest } from "./skillOps";
import { computeUsageStats, readEnrichedRuns, SkillUsageStat } from "./usageStats";
import { readPipelineCycle, isPipelineReadyForOptimizer } from "./pipelineCycle";
import { buildSystemModeContext } from "./systemMode";
import { applyOptimizerSafetyCaps } from "./optimizerSafety";

export type OptimizationType = "disable" | "switch_agent" | "cache" | "unused";

export interface OptimizerThresholds {
  disableCostPerUseUsd: number;
  disableMaxRuns: number;
  agentSavingsRatio: number;
  unusedIdleDays: number;
  unusedMinCostUsd: number;
}

export function optimizerThresholds(): OptimizerThresholds {
  const cfg = vscode.workspace.getConfiguration("claudeSkills.optimizer");
  return {
    disableCostPerUseUsd: cfg.get<number>("disableCostPerUseUsd", 1.0),
    disableMaxRuns: cfg.get<number>("disableMaxRuns", 5),
    agentSavingsRatio: cfg.get<number>("agentSavingsRatio", 0.7),
    unusedIdleDays: cfg.get<number>("unusedIdleDays", 7),
    unusedMinCostUsd: cfg.get<number>("unusedMinCostUsd", 0.5),
  };
}

export interface OptimizationSuggestion {
  type: OptimizationType;
  skill: string;
  reason: string;
  action: string;
  savings?: number;
  /** Heuristic monthly savings (14d data × 2). */
  monthlySavingsUsd?: number;
  from?: AgentId;
  to?: AgentId;
  priority: number;
}

/** Extrapolate 14-day workspace cost to a rough monthly figure. */
const MONTHLY_EXTRAPOLATION = 2;

function monthlyUsd(amount: number): number {
  return Math.round(amount * MONTHLY_EXTRAPOLATION * 100) / 100;
}

function formatMonthlyAction(base: string, monthlyUsd: number): string {
  return `${base} → save ~$${monthlyUsd.toFixed(0)}/month`;
}

function skillTotalCost(data: Partial<Record<AgentId, AgentAttribution>>): number {
  return Object.values(data).reduce((sum, a) => sum + (a?.cost ?? 0), 0);
}

function usageCount(skill: string, stats: SkillUsageStat[]): number {
  return stats.find((s) => s.name === skill)?.runs ?? 0;
}

function daysSinceLastUse(skill: string, stats: SkillUsageStat[]): number | null {
  return stats.find((s) => s.name === skill)?.daysSinceLastUse ?? null;
}

export function generateOptimizationSuggestions(
  target: string,
  libraryDir: string,
  manifest?: Manifest
): OptimizationSuggestion[] {
  const m = manifest ?? loadManifest(libraryDir);
  const built = buildCostAttribution(target, libraryDir);
  const health = assessAttributionHealth(target, libraryDir);
  const cycle = readPipelineCycle(target);
  const modeCtx = buildSystemModeContext(health, cycle);
  if (!modeCtx.canSuggestOptimizations || !isPipelineReadyForOptimizer(cycle)) {
    return [];
  }
  if (!health.reliable && health.confidenceScore < 0.45) {
    return [];
  }
  const { attribution } = resolveDisplayAttribution(built, target);
  const usageStats = computeUsageStats(target, m);
  const suggestions: OptimizationSuggestion[] = [];
  const thresholds = optimizerThresholds();

  updateCostProfileFromAttribution(target, libraryDir, attribution, usageStats);

  const NON_SKILL_KEYS = new Set(["unattributed", "base_context"]);

  for (const [skill, agentData] of Object.entries(attribution)) {
    if (NON_SKILL_KEYS.has(skill)) {
      continue;
    }
    const totalCost = skillTotalCost(agentData);
    if (totalCost <= 0) {
      continue;
    }

    const runs = Math.max(1, usageCount(skill, usageStats));
    const costPerUse = totalCost / runs;

    if (costPerUse > thresholds.disableCostPerUseUsd && runs < thresholds.disableMaxRuns) {
      const monthly = monthlyUsd(totalCost);
      suggestions.push({
        type: "disable",
        skill,
        reason: `$${costPerUse.toFixed(2)} per use, used only ${runs} time(s)`,
        action: formatMonthlyAction(`Disable "${skill}"`, monthly),
        savings: totalCost,
        monthlySavingsUsd: monthly,
        priority: 90,
      });
    }

    const claude = agentData.claude;
    const cursor = agentData.cursor;
    if (claude && cursor && claude.sessions > 0 && cursor.sessions > 0) {
      const claudePer = claude.cost / claude.sessions;
      const cursorPer = cursor.cost / cursor.sessions;
      if (cursorPer < claudePer * thresholds.agentSavingsRatio) {
        const savings = claudePer - cursorPer;
        const pct = Math.round((1 - cursorPer / claudePer) * 100);
        const monthly = monthlyUsd(savings * runs);
        suggestions.push({
          type: "switch_agent",
          skill,
          from: "claude",
          to: "cursor",
          reason: `Cursor ~$${cursorPer.toFixed(2)}/run vs Claude ~$${claudePer.toFixed(2)}/run`,
          action: formatMonthlyAction(`Switch "${skill}" to Cursor (~${pct}% per run)`, monthly),
          savings,
          monthlySavingsUsd: monthly,
          priority: 80,
        });
      }
    } else {
      const cheapest = cheapestAgentForSkill(skill, attribution);
      const claudeOnly = agentData.claude;
      if (cheapest && cheapest !== "claude" && claudeOnly && claudeOnly.sessions >= 2) {
        const claudePer = claudeOnly.cost / claudeOnly.sessions;
        const cheap = agentData[cheapest];
        if (cheap && cheap.sessions > 0) {
          const cheapPer = cheap.cost / cheap.sessions;
          if (cheapPer < claudePer * thresholds.agentSavingsRatio) {
            const savings = claudePer - cheapPer;
            const pct = Math.round((1 - cheapPer / claudePer) * 100);
            const monthly = monthlyUsd(savings * runs);
            suggestions.push({
              type: "switch_agent",
              skill,
              from: "claude",
              to: cheapest,
              reason: `${cheapest} historically cheaper for this skill`,
              action: formatMonthlyAction(`Switch "${skill}" to ${cheapest} (~${pct}% per run)`, monthly),
              savings,
              monthlySavingsUsd: monthly,
              priority: 75,
            });
          }
        }
      }
    }

    const idleDays = daysSinceLastUse(skill, usageStats);
    if (idleDays !== null && idleDays >= thresholds.unusedIdleDays && totalCost > thresholds.unusedMinCostUsd) {
      const monthly = monthlyUsd(totalCost * 0.5);
      suggestions.push({
        type: "unused",
        skill,
        reason: `No usage in ${idleDays} days (~$${totalCost.toFixed(2)} attributed)`,
        action: formatMonthlyAction(`Disable idle "${skill}"`, monthly),
        savings: totalCost * 0.5,
        monthlySavingsUsd: monthly,
        priority: 70,
      });
    }

    if (tierForSkill(m.skills[skill]?.cost_estimate) === "high" && runs >= 5) {
      const tip = getProfileTip(target, libraryDir, skill);
      suggestions.push({
        type: "cache",
        skill,
        reason: `High-tier skill used ${runs} times`,
        action: tip ?? `Enable knowledge-cache for "${skill}" to reduce repeat exploration tokens`,
        priority: 50,
      });
    }
  }

  return applyOptimizerSafetyCaps(
    suggestions.sort((a, b) => b.priority - a.priority || (b.savings ?? 0) - (a.savings ?? 0)),
    target,
    usageStats
  );
}

export function formatSuggestionsReport(
  suggestions: OptimizationSuggestion[],
  opts?: { attributionSummary?: string }
): string[] {
  if (opts?.attributionSummary) {
    return ["## Cost optimization suggestions", "", opts.attributionSummary, ""];
  }
  if (suggestions.length === 0) {
    return ["No optimization suggestions yet — need more attribution data in runs.jsonl / transcripts.", ""];
  }
  const lines = ["## Cost optimization suggestions", ""];
  for (const s of suggestions.slice(0, 15)) {
    const monthly =
      s.monthlySavingsUsd !== undefined ? ` (~$${s.monthlySavingsUsd.toFixed(0)}/mo est.)` : "";
    lines.push(`- **${s.skill}** (${s.type}): ${s.action}${monthly}`);
    lines.push(`  _${s.reason}_`);
  }
  lines.push("");
  return lines;
}

export function crossAgentSavingsSummary(attribution: SkillAttributionMap): {
  realizedUsd: number;
  /** Speculative heuristic — not measured savings. */
  speculativeUsd: number;
  cursorSkills: number;
} {
  let realized = 0;
  let potential = 0;
  let cursorSkills = 0;

  for (const [, agentData] of Object.entries(attribution)) {
    const claude = agentData.claude;
    const cursor = agentData.cursor;
    if (cursor && cursor.sessions > 0) {
      cursorSkills += 1;
      if (claude && claude.sessions > 0) {
        const claudePer = claude.cost / claude.sessions;
        const cursorPer = cursor.cost / cursor.sessions;
        if (cursorPer < claudePer) {
          realized += (claudePer - cursorPer) * cursor.sessions;
        }
      }
    }
    if (claude && claude.sessions > 0 && (!cursor || cursor.sessions === 0)) {
      const claudePer = claude.cost / claude.sessions;
      potential += claudePer * 0.3 * claude.sessions;
    }
  }

  return { realizedUsd: realized, speculativeUsd: potential, cursorSkills };
}

const DASHBOARD_EXCLUDE = new Set(["unattributed", "base_context"]);

export function topExpensiveSkills(
  attribution: SkillAttributionMap,
  limit = 5
): { skill: string; cost: number; tokens: number }[] {
  return Object.entries(attribution)
    .filter(([skill]) => !DASHBOARD_EXCLUDE.has(skill))
    .map(([skill, agents]) => ({
      skill,
      cost: skillTotalCost(agents),
      tokens: Object.values(agents).reduce((s, a) => s + (a?.tokens ?? 0), 0),
    }))
    .filter((r) => r.cost > 0)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, limit);
}

export function sessionCostSince(target: string, sinceIso: string): number {
  const since = new Date(sinceIso).getTime();
  return readEnrichedRuns(target)
    .filter((r) => new Date(r.ts).getTime() >= since)
    .reduce((sum, r) => sum + r.cost, 0);
}
