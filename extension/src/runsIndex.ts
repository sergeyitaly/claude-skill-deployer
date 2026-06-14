import * as fs from "node:fs";
import * as path from "node:path";
import { Manifest } from "./skillOps";
import { computeUsageStats, SkillUsageStat } from "./usageStats";
import { readCachedEnrichedRuns } from "./learningStateIndex";
import { writeJsonAtomic } from "./fileWriteCoordination";
import { markPipelineIndexed } from "./pipelineCycle";

const RUNS_REL = path.join(".claude", "learning", "runs.jsonl");

export interface SkillStatsIndex {
  version: 1;
  runsFileMtime: number;
  runsFileSize: number;
  computedAt: string;
  skills: Record<string, SkillUsageStat>;
}

export interface DailyStatsIndex {
  version: 1;
  runsFileMtime: number;
  runsFileSize: number;
  computedAt: string;
  days: Record<string, { cost: number; tokens: number; runs: number }>;
}

function runsFingerprint(target: string): { mtimeMs: number; size: number } {
  const file = path.join(target, RUNS_REL);
  if (!fs.existsSync(file)) {
    return { mtimeMs: 0, size: 0 };
  }
  const st = fs.statSync(file);
  return { mtimeMs: st.mtimeMs, size: st.size };
}

export function skillStatsIndexPath(target: string): string {
  return path.join(target, ".claude", "learning", "skill-stats.json");
}

export function dailyStatsIndexPath(target: string): string {
  return path.join(target, ".claude", "learning", "daily-stats.json");
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

export function refreshRunsIndex(target: string, manifest: Manifest): void {
  const fp = runsFingerprint(target);
  let skillFresh = false;
  let dailyFresh = false;
  try {
    const raw = JSON.parse(fs.readFileSync(skillStatsIndexPath(target), "utf-8")) as SkillStatsIndex;
    skillFresh = indexIsFresh(raw, fp);
  } catch {
    // rebuild
  }
  try {
    const daily = JSON.parse(fs.readFileSync(dailyStatsIndexPath(target), "utf-8")) as DailyStatsIndex;
    dailyFresh = indexIsFresh(daily, fp);
  } catch {
    // rebuild
  }
  if (skillFresh && dailyFresh) {
    markPipelineIndexed(target);
    return;
  }

  const stats = computeUsageStats(target, manifest);
  const skillIndex: SkillStatsIndex = {
    version: 1,
    runsFileMtime: fp.mtimeMs,
    runsFileSize: fp.size,
    computedAt: new Date().toISOString(),
    skills: Object.fromEntries(stats.map((s) => [s.name, s])),
  };
  writeJsonAtomic(skillStatsIndexPath(target), skillIndex);

  const days: DailyStatsIndex["days"] = {};
  for (const run of readCachedEnrichedRuns(target)) {
    const key = dayKey(run.ts);
    const row = days[key] ?? { cost: 0, tokens: 0, runs: 0 };
    row.runs += 1;
    row.cost += run.cost ?? 0;
    row.tokens += run.tokens ?? 0;
    days[key] = row;
  }
  const dailyIndex: DailyStatsIndex = {
    version: 1,
    runsFileMtime: fp.mtimeMs,
    runsFileSize: fp.size,
    computedAt: new Date().toISOString(),
    days,
  };
  writeJsonAtomic(dailyStatsIndexPath(target), dailyIndex);
  markPipelineIndexed(target);
}

function indexIsFresh(
  index: { runsFileMtime: number; runsFileSize: number } | undefined,
  fp: { mtimeMs: number; size: number }
): boolean {
  return !!index && index.runsFileMtime === fp.mtimeMs && index.runsFileSize === fp.size;
}

/** Read skill stats from index when fresh; otherwise compute live. */
export function readSkillStatsIndex(target: string, manifest: Manifest): SkillUsageStat[] {
  const fp = runsFingerprint(target);
  try {
    const raw = JSON.parse(fs.readFileSync(skillStatsIndexPath(target), "utf-8")) as SkillStatsIndex;
    if (indexIsFresh(raw, fp) && raw.skills) {
      return Object.values(raw.skills).sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));
    }
  } catch {
    // fall through
  }
  refreshRunsIndex(target, manifest);
  return computeUsageStats(target, manifest);
}
