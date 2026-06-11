import { AgentId } from "./agentOps";
import {
  AgentAttribution,
  buildCostAttribution,
  cheapestAgentForSkill,
  SkillAttributionMap,
} from "./costAttribution";
import { getProfileTip, updateCostProfileFromAttribution } from "./costProfiles";
import { tierForSkill } from "./skillCost";
import { loadManifest, Manifest } from "./skillOps";
import { computeUsageStats, readEnrichedRuns, SkillUsageStat } from "./usageStats";

export type OptimizationType = "disable" | "switch_agent" | "cache" | "unused";

export interface OptimizationSuggestion {
  type: OptimizationType;
  skill: string;
  reason: string;
  action: string;
  savings?: number;
  from?: AgentId;
  to?: AgentId;
  priority: number;
}

function mergeAttribution(skills: SkillAttributionMap, transcriptSkills: SkillAttributionMap): SkillAttributionMap {
  const out: SkillAttributionMap = { ...skills };
  for (const [skill, agents] of Object.entries(transcriptSkills)) {
    const existing = out[skill] ?? {};
    for (const [agent, stats] of Object.entries(agents) as [AgentId, AgentAttribution][]) {
      const bucket = existing[agent] ?? { tokens: 0, cost: 0, sessions: 0 };
      bucket.tokens += stats.tokens;
      bucket.cost += stats.cost;
      bucket.sessions += stats.sessions;
      existing[agent] = bucket;
    }
    out[skill] = existing;
  }
  return out;
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
  const attribution = mergeAttribution(built.skills, built.transcriptSkills);
  const usageStats = computeUsageStats(target, m);
  const suggestions: OptimizationSuggestion[] = [];

  updateCostProfileFromAttribution(target, libraryDir, attribution, usageStats);

  for (const [skill, agentData] of Object.entries(attribution)) {
    const totalCost = skillTotalCost(agentData);
    if (totalCost <= 0) {
      continue;
    }

    const runs = Math.max(1, usageCount(skill, usageStats));
    const costPerUse = totalCost / runs;

    if (costPerUse > 1.0 && runs < 5) {
      suggestions.push({
        type: "disable",
        skill,
        reason: `$${costPerUse.toFixed(2)} per use, used only ${runs} time(s)`,
        action: `Disable "${skill}" to save ~$${totalCost.toFixed(2)}`,
        savings: totalCost,
        priority: 90,
      });
    }

    const claude = agentData.claude;
    const cursor = agentData.cursor;
    if (claude && cursor && claude.sessions > 0 && cursor.sessions > 0) {
      const claudePer = claude.cost / claude.sessions;
      const cursorPer = cursor.cost / cursor.sessions;
      if (cursorPer < claudePer * 0.7) {
        const savings = claudePer - cursorPer;
        suggestions.push({
          type: "switch_agent",
          skill,
          from: "claude",
          to: "cursor",
          reason: `Cursor ~$${cursorPer.toFixed(2)}/run vs Claude ~$${claudePer.toFixed(2)}/run`,
          action: `Use Cursor instead of Claude for "${skill}" (save ~$${savings.toFixed(2)}/run)`,
          savings,
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
          if (cheapPer < claudePer * 0.7) {
            suggestions.push({
              type: "switch_agent",
              skill,
              from: "claude",
              to: cheapest,
              reason: `${cheapest} historically cheaper for this skill`,
              action: `Prefer ${cheapest} for "${skill}" (save ~$${(claudePer - cheapPer).toFixed(2)}/run)`,
              savings: claudePer - cheapPer,
              priority: 75,
            });
          }
        }
      }
    }

    const idleDays = daysSinceLastUse(skill, usageStats);
    if (idleDays !== null && idleDays >= 7 && totalCost > 0.5) {
      suggestions.push({
        type: "unused",
        skill,
        reason: `No usage in ${idleDays} days (~$${totalCost.toFixed(2)} attributed)`,
        action: `Consider disabling "${skill}" — idle ${idleDays}d`,
        savings: totalCost * 0.5,
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

  return suggestions.sort((a, b) => b.priority - a.priority || (b.savings ?? 0) - (a.savings ?? 0));
}

export function formatSuggestionsReport(suggestions: OptimizationSuggestion[]): string[] {
  if (suggestions.length === 0) {
    return ["No optimization suggestions yet — need more attribution data in runs.jsonl / transcripts.", ""];
  }
  const lines = ["## Cost optimization suggestions", ""];
  for (const s of suggestions.slice(0, 15)) {
    lines.push(`- **${s.skill}** (${s.type}): ${s.action}`);
    lines.push(`  _${s.reason}_`);
  }
  lines.push("");
  return lines;
}

export function crossAgentSavingsSummary(attribution: SkillAttributionMap): {
  realizedUsd: number;
  potentialUsd: number;
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

  return { realizedUsd: realized, potentialUsd: potential, cursorSkills };
}

export function topExpensiveSkills(
  attribution: SkillAttributionMap,
  limit = 5
): { skill: string; cost: number; tokens: number }[] {
  return Object.entries(attribution)
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
