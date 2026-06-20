import * as fs from "node:fs";
import * as path from "node:path";
import { tokenCostUsd as estimateTokenCost, estimateUsageCostFromRaw } from "./costRates";
import { invalidateTranscriptUsageCache } from "./transcriptUsageIndex";
import { Manifest } from "./skillOps";
import { computeUsageStats, SkillUsageStat } from "./usageStats";
import { writeJsonAtomic } from "./fileWriteCoordination";
import { markPipelineIndexed } from "./pipelineCycle";

export { BLENDED_USD_PER_M_TOKEN, tokenCostUsd } from "./costRates";
export { pruneRunsJsonl } from "./learningPrune";

// ── Run Recording ─────────────────────────────────────────────────────────────

export type RunAgent = "claude" | "cursor" | "kiro" | "copilot";

export const SKILL_INVOKE_HOOK_SOURCE = "skill-invoke-hook-v2";
export const ATTRIBUTION_COLLECTOR_SOURCE = "attribution-collector";

export function isCollectorTranscriptRun(entry: {
  action?: string;
  metadata?: { source?: string };
}): boolean {
  return entry.action === "transcript" && entry.metadata?.source === ATTRIBUTION_COLLECTOR_SOURCE;
}

export function isUsageRunRecord(entry: {
  action?: string;
  metadata?: { source?: string };
}): boolean {
  return !isCollectorTranscriptRun(entry);
}

export function isUsageBreakdownRun(entry: { metadata?: RunMetadata }): boolean {
  const meta = entry.metadata ?? {};
  return meta.cost_method === "usage_breakdown" || Boolean(meta.usage);
}

export interface RunMetadata {
  task_type?: string;
  duration_seconds?: number;
  cache_hit?: boolean;
  source?: string;
  invoked?: boolean;
  [key: string]: unknown;
}

export interface EnrichedRunRecord {
  ts: string;
  timestamp: string;
  skill: string;
  action: string;
  agent: RunAgent;
  tokens: number;
  cost: number;
  rc: number;
  success: boolean;
  session_id: string;
  project: string;
  branch?: string | null;
  metadata: RunMetadata;
  duration?: number;
  error?: string;
  hint?: string;
  note?: string;
}

export function tokenCostUsdForRun(tokens: number, model?: string): number {
  return estimateTokenCost(tokens, model);
}

export function runsFilePath(target: string): string {
  return path.join(target, ".claude", "learning", "runs.jsonl");
}

export function readEnrichedRunsFromFile(file: string): EnrichedRunRecord[] {
  if (!fs.existsSync(file)) return [];
  const out: EnrichedRunRecord[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = normalizeRunRecord(JSON.parse(line) as Record<string, unknown>);
      if (row) out.push(row);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

export function isV2HookRun(record: EnrichedRunRecord): boolean {
  return record.metadata?.source === SKILL_INVOKE_HOOK_SOURCE && record.metadata?.invoked === true;
}

export function countV2HookRuns(target: string): number {
  return countCachedV2HookRuns(target);
}

export function sessionHasV2HookRuns(target: string, sessionId: string): boolean {
  return sessionHasCachedV2HookRuns(target, sessionId);
}

export function normalizeRunRecord(raw: Record<string, unknown>): EnrichedRunRecord | null {
  const skill = raw.skill;
  const ts = (raw.ts ?? raw.timestamp) as string | undefined;
  if (typeof skill !== "string" || typeof ts !== "string") return null;

  const tokens = typeof raw.tokens === "number" ? raw.tokens : 0;
  const rc = typeof raw.rc === "number" ? raw.rc : raw.success === false ? 1 : 0;
  const agent = (typeof raw.agent === "string" ? raw.agent : "claude") as RunAgent;
  const metadata = (raw.metadata as RunMetadata) ?? {};
  const model =
    typeof raw.model === "string"
      ? raw.model
      : typeof metadata.model === "string"
        ? metadata.model
        : undefined;
  const usageRaw = metadata.usage as
    | { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_creation_input_tokens_1h?: number; cache_read_input_tokens?: number }
    | undefined;
  const usageCost = estimateUsageCostFromRaw(usageRaw, model);
  const cost =
    usageCost > 0
      ? usageCost
      : typeof raw.cost === "number"
        ? raw.cost
        : estimateTokenCost(tokens, model);

  return {
    ts, timestamp: ts, skill,
    action: typeof raw.action === "string" ? raw.action : "run",
    agent, tokens, cost, rc,
    success: typeof raw.success === "boolean" ? raw.success : rc === 0,
    session_id: typeof raw.session_id === "string" ? raw.session_id : `unknown_${ts}`,
    project: typeof raw.project === "string" ? raw.project : "",
    branch: typeof raw.branch === "string" ? raw.branch : null,
    metadata,
    duration: typeof raw.duration === "number" ? raw.duration : undefined,
    error: typeof raw.error === "string" ? raw.error : undefined,
    hint: typeof raw.hint === "string" ? raw.hint : undefined,
    note: typeof raw.note === "string" ? raw.note : undefined,
  };
}

export function appendSkillRun(
  target: string,
  entry: {
    skill: string;
    agent: RunAgent;
    tokens: number;
    success: boolean;
    action?: string;
    session_id?: string;
    branch?: string | null;
    metadata?: RunMetadata;
    duration?: number;
  }
): EnrichedRunRecord {
  const file = runsFilePath(target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ts = new Date().toISOString();
  const record: EnrichedRunRecord = {
    ts, timestamp: ts,
    skill: entry.skill,
    action: entry.action ?? "run",
    agent: entry.agent,
    tokens: entry.tokens,
    cost: estimateTokenCost(entry.tokens, (entry.metadata as RunMetadata | undefined)?.model as string | undefined),
    rc: entry.success ? 0 : 1,
    success: entry.success,
    session_id: entry.session_id ?? `ext_${ts}`,
    project: target,
    branch: entry.branch ?? null,
    metadata: entry.metadata ?? {},
    duration: entry.duration,
  };
  fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf-8");
  invalidateLearningCache(target);
  return record;
}

export function appendToolUse(
  target: string,
  entry: {
    tool: string;
    agent?: RunAgent;
    sessionId?: string;
    durationMs?: number;
    metadata?: Record<string, unknown>;
  }
): void {
  const file = path.join(target, ".claude", "mcp-usage.jsonl");
  const record = {
    ts: new Date().toISOString(),
    tool: `native:${entry.tool}`,
    durationMs: entry.durationMs ?? 0,
    sessionId: entry.sessionId,
    ...entry.metadata,
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf-8");
  } catch {
    // non-fatal
  }
}

// ── Learning State Index (runs cache) ─────────────────────────────────────────

const RUNS_REL = path.join(".claude", "learning", "runs.jsonl");
const SNAPSHOT_REL = path.join(".claude", "learning", "runs.snapshot.json");
const SNAPSHOT_VERSION = 2;

export interface RunsDerivedStats {
  v2HookRuns: number;
  v2SessionIds: Set<string>;
}

interface RunsSnapshotFile {
  version: number;
  lastUpdated: number;
  sourceMtimeMs: number;
  sourceSize: number;
  records: EnrichedRunRecord[];
  derived: { v2HookRuns: number; v2SessionIds: string[] };
  partialTail: string;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  data: EnrichedRunRecord[];
  derived: RunsDerivedStats;
  partialTail: string;
}

const runsCache = new Map<string, CacheEntry>();

function deriveRunsStats(runs: EnrichedRunRecord[]): RunsDerivedStats {
  let v2HookRuns = 0;
  const v2SessionIds = new Set<string>();
  for (const run of runs) {
    if (run.metadata?.source !== SKILL_INVOKE_HOOK_SOURCE || run.metadata?.invoked !== true) continue;
    v2HookRuns += 1;
    if (run.session_id) v2SessionIds.add(run.session_id);
  }
  return { v2HookRuns, v2SessionIds };
}

function runsFile(target: string): string {
  return path.join(target, RUNS_REL);
}

function snapshotFile(target: string): string {
  return path.join(target, SNAPSHOT_REL);
}

function writeRunsSnapshot(target: string, entry: CacheEntry): void {
  const file = snapshotFile(target);
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const payload: RunsSnapshotFile = {
      version: SNAPSHOT_VERSION,
      lastUpdated: Date.now(),
      sourceMtimeMs: entry.mtimeMs,
      sourceSize: entry.size,
      records: entry.data,
      derived: { v2HookRuns: entry.derived.v2HookRuns, v2SessionIds: [...entry.derived.v2SessionIds] },
      partialTail: entry.partialTail,
    };
    fs.writeFileSync(file, JSON.stringify(payload), "utf-8");
  } catch {
    // non-fatal
  }
}

function readRunsSnapshot(target: string, fp: { mtimeMs: number; size: number }): CacheEntry | undefined {
  const file = snapshotFile(target);
  if (!fs.existsSync(file)) return undefined;
  try {
    const snap = JSON.parse(fs.readFileSync(file, "utf-8")) as RunsSnapshotFile;
    if (snap.version !== SNAPSHOT_VERSION) return undefined;
    if (snap.sourceMtimeMs !== fp.mtimeMs || snap.sourceSize !== fp.size) return undefined;
    return {
      mtimeMs: snap.sourceMtimeMs, size: snap.sourceSize, data: snap.records,
      partialTail: snap.partialTail,
      derived: { v2HookRuns: snap.derived.v2HookRuns, v2SessionIds: new Set(snap.derived.v2SessionIds) },
    };
  } catch {
    return undefined;
  }
}

function fileFingerprint(file: string): { mtimeMs: number; size: number } {
  if (!fs.existsSync(file)) return { mtimeMs: 0, size: 0 };
  const st = fs.statSync(file);
  return { mtimeMs: st.mtimeMs, size: st.size };
}

function parseRunLine(line: string): EnrichedRunRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return normalizeRunRecord(JSON.parse(trimmed) as Record<string, unknown>);
  } catch {
    return null;
  }
}

function parseRunsFile(file: string): { data: EnrichedRunRecord[]; partialTail: string } {
  if (!fs.existsSync(file)) return { data: [], partialTail: "" };
  const raw = fs.readFileSync(file, "utf-8");
  const endsWithNewline = raw.endsWith("\n");
  const lines = raw.split("\n");
  const partialTail = endsWithNewline ? "" : lines.pop() ?? "";
  const records: EnrichedRunRecord[] = [];
  for (const line of lines) {
    const normalized = parseRunLine(line);
    if (normalized) records.push(normalized);
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
    if (normalized) records.push(normalized);
  }
  return { data: records, partialTail: nextTail };
}

function loadRunsRecords(file: string, prev?: CacheEntry, snapshotTarget?: string): { data: EnrichedRunRecord[]; partialTail: string } {
  const fp = fileFingerprint(file);
  if (!fs.existsSync(file)) return { data: [], partialTail: "" };
  if (prev && prev.mtimeMs === fp.mtimeMs && prev.size === fp.size) return { data: prev.data, partialTail: prev.partialTail };
  if (!prev && snapshotTarget) {
    const fromSnap = readRunsSnapshot(snapshotTarget, fp);
    if (fromSnap) return { data: fromSnap.data, partialTail: fromSnap.partialTail };
  }
  if (prev && fp.size > prev.size && fp.mtimeMs >= prev.mtimeMs) {
    const delta = fp.size - prev.size;
    const buf = Buffer.alloc(delta);
    const fd = fs.openSync(file, "r");
    try { fs.readSync(fd, buf, 0, delta, prev.size); } finally { fs.closeSync(fd); }
    return appendRunsFromChunk(prev.data, prev.partialTail, buf.toString("utf-8"));
  }
  return parseRunsFile(file);
}

function storeRunsCache(key: string, target: string, file: string, fp: { mtimeMs: number; size: number }, loaded: { data: EnrichedRunRecord[]; partialTail: string }): EnrichedRunRecord[] {
  const entry: CacheEntry = { mtimeMs: fp.mtimeMs, size: fp.size, data: loaded.data, partialTail: loaded.partialTail, derived: deriveRunsStats(loaded.data) };
  runsCache.set(key, entry);
  writeRunsSnapshot(target, entry);
  return loaded.data;
}

export function readCachedEnrichedRuns(target: string): EnrichedRunRecord[] {
  const key = path.resolve(target);
  const file = runsFile(target);
  const fp = fileFingerprint(file);
  const hit = runsCache.get(key);
  if (hit && hit.mtimeMs === fp.mtimeMs && hit.size === fp.size) return hit.data;
  const loaded = loadRunsRecords(file, hit, target);
  return storeRunsCache(key, target, file, fp, loaded);
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
    const key = path.resolve(target);
    runsCache.delete(key);
    try {
      const snap = snapshotFile(target);
      if (fs.existsSync(snap)) fs.unlinkSync(snap);
    } catch {
      // non-fatal
    }
    invalidateTranscriptUsageCache(target);
    return;
  }
  runsCache.clear();
  invalidateTranscriptUsageCache();
}

export const invalidateLearningIndex = invalidateLearningCache;

export function learningCacheSize(): number {
  return runsCache.size;
}

// ── Runs Index ────────────────────────────────────────────────────────────────

const SKILL_STATS_REL = path.join(".claude", "learning", "skill-stats.json");
const DAILY_STATS_REL = path.join(".claude", "learning", "daily-stats.json");

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
  if (!fs.existsSync(file)) return { mtimeMs: 0, size: 0 };
  const st = fs.statSync(file);
  return { mtimeMs: st.mtimeMs, size: st.size };
}

export function skillStatsIndexPath(target: string): string {
  return path.join(target, SKILL_STATS_REL);
}

export function dailyStatsIndexPath(target: string): string {
  return path.join(target, DAILY_STATS_REL);
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function indexIsFresh(
  index: { runsFileMtime: number; runsFileSize: number } | undefined,
  fp: { mtimeMs: number; size: number }
): boolean {
  return !!index && index.runsFileMtime === fp.mtimeMs && index.runsFileSize === fp.size;
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
