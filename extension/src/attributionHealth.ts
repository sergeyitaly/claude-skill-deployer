import { computeEnabledAgentsCreditUsage } from "./agentOps";
import { buildCostAttribution, resolveDisplayAttribution } from "./costAttribution";
import { topExpensiveSkills } from "./costOptimizer";

export interface AttributionHealth {
  reliable: boolean;
  staleEqualSplit: boolean;
  highUnattributedRatio: boolean;
  noPerSkillData: boolean;
  summary: string;
}

/** Gate optimizers and apply-actions until attribution is trustworthy enough. */
export function assessAttributionHealth(target: string, libraryDir: string): AttributionHealth {
  const built = buildCostAttribution(target, libraryDir);
  const { staleEqualSplit, attribution } = resolveDisplayAttribution(built);
  const unattributedTokens = Object.values(built.unattributed).reduce((s, t) => s + (t ?? 0), 0);
  const credit = computeEnabledAgentsCreditUsage(libraryDir, 14);
  const highUnattributedRatio =
    credit.totalTokens > 0 && unattributedTokens / credit.totalTokens > 0.3;
  const noPerSkillData = topExpensiveSkills(attribution, 1).length === 0;
  const reliable = !staleEqualSplit && !highUnattributedRatio && !noPerSkillData;

  let summary = "Per-skill attribution looks usable.";
  if (staleEqualSplit) {
    summary = "Equal-split mis-attribution detected — run Reset Mis-attributed Cost Data.";
  } else if (noPerSkillData) {
    summary = "No per-skill cost data yet — install skills and collect runs/transcripts.";
  } else if (highUnattributedRatio) {
    summary = "Too many unattributed tokens — record runs with invoked: true (self-learning skill).";
  }

  return { reliable, staleEqualSplit, highUnattributedRatio, noPerSkillData, summary };
}
