import { computeEnabledAgentsCreditUsage } from "./agentOps";
import { SkillAttributionMap } from "./costAttribution";
import { countV2HookRuns, isV2HookRun, SKILL_INVOKE_HOOK_SOURCE } from "./runRecording";
import { readEnrichedRuns } from "./usageStats";

export type ConfidenceLevel = "high" | "estimated" | "low";

/** Inputs for workspace confidence before graded fields are computed. */
export interface AttributionHealthSignals {
  reliable: boolean;
  staleEqualSplit: boolean;
  highUnattributedRatio: boolean;
  noPerSkillData: boolean;
  v2HookRuns: number;
  summary: string;
}

export type SkillCostSource = "v2-hook" | "runs" | "transcript-split" | "heuristic";

export interface SkillCostConfidence {
  skill: string;
  level: ConfidenceLevel;
  /** 0–1 composite score for sorting and gating. */
  score: number;
  source: SkillCostSource;
}

export interface WorkspaceConfidence {
  score: number;
  level: ConfidenceLevel;
  v2Coverage: number;
  summary: string;
}

function levelFromScore(score: number): ConfidenceLevel {
  if (score >= 0.75) {
    return "high";
  }
  if (score >= 0.45) {
    return "estimated";
  }
  return "low";
}

function sourceForSkill(
  skill: string,
  usesV2HookRuns: boolean,
  inTranscriptSkills: boolean,
  v2RunsForSkill: number
): SkillCostSource {
  if (v2RunsForSkill > 0 || (usesV2HookRuns && !inTranscriptSkills)) {
    return v2RunsForSkill > 0 ? "v2-hook" : "runs";
  }
  if (inTranscriptSkills) {
    return "transcript-split";
  }
  return "heuristic";
}

function scoreForSource(source: SkillCostSource, runs: number, staleEqualSplit: boolean): number {
  if (staleEqualSplit) {
    return 0.15;
  }
  switch (source) {
    case "v2-hook":
      return Math.min(0.95, 0.8 + runs * 0.03);
    case "runs":
      return Math.min(0.85, 0.55 + runs * 0.05);
    case "transcript-split":
      return 0.4;
    default:
      return 0.25;
  }
}

/** Per-skill confidence for displayed cost rows. */
export function assessSkillCostConfidence(
  target: string,
  attribution: SkillAttributionMap,
  options: {
    usesV2HookRuns: boolean;
    staleEqualSplit: boolean;
    transcriptSkills?: SkillAttributionMap;
  }
): Map<string, SkillCostConfidence> {
  const runs = readEnrichedRuns(target);
  const v2BySkill = new Map<string, number>();
  const runsBySkill = new Map<string, number>();
  for (const r of runs) {
    runsBySkill.set(r.skill, (runsBySkill.get(r.skill) ?? 0) + 1);
    if (isV2HookRun(r)) {
      v2BySkill.set(r.skill, (v2BySkill.get(r.skill) ?? 0) + 1);
    }
  }

  const transcriptSkills = options.transcriptSkills ?? {};
  const out = new Map<string, SkillCostConfidence>();

  for (const skill of Object.keys(attribution)) {
    const v2Count = v2BySkill.get(skill) ?? 0;
    const runCount = runsBySkill.get(skill) ?? 0;
    const inTranscript = skill in transcriptSkills;
    const source = sourceForSkill(skill, options.usesV2HookRuns, inTranscript, v2Count);
    const score = scoreForSource(source, Math.max(v2Count, runCount), options.staleEqualSplit);
    out.set(skill, {
      skill,
      level: levelFromScore(score),
      score,
      source,
    });
  }
  return out;
}

/** Workspace-level confidence — complements boolean `reliable` with a graded score. */
export function assessWorkspaceConfidence(
  target: string,
  libraryDir: string,
  health: AttributionHealthSignals,
  unattributedTokens: number
): WorkspaceConfidence {
  const credit = computeEnabledAgentsCreditUsage(libraryDir, 14, target);
  const v2Runs = countV2HookRuns(target);
  const totalRuns = readEnrichedRuns(target).length;
  const v2Coverage = totalRuns > 0 ? v2Runs / totalRuns : v2Runs > 0 ? 1 : 0;
  const unattributedRatio = credit.totalTokens > 0 ? unattributedTokens / credit.totalTokens : 0;

  let score = 0.35;
  if (health.reliable) {
    score = 0.82;
  } else if (v2Runs > 0) {
    score = 0.62;
  } else if (!health.noPerSkillData) {
    score = 0.48;
  }

  score += v2Coverage * 0.12;
  score -= Math.min(0.35, unattributedRatio * 0.5);
  if (health.staleEqualSplit) {
    score = Math.min(score, 0.2);
  }
  score = Math.max(0, Math.min(1, score));

  const level = levelFromScore(score);
  let summary = "Cost intelligence is best-effort, not an API invoice.";
  if (level === "high") {
    summary = `High confidence — v2 hooks logged ${v2Runs} invoke(s); per-skill costs are measured where hooks fired.`;
  } else if (level === "estimated") {
    summary = `Estimated — mix of hooks/transcripts; ${Math.round(unattributedRatio * 100)}% tokens unattributed to skills.`;
  } else {
    summary = health.summary;
  }

  return { score, level, v2Coverage, summary };
}

export function formatConfidenceBadge(level: ConfidenceLevel): string {
  switch (level) {
    case "high":
      return "high confidence";
    case "estimated":
      return "estimated";
    default:
      return "low confidence";
  }
}

export function formatSkillCostWithConfidence(costLabel: string, conf: SkillCostConfidence | undefined): string {
  if (!conf) {
    return `${costLabel} (confidence: estimated)`;
  }
  return `${costLabel} (confidence: ${formatConfidenceBadge(conf.level)})`;
}

/** Exported for tests — documents v2 hook source id. */
export { SKILL_INVOKE_HOOK_SOURCE };
