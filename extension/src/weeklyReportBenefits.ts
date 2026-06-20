import { SkillAttributionMap } from "./costAttribution";
import { OptimizationSuggestion, crossAgentSavingsSummary } from "./costOptimizer";
import { DEFAULTS } from "./featureFlags";
import {
  buildProjectProfile,
  ProjectProfileFile,
  readProjectProfile,
} from "./projectProfile";
import {
  buildProjectProfileView,
  PROFILE_TYPE_BADGE,
  TIER_FEATURE_KEYS,
  tierFeatureEnabled,
} from "./projectProfileDisplay";
import { isUsageRunRecord, isV2HookRun } from "./runsStore";
import { formatCompactUsd } from "./skillCost";
import {
  buildScenarioResult,
  compareTierBenefits,
  countEnabledFeatures,
  TierBenchComparison,
} from "./tierBenefitBenchmark";
import { formatCrossAgentUsageBrief, readEnrichedRuns, SkillUsageStat } from "./usageStats";

export interface WeeklyRunsBenefits {
  totalRuns: number;
  successCount: number;
  failureCount: number;
  successRatePct: number | null;
  distinctSkills: number;
  v2HookRuns: number;
  v2Sessions: number;
  topReliable: Array<{ name: string; runs: number; successRate: number }>;
  needsAttention: Array<{ name: string; runs: number; successRate: number }>;
}

export function summarizeWeeklyRunsBenefits(target: string, daysBack = 7): WeeklyRunsBenefits {
  const cutoff = Date.now() - daysBack * 86_400_000;
  const runs = readEnrichedRuns(target).filter(
    (r) => isUsageRunRecord(r) && new Date(r.ts).getTime() >= cutoff
  );

  let successCount = 0;
  let failureCount = 0;
  const skills = new Set<string>();
  const v2Sessions = new Set<string>();
  let v2HookRuns = 0;

  for (const run of runs) {
    skills.add(run.skill);
    if (run.success) {
      successCount += 1;
    } else {
      failureCount += 1;
    }
    if (isV2HookRun(run)) {
      v2HookRuns += 1;
      if (run.session_id) {
        v2Sessions.add(run.session_id);
      }
    }
  }

  const totalRuns = runs.length;
  const successRatePct = totalRuns > 0 ? (successCount / totalRuns) * 100 : null;

  return {
    totalRuns,
    successCount,
    failureCount,
    successRatePct,
    distinctSkills: skills.size,
    v2HookRuns,
    v2Sessions: v2Sessions.size,
    topReliable: [],
    needsAttention: [],
  };
}

function skillOutcomeHighlights(stats: SkillUsageStat[]): Pick<WeeklyRunsBenefits, "topReliable" | "needsAttention"> {
  const topReliable = stats
    .filter((s) => s.runs >= 3 && (s.successRate ?? 0) >= 80)
    .sort((a, b) => b.runs - a.runs || (b.successRate ?? 0) - (a.successRate ?? 0))
    .slice(0, 5)
    .map((s) => ({ name: s.name, runs: s.runs, successRate: s.successRate ?? 0 }));

  const needsAttention = stats
    .filter((s) => s.runs >= 3 && (s.successRate ?? 100) < 60)
    .sort((a, b) => (a.successRate ?? 0) - (b.successRate ?? 0) || b.runs - a.runs)
    .slice(0, 5)
    .map((s) => ({ name: s.name, runs: s.runs, successRate: s.successRate ?? 0 }));

  return { topReliable, needsAttention };
}

export function compareTierBenefitsFromProfile(profile: ProjectProfileFile): TierBenchComparison {
  const noExtension = buildScenarioResult({
    id: "no-extension",
    label: "No extension",
    enabledFeatures: {},
    pipelineP50Ms: 0,
    pipelineSkipped: true,
    multiAgentSyncEnabled: false,
    featuresEnabledCount: 0,
  });
  const naiveFullStack = buildScenarioResult({
    id: "naive-full-stack",
    label: "Naive full stack",
    profileType: "team-multi-agent",
    enabledFeatures: { ...DEFAULTS },
    pipelineP50Ms: 50,
    pipelineSkipped: false,
    multiAgentSyncEnabled: true,
    featuresEnabledCount: countEnabledFeatures(DEFAULTS),
  });
  const current = buildScenarioResult({
    id: "manual-tier",
    label: "Current tier",
    profileType: profile.profileType,
    enabledFeatures: profile.enabledFeatures,
    pipelineP50Ms: 0,
    pipelineSkipped: false,
    multiAgentSyncEnabled: true,
    featuresEnabledCount: countEnabledFeatures(profile.enabledFeatures),
    confidencePct: Math.round(profile.confidence * 100),
    rationale: profile.rationale,
  });
  return compareTierBenefits(current, noExtension, naiveFullStack);
}

function enabledTierFeatureLines(profile: ProjectProfileFile): string[] {
  const on = TIER_FEATURE_KEYS.filter((key) => tierFeatureEnabled(profile, key));
  if (on.length === 0) {
    return ["- Tier presets active — minimal feature stack (low overhead mode)"];
  }
  const labels: Record<(typeof TIER_FEATURE_KEYS)[number], string> = {
    autoOptimizer: "Auto-optimizer",
    communityBenchmarks: "Community benchmarks",
    prCostEstimate: "PR cost estimate",
  };
  return on.map((key) => `- ${labels[key]} — enabled for this project tier`);
}

function optimizationBenefitLines(suggestions: OptimizationSuggestion[]): string[] {
  if (suggestions.length === 0) {
    return [];
  }
  const lines = ["### Further savings opportunities", ""];
  let monthlyTotal = 0;
  for (const s of suggestions.slice(0, 5)) {
    const monthly = s.monthlySavingsUsd ?? 0;
    monthlyTotal += monthly;
    const monthlyNote = monthly > 0 ? ` (~${formatCompactUsd(monthly)}/mo est.)` : "";
    lines.push(`- **${s.skill}**: ${s.action}${monthlyNote}`);
    lines.push(`  _${s.reason}_`);
  }
  if (monthlyTotal > 0) {
    lines.push("", `- **Potential additional savings:** ~${formatCompactUsd(monthlyTotal)}/mo if applied`);
  }
  lines.push("");
  return lines;
}

/** Markdown sections describing measured extension value from logs + tier state. */
export function formatWeeklyBenefitsLines(
  target: string,
  attribution: SkillAttributionMap,
  usageStats: SkillUsageStat[],
  suggestions: OptimizationSuggestion[]
): string[] {
  const profile = readProjectProfile(target) ?? buildProjectProfile(target);
  const view = buildProjectProfileView(profile);
  const tierCmp = compareTierBenefitsFromProfile(profile);
  const runs = summarizeWeeklyRunsBenefits(target, 7);
  const outcomes = skillOutcomeHighlights(usageStats);
  const crossSavings = crossAgentSavingsSummary(attribution);

  const planLine = profile.userPlan && profile.userPlan !== "accept-detected"
    ? ` (plan: ${profile.userPlan.replace(/-/g, " ")})`
    : profile.manualOverride
      ? " (manual tier lock)"
      : " (auto-detected)";

  const lines = [
    "## Extension benefits this week",
    "",
    "### Project tier (from extension logs)",
    `- **Current tier:** ${PROFILE_TYPE_BADGE[profile.profileType]}${planLine}`,
    `- **Team capability delivered:** ${tierCmp.autoTier.teamCapabilityPct}% of full multi-agent stack`,
    `- **Capability uplift vs no extension:** +${tierCmp.extensionValueUpliftPct}%`,
    `- **Extension overhead:** ~${formatCompactUsd(view.monthlyOverheadUsd)}/month`,
  ];

  if (view.monthlySavingsUsd > 0) {
    lines.push(
      `- **Overhead saved vs naive full stack:** ~${formatCompactUsd(view.monthlySavingsUsd)}/month (${tierCmp.overheadSavingsPct}% less background work)`
    );
  }

  lines.push(
    `- **Net benefit index:** ${tierCmp.netTeamBenefitPct}% (capability retained + overhead saved)`,
    "",
    "### Features active for your tier",
    ...enabledTierFeatureLines(profile),
    "",
    "### Skill outcomes (runs.jsonl, last 7 days)",
  );

  if (runs.totalRuns === 0) {
    lines.push(
      "- No skill runs logged yet — install skill-invoke hooks or use the self-learning skill to record outcomes.",
      ""
    );
  } else {
    const rate =
      runs.successRatePct === null ? "n/a" : `${runs.successRatePct.toFixed(0)}% success`;
    lines.push(
      `- **${runs.totalRuns}** skill run(s) recorded (${rate})`,
      `- **${runs.distinctSkills}** distinct skill(s) used`,
      `- **${runs.v2HookRuns}** hook-tracked invocation(s) across **${runs.v2Sessions}** session(s)`
    );
    const skillNames = [
      ...new Set(
        readEnrichedRuns(target)
          .filter((r) => isUsageRunRecord(r) && new Date(r.ts).getTime() >= Date.now() - 7 * 86_400_000)
          .map((r) => r.skill)
      ),
    ].sort();
    if (skillNames.length > 0 && skillNames.length <= 12) {
      lines.push(`- Skills: ${skillNames.join(", ")}`);
    }
    if (outcomes.topReliable.length > 0) {
      lines.push("", "**Most reliable skills:**");
      for (const s of outcomes.topReliable) {
        lines.push(`- ${s.name}: ${Math.round(s.successRate)}% over ${s.runs} run(s)`);
      }
    }
    if (outcomes.needsAttention.length > 0) {
      lines.push("", "**Needs attention (check .claude/learning/patterns.md):**");
      for (const s of outcomes.needsAttention) {
        lines.push(`- ${s.name}: ${Math.round(s.successRate)}% over ${s.runs} run(s)`);
      }
    }
    lines.push("");
  }

  if (crossSavings.realizedUsd > 0 || crossSavings.cursorSkills > 0) {
    lines.push(
      "### Cross-agent savings (measured from attribution)",
      `- Cursor used for **${crossSavings.cursorSkills}** skill(s) where Claude also ran`,
      `- **Measured savings vs Claude:** ~${formatCompactUsd(crossSavings.realizedUsd)} (14d attribution window)`,
    );
    if (crossSavings.speculativeUsd > 0) {
      lines.push(`- **Additional opportunity:** ~${formatCompactUsd(crossSavings.speculativeUsd)} if more skills move to Cursor`);
    }
    lines.push("");
  }

  const crossBrief = formatCrossAgentUsageBrief(usageStats);
  if (crossBrief.length > 0) {
    lines.push(...crossBrief);
  }

  lines.push(...optimizationBenefitLines(suggestions));

  return lines;
}
