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
  /** Incomplete trailing line when file grows mid-write. */
  partialTail: string;
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

function parseRunLine(line: string): EnrichedRunRecord | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    return normalizeRunRecord(obj);
  } catch {
    return null;
  }
}

function parseRunsFile(file: string): { data: EnrichedRunRecord[]; partialTail: string } {
  if (!fs.existsSync(file)) {
    return { data: [], partialTail: "" };
  }
  const raw = fs.readFileSync(file, "utf-8");
  const endsWithNewline = raw.endsWith("\n");
  const lines = raw.split("\n");
  const partialTail = endsWithNewline ? "" : lines.pop() ?? "";
  const records: EnrichedRunRecord[] = [];
  for (const line of lines) {
    const normalized = parseRunLine(line);
    if (normalized) {
      records.push(normalized);
    }
  }
  return { data: records, partialTail };
}

function appendRunsFromChunk(
  base: EnrichedRunRecord[],
  partialTail: string,
  chunk: string
): { data: EnrichedRunRecord[]; partialTail: string } {
  const combined = partialTail + chunk;
  const endsWithNewline = combined.endsWith("\n");
  const lines = combined.split("\n");
  const nextTail = endsWithNewline ? "" : lines.pop() ?? "";
  const records = [...base];
  for (const line of lines) {
    const normalized = parseRunLine(line);
    if (normalized) {
      records.push(normalized);
    }
  }
  return { data: records, partialTail: nextTail };
}

function loadRunsRecords(file: string, prev?: CacheEntry): { data: EnrichedRunRecord[]; partialTail: string } {
  const fp = fileFingerprint(file);
  if (!fs.existsSync(file)) {
    return { data: [], partialTail: "" };
  }
  if (prev && prev.mtimeMs === fp.mtimeMs && prev.size === fp.size) {
    return { data: prev.data, partialTail: prev.partialTail };
  }
  if (prev && fp.size > prev.size && fp.mtimeMs >= prev.mtimeMs) {
    const delta = fp.size - prev.size;
    const buf = Buffer.alloc(delta);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buf, 0, delta, prev.size);
    } finally {
      fs.closeSync(fd);
    }
    return appendRunsFromChunk(prev.data, prev.partialTail, buf.toString("utf-8"));
  }
  return parseRunsFile(file);
}

/** Cached read of runs.jsonl — invalidated when file mtime/size changes; appends on growth. */
export function readCachedEnrichedRuns(target: string): EnrichedRunRecord[] {
  const key = path.resolve(target);
  const file = runsFile(target);
  const fp = fileFingerprint(file);
  const hit = runsCache.get(key);
  const loaded = loadRunsRecords(file, hit);
  runsCache.set(key, {
    mtimeMs: fp.mtimeMs,
    size: fp.size,
    data: loaded.data,
    partialTail: loaded.partialTail,
    derived: deriveRunsStats(loaded.data),
  });
  return loaded.data;
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
