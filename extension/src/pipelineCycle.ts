import * as fs from "node:fs";
import * as path from "node:path";
import { costAttributionPath } from "./costAttribution";
import { readJsonFile, writeJsonAtomic } from "./fileWriteCoordination";

export interface PipelineCycleTimestamps {
  collectedAt?: string;
  indexedAt?: string;
  analyzedAt?: string;
  /** runs.jsonl mtime/size captured at last index pass. */
  runsFileMtime?: number;
  runsFileSize?: number;
  /** cost-attribution.json mtime captured at last collect/index pass. */
  attributionMtime?: number;
}

export interface PipelineFileFingerprint {
  mtimeMs: number;
  size: number;
}

const RUNS_REL = path.join(".claude", "learning", "runs.jsonl");

export function pipelineCyclePath(target: string): string {
  return path.join(target, ".claude", "learning", "pipeline-cycle.json");
}

export function readPipelineCycle(target: string): PipelineCycleTimestamps {
  return readJsonFile<PipelineCycleTimestamps>(pipelineCyclePath(target)) ?? {};
}

export function runsFileFingerprint(target: string): PipelineFileFingerprint {
  const file = path.join(target, RUNS_REL);
  if (!fs.existsSync(file)) {
    return { mtimeMs: 0, size: 0 };
  }
  const st = fs.statSync(file);
  return { mtimeMs: st.mtimeMs, size: st.size };
}

export function attributionFileFingerprint(target: string): PipelineFileFingerprint {
  const file = costAttributionPath(target);
  if (!fs.existsSync(file)) {
    return { mtimeMs: 0, size: 0 };
  }
  const st = fs.statSync(file);
  return { mtimeMs: st.mtimeMs, size: st.size };
}

function writePipelineCycle(target: string, cycle: PipelineCycleTimestamps): PipelineCycleTimestamps {
  writeJsonAtomic(pipelineCyclePath(target), cycle);
  return cycle;
}

export function markPipelineCollected(target: string): PipelineCycleTimestamps {
  const cycle = readPipelineCycle(target);
  cycle.collectedAt = new Date().toISOString();
  const attr = attributionFileFingerprint(target);
  cycle.attributionMtime = attr.mtimeMs;
  return writePipelineCycle(target, cycle);
}

export function markPipelineIndexed(target: string): PipelineCycleTimestamps {
  const cycle = readPipelineCycle(target);
  cycle.indexedAt = new Date().toISOString();
  const runs = runsFileFingerprint(target);
  cycle.runsFileMtime = runs.mtimeMs;
  cycle.runsFileSize = runs.size;
  const attr = attributionFileFingerprint(target);
  cycle.attributionMtime = attr.mtimeMs;
  return writePipelineCycle(target, cycle);
}

export function markPipelineAnalyzed(target: string): PipelineCycleTimestamps {
  const cycle = readPipelineCycle(target);
  cycle.analyzedAt = new Date().toISOString();
  return writePipelineCycle(target, cycle);
}

function tsMs(iso: string | undefined): number {
  if (!iso) {
    return 0;
  }
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** True when index has not caught up to the latest collector pass. */
export function isIndexStaleForCollection(cycle: PipelineCycleTimestamps): boolean {
  const collected = tsMs(cycle.collectedAt);
  if (collected === 0) {
    return false;
  }
  const indexed = tsMs(cycle.indexedAt);
  return indexed < collected;
}

/** Phase ordering: index and analyze completed after last collect (when present). */
export function isPipelineReadyForOptimizer(cycle: PipelineCycleTimestamps): boolean {
  if (isIndexStaleForCollection(cycle)) {
    return false;
  }
  const indexed = tsMs(cycle.indexedAt);
  const analyzed = tsMs(cycle.analyzedAt);
  if (indexed === 0 || analyzed === 0) {
    return false;
  }
  return analyzed >= indexed;
}

/** Indexed snapshot matches current on-disk learning files. */
export function isPipelineFresh(target: string, cycle: PipelineCycleTimestamps): boolean {
  if (!isPipelineReadyForOptimizer(cycle)) {
    return false;
  }
  const runs = runsFileFingerprint(target);
  if (cycle.runsFileMtime !== runs.mtimeMs || cycle.runsFileSize !== runs.size) {
    return false;
  }
  const attr = attributionFileFingerprint(target);
  if (attr.size > 0 && cycle.attributionMtime !== undefined && cycle.attributionMtime !== attr.mtimeMs) {
    return false;
  }
  return true;
}

export function pipelineStaleSummary(target: string, cycle: PipelineCycleTimestamps): string | undefined {
  if (isIndexStaleForCollection(cycle)) {
    return "Cost index is behind the latest attribution collection — refresh or wait for sync before applying optimizations.";
  }
  if (!isPipelineReadyForOptimizer(cycle)) {
    return "Cost pipeline has not finished indexing — optimizations paused until data is consistent.";
  }
  if (!isPipelineFresh(target, cycle)) {
    return "Cost data changed since the last index pass — waiting for pipeline sync.";
  }
  return undefined;
}

export function evaluatePipelineStatus(
  target: string,
  cycle: PipelineCycleTimestamps = readPipelineCycle(target)
): {
  cycle: PipelineCycleTimestamps;
  ready: boolean;
  fresh: boolean;
  staleMessage?: string;
} {
  return {
    cycle,
    ready: isPipelineReadyForOptimizer(cycle),
    fresh: isPipelineFresh(target, cycle),
    staleMessage: pipelineStaleSummary(target, cycle),
  };
}
