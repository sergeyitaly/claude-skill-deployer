import { ConfidenceLevel, SkillCostConfidence, SkillCostSource } from "./attributionConfidence";
import { AttributionHealth } from "./attributionHealth";
import { WorkspaceHookStatus } from "./hookOps";
import { RoiBand } from "./skillRoi";

export type GlobalTrustTier = "reliable" | "estimated" | "low";

export interface GlobalTrustBadge {
  tier: GlobalTrustTier;
  label: string;
  shortLabel: string;
  detail: string;
  scorePct: number;
}

export interface SkillTrustLine {
  roiBand?: RoiBand;
  confidencePct: number;
  level: ConfidenceLevel;
  sourceLabel: string;
  summary: string;
}

function tierFromLevel(level: ConfidenceLevel, hooksActive: boolean): GlobalTrustTier {
  if (level === "high" && hooksActive) {
    return "reliable";
  }
  if (level === "low") {
    return "low";
  }
  return "estimated";
}

/** Global attribution trust badge for status bar and report headers. */
export function buildGlobalTrustBadge(
  health: Pick<AttributionHealth, "confidenceLevel" | "confidenceScore" | "summary" | "v2HookRuns">,
  hookStatus?: Pick<WorkspaceHookStatus, "attribution">
): GlobalTrustBadge {
  const hooksActive =
    (hookStatus?.attribution.allConfigured && (hookStatus.attribution.applicableCount ?? 0) > 0) ||
    health.v2HookRuns > 0;
  const tier = tierFromLevel(health.confidenceLevel, hooksActive);
  const scorePct = Math.round(health.confidenceScore * 100);

  switch (tier) {
    case "reliable":
      return {
        tier,
        label: "Reliable (hooks active)",
        shortLabel: "Reliable",
        detail: health.summary,
        scorePct,
      };
    case "estimated":
      return {
        tier,
        label: "Estimated (transcripts)",
        shortLabel: "Estimated",
        detail:
          health.summary +
          " Per-skill costs are probabilistic when hooks did not fire — not an API invoice.",
        scorePct,
      };
    default:
      return {
        tier: "low",
        label: "Low confidence",
        shortLabel: "Low confidence",
        detail: health.summary + " Enable Attribution v2 hooks for measured per-skill costs.",
        scorePct,
      };
  }
}

export function formatGlobalTrustStatusBar(badge: GlobalTrustBadge): string {
  return `$(shield) Trust: ${badge.shortLabel} (${badge.scorePct}%)`;
}

export function formatGlobalTrustBannerHtml(badge: GlobalTrustBadge): string {
  const cls = badge.tier === "reliable" ? "trust-reliable" : badge.tier === "estimated" ? "trust-estimated" : "trust-low";
  return `<div class="trust-banner ${cls}"><b>${badge.label}</b> · ${badge.scorePct}% · <span class="trust-detail">${badge.detail}</span></div>`;
}

export function skillCostSourceLabel(source: SkillCostSource): string {
  switch (source) {
    case "v2-hook":
      return "Hook-based";
    case "runs":
      return "Self-learning runs";
    case "transcript-split":
      return "Transcript-based";
    default:
      return "Heuristic";
  }
}

/** Per-skill trust line for usage report rows — e.g. ROI: HIGH · Confidence: 62% (Transcript-based). */
export function buildSkillTrustLine(
  conf: SkillCostConfidence | undefined,
  roiBand?: RoiBand
): SkillTrustLine {
  const level = conf?.level ?? "estimated";
  const score = conf?.score ?? 0.4;
  const source = conf?.source ?? "heuristic";
  const confidencePct = Math.round(score * 100);
  const sourceLabel = skillCostSourceLabel(source);
  const roiPart = roiBand ? `ROI: ${roiBand}` : undefined;
  const confPart = `Confidence: ${confidencePct}% (${sourceLabel})`;
  return {
    roiBand,
    confidencePct,
    level,
    sourceLabel,
    summary: roiPart ? `${roiPart} · ${confPart}` : confPart,
  };
}

export function formatSkillTrustPlain(line: SkillTrustLine): string {
  return line.summary;
}

export function formatSkillTrustHtml(line: SkillTrustLine): string {
  const roi =
    line.roiBand != null
      ? `<span class="roi-${line.roiBand.toLowerCase()}">ROI: ${line.roiBand}</span>`
      : "";
  const conf = `<span class="conf-${line.level}">Confidence: ${line.confidencePct}% (${line.sourceLabel})</span>`;
  return [roi, conf].filter(Boolean).join(" · ");
}
