import { tokenCostUsd, hourlyRateUsd } from "./costRates";
import { ConfidenceLevel } from "./attributionConfidence";
import { CostEstimateTier, estimateSessionCostUsd, tierForSkill } from "./skillCost";
import { Manifest } from "./skillOps";
import { SkillUsageStat } from "./usageStats";

/** Estimated developer minutes saved per skill invocation (heuristic). */
const TIME_SAVED_MINUTES: Record<CostEstimateTier, number> = {
  low: 3,
  medium: 8,
  high: 15,
};

/** Skills with known high time-save impact (minutes per invocation). */
const SKILL_MINUTES_OVERRIDES: Record<string, number> = {
  "deployment-practical": 20,
  "ci-pipeline-debug": 15,
  "terraform-plan-review": 12,
  "azure-rbac-diagnostics": 10,
  "ci-preflight": 10,
};

const DEFAULT_HOURLY_RATE_USD = 75;

export type SkillSortMode = "relevance" | "lowest_cost" | "highest_roi" | "best_value";
export type RoiBand = "HIGH" | "MEDIUM" | "LOW";
export type RoiDataSource = "v2-hook" | "runs" | "heuristic";

export interface SkillRoiMetrics {
  sessionCostUsd: number;
  minutesSaved: number;
  roi: number;
  roiBand: RoiBand;
  confidence: ConfidenceLevel;
  dataSource: RoiDataSource;
  successRate: number | null;
  empiricalCostUsd?: number;
}

export function roiBandFromMultiple(roi: number): RoiBand {
  if (roi >= 20) {
    return "HIGH";
  }
  if (roi >= 8) {
    return "MEDIUM";
  }
  return "LOW";
}

function minutesSavedForSkill(skillName: string, tier: CostEstimateTier, usageStat?: SkillUsageStat): number {
  let minutes = SKILL_MINUTES_OVERRIDES[skillName] ?? TIME_SAVED_MINUTES[tier];
  if (usageStat?.successRate !== null && usageStat?.successRate !== undefined && usageStat.runs >= 3) {
    const factor = 0.6 + (usageStat.successRate / 100) * 0.4;
    minutes = Math.round(minutes * factor);
  }
  return minutes;
}

function confidenceForRoi(dataSource: RoiDataSource, usageStat?: SkillUsageStat): ConfidenceLevel {
  if (dataSource === "v2-hook") {
    return "high";
  }
  if (dataSource === "runs" && (usageStat?.runs ?? 0) >= 3) {
    return "estimated";
  }
  return "low";
}

export function sumRoiValue(metrics: { minutesSaved: number }): number {
  const rate = hourlyRateUsd() || DEFAULT_HOURLY_RATE_USD;
  return (metrics.minutesSaved / 60) * rate;
}

/** Full ROI model for one skill — optional totalCost overrides session average for dashboard rows. */
export function computeSkillRoi(
  skillName: string,
  manifest: Manifest,
  usageStat?: SkillUsageStat,
  totalCostUsd?: number
): SkillRoiMetrics {
  const tier = tierForSkill(manifest.skills[skillName]?.cost_estimate);
  let sessionCostUsd = estimateSessionCostUsd(tier);
  let dataSource: RoiDataSource = "heuristic";

  if (usageStat?.totalTokens && usageStat.runs > 0) {
    sessionCostUsd = tokenCostUsd(usageStat.totalTokens / usageStat.runs);
    dataSource = "runs";
  }
  if (totalCostUsd !== undefined && usageStat?.runs && usageStat.runs > 0) {
    sessionCostUsd = totalCostUsd / usageStat.runs;
  }

  const minutesSaved = minutesSavedForSkill(skillName, tier, usageStat);
  const valueUsd = sumRoiValue({ sessionCostUsd, minutesSaved, roi: 0, roiBand: "LOW", confidence: "low", dataSource, successRate: usageStat?.successRate ?? null });
  const roi = sessionCostUsd > 0 ? valueUsd / sessionCostUsd : 0;

  return {
    sessionCostUsd,
    minutesSaved,
    roi: Math.round(roi),
    roiBand: roiBandFromMultiple(roi),
    confidence: confidenceForRoi(dataSource, usageStat),
    dataSource,
    successRate: usageStat?.successRate ?? null,
    empiricalCostUsd: usageStat?.totalTokens && usageStat.runs > 0 ? sessionCostUsd : undefined,
  };
}

export function skillRoiMetrics(
  skillName: string,
  manifest: Manifest,
  usageStat?: SkillUsageStat
): SkillRoiMetrics {
  return computeSkillRoi(skillName, manifest, usageStat);
}

export function formatRoiDescription(metrics: SkillRoiMetrics, highlight = false): string {
  const star = highlight && metrics.roiBand === "HIGH" ? " *" : "";
  const conf = metrics.confidence === "high" ? "" : ` (${metrics.confidence})`;
  return `Est. $${metrics.sessionCostUsd.toFixed(2)}/session | ~${metrics.minutesSaved} min saved${conf} | ROI: ${metrics.roiBand}${star}`;
}

export function formatRoiDashboardLine(metrics: SkillRoiMetrics, costLabel: string): string {
  return `Saved ~${metrics.minutesSaved} min | ROI: ${metrics.roiBand} | ${costLabel} (confidence: ${metrics.confidence})`;
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

/** Detect v2-hook sourced runs for ROI confidence upgrade. */
export function upgradeRoiConfidenceFromRuns(
  metrics: SkillRoiMetrics,
  v2RunCount: number
): SkillRoiMetrics {
  if (v2RunCount <= 0) {
    return metrics;
  }
  return {
    ...metrics,
    dataSource: "v2-hook",
    confidence: v2RunCount >= 2 ? "high" : "estimated",
  };
}
