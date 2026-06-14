import { DEFAULTS, FeatureKey } from "./featureFlags";
import { ProjectProfileType } from "./projectProfile";
import { estimateMonthlyOverhead, TIER_MONTHLY_OVERHEAD_USD } from "./projectProfileDisplay";

/** Team-oriented capability weights (sum = 1). */
export const TEAM_CAPABILITY_WEIGHTS: Partial<Record<FeatureKey, number>> = {
  multiAgent: 0.22,
  attributionCollector: 0.18,
  costIntelligence: 0.15,
  teamCostSharing: 0.12,
  sessionSkillAdaptation: 0.1,
  branchProfiles: 0.08,
  autoOptimizer: 0.05,
  taskSkillFocus: 0.05,
  costAwareSearch: 0.05,
};

export const FULL_STACK_OVERHEAD_USD = TIER_MONTHLY_OVERHEAD_USD["team-multi-agent"];

export type TierBenchScenarioId =
  | "no-extension"
  | "naive-full-stack"
  | "auto-detected-local"
  | "auto-detected-remote"
  | "manual-tier";

export interface TierBenchScenarioInput {
  id: TierBenchScenarioId;
  label: string;
  profileType?: ProjectProfileType;
  enabledFeatures: Partial<Record<FeatureKey, boolean>>;
  /** Measured extension background work (ms p50). */
  pipelineP50Ms: number;
  pipelineSkipped: boolean;
  multiAgentSyncEnabled: boolean;
  featuresEnabledCount: number;
  confidencePct?: number;
  rationale?: string;
}

export interface TierBenchScenarioResult extends TierBenchScenarioInput {
  monthlyOverheadUsd: number;
  teamCapabilityPct: number;
  efficiencyIndex: number;
}

export interface TierBenchComparison {
  autoTier: TierBenchScenarioResult;
  noExtension: TierBenchScenarioResult;
  naiveFullStack: TierBenchScenarioResult;
  /** % of full-stack team capability retained at auto tier. */
  capabilityRetainedPct: number;
  /** % extension overhead saved vs always running full stack. */
  overheadSavingsPct: number;
  /** Net team benefit: capability gained vs no-extension, minus overhead tax vs full stack. */
  netTeamBenefitPct: number;
  /** Extension value for team: capability uplift over no-extension baseline. */
  extensionValueUpliftPct: number;
  /** $/month saved by auto-tier vs naive full stack on this workspace. */
  monthlySavingsUsd: number;
  summary: string;
}

export function countEnabledFeatures(
  enabledFeatures: Partial<Record<FeatureKey, boolean>>,
  useDefaults = true
): number {
  let n = 0;
  for (const key of Object.keys(DEFAULTS) as FeatureKey[]) {
    const on = enabledFeatures[key] ?? (useDefaults ? DEFAULTS[key] : false);
    if (on) {
      n += 1;
    }
  }
  return n;
}

export function teamCapabilityPct(
  enabledFeatures: Partial<Record<FeatureKey, boolean>>,
  useDefaults = true
): number {
  let score = 0;
  for (const [key, weight] of Object.entries(TEAM_CAPABILITY_WEIGHTS) as [FeatureKey, number][]) {
    const on = enabledFeatures[key] ?? (useDefaults ? DEFAULTS[key] : false);
    if (on) {
      score += weight;
    }
  }
  return Math.round(score * 100);
}

export function monthlyOverheadForScenario(
  id: TierBenchScenarioId,
  profileType?: ProjectProfileType
): number {
  if (id === "no-extension") {
    return 0;
  }
  if (profileType) {
    return estimateMonthlyOverhead(profileType);
  }
  return FULL_STACK_OVERHEAD_USD;
}

/** Higher = more team value per dollar of extension overhead. */
export function efficiencyIndex(capabilityPct: number, monthlyOverheadUsd: number): number {
  if (monthlyOverheadUsd <= 0) {
    return capabilityPct;
  }
  return Math.round((capabilityPct / monthlyOverheadUsd) * FULL_STACK_OVERHEAD_USD);
}

export function buildScenarioResult(input: TierBenchScenarioInput): TierBenchScenarioResult {
  const monthlyOverheadUsd = monthlyOverheadForScenario(input.id, input.profileType);
  const teamCapability = teamCapabilityPct(
    input.enabledFeatures,
    input.id !== "no-extension"
  );
  return {
    ...input,
    monthlyOverheadUsd,
    teamCapabilityPct: teamCapability,
    efficiencyIndex: efficiencyIndex(teamCapability, monthlyOverheadUsd),
  };
}

export function compareTierBenefits(
  autoTier: TierBenchScenarioResult,
  noExtension: TierBenchScenarioResult,
  naiveFullStack: TierBenchScenarioResult
): TierBenchComparison {
  const capabilityRetainedPct =
    naiveFullStack.teamCapabilityPct > 0
      ? Math.round((autoTier.teamCapabilityPct / naiveFullStack.teamCapabilityPct) * 100)
      : 0;

  const overheadSavingsPct =
    naiveFullStack.monthlyOverheadUsd > 0
      ? Math.round(
          ((naiveFullStack.monthlyOverheadUsd - autoTier.monthlyOverheadUsd) /
            naiveFullStack.monthlyOverheadUsd) *
            100
        )
      : 0;

  const extensionValueUpliftPct = Math.max(
    0,
    autoTier.teamCapabilityPct - noExtension.teamCapabilityPct
  );

  const overheadTaxPct =
    naiveFullStack.monthlyOverheadUsd > 0
      ? Math.round((autoTier.monthlyOverheadUsd / naiveFullStack.monthlyOverheadUsd) * 100)
      : 0;

  const netTeamBenefitPct = Math.round(
    capabilityRetainedPct * 0.6 + overheadSavingsPct * 0.4
  );

  const monthlySavingsUsd = Math.max(
    0,
    naiveFullStack.monthlyOverheadUsd - autoTier.monthlyOverheadUsd
  );

  const summary = [
    `Auto-tier retains **${capabilityRetainedPct}%** of full-stack team capability`,
    `saves **${overheadSavingsPct}%** extension overhead (~$${monthlySavingsUsd}/mo)`,
    `vs no extension delivers **+${extensionValueUpliftPct}%** team capability uplift`,
    `(overhead tax **${overheadTaxPct}%** of naive full stack).`,
  ].join("; ");

  return {
    autoTier,
    noExtension,
    naiveFullStack,
    capabilityRetainedPct,
    overheadSavingsPct,
    netTeamBenefitPct,
    extensionValueUpliftPct,
    monthlySavingsUsd,
    summary,
  };
}

export function formatTierBenefitMarkdown(
  workspaceDir: string,
  extensionVersion: string,
  scenarios: TierBenchScenarioResult[],
  comparison: TierBenchComparison,
  generatedAt: string
): string {
  const lines = [
    "# Tier benefit benchmark — auto-tier vs no extension",
    "",
    `**Generated:** ${generatedAt}`,
    `**Extension:** v${extensionVersion}`,
    `**Workspace:** ${workspaceDir}`,
    "",
    "## Executive summary (team)",
    "",
    comparison.summary,
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Net team benefit index | **${comparison.netTeamBenefitPct}%** |`,
    `| Team capability retained (auto vs full stack) | **${comparison.capabilityRetainedPct}%** |`,
    `| Extension overhead saved (auto vs full stack) | **${comparison.overheadSavingsPct}%** (~$${comparison.monthlySavingsUsd}/mo) |`,
    `| Capability uplift vs no extension | **+${comparison.extensionValueUpliftPct}%** |`,
    `| Auto-detected tier | **${comparison.autoTier.profileType ?? "—"}** |`,
    "",
    "## Scenarios",
    "",
    "| Scenario | Tier | Team capability | Monthly overhead | Pipeline p50 | Features on | Efficiency |",
    "|---|---|---:|---:|---:|---:|---:|",
  ];

  for (const s of scenarios) {
    lines.push(
      `| ${s.label} | ${s.profileType ?? "—"} | ${s.teamCapabilityPct}% | $${s.monthlyOverheadUsd} | ${
        s.pipelineSkipped ? "skipped" : `${s.pipelineP50Ms.toFixed(1)} ms`
      } | ${s.featuresEnabledCount} | ${s.efficiencyIndex} |`
    );
  }

  lines.push(
    "",
    "## How to read this",
    "",
    "- **no-extension** — baseline with extension absent ($0 overhead, 0% team capability from tier features).",
    "- **naive-full-stack** — extension always on team-multi-agent (worst-case overhead for solo/throwaway repos).",
    "- **auto-detected** — tier from git/repo signals (and optional remote probe); this is what the extension picks for your workspace.",
    "- **Net team benefit index** — weighted blend: 60% capability retained + 40% overhead saved vs naive full stack.",
    "- **Efficiency index** — team capability normalized by monthly overhead (higher is better).",
    "",
    "Run: `cd extension && npm run bench:tier-benefits`",
    ""
  );

  return lines.join("\n");
}
