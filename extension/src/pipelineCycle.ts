import * as path from "node:path";
import { readJsonFile, writeJsonAtomic } from "./fileWriteCoordination";

export interface PipelineCycleTimestamps {
  collectedAt?: string;
  indexedAt?: string;
  analyzedAt?: string;
}

export function pipelineCyclePath(target: string): string {
  return path.join(target, ".claude", "learning", "pipeline-cycle.json");
}

export function readPipelineCycle(target: string): PipelineCycleTimestamps {
  return readJsonFile<PipelineCycleTimestamps>(pipelineCyclePath(target)) ?? {};
}

function touchPipelineField(target: string, field: keyof PipelineCycleTimestamps): PipelineCycleTimestamps {
  const cycle = readPipelineCycle(target);
  cycle[field] = new Date().toISOString();
  writeJsonAtomic(pipelineCyclePath(target), cycle);
  return cycle;
}

export function markPipelineCollected(target: string): PipelineCycleTimestamps {
  return touchPipelineField(target, "collectedAt");
}

export function markPipelineIndexed(target: string): PipelineCycleTimestamps {
  return touchPipelineField(target, "indexedAt");
}

export function markPipelineAnalyzed(target: string): PipelineCycleTimestamps {
  return touchPipelineField(target, "analyzedAt");
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

/** Optimizer and auto-apply should wait until index and analysis are at least as fresh as collection. */
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

export function pipelineStaleSummary(cycle: PipelineCycleTimestamps): string | undefined {
  if (isIndexStaleForCollection(cycle)) {
    return "Cost index is behind the latest attribution collection — refresh or wait for sync before applying optimizations.";
  }
  if (!isPipelineReadyForOptimizer(cycle)) {
    return "Cost pipeline has not finished indexing — optimizations paused until data is consistent.";
  }
  return undefined;
}
