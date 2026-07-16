import * as path from "node:path";
import { SkillAttributionMap } from "./costAttribution";
import { computeAuthorAttribution, SkillAuthorAttribution } from "./teamCostSharing";
import { computeSkillRoi, RoiBand, roiBandFromMultiple, SkillRoiMetrics, sumRoiValue } from "./skillRoi";
import { Manifest } from "./skillOps";
import { readCachedEnrichedRuns } from "./runsStore";
import { computeUsageStats } from "./usageStats";

export interface RepoCostRollup {
  repoPath: string;
  costUsd: number;
  runs: number;
  skills: string[];
}

export interface TeamEconomicsSnapshot {
  workspaceCostUsd: number;
  estimatedMinutesSaved: number;
  estimatedValueUsd: number;
  netRoi: number;
  netRoiBand: RoiBand;
  skillCount: number;
  byRepo: RepoCostRollup[];
  /** Skill-owner proxy from git blame — not the invoking developer. */
  bySkillOwner: Array<{ author: string; costUsd: number; skills: string[] }>;
}

function skillTotalCost(skill: string, attribution: SkillAttributionMap): number {
  const agents = attribution[skill];
  if (!agents) {
    return 0;
  }
  return Object.values(agents).reduce((s, a) => s + (a?.cost ?? 0), 0);
}

/** Workspace-level value estimate and repo rollups (foundation for team dashboard). */
export function buildTeamEconomicsSnapshot(
  target: string,
  libraryDir: string,
  manifest: Manifest,
  attribution: SkillAttributionMap,
  skillOwners?: SkillAuthorAttribution[]
): TeamEconomicsSnapshot {
  const usageMap = new Map(computeUsageStats(target, manifest).map((s) => [s.name, s]));
  const runs = readCachedEnrichedRuns(target);

  let workspaceCostUsd = 0;
  let estimatedMinutesSaved = 0;
  let estimatedValueUsd = 0;
  const roiMetrics: SkillRoiMetrics[] = [];

  for (const skill of Object.keys(attribution)) {
    const cost = skillTotalCost(skill, attribution);
    if (cost <= 0) {
      continue;
    }
    workspaceCostUsd += cost;
    const roi = computeSkillRoi(skill, manifest, usageMap.get(skill), cost);
    roiMetrics.push(roi);
    estimatedMinutesSaved += roi.minutesSaved * (usageMap.get(skill)?.runs ?? 1);
    estimatedValueUsd += sumRoiValue(roi) * (usageMap.get(skill)?.runs ?? 1);
  }

  const netRoi = workspaceCostUsd > 0 ? estimatedValueUsd / workspaceCostUsd : 0;

  const repoMap = new Map<string, RepoCostRollup>();
  for (const run of runs) {
    const repoPath = run.project ? path.basename(run.project) : path.basename(target);
    const key = run.project || target;
    const row = repoMap.get(key) ?? { repoPath, costUsd: 0, runs: 0, skills: [] };
    row.runs += 1;
    row.costUsd += run.cost ?? 0;
    if (!row.skills.includes(run.skill)) {
      row.skills.push(run.skill);
    }
    repoMap.set(key, row);
  }

  const bySkillOwner: TeamEconomicsSnapshot["bySkillOwner"] = [];
  const owners = skillOwners ?? computeAuthorAttribution(target, attribution);
  const authorMap = new Map<string, { costUsd: number; skills: string[] }>();
  for (const row of owners) {
    const cost = skillTotalCost(row.skill, attribution);
    const prev = authorMap.get(row.author) ?? { costUsd: 0, skills: [] };
    prev.costUsd += cost;
    prev.skills.push(row.skill);
    authorMap.set(row.author, prev);
  }
  for (const [author, data] of authorMap) {
    bySkillOwner.push({ author, costUsd: data.costUsd, skills: data.skills.sort() });
  }
  bySkillOwner.sort((a, b) => b.costUsd - a.costUsd);

  return {
    workspaceCostUsd,
    estimatedMinutesSaved: Math.round(estimatedMinutesSaved),
    estimatedValueUsd,
    netRoi: Math.round(netRoi),
    netRoiBand: roiBandFromMultiple(netRoi),
    skillCount: roiMetrics.length,
    byRepo: [...repoMap.values()].sort((a, b) => b.costUsd - a.costUsd),
    bySkillOwner,
  };
}
