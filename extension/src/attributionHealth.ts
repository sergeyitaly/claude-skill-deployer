import { computeEnabledAgentsCreditUsage } from "./agentOps";
import { buildCostAttribution, resolveDisplayAttribution } from "./costAttribution";
import { topExpensiveSkills } from "./costOptimizer";
import { countV2HookRuns } from "./runRecording";

export interface AttributionHealth {
  reliable: boolean;
  staleEqualSplit: boolean;
  highUnattributedRatio: boolean;
  noPerSkillData: boolean;
  v2HookRuns: number;
  summary: string;
}

/** Gate optimizers and apply-actions until attribution is trustworthy enough. */
export function assessAttributionHealth(target: string, libraryDir: string): AttributionHealth {
  const built = buildCostAttribution(target, libraryDir);
  const v2HookRuns = countV2HookRuns(target);
  const { staleEqualSplit, attribution } = resolveDisplayAttribution(built, target);
  const unattributedTokens = Object.values(built.unattributed).reduce((s, t) => s + (t ?? 0), 0);
  const credit = computeEnabledAgentsCreditUsage(libraryDir, 14, target);
  const highUnattributedRatio =
    v2HookRuns === 0 && credit.totalTokens > 0 && unattributedTokens / credit.totalTokens > 0.3;
  const noPerSkillData = topExpensiveSkills(attribution, 1).length === 0;
  const reliable = !staleEqualSplit && !highUnattributedRatio && !noPerSkillData;

  let summary = "Per-skill attribution looks usable.";
  if (staleEqualSplit) {
    summary = "Equal-split mis-attribution detected — run Reset Mis-attributed Cost Data.";
  } else if (noPerSkillData && v2HookRuns === 0) {
    summary =
      "No per-skill cost data yet — enable Attribution Hooks (v2) or collect runs/transcripts.";
  } else if (noPerSkillData) {
    summary = "Invoke skills in Claude Code to populate v2 hook runs, then reopen the dashboard.";
  } else if (highUnattributedRatio) {
    summary = "Too many unattributed tokens — enable Attribution Hooks or record invoked: true runs.";
  } else if (v2HookRuns > 0) {
    summary = `Attribution v2 active (${v2HookRuns} explicit skill invoke(s) logged).`;
  }

  return { reliable, staleEqualSplit, highUnattributedRatio, noPerSkillData, v2HookRuns, summary };
}
