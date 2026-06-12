import * as fs from "node:fs";
import * as path from "node:path";
import { EnrichedRunRecord, normalizeRunRecord } from "./runRecording";

const RUNS_REL = path.join(".claude", "learning", "runs.jsonl");

interface CacheEntry<T> {
  mtimeMs: number;
  size: number;
  data: T;
}

const runsCache = new Map<string, CacheEntry<EnrichedRunRecord[]>>();

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
  runsCache.set(key, { mtimeMs: fp.mtimeMs, size: fp.size, data });
  return data;
}

export function invalidateLearningCache(target?: string): void {
  if (target) {
    runsCache.delete(path.resolve(target));
    return;
  }
  runsCache.clear();
}

/** Test helper — number of warm cache entries. */
export function learningCacheSize(): number {
  return runsCache.size;
}
