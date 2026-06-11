import { tokenCostUsd } from "./costRates";
import { CostEstimateTier, estimateSessionCostUsd, tierForSkill } from "./skillCost";
import { Manifest } from "./skillOps";
import { SkillUsageStat } from "./usageStats";

/** Estimated developer minutes saved per skill invocation (heuristic). */
const TIME_SAVED_MINUTES: Record<CostEstimateTier, number> = {
  low: 3,
  medium: 8,
  high: 15,
};

export type SkillSortMode = "relevance" | "lowest_cost" | "highest_roi" | "best_value";

export interface SkillRoiMetrics {
  sessionCostUsd: number;
  minutesSaved: number;
  roi: number;
  empiricalCostUsd?: number;
}

export function skillRoiMetrics(
  skillName: string,
  manifest: Manifest,
  usageStat?: SkillUsageStat
): SkillRoiMetrics {
  const tier = tierForSkill(manifest.skills[skillName]?.cost_estimate);
  let sessionCostUsd = estimateSessionCostUsd(tier);
  if (usageStat?.totalTokens && usageStat.runs > 0) {
    sessionCostUsd = tokenCostUsd(usageStat.totalTokens / usageStat.runs);
  }
  const minutesSaved = TIME_SAVED_MINUTES[tier];
  const hourlyRate = 75;
  const valueUsd = (minutesSaved / 60) * hourlyRate;
  const roi = sessionCostUsd > 0 ? valueUsd / sessionCostUsd : 0;
  return { sessionCostUsd, minutesSaved, roi: Math.round(roi) };
}

export function formatRoiDescription(metrics: SkillRoiMetrics, highlight = false): string {
  const star = highlight && metrics.roi >= 30 ? " *" : "";
  return `Est. $${metrics.sessionCostUsd.toFixed(2)}/session | ~${metrics.minutesSaved} min saved (heuristic) | ROI: ${metrics.roi}x${star}`;
}

export function compareSkillsForSort(
  a: string,
  b: string,
  mode: SkillSortMode,
  manifest: Manifest,
  usage: Map<string, SkillUsageStat>
): number {
  if (mode === "relevance") {
    return a.localeCompare(b);
  }
  const ma = skillRoiMetrics(a, manifest, usage.get(a));
  const mb = skillRoiMetrics(b, manifest, usage.get(b));
  switch (mode) {
    case "lowest_cost":
      return ma.sessionCostUsd - mb.sessionCostUsd;
    case "highest_roi":
      return mb.roi - ma.roi;
    case "best_value": {
      const aScore = ma.sessionCostUsd > 0 ? ma.roi / ma.sessionCostUsd : 0;
      const bScore = mb.sessionCostUsd > 0 ? mb.roi / mb.sessionCostUsd : 0;
      return bScore - aScore;
    }
    default:
      return a.localeCompare(b);
  }
}
