import * as fs from "node:fs";
import * as path from "node:path";
import { EnrichedRunRecord, normalizeRunRecord, SKILL_INVOKE_HOOK_SOURCE } from "./runRecording";
import { invalidateTranscriptUsageCache } from "./transcriptUsageIndex";

const RUNS_REL = path.join(".claude", "learning", "runs.jsonl");

export interface RunsDerivedStats {
  v2HookRuns: number;
  v2SessionIds: Set<string>;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  data: EnrichedRunRecord[];
  derived: RunsDerivedStats;
}

const runsCache = new Map<string, CacheEntry>();

function deriveRunsStats(runs: EnrichedRunRecord[]): RunsDerivedStats {
  let v2HookRuns = 0;
  const v2SessionIds = new Set<string>();
  for (const run of runs) {
    if (run.metadata?.source !== SKILL_INVOKE_HOOK_SOURCE || run.metadata?.invoked !== true) {
      continue;
    }
    v2HookRuns += 1;
    if (run.session_id) {
      v2SessionIds.add(run.session_id);
    }
  }
  return { v2HookRuns, v2SessionIds };
}

function runsFile(target: string): string {
  return path.join(target, RUNS_REL);
}

function fileFingerprint(file: string): { mtimeMs: number; size: number } {
  if (!fs.existsSync(file)) {
    return { mtimeMs: 0, size: 0 };
  }
  const st = fs.statSync(file);
  return { mtimeMs: st.mtimeMs, size: st.size };
}

function parseRunsFile(file: string): EnrichedRunRecord[] {
  if (!fs.existsSync(file)) {
    return [];
  }
  const lines = fs.readFileSync(file, "utf-8").split("\n");
  const records: EnrichedRunRecord[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const normalized = normalizeRunRecord(obj);
      if (normalized) {
        records.push(normalized);
      }
    } catch {
      // skip malformed lines
    }
  }
  return records;
}

/** Cached read of runs.jsonl — invalidated when file mtime/size changes. */
export function readCachedEnrichedRuns(target: string): EnrichedRunRecord[] {
  const key = path.resolve(target);
  const file = runsFile(target);
  const fp = fileFingerprint(file);
  const hit = runsCache.get(key);
  if (hit && hit.mtimeMs === fp.mtimeMs && hit.size === fp.size) {
    return hit.data;
  }
  const data = parseRunsFile(file);
  runsCache.set(key, {
    mtimeMs: fp.mtimeMs,
    size: fp.size,
    data,
    derived: deriveRunsStats(data),
  });
  return data;
}

export function readCachedRunsDerivedStats(target: string): RunsDerivedStats {
  readCachedEnrichedRuns(target);
  const hit = runsCache.get(path.resolve(target));
  return hit?.derived ?? { v2HookRuns: 0, v2SessionIds: new Set() };
}

export function countCachedV2HookRuns(target: string): number {
  return readCachedRunsDerivedStats(target).v2HookRuns;
}

export function sessionHasCachedV2HookRuns(target: string, sessionId: string): boolean {
  return readCachedRunsDerivedStats(target).v2SessionIds.has(sessionId);
}

export function invalidateLearningCache(target?: string): void {
  if (target) {
    runsCache.delete(path.resolve(target));
    invalidateTranscriptUsageCache(target);
    return;
  }
  runsCache.clear();
  invalidateTranscriptUsageCache();
}

/** Alias for unified learning + transcript cache invalidation. */
export const invalidateLearningIndex = invalidateLearningCache;

/** Test helper — number of warm cache entries. */
export function learningCacheSize(): number {
  return runsCache.size;
}
