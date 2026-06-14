import { DEFAULTS, FeatureKey } from "./featureFlags";
import { formatCompactUsd } from "./skillCost";
import {
  PROFILE_TYPE_LABELS,
  ProjectProfileFile,
  ProjectProfileType,
  projectProfileApplyTierEnabled,
} from "./projectProfile";

/** Uppercase badge labels for status bar and dashboard. */
export const PROFILE_TYPE_BADGE: Record<ProjectProfileType, string> = {
  "solo-dev": "SOLO DEV",
  "team-multi-agent": "TEAM MULTI-AGENT",
  "budget-sensitive": "BUDGET-SENSITIVE",
  enterprise: "ENTERPRISE",
  throwaway: "THROWAWAY",
};

/** Key tier features surfaced in UI (order matters). */
export const TIER_FEATURE_KEYS: FeatureKey[] = [
  "multiAgent",
  "attributionCollector",
  "costIntelligence",
  "sessionSkillAdaptation",
  "autoOptimizer",
  "taskSkillFocus",
];

export const TIER_FEATURE_LABELS: Record<(typeof TIER_FEATURE_KEYS)[number], string> = {
  multiAgent: "Multi-agent sync",
  attributionCollector: "Attribution collector",
  costIntelligence: "Cost intelligence",
  sessionSkillAdaptation: "Session skill adaptation",
  autoOptimizer: "Auto-optimizer",
  taskSkillFocus: "Task skill focus",
};

/**
 * Estimated monthly extension overhead (extra tokens + background work), not user AI invoice.
 * Baseline is team-multi-agent full stack (~15% overhead in tier matrix).
 */
export const TIER_MONTHLY_OVERHEAD_USD: Record<ProjectProfileType, number> = {
  "team-multi-agent": 28,
  "budget-sensitive": 18,
  "solo-dev": 9,
  enterprise: 11,
  throwaway: 2,
};

const FULL_STACK_OVERHEAD_USD = TIER_MONTHLY_OVERHEAD_USD["team-multi-agent"];

export interface ProjectProfileView {
  badge: string;
  label: string;
  tierFeaturesApplied: boolean;
  features: { key: FeatureKey; label: string; on: boolean }[];
  monthlyOverheadUsd: number;
  monthlySavingsUsd: number;
  confidencePct: number;
  rationale: string;
}

export function tierFeatureEnabled(profile: ProjectProfileFile, key: FeatureKey): boolean {
  return profile.enabledFeatures[key] ?? DEFAULTS[key];
}

export function estimateMonthlyOverhead(profileType: ProjectProfileType): number {
  return TIER_MONTHLY_OVERHEAD_USD[profileType] ?? FULL_STACK_OVERHEAD_USD;
}

export function estimateMonthlySavings(profile: ProjectProfileFile): number {
  const overhead = estimateMonthlyOverhead(profile.profileType);
  return Math.max(0, FULL_STACK_OVERHEAD_USD - overhead);
}

export function buildProjectProfileView(profile: ProjectProfileFile): ProjectProfileView {
  return {
    badge: PROFILE_TYPE_BADGE[profile.profileType],
    label: PROFILE_TYPE_LABELS[profile.profileType],
    tierFeaturesApplied: projectProfileApplyTierEnabled(),
    features: TIER_FEATURE_KEYS.map((key) => ({
      key,
      label: TIER_FEATURE_LABELS[key],
      on: tierFeatureEnabled(profile, key),
    })),
    monthlyOverheadUsd: estimateMonthlyOverhead(profile.profileType),
    monthlySavingsUsd: estimateMonthlySavings(profile),
    confidencePct: Math.round(profile.confidence * 100),
    rationale: profile.rationale,
  };
}

export function formatProjectProfileStatusBarText(profile: ProjectProfileFile): string {
  const view = buildProjectProfileView(profile);
  const icon =
    profile.profileType === "team-multi-agent"
      ? "$(organization)"
      : profile.profileType === "throwaway"
        ? "$(zap)"
        : profile.profileType === "budget-sensitive"
          ? "$(credit-card)"
          : "$(person)";
  if (view.monthlySavingsUsd >= 1) {
    return `${icon} ${view.badge} · saves ~${formatCompactUsd(view.monthlySavingsUsd)}/mo`;
  }
  return `${icon} ${view.badge}`;
}

export function formatProjectProfileStatusBarTooltip(profile: ProjectProfileFile): string {
  const view = buildProjectProfileView(profile);
  const lines = [
    `Project type detected: ${view.badge}`,
    view.rationale,
    "",
    `Tier presets: ${view.tierFeaturesApplied ? "ON (applied to this workspace)" : "OFF (VS Code settings only)"}`,
    `Confidence: ${view.confidencePct}%`,
    "",
    "Features:",
    ...view.features.map((f) => `  ${f.label}: ${f.on ? "ON" : "OFF"}`),
    "",
    `Estimated extension overhead: ~${formatCompactUsd(view.monthlyOverheadUsd)}/month`,
  ];
  if (view.monthlySavingsUsd >= 1) {
    lines.push(`Estimated savings vs full stack: ~${formatCompactUsd(view.monthlySavingsUsd)}/month`);
  } else {
    lines.push("Full stack enabled for this project tier.");
  }
  lines.push("", "Click to view details or change tier.");
  return lines.join("\n");
}

export function formatProjectProfileSummaryBlock(profile: ProjectProfileFile): string {
  const view = buildProjectProfileView(profile);
  const lines = [
    `=== Project tier: ${view.badge} ===`,
    view.rationale,
    "",
    `Tier presets: ${view.tierFeaturesApplied ? "ON" : "OFF"}`,
    `Confidence: ${view.confidencePct}%`,
    "",
    "Features:",
    ...view.features.map((f) => `  ${f.on ? "[ON] " : "[OFF]"} ${f.label}`),
    "",
    `Estimated extension overhead: ~${formatCompactUsd(view.monthlyOverheadUsd)}/month`,
  ];
  if (view.monthlySavingsUsd >= 1) {
    lines.push(`Estimated savings vs full stack: ~${formatCompactUsd(view.monthlySavingsUsd)}/month`);
  }
  lines.push(
    "",
    `AI tools: ${profile.detectedFrom.aiTools.join(", ")}`,
    `Team size (30d): ${profile.detectedFrom.teamSize}`,
    `Cost tracking: ${profile.costTracking}`
  );
  return lines.join("\n");
}

export function formatProjectProfileDashboardHtml(profile: ProjectProfileFile): string {
  const view = buildProjectProfileView(profile);
  const featureRows = view.features
    .map(
      (f) =>
        `<li><span class="hook-badge ${f.on ? "hook-on" : "hook-off"}">${f.on ? "ON" : "OFF"}</span> ${f.label}</li>`
    )
    .join("");
  const savingsLine =
    view.monthlySavingsUsd >= 1
      ? `<p class="note">Estimated savings vs full stack: <b>~${formatCompactUsd(view.monthlySavingsUsd)}/month</b> (extension tokens + background work)</p>`
      : `<p class="note">Full stack enabled for this tier — all key features ON.</p>`;
  return `
  <div class="panel">
    <h2>Project tier</h2>
    <div class="stat-grid">
      <div class="stat-pill"><b>Detected</b><span class="val">${view.badge}</span></div>
      <div class="stat-pill"><b>Tier presets</b><span class="val">${view.tierFeaturesApplied ? "ON" : "off"}</span></div>
      <div class="stat-pill"><b>Overhead</b><span class="val">~${formatCompactUsd(view.monthlyOverheadUsd)}/mo</span></div>
      ${
        view.monthlySavingsUsd >= 1
          ? `<div class="stat-pill"><b>Saves</b><span class="val roi-high">~${formatCompactUsd(view.monthlySavingsUsd)}/mo</span></div>`
          : `<div class="stat-pill"><b>Stack</b><span class="val">full</span></div>`
      }
      <div class="stat-pill"><b>Confidence</b><span class="val">${view.confidencePct}%</span></div>
    </div>
    <p class="note">${view.rationale}</p>
    ${savingsLine}
    <ul class="hook-list">${featureRows}</ul>
  </div>`;
}

export function formatProjectProfileNotifyMessage(profile: ProjectProfileFile): string {
  const view = buildProjectProfileView(profile);
  if (view.monthlySavingsUsd >= 1) {
    return `Project type: ${view.badge}. Tier presets ON — est. savings ~${formatCompactUsd(view.monthlySavingsUsd)}/mo vs full stack.`;
  }
  return `Project type: ${view.badge}. Tier presets ON — full feature stack for multi-agent teams.`;
}
