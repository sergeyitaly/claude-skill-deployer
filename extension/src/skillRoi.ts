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

export function sumRoiValue(metrics: { minutesSaved: number }): number {
  const rate = hourlyRateUsd() || DEFAULT_HOURLY_RATE_USD;
  return (metrics.minutesSaved / 60) * rate;
}

function resolveMeasuredSessionCost(usageStat?: SkillUsageStat): {
  sessionCostUsd?: number;
  dataSource?: RoiDataSource;
  confidence?: ConfidenceLevel;
} {
  if (!usageStat || usageStat.runs <= 0) {
    return {};
  }
  if (usageStat.avgCostUsd && usageStat.avgCostUsd > 0) {
    const measured = usageStat.measuredRuns ?? 0;
    const allMeasured = measured >= usageStat.runs;
    const mostlyMeasured = measured >= Math.ceil(usageStat.runs / 2);
    return {
      sessionCostUsd: usageStat.avgCostUsd,
      dataSource: allMeasured || mostlyMeasured ? "v2-hook" : "runs",
      confidence: measured >= 2 ? "high" : measured >= 1 ? "estimated" : "low",
    };
  }
  if (usageStat.totalCost && usageStat.totalCost > 0) {
    return {
      sessionCostUsd: usageStat.totalCost / usageStat.runs,
      dataSource: "runs",
      confidence: usageStat.runs >= 3 ? "estimated" : "low",
    };
  }
  if (usageStat.totalTokens && usageStat.totalTokens > 0) {
    return {
      sessionCostUsd: tokenCostUsd(usageStat.totalTokens / usageStat.runs),
      dataSource: "runs",
      confidence: usageStat.runs >= 3 ? "estimated" : "low",
    };
  }
  return {};
}

/** Human-readable per-session cost for skills tree and reports. */
export function formatSessionCostLabel(metrics: SkillRoiMetrics): string {
  const amount = `$${metrics.sessionCostUsd.toFixed(2)}/session`;
  if (metrics.dataSource === "heuristic") {
    return `~${amount} (catalog)`;
  }
  if (metrics.dataSource === "v2-hook" && metrics.confidence === "high") {
    return `${amount} (API)`;
  }
  if (metrics.dataSource === "v2-hook") {
    return `${amount} (API)`;
  }
  if (metrics.dataSource === "runs") {
    return `${amount} (logged)`;
  }
  return `Est. ${amount}`;
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
  let confidence: ConfidenceLevel = "low";

  const measured = resolveMeasuredSessionCost(usageStat);
  if (measured.sessionCostUsd !== undefined) {
    sessionCostUsd = measured.sessionCostUsd;
    dataSource = measured.dataSource ?? "runs";
    confidence = measured.confidence ?? "estimated";
  }
  if (totalCostUsd !== undefined && usageStat?.runs && usageStat.runs > 0) {
    sessionCostUsd = totalCostUsd / usageStat.runs;
    if ((usageStat.measuredRuns ?? 0) > 0) {
      dataSource = "v2-hook";
      confidence = (usageStat.measuredRuns ?? 0) >= 2 ? "high" : "estimated";
    } else {
      dataSource = "runs";
    }
  }

  const minutesSaved = minutesSavedForSkill(skillName, tier, usageStat);
  const valueUsd = sumRoiValue({ minutesSaved });
  const roi = sessionCostUsd > 0 ? valueUsd / sessionCostUsd : 0;

  return {
    sessionCostUsd,
    minutesSaved,
    roi: Math.round(roi),
    roiBand: roiBandFromMultiple(roi),
    confidence,
    dataSource,
    successRate: usageStat?.successRate ?? null,
    empiricalCostUsd:
      measured.sessionCostUsd !== undefined || (usageStat?.totalCost && usageStat.runs > 0)
        ? sessionCostUsd
        : undefined,
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
  const costLine = formatSessionCostLabel(metrics);
  const conf =
    metrics.dataSource === "heuristic" && metrics.confidence !== "high"
      ? ` (${metrics.confidence})`
      : "";
  return `${costLine} | ~${metrics.minutesSaved} min saved${conf} | ROI: ${metrics.roiBand}${star}`;
}

export function formatRoiDashboardLine(metrics: SkillRoiMetrics, costLabel: string): string {
  const basis =
    metrics.dataSource === "v2-hook" && metrics.confidence === "high"
      ? "API-priced"
      : metrics.dataSource === "runs"
        ? "logged"
        : metrics.confidence;
  return `Saved ~${metrics.minutesSaved} min | ROI: ${metrics.roiBand} | ${costLabel} (${basis})`;
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
