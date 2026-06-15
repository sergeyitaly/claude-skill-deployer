import { assessClaudeVscodeAttributionGap } from "./claudeVscodeAttributionGap";
import { computeEnabledAgentsCreditUsage } from "./agentOps";
import { buildCostAttribution, resolveDisplayAttribution } from "./costAttribution";
import { topExpensiveSkills } from "./costOptimizer";
import { countV2HookRuns } from "./runRecording";
import { summarizeSkillCostsFromRuns } from "./skillCostFromRuns";
import { assessWorkspaceConfidence } from "./attributionConfidence";
import { computeGeneralApiSpend } from "./generalApiSpend";

export interface AttributionHealth {
  reliable: boolean;
  staleEqualSplit: boolean;
  highUnattributedRatio: boolean;
  noPerSkillData: boolean;
  v2HookRuns: number;
  /** 0–1 graded trust score (see attributionConfidence). */
  confidenceScore: number;
  confidenceLevel: "high" | "estimated" | "low";
  summary: string;
}

/** Gate optimizers and apply-actions until attribution is trustworthy enough. */
export function assessAttributionHealth(target: string, libraryDir: string): AttributionHealth {
  const built = buildCostAttribution(target, libraryDir);
  const v2HookRuns = countV2HookRuns(target);
  const { staleEqualSplit, attribution } = resolveDisplayAttribution(built, target);
  const generalApi = computeGeneralApiSpend(target, libraryDir, 14);
  const legacyUnattributed = generalApi.legacyUnattributedTokens;
  const credit = computeEnabledAgentsCreditUsage(libraryDir, 14, target);
  const highUnattributedRatio =
    legacyUnattributed > 0 &&
    credit.totalTokens > 0 &&
    legacyUnattributed / credit.totalTokens > 0.3;
  const hookSkillCosts = summarizeSkillCostsFromRuns(target, 14);
  const noPerSkillData =
    hookSkillCosts.includedRuns === 0 && topExpensiveSkills(attribution, 1).length === 0;
  const reliable = !staleEqualSplit && !highUnattributedRatio && !noPerSkillData;

  let summary = "Per-skill attribution looks usable.";
  if (staleEqualSplit) {
    summary = "Equal-split mis-attribution detected — run Reset Mis-attributed Cost Data.";
  } else if (noPerSkillData && v2HookRuns === 0) {
    const gap = assessClaudeVscodeAttributionGap(target);
    if (gap.detected) {
      summary = gap.recommendation || gap.summary;
    } else {
      summary =
        "No per-skill cost data yet — enable Attribution Hooks (v2) or collect runs/transcripts.";
    }
  } else if (noPerSkillData) {
    summary = "Invoke skills in Claude Code to populate v2 hook runs, then reopen the dashboard.";
  } else if (highUnattributedRatio) {
    summary = "Legacy unattributed bucket inflated — run Reset Mis-attributed Cost Data (pre-1.0.49 collector).";
  } else if (v2HookRuns > 0) {
    summary = `Attribution v2 active (${v2HookRuns} explicit skill invoke(s) logged).`;
  }

  const workspaceConf = assessWorkspaceConfidence(target, libraryDir, {
    reliable,
    staleEqualSplit,
    highUnattributedRatio,
    noPerSkillData,
    v2HookRuns,
    summary,
  }, legacyUnattributed);

  return {
    reliable,
    staleEqualSplit,
    highUnattributedRatio,
    noPerSkillData,
    v2HookRuns,
    confidenceScore: workspaceConf.score,
    confidenceLevel: workspaceConf.level,
    summary: workspaceConf.summary,
  };
}
