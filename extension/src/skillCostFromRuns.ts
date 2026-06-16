import {
  EnrichedRunRecord,
  isUsageBreakdownRun,
  isUsageRunRecord,
  isV2HookRun,
  readEnrichedRunsFromFile,
  runsFilePath,
} from "./runRecording";
import { formatCompactUsd } from "./skillCost";
import { readEnrichedRuns } from "./usageStats";

export type SkillCostMethod = "usage_breakdown" | "reconciled" | "model_blended" | "stored";

export interface SkillCostFromRunsRow {
  skill: string;
  runs: number;
  hookRuns: number;
  tokens: number;
  cost: number;
  usageBreakdownRuns: number;
  /** Runs whose cost was reconciled against an actual-billing CSV import (e.g. Cursor dashboard export). */
  reconciledRuns: number;
  byAgent: Partial<Record<EnrichedRunRecord["agent"], { runs: number; cost: number; tokens: number }>>;
}

export interface SkillCostFromRunsSummary {
  daysBack: number;
  includedRuns: number;
  excludedCollectorRuns: number;
  totalCost: number;
  totalTokens: number;
  skills: SkillCostFromRunsRow[];
}

function shouldIncludeRunForSkillCost(record: EnrichedRunRecord): boolean {
  if (!isUsageRunRecord(record)) {
    return false;
  }
  if (isV2HookRun(record)) {
    return true;
  }
  const source = record.metadata?.source;
  const action = record.action;
  return (
    (source === "self-learning" || source === "extension") &&
    (action === "run" || action === "skill_invoke")
  );
}

function costMethodForRun(record: EnrichedRunRecord): SkillCostMethod {
  const meta = record.metadata ?? {};
  if (meta.cost_method === "reconciled") {
    return "reconciled";
  }
  if (isUsageBreakdownRun(record)) {
    return "usage_breakdown";
  }
  if (meta.cost_method === "model_blended") {
    return "model_blended";
  }
  return "stored";
}

function tokensForRun(record: EnrichedRunRecord): number {
  const usage = record.metadata?.usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      }
    | undefined;
  if (usage) {
    return (
      (usage.input_tokens ?? 0) +
      (usage.output_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0)
    );
  }
  return record.tokens ?? 0;
}

/** Aggregate hook-grounded per-skill costs from runs.jsonl (excludes attribution-collector rows). */
export function summarizeSkillCostsFromRuns(target: string, daysBack = 14): SkillCostFromRunsSummary {
  const cutoff = Date.now() - daysBack * 86_400_000;
  const runs = readEnrichedRuns(target).filter((r) => new Date(r.ts).getTime() >= cutoff);

  let excludedCollectorRuns = 0;
  const bySkill = new Map<string, SkillCostFromRunsRow>();

  for (const record of runs) {
    if (!isUsageRunRecord(record)) {
      excludedCollectorRuns += 1;
      continue;
    }
    if (!shouldIncludeRunForSkillCost(record)) {
      continue;
    }

    const skill = record.skill;
    const bucket: SkillCostFromRunsRow =
      bySkill.get(skill) ??
      ({
        skill,
        runs: 0,
        hookRuns: 0,
        tokens: 0,
        cost: 0,
        usageBreakdownRuns: 0,
        reconciledRuns: 0,
        byAgent: {},
      } satisfies SkillCostFromRunsRow);

    bucket.runs += 1;
    if (isV2HookRun(record)) {
      bucket.hookRuns += 1;
    }
    const tokens = tokensForRun(record);
    bucket.tokens += tokens;
    bucket.cost += record.cost ?? 0;
    const costMethod = costMethodForRun(record);
    if (costMethod === "usage_breakdown") {
      bucket.usageBreakdownRuns += 1;
    } else if (costMethod === "reconciled") {
      bucket.reconciledRuns += 1;
    }

    const agent = record.agent;
    const agentRow = bucket.byAgent[agent] ?? { runs: 0, cost: 0, tokens: 0 };
    agentRow.runs += 1;
    agentRow.cost += record.cost ?? 0;
    agentRow.tokens += tokens;
    bucket.byAgent[agent] = agentRow;

    bySkill.set(skill, bucket);
  }

  const skills = [...bySkill.values()].sort((a, b) => b.cost - a.cost);
  const includedRuns = skills.reduce((s, r) => s + r.runs, 0);

  return {
    daysBack,
    includedRuns,
    excludedCollectorRuns,
    totalCost: skills.reduce((s, r) => s + r.cost, 0),
    totalTokens: skills.reduce((s, r) => s + r.tokens, 0),
    skills,
  };
}

export function topSkillsFromRuns(
  target: string,
  limit = 5,
  daysBack = 14
): { skill: string; cost: number; tokens: number; hookRuns: number; usageBreakdownRuns: number }[] {
  return summarizeSkillCostsFromRuns(target, daysBack)
    .skills.filter((r) => r.cost > 0 || r.runs > 0)
    .slice(0, limit)
    .map((r) => ({
      skill: r.skill,
      cost: r.cost,
      tokens: r.tokens,
      hookRuns: r.hookRuns,
      usageBreakdownRuns: r.usageBreakdownRuns,
    }));
}

export function formatSkillCostAgentBreakdown(row: SkillCostFromRunsRow): string {
  const parts = (["claude", "cursor", "kiro", "copilot"] as const)
    .filter((agent) => {
      const stats = row.byAgent[agent];
      return stats && (stats.cost > 0 || stats.tokens > 0);
    })
    .map((agent) => {
      const stats = row.byAgent[agent]!;
      return `${agent}: ${formatCompactUsd(stats.cost)}`;
    });
  return parts.length > 0 ? `By agent: ${parts.join(", ")}` : "";
}

/** Count attribution-collector rows in runs file (for dashboard warnings). */
export function countCollectorRunsInFile(target: string): number {
  const file = runsFilePath(target);
  const rows = readEnrichedRunsFromFile(file);
  return rows.filter((r) => !isUsageRunRecord(r)).length;
}
