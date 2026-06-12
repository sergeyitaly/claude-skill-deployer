import { listEffectiveEnabledSkills } from "./skillOps";
import { OptimizationSuggestion } from "./costOptimizer";
import { SkillUsageStat } from "./usageStats";

export interface OptimizerSafetyLimits {
  maxDisableFraction: number;
  topProtectedByRuns: number;
  recentUseHours: number;
  maxAutoApplyPerCycle: number;
}

export const DEFAULT_OPTIMIZER_SAFETY: OptimizerSafetyLimits = {
  maxDisableFraction: 0.3,
  topProtectedByRuns: 3,
  recentUseHours: 24,
  maxAutoApplyPerCycle: 1,
};

function isDisableSuggestion(s: OptimizationSuggestion): boolean {
  return s.type === "disable" || s.type === "unused";
}

function usedWithinHours(stat: SkillUsageStat | undefined, hours: number): boolean {
  if (!stat?.lastUsed) {
    return false;
  }
  return Date.now() - new Date(stat.lastUsed).getTime() < hours * 60 * 60 * 1000;
}

function usageByName(stats: SkillUsageStat[]): Map<string, SkillUsageStat> {
  return new Map(stats.map((s) => [s.name, s]));
}

/** Skills that must never receive disable/unused suggestions. */
export function protectedDisableSkills(
  usageStats: SkillUsageStat[],
  limits: OptimizerSafetyLimits = DEFAULT_OPTIMIZER_SAFETY
): Set<string> {
  const protectedSet = new Set<string>();
  const sorted = [...usageStats].sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));
  for (const stat of sorted.slice(0, limits.topProtectedByRuns)) {
    if (stat.runs > 0) {
      protectedSet.add(stat.name);
    }
  }
  for (const stat of usageStats) {
    if (usedWithinHours(stat, limits.recentUseHours)) {
      protectedSet.add(stat.name);
    }
  }
  return protectedSet;
}

/** Filter and cap disable suggestions so optimizer cannot wipe out active skills. */
export function applyOptimizerSafetyCaps(
  suggestions: OptimizationSuggestion[],
  target: string,
  usageStats: SkillUsageStat[],
  limits: OptimizerSafetyLimits = DEFAULT_OPTIMIZER_SAFETY
): OptimizationSuggestion[] {
  const usage = usageByName(usageStats);
  const protectedSkills = protectedDisableSkills(usageStats, limits);
  const enabledCount = Math.max(1, listEffectiveEnabledSkills(target).length);
  const maxDisables = Math.floor(enabledCount * limits.maxDisableFraction);

  let disableCount = 0;
  const kept: OptimizationSuggestion[] = [];

  for (const suggestion of suggestions) {
    if (!isDisableSuggestion(suggestion)) {
      kept.push(suggestion);
      continue;
    }
    if (protectedSkills.has(suggestion.skill)) {
      continue;
    }
    if (disableCount >= maxDisables) {
      continue;
    }
    disableCount += 1;
    kept.push(suggestion);
  }

  return kept;
}

export function capAutoApplySuggestions(
  suggestions: OptimizationSuggestion[],
  limits: OptimizerSafetyLimits = DEFAULT_OPTIMIZER_SAFETY
): OptimizationSuggestion[] {
  const disableLike = suggestions.filter(isDisableSuggestion);
  const other = suggestions.filter((s) => !isDisableSuggestion(s));
  return [...disableLike.slice(0, limits.maxAutoApplyPerCycle), ...other];
}

export function countDisableSuggestions(suggestions: OptimizationSuggestion[]): number {
  return suggestions.filter(isDisableSuggestion).length;
}
