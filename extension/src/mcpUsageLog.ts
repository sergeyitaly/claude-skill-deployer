import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const MCP_USAGE_LOG_PATH = path.join(os.homedir(), ".claude", "learning", "mcp-usage.jsonl");
export const MCP_HINTS_PATH = path.join(os.homedir(), ".claude", "learning", "mcp-agent-hints.md");
export const MCP_SESSION_INDEX_PATH = path.join(os.homedir(), ".claude", "learning", "mcp-session-index.json");

/** Returns the workspace-scoped MCP usage log path for hybrid telemetry. */
export function workspaceMcpLogPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".claude", "mcp-usage.jsonl");
}

/** One line written by the MCP filesystem or CLI server per tool call. */
export interface McpUsageEntry {
  ts: string;
  /**
   * Filesystem server: "read_file" | "write_file" | "list_directory" | "search_files" | "delete_file"
   * CLI server: "cli:<name>" (e.g. "cli:az", "cli:terraform") | "list_available_clis"
   */
  tool: string;
  /** Filesystem entries always have a path; CLI entries omit it. */
  path: string;
  durationMs: number;
  /** Byte size of content read or written (filesystem only). */
  bytes?: number;
  /** SHA-1 prefix of written content (write_file only, for no-op detection). */
  contentHash?: string;
  /** True when a write_file was skipped because content was identical. */
  skipped?: boolean;
  /** Number of entries returned by list_directory or search_files. */
  entryCount?: number;
  /** True when search_files hit the recursion depth limit (depth > 10). */
  depthReached?: boolean;
  error?: string;
  /** Rotated on each MCP initialize handshake — identifies one agent conversation. */
  sessionId?: string;
  // ── CLI server fields (present when server === "cli") ──────────────────────
  /** "cli" for CLI MCP server entries; absent for filesystem server entries. */
  server?: "cli";
  /** Normalised CLI name, e.g. "az", "terraform" (CLI server only). */
  cli?: string;
  /** Process exit code (CLI server only). */
  exitCode?: number;
  /** Byte length of stdout (CLI server only). */
  stdoutBytes?: number;
  /** Byte length of stderr (CLI server only). */
  stderrBytes?: number;
  /** True when the command was killed after timeout (CLI server only). */
  timedOut?: boolean;
  /** Working directory the command ran in (CLI server only). */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Detection result types
// ---------------------------------------------------------------------------

export interface McpFileStat {
  path: string;
  calls: number;
  avgDurationMs: number;
  totalBytesRead: number;
  estimatedTokens: number;
}

export interface McpWasteWarning {
  path: string;
  reads: number;
  wastedTokens: number;
  description: string;
}

export interface ReadAfterWriteWarning {
  path: string;
  secondsAfter: number;
  /** Tokens wasted by reading content that was just written (bytes of the read / 4). */
  estimatedWastedTokens: number;
  description: string;
}

export interface AgentLoopWarning {
  path: string;
  reads: number;
  windowMinutes: number;
  estimatedWastedTokens: number;
  description: string;
}

export interface LargeFileWarning {
  path: string;
  bytes: number;
  reads: number;
  description: string;
  suggestion: string;
}

export interface NoOpWriteInfo {
  path: string;
  skippedCount: number;
  description: string;
}

export interface ExcessiveScanWarning {
  path: string;
  scans: number;
  /** Avg entries per scan × excess scans — proportional penalty for large directories. */
  estimatedWastedEntries: number;
  description: string;
}

export interface EfficiencyScore {
  /** 0–100. */
  score: number;
  totalOps: number;
  wastefulOps: number;
  grade: "A" | "B" | "C" | "D" | "F";
  /** True when totalOps < MIN_OPS_FOR_SCORE — score is not meaningful yet. */
  notEnoughData?: boolean;
}

export interface McpOptimizationSuggestion {
  kind: "cache" | "batch_reads" | "deduplicate_scans" | "partial_read" | "skip_write";
  description: string;
  estimatedSavedTokens?: number;
}

export interface McpUsageSummary {
  totalCalls: number;
  byTool: Record<string, { calls: number; avgDurationMs: number }>;
  topFiles: McpFileStat[];
  avgDurationMs: number;
  totalEstimatedTokens: number;
  /** Files read 3+ times (redundant repeated reads). */
  wasteWarnings: McpWasteWarning[];
  /** write_file followed by read_file on the same path within 60s. */
  readAfterWrite: ReadAfterWriteWarning[];
  /** Same file read 4+ times in a 5-min window (likely reasoning loop). */
  agentLoops: AgentLoopWarning[];
  /** Files larger than 100KB. */
  largeFiles: LargeFileWarning[];
  /** write_file calls auto-skipped because content was unchanged. */
  noOpWrites: NoOpWriteInfo[];
  /** Directories listed 3+ times in the window. */
  excessiveScans: ExcessiveScanWarning[];
  /** Actionable optimization suggestions. */
  suggestions: McpOptimizationSuggestion[];
  efficiencyScore: EfficiencyScore;
  /** Total tokens provably wasted: redundant reads + agent loop re-reads. */
  totalWastedTokens: number;
  /** Session ID from the most recent log entry that carries one; undefined when no session IDs are present (legacy logs). */
  latestSessionId?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 4 bytes ≈ 1 token for typical code/text. */
function bytesToTokens(bytes: number): number {
  return Math.round(bytes / 4);
}

const LARGE_FILE_BYTES = 100 * 1024; // 100 KB
const LOOP_WINDOW_MINUTES = 5;
const LOOP_THRESHOLD = 4;
const READ_AFTER_WRITE_WINDOW_SECS = 60;

/** Normalize + resolve Windows 8.3 short names (e.g. SERHII~1 → SerhiiVoinolovich). */
function resolvePath(p: string): string {
  const normalized = path.normalize(p);
  try {
    return fs.realpathSync(normalized);
  } catch {
    return normalized;
  }
}

/**
 * Memoized wrapper around resolvePath. Pass a per-call Map so syscalls are
 * deduplicated within a single summarize pass without leaking across calls.
 */
function cachedResolvePath(p: string, cache: Map<string, string>): string {
  const hit = cache.get(p);
  if (hit !== undefined) return hit;
  const resolved = resolvePath(p);
  cache.set(p, resolved);
  return resolved;
}

// ---------------------------------------------------------------------------
// Log I/O
// ---------------------------------------------------------------------------

interface LogCache { mtime: number; entries: McpUsageEntry[] }
const logCache = new Map<string, LogCache>();
const LOG_CACHE_MAX_PATHS = 50;

// Prune entries older than this when the log exceeds LOG_MAX_BYTES.
const LOG_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const LOG_RETENTION_DAYS = 30;

// Background periodic prune timer — keeps the log trim independently of the read-path
// trigger so the file stays manageable even when the dashboard is rarely opened.
let _pruneTimerStarted = false;
function ensurePruneTimer(): void {
  if (_pruneTimerStarted) return;
  _pruneTimerStarted = true;
  setInterval(() => {
    try { maybePruneLog(MCP_USAGE_LOG_PATH); } catch { /* non-fatal */ }
  }, 10 * 60 * 1000).unref();
}

function setLogCache(key: string, value: LogCache): void {
  // LRU eviction: delete before re-inserting so the entry moves to the newest
  // position. When at capacity and the key is new, evict the oldest (first) entry.
  if (logCache.has(key)) {
    logCache.delete(key);
  } else if (logCache.size >= LOG_CACHE_MAX_PATHS) {
    logCache.delete(logCache.keys().next().value as string);
  }
  logCache.set(key, value);
}

/**
 * Removes log entries older than LOG_RETENTION_DAYS when the file exceeds
 * LOG_MAX_BYTES. Uses a temp-file rename for atomicity so the MCP server can
 * keep appending without interruption. Clears the in-memory cache entry so the
 * next readMcpUsageLog call picks up the pruned content.
 */
function maybePruneLog(logPath: string): void {
  try {
    if (fs.statSync(logPath).size < LOG_MAX_BYTES) return;
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 86_400_000;
    const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
    const kept = lines.filter((line) => {
      try { return new Date((JSON.parse(line) as McpUsageEntry).ts).getTime() >= cutoff; }
      catch { return false; }
    });
    if (kept.length >= lines.length) return; // nothing to prune
    const tmp = `${logPath}.prune-${process.pid}-${Date.now()}.tmp`;
    fs.writeFileSync(tmp, kept.join("\n") + (kept.length > 0 ? "\n" : ""), "utf-8");
    fs.renameSync(tmp, logPath);
    logCache.delete(logPath); // force re-read after prune
  } catch {
    // non-fatal — log pruning is best-effort
  }
}

export function readMcpUsageLog(logPath = MCP_USAGE_LOG_PATH): McpUsageEntry[] {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  try {
    ensurePruneTimer();
    maybePruneLog(logPath); // trim old entries if file has grown large; no-op otherwise
    const mtime = fs.statSync(logPath).mtimeMs;
    const cached = logCache.get(logPath);
    if (cached && cached.mtime === mtime) {
      // Promote to newest position on every cache hit (LRU access tracking).
      logCache.delete(logPath);
      logCache.set(logPath, cached);
      return cached.entries;
    }
    const entries = fs
      .readFileSync(logPath, "utf-8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as McpUsageEntry];
        } catch {
          return [];
        }
      });
    setLogCache(logPath, { mtime, entries });
    return entries;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Detection functions
// ---------------------------------------------------------------------------

function detectWaste(
  entries: McpUsageEntry[]
): { warnings: McpWasteWarning[]; totalWastedTokens: number } {
  const byFile: Record<string, { calls: number; totalBytesRead: number; readCalls: number }> = {};
  for (const e of entries) {
    if (!e.path || e.error) continue;
    const f = (byFile[e.path] ??= { calls: 0, totalBytesRead: 0, readCalls: 0 });
    f.calls += 1;
    if (e.tool === "read_file" && typeof e.bytes === "number") {
      f.totalBytesRead += e.bytes;
      f.readCalls += 1;
    }
  }
  const warnings: McpWasteWarning[] = [];
  let totalWastedTokens = 0;
  for (const [filePath, stats] of Object.entries(byFile)) {
    if (stats.readCalls < 3) continue;
    const avgBytes = stats.readCalls > 0 ? stats.totalBytesRead / stats.readCalls : 0;
    const wastedTokens = bytesToTokens(avgBytes * (stats.readCalls - 1));
    totalWastedTokens += wastedTokens;
    warnings.push({
      path: filePath,
      reads: stats.readCalls,
      wastedTokens,
      description: `Read ${stats.readCalls}× — ${stats.readCalls - 1} redundant read(s), ~${wastedTokens.toLocaleString()} tokens wasted`,
    });
  }
  const sortedWarnings = [...warnings].sort((a, b) => b.wastedTokens - a.wastedTokens);
  // No top-N cap here — caller filters loop paths first, then caps, so no slots are wasted.
  return { warnings: sortedWarnings, totalWastedTokens };
}

function detectReadAfterWrite(
  entries: McpUsageEntry[],
  windowSecs = READ_AFTER_WRITE_WINDOW_SECS
): ReadAfterWriteWarning[] {
  // O(n) pass: accumulate ALL write timestamps per path (not just the latest) so that
  // a read after the first of multiple writes is also detected. Previously only the most
  // recent write timestamp was stored, meaning a read between two writes could be missed
  // when an out-of-order entry from a concurrent agent overwrote the first write's ts.
  const writesByPath = new Map<string, number[]>();
  const warnings: ReadAfterWriteWarning[] = [];
  const windowMs = windowSecs * 1000;

  for (const e of entries) {
    if (e.error) continue;
    const ts = new Date(e.ts).getTime();
    if (e.tool === "write_file" && !e.skipped) {
      const ws = writesByPath.get(e.path) ?? [];
      ws.push(ts);
      writesByPath.set(e.path, ws);
    } else if (e.tool === "read_file") {
      const writes = writesByPath.get(e.path);
      if (writes && writes.length > 0) {
        // Find all writes that precede this read and fall within the window.
        const eligible = writes.filter((wt) => wt < ts && ts - wt <= windowMs);
        if (eligible.length > 0) {
          // Report against the earliest qualifying write — most relevant to the agent.
          const earliestWrite = Math.min(...eligible);
          const secondsAfter = Math.round((ts - earliestWrite) / 1000);
          warnings.push({
            path: e.path,
            secondsAfter,
            estimatedWastedTokens: bytesToTokens(e.bytes ?? 0),
            description: `Read ${secondsAfter}s after write — reuse written content instead of re-reading`,
          });
          // Consume writes that predated this read; keep any that are newer (e.g. from
          // concurrent agent processes whose entries appear out of chronological order).
          writesByPath.set(e.path, writes.filter((wt) => wt > ts));
        }
      }
    }
  }
  return warnings;
}

function detectAgentLoops(entries: McpUsageEntry[]): AgentLoopWarning[] {
  const reads = entries.filter((e) => e.tool === "read_file" && !e.error);
  const byPath: Record<string, McpUsageEntry[]> = {};
  for (const r of reads) {
    if (!byPath[r.path]) byPath[r.path] = [];
    byPath[r.path].push(r);
  }

  const warnings: AgentLoopWarning[] = [];
  const windowMs = LOOP_WINDOW_MINUTES * 60 * 1000;

  for (const [filePath, pathReads] of Object.entries(byPath)) {
    const sorted = [...pathReads].sort((a, b) => a.ts.localeCompare(b.ts));
    // Pre-parse timestamps once: O(n) instead of repeated Date construction per iteration.
    const times = sorted.map((r) => new Date(r.ts).getTime());
    // Sliding window: O(n) scan replaces the previous O(n²) filter-per-anchor approach.
    let bestCount = 0;
    let left = 0;
    for (let right = 0; right < times.length; right++) {
      while (times[right] - times[left] > windowMs) left++;
      const count = right - left + 1;
      if (count > bestCount) bestCount = count;
    }

    if (bestCount >= LOOP_THRESHOLD) {
      const avgBytes = sorted.reduce((s, r) => s + (r.bytes ?? 0), 0) / sorted.length;
      const wastedTokens = bytesToTokens(avgBytes * (bestCount - 1));
      warnings.push({
        path: filePath,
        reads: bestCount,
        windowMinutes: LOOP_WINDOW_MINUTES,
        estimatedWastedTokens: wastedTokens,
        description: `Read ${bestCount}× in ${LOOP_WINDOW_MINUTES}min — possible agent reasoning loop`,
      });
    }
  }
  const sortedWarnings = [...warnings].sort((a, b) => b.estimatedWastedTokens - a.estimatedWastedTokens);
  return sortedWarnings;
}

function detectLargeFiles(entries: McpUsageEntry[]): LargeFileWarning[] {
  const readsByPath: Record<string, { maxBytes: number; reads: number }> = {};
  for (const e of entries) {
    if (e.tool !== "read_file" || e.error || (e.bytes ?? 0) < LARGE_FILE_BYTES) continue;
    const rec = (readsByPath[e.path] ??= { maxBytes: 0, reads: 0 });
    rec.maxBytes = Math.max(rec.maxBytes, e.bytes ?? 0);
    rec.reads += 1;
  }
  return Object.entries(readsByPath)
    .map(([p, s]) => ({
      path: p,
      bytes: s.maxBytes,
      reads: s.reads,
      description: `${Math.round(s.maxBytes / 1024)}KB file read ${s.reads}×`,
      suggestion:
        s.maxBytes > 512 * 1024
          ? "Use search_in_file or chunk reading — full load is expensive"
          : "Extract only needed sections to reduce context pressure",
    }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5);
}

function detectNoOpWrites(entries: McpUsageEntry[]): NoOpWriteInfo[] {
  const byPath: Record<string, number> = {};
  for (const e of entries) {
    if (e.tool === "write_file" && e.skipped) {
      byPath[e.path] = (byPath[e.path] ?? 0) + 1;
    }
  }
  return Object.entries(byPath)
    .map(([p, count]) => ({
      path: p,
      skippedCount: count,
      description: `${count} identical write(s) auto-skipped — content unchanged`,
    }))
    .sort((a, b) => b.skippedCount - a.skippedCount)
    .slice(0, 5);
}

function detectExcessiveScans(entries: McpUsageEntry[]): ExcessiveScanWarning[] {
  const byPath: Record<string, { scans: number; totalEntries: number }> = {};
  for (const e of entries) {
    if ((e.tool === "list_directory" || e.tool === "search_files") && !e.error && e.path) {
      const rec = (byPath[e.path] ??= { scans: 0, totalEntries: 0 });
      rec.scans += 1;
      rec.totalEntries += e.entryCount ?? 0;
    }
  }
  return Object.entries(byPath)
    .filter(([, rec]) => rec.scans >= 3)
    .map(([p, rec]) => {
      const avgEntries = rec.scans > 0 ? Math.round(rec.totalEntries / rec.scans) : 0;
      const estimatedWastedEntries = avgEntries * Math.max(0, rec.scans - 1);
      const entrySuffix = avgEntries > 0 ? `, ~${estimatedWastedEntries} wasted entries` : "";
      return {
        path: p,
        scans: rec.scans,
        estimatedWastedEntries,
        description: `Scanned ${rec.scans}×${entrySuffix} — cache listing instead of re-scanning`,
      };
    })
    .sort((a, b) => b.estimatedWastedEntries - a.estimatedWastedEntries || b.scans - a.scans);
}

const MIN_OPS_FOR_SCORE = 5;

function scoreToGrade(score: number): EfficiencyScore["grade"] {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 45) return "D";
  return "F";
}

function computeScore(
  totalOps: number,
  waste: McpWasteWarning[],
  readAfterWrite: ReadAfterWriteWarning[],
  loops: AgentLoopWarning[],
  noOpWrites: NoOpWriteInfo[],
  excessiveScans: ExcessiveScanWarning[]
): EfficiencyScore {
  if (totalOps === 0) {
    return { score: 100, totalOps: 0, wastefulOps: 0, grade: "A" };
  }
  if (totalOps < MIN_OPS_FOR_SCORE) {
    return { score: 100, totalOps, wastefulOps: 0, grade: "A", notEnoughData: true };
  }
  // No-op writes are auto-optimised by the MCP server (content-hash guard) and should not
  // lower the efficiency grade. Exclude them from both the scoring denominator and the
  // wasteful-ops count so sessions with many skipped writes are not penalised.
  const noOpWriteCount = noOpWrites.reduce((s, n) => s + n.skippedCount, 0);
  const scoringOps = Math.max(MIN_OPS_FOR_SCORE, totalOps - noOpWriteCount);
  const wastefulOps =
    waste.reduce((s, w) => s + Math.max(0, w.reads - 1), 0) +
    readAfterWrite.length +
    loops.reduce((s, l) => s + Math.max(0, l.reads - 1), 0) +
    excessiveScans.reduce((s, sc) => s + Math.max(1, Math.ceil(sc.estimatedWastedEntries / 50)), 0);
  const score = Math.max(0, Math.round(((scoringOps - wastefulOps) / scoringOps) * 100));
  // totalOps in the return value retains the raw count for display; scoringOps is only
  // used for the ratio so the dashboard stat shows the true number of MCP calls.
  return { score, totalOps, wastefulOps, grade: scoreToGrade(score) };
}

// ---------------------------------------------------------------------------
// Main summarizer
// ---------------------------------------------------------------------------

interface AccumulatedRaw {
  byToolRaw: Record<string, { calls: number; totalMs: number }>;
  byFileRaw: Record<string, { calls: number; totalMs: number; totalBytesRead: number; readCalls: number }>;
  totalMs: number;
  totalEstimatedTokens: number;
}

function accumulateEntries(goodEntries: McpUsageEntry[], resolveCache: Map<string, string>): AccumulatedRaw {
  const byToolRaw: AccumulatedRaw["byToolRaw"] = {};
  const byFileRaw: AccumulatedRaw["byFileRaw"] = {};
  let totalMs = 0;
  let totalEstimatedTokens = 0;
  for (const e of goodEntries) {
    const tool = (byToolRaw[e.tool] ??= { calls: 0, totalMs: 0 });
    tool.calls += 1;
    tool.totalMs += e.durationMs;
    const normalized = e.path ? cachedResolvePath(e.path, resolveCache) : "";
    if (normalized) {
      const file = (byFileRaw[normalized] ??= { calls: 0, totalMs: 0, totalBytesRead: 0, readCalls: 0 });
      file.calls += 1;
      file.totalMs += e.durationMs;
      if (e.tool === "read_file" && typeof e.bytes === "number") {
        file.totalBytesRead += e.bytes;
        file.readCalls += 1;
        totalEstimatedTokens += bytesToTokens(e.bytes);
      }
      if ((e.tool === "list_directory" || e.tool === "search_files") && typeof e.entryCount === "number") {
        // ~4 tokens per entry (name + type) — proportional, not precise
        totalEstimatedTokens += e.entryCount * 4;
      }
    }
    totalMs += e.durationMs;
  }
  return { byToolRaw, byFileRaw, totalMs, totalEstimatedTokens };
}

export function summarizeMcpUsage(daysBack = 14, logPath?: string): McpUsageSummary {
  const cutoff = Date.now() - daysBack * 86_400_000;
  const entries = readMcpUsageLog(logPath).filter((e) => new Date(e.ts).getTime() >= cutoff);
  const goodEntries = entries.filter((e) => !e.error);

  // Single resolve cache for the entire summarize pass — avoids repeated
  // fs.realpathSync syscalls for the same path across accumulate + detection steps.
  const resolveCache = new Map<string, string>();

  const { byToolRaw, byFileRaw, totalMs, totalEstimatedTokens } = accumulateEntries(goodEntries, resolveCache);

  const byTool: McpUsageSummary["byTool"] = {};
  for (const [tool, stats] of Object.entries(byToolRaw)) {
    byTool[tool] = { calls: stats.calls, avgDurationMs: Math.round(stats.totalMs / stats.calls) };
  }

  const topFiles: McpFileStat[] = Object.entries(byFileRaw)
    .map(([filePath, stats]) => ({
      path: filePath,
      calls: stats.calls,
      avgDurationMs: Math.round(stats.totalMs / stats.calls),
      totalBytesRead: stats.totalBytesRead,
      estimatedTokens: bytesToTokens(stats.totalBytesRead),
    }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 8);

  // Resolve Windows 8.3 short names so all detection functions key off the same path form.
  // Re-use the same cache populated during accumulateEntries — zero extra syscalls.
  const resolvedEntries = goodEntries.map((e) =>
    e.path ? { ...e, path: cachedResolvePath(e.path, resolveCache) } : e
  );

  // Detections
  const readAfterWriteAll = detectReadAfterWrite(resolvedEntries);
  const agentLoopsAll = detectAgentLoops(resolvedEntries);
  const largeFiles = detectLargeFiles(resolvedEntries);
  // Exclude files already surfaced as agent loops before scoring — the loop warning is more
  // specific and counting the same file in both signals would double-penalise the score.
  const loopPaths = new Set(agentLoopsAll.map((l) => l.path));
  const wasteWarningsAll = detectWaste(resolvedEntries).warnings
    .filter((w) => !loopPaths.has(w.path));
  const noOpWrites = detectNoOpWrites(resolvedEntries);
  const excessiveScansAll = detectExcessiveScans(resolvedEntries);

  // Score with full (uncapped) arrays so all wasteful ops penalise the grade.
  const efficiencyScore = computeScore(goodEntries.length, wasteWarningsAll, readAfterWriteAll, agentLoopsAll, noOpWrites, excessiveScansAll);

  const totalWastedTokens =
    wasteWarningsAll.reduce((s, w) => s + w.wastedTokens, 0) +
    agentLoopsAll.reduce((s, l) => s + l.estimatedWastedTokens, 0) +
    readAfterWriteAll.reduce((s, r) => s + r.estimatedWastedTokens, 0);

  // Suggestions
  const suggestions: McpOptimizationSuggestion[] = [];
  if (wasteWarningsAll.length > 0) {
    suggestions.push({
      kind: "cache",
      description: `Cache ${wasteWarningsAll.length} hot file(s) read 3× or more — avoid re-reading content already in context`,
      estimatedSavedTokens: totalWastedTokens,
    });
  }
  const listCalls = byToolRaw["list_directory"]?.calls ?? 0;
  const readCalls = byToolRaw["read_file"]?.calls ?? 0;
  if (listCalls > 0 && readCalls > 0 && listCalls / readCalls > 0.5) {
    suggestions.push({
      kind: "batch_reads",
      description: `High list_directory/read_file ratio (${listCalls}/${readCalls}) — batch directory scans into a single pass`,
    });
  }
  if (largeFiles.length > 0) {
    suggestions.push({
      kind: "partial_read",
      description: `${largeFiles.length} large file(s) — consider search_in_file or chunk reading instead of full load`,
      estimatedSavedTokens: largeFiles.reduce((s, f) => s + bytesToTokens(f.bytes * (f.reads - 1)), 0),
    });
  }
  if (noOpWrites.length > 0) {
    const saved = noOpWrites.reduce((s, n) => s + n.skippedCount, 0);
    suggestions.push({
      kind: "skip_write",
      description: `${saved} no-op write(s) auto-skipped — MCP server now compares content hash before writing`,
    });
  }
  if (excessiveScansAll.length > 0) {
    const totalWastedEntries = excessiveScansAll.reduce((s, sc) => s + sc.estimatedWastedEntries, 0);
    const entrySuffix = totalWastedEntries > 0 ? ` (${totalWastedEntries.toLocaleString()} wasted entries total)` : "";
    suggestions.push({
      kind: "deduplicate_scans",
      description: `Cache directory listings instead of re-scanning — ${excessiveScansAll.length} path(s) scanned 3× or more${entrySuffix}`,
    });
  }

  // Detections — full (uncapped) arrays for accurate scoring; display fields capped at 5 below.
  // Cap display arrays to 5 items — scoring used the full sets above.
  // Latest session ID for per-session alert deduplication.
  const latestSessionId = [...entries].reverse().find((e) => e.sessionId)?.sessionId;

  return {
    totalCalls: goodEntries.length,
    byTool,
    topFiles,
    avgDurationMs: goodEntries.length > 0 ? Math.round(totalMs / goodEntries.length) : 0,
    totalEstimatedTokens,
    wasteWarnings: wasteWarningsAll.slice(0, 5),
    readAfterWrite: readAfterWriteAll.slice(0, 5),
    agentLoops: agentLoopsAll.slice(0, 5),
    largeFiles,
    noOpWrites,
    excessiveScans: excessiveScansAll.slice(0, 5),
    suggestions,
    efficiencyScore,
    totalWastedTokens,
    latestSessionId,
  };
}

// ---------------------------------------------------------------------------
// Auto-remediation: write a hints file agents can read at session start
// ---------------------------------------------------------------------------

function hintWasteWarnings(items: McpWasteWarning[]): string[] {
  if (items.length === 0) return [];
  return [
    "## Files to cache in memory (read repeatedly — do not re-read)",
    ...items.map((w) => `- \`${w.path}\` — read ${w.reads}×, ~${w.wastedTokens.toLocaleString()} tokens wasted`),
    "", "→ Rule: if a file is already in your context, do NOT call read_file again.", "",
  ];
}

function hintAgentLoops(items: AgentLoopWarning[]): string[] {
  if (items.length === 0) return [];
  return [
    "## Detected reasoning loops (same file read many times in short window)",
    ...items.map((l) => `- \`${l.path}\` — read ${l.reads}× in ${l.windowMinutes}min`),
    "", "→ Rule: analyze once, store the result in your reasoning. Do not re-read to 'verify'.", "",
  ];
}

function hintLargeFiles(items: LargeFileWarning[]): string[] {
  if (items.length === 0) return [];
  return [
    "## Large files (>100KB) — avoid full reads",
    ...items.map((f) => `- \`${f.path}\` — ${Math.round(f.bytes / 1024)}KB — ${f.suggestion}`),
    "",
  ];
}

function hintReadAfterWrite(items: ReadAfterWriteWarning[]): string[] {
  if (items.length === 0) return [];
  return [
    "## Read-after-write patterns (reuse content you just wrote)",
    ...items.map((r) => `- \`${r.path}\` — read ${r.secondsAfter}s after write`),
    "", "→ Rule: after write_file, keep the written content in memory — no need to read it back.", "",
  ];
}

function hintExcessiveScans(items: ExcessiveScanWarning[]): string[] {
  if (items.length === 0) return [];
  return [
    "## Directories that are repeatedly re-scanned (cache these in memory)",
    ...items.map((s) => {
      const waste = s.estimatedWastedEntries > 0 ? `, ~${s.estimatedWastedEntries} wasted entries` : "";
      return `- \`${s.path}\` — listed ${s.scans}×${waste}`;
    }),
    "",
    "→ Rule: after the first list_directory call, keep the result in context.",
    "  The dir-cache-guard hook will block repeat scans automatically when active.",
    "",
  ];
}

function hintEfficiency(score: EfficiencyScore): string[] {
  if (score.score >= 80) return [];
  return [
    `## Session efficiency: ${score.score}% (grade ${score.grade})`,
    `- Total ops: ${score.totalOps}  Wasteful: ${score.wastefulOps}`,
    "",
  ];
}

export function writeMcpHints(summary: McpUsageSummary): void {
  const lines = [
    "# MCP Optimization Hints (auto-generated — do not edit)",
    `# Last updated: ${new Date().toISOString()}`,
    "#", "# Read this at the start of your session. Follow these rules to avoid",
    "# token waste and redundant file operations.", "",
    ...hintWasteWarnings(summary.wasteWarnings),
    ...hintAgentLoops(summary.agentLoops),
    ...hintLargeFiles(summary.largeFiles),
    ...hintReadAfterWrite(summary.readAfterWrite),
    ...hintExcessiveScans(summary.excessiveScans),
    ...hintEfficiency(summary.efficiencyScore),
    "## General rules (always apply)",
    "- Do not call list_directory on the same path more than once per session",
    "- Do not call read_file on a file already present in your context",
    "- After write_file, reuse the content you already have",
    "- For files > 100KB, request only the relevant section",
    "",
  ];

  try {
    fs.mkdirSync(path.dirname(MCP_HINTS_PATH), { recursive: true });
    // Preserve any permanent-cache-rules block written by applyMcpAutoFixes() — it lives
    // at the top of the file and must not be overwritten by session-specific hint refreshes.
    let permanentBlock = "";
    try {
      if (fs.existsSync(MCP_HINTS_PATH)) {
        const cur = fs.readFileSync(MCP_HINTS_PATH, "utf-8");
        const s = cur.indexOf("<!-- permanent-cache-rules -->");
        const e = cur.indexOf("<!-- /permanent-cache-rules -->");
        if (s !== -1 && e !== -1 && e >= s) {
          permanentBlock = cur.slice(s, e + "<!-- /permanent-cache-rules -->".length);
        }
      }
    } catch { /* ignore — session hints are still written */ }
    const sessionContent = lines.join("\n");
    fs.writeFileSync(
      MCP_HINTS_PATH,
      permanentBlock ? permanentBlock + "\n\n" + sessionContent : sessionContent,
      "utf-8"
    );
  } catch {
    // non-fatal
  }
}

// ---------------------------------------------------------------------------
// CLI outcome pattern analysis + hints (cross-CLI, not Azure-specific)
// ---------------------------------------------------------------------------

export interface CliErrorPattern {
  cli: string;
  errorCount: number;
  totalCount: number;
  /** Distinct working directories where errors were seen. */
  cwds: string[];
  lastSeen: string;
}

/**
 * Analyses CLI MCP log entries and returns CLIs with a recurring error rate
 * (≥2 errors in the window). Used to populate actionable hints for agents.
 */
export function analyzeCliPatterns(entries: McpUsageEntry[]): CliErrorPattern[] {
  const byCliMap = new Map<string, { errors: McpUsageEntry[]; total: number }>();

  for (const entry of entries) {
    if (entry.server !== "cli" || !entry.cli) continue;
    const bucket = byCliMap.get(entry.cli) ?? { errors: [], total: 0 };
    bucket.total++;
    if (typeof entry.exitCode === "number" && entry.exitCode !== 0) {
      bucket.errors.push(entry);
    }
    byCliMap.set(entry.cli, bucket);
  }

  const patterns: CliErrorPattern[] = [];
  for (const [cli, { errors, total }] of byCliMap.entries()) {
    if (errors.length < 2) continue;
    const cwds = [...new Set(
      errors.map((e) => e.cwd).filter((c): c is string => Boolean(c))
    )].slice(0, 3);
    patterns.push({
      cli,
      errorCount: errors.length,
      totalCount: total,
      cwds,
      lastSeen: errors[errors.length - 1]?.ts ?? "",
    });
  }

  return patterns.sort((a, b) => b.errorCount - a.errorCount);
}

/**
 * Appends a CLI error-pattern section to `mcp-agent-hints.md`, replacing any
 * previous CLI section so the file stays current without growing unboundedly.
 */
export function appendCliPatternHints(patterns: CliErrorPattern[]): void {
  if (patterns.length === 0) return;

  const section: string[] = [
    "",
    "## CLI error patterns (learned from recent history)",
  ];

  for (const p of patterns) {
    const rate = Math.round((p.errorCount / p.totalCount) * 100);
    const lastDate = p.lastSeen.slice(0, 10);
    section.push(
      `- \`${p.cli}\`: ${p.errorCount}/${p.totalCount} calls failed (${rate}%) — last ${lastDate}`
    );
    if (p.cwds.length > 0) {
      section.push(`  cwd: ${p.cwds.map((c) => `\`${c}\``).join(", ")}`);
    }
  }

  section.push(
    "",
    "→ Rule: before invoking a high-error CLI, call list_available_clis to verify",
    "  it is installed and confirm the working directory (cwd) is correct.",
    ""
  );

  try {
    fs.mkdirSync(path.dirname(MCP_HINTS_PATH), { recursive: true });
    const existing = fs.existsSync(MCP_HINTS_PATH)
      ? fs.readFileSync(MCP_HINTS_PATH, "utf-8")
      : "";
    // Replace a previous CLI section if present, otherwise append.
    const stripped = existing.replace(/\n## CLI error patterns[\s\S]*?(?=\n## |\n*$)/, "");
    fs.writeFileSync(MCP_HINTS_PATH, stripped.trimEnd() + "\n" + section.join("\n"), "utf-8");
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Cross-session pattern analysis
// ---------------------------------------------------------------------------

export interface CrossSessionHotFile {
  path: string;
  /** Number of distinct sessions where this file was read. */
  sessionCount: number;
  totalSessions: number;
  /** Average reads per session. */
  readsPerSession: number;
  /** Fraction of sessions that accessed this file (0–1). */
  prevalence: number;
}

export interface CrossSessionNoOpWriteFile {
  path: string;
  /** Number of distinct sessions where this file had a skipped (no-op) write. */
  sessionCount: number;
  totalSessions: number;
  /** Average skipped writes per session. */
  skipsPerSession: number;
  /** Fraction of sessions (0–1). */
  prevalence: number;
}

export interface CrossSessionSummary {
  totalSessions: number;
  /** Files read in >50% of sessions, sorted by prevalence desc. */
  persistentHotFiles: CrossSessionHotFile[];
  /** Files with skipped (no-op) writes in >50% of sessions — agents are needlessly rewriting them. */
  persistentNoOpWrites: CrossSessionNoOpWriteFile[];
}

// ---------------------------------------------------------------------------
// Incremental cross-session index
// Completed sessions are aggregated into a compact JSON file so that
// summarizeCrossSessionPatterns can skip the O(n) entry scan for sessions
// already processed, reading only new (active-session) entries from the log.
// ---------------------------------------------------------------------------

interface SessionIndexEntry {
  lastTs: string;
  reads: Record<string, number>;
  noOps: Record<string, number>;
}

type RawSessionIndex = Record<string, SessionIndexEntry>;

function readRawSessionIndex(): RawSessionIndex {
  try {
    const raw = JSON.parse(fs.readFileSync(MCP_SESSION_INDEX_PATH, "utf-8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as RawSessionIndex) : {};
  } catch {
    return {};
  }
}

function writeRawSessionIndex(index: RawSessionIndex): void {
  try {
    fs.mkdirSync(path.dirname(MCP_SESSION_INDEX_PATH), { recursive: true });
    const tmp = `${MCP_SESSION_INDEX_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(index), "utf-8");
    fs.renameSync(tmp, MCP_SESSION_INDEX_PATH);
  } catch {
    // non-fatal
  }
}

function evictStaleIndexEntries(index: RawSessionIndex, cutoffMs: number): boolean {
  let changed = false;
  for (const sid of Object.keys(index)) {
    if (new Date(index[sid].lastTs).getTime() < cutoffMs) {
      delete index[sid];
      changed = true;
    }
  }
  return changed;
}

/**
 * Groups MCP read_file events by sessionId to find files that are
 * consistently over-read across sessions — the ground-truth signal
 * for globally actionable optimization hints.
 *
 * Entries without a sessionId are grouped under a synthetic session
 * keyed by date (YYYY-MM-DD) so legacy logs still contribute signal.
 */
function aggregateFileStats(
  sessions: Map<string, Map<string, number>>
): Map<string, { sessionCount: number; totalReads: number }> {
  const fileStats = new Map<string, { sessionCount: number; totalReads: number }>();
  for (const sessionFiles of sessions.values()) {
    for (const [filePath, reads] of sessionFiles.entries()) {
      const stat = fileStats.get(filePath) ?? { sessionCount: 0, totalReads: 0 };
      stat.sessionCount += 1;
      stat.totalReads += reads;
      fileStats.set(filePath, stat);
    }
  }
  return fileStats;
}

export function summarizeCrossSessionPatterns(daysBack = 30, logPath?: string): CrossSessionSummary {
  const cutoff = Date.now() - daysBack * 86_400_000;
  const allEntries = readMcpUsageLog(logPath).filter(
    (e) => !e.error && new Date(e.ts).getTime() >= cutoff
  );

  // Use the incremental index only for the global log — workspace logs may have
  // different entry subsets for the same session ID, so we avoid cross-contaminating.
  const useIndex = !logPath;
  const index: RawSessionIndex = useIndex ? readRawSessionIndex() : {};

  // The latest session ID is still "active" (entries may still arrive).
  // All other sessions with distinct IDs are complete and safe to index.
  const latestSid = [...allEntries].reverse().find((e) => e.sessionId)?.sessionId;
  const todayKey = new Date().toISOString().slice(0, 10);

  // --- Pass 1: index newly completed sessions ---
  const newlyIndexed = new Map<string, { lastTs: string; reads: Map<string, number>; noOps: Map<string, number> }>();
  for (const e of allEntries) {
    const sid = e.sessionId ?? e.ts.slice(0, 10);
    if (index[sid]) continue; // already indexed
    if (sid === latestSid || sid === todayKey) continue; // still potentially active
    if (!e.path) continue;
    const filePath = resolvePath(e.path);
    const sess = newlyIndexed.get(sid) ?? { lastTs: e.ts, reads: new Map<string, number>(), noOps: new Map<string, number>() };
    if (e.ts > sess.lastTs) sess.lastTs = e.ts;
    if (e.tool === "read_file") {
      sess.reads.set(filePath, (sess.reads.get(filePath) ?? 0) + 1);
    } else if (e.tool === "write_file" && e.skipped) {
      sess.noOps.set(filePath, (sess.noOps.get(filePath) ?? 0) + 1);
    }
    newlyIndexed.set(sid, sess);
  }

  // Persist newly indexed sessions; evict entries older than the cutoff.
  if (useIndex) {
    let dirty = newlyIndexed.size > 0;
    for (const [sid, sess] of newlyIndexed.entries()) {
      index[sid] = { lastTs: sess.lastTs, reads: Object.fromEntries(sess.reads), noOps: Object.fromEntries(sess.noOps) };
    }
    if (evictStaleIndexEntries(index, cutoff)) dirty = true;
    if (dirty) writeRawSessionIndex(index);
  }

  // --- Pass 2: build combined session maps from index + live active-session entries ---
  const sessions = new Map<string, Map<string, number>>();
  const noOpSessions = new Map<string, Map<string, number>>();

  // Populate from the index (stale entries were evicted above).
  for (const [sid, entry] of Object.entries(index)) {
    if (new Date(entry.lastTs).getTime() < cutoff) continue;
    sessions.set(sid, new Map(Object.entries(entry.reads)));
    if (Object.keys(entry.noOps).length > 0) {
      noOpSessions.set(sid, new Map(Object.entries(entry.noOps)));
    }
  }
  // For workspace-log paths (useIndex=false) add newly processed sessions directly.
  if (!useIndex) {
    for (const [sid, sess] of newlyIndexed.entries()) {
      sessions.set(sid, new Map(sess.reads));
      if (sess.noOps.size > 0) noOpSessions.set(sid, new Map(sess.noOps));
    }
  }
  // Add the active-session live entries (not yet in the index or newlyIndexed).
  for (const e of allEntries) {
    const sid = e.sessionId ?? e.ts.slice(0, 10);
    if (index[sid] || newlyIndexed.has(sid)) continue;
    if (!e.path) continue;
    const filePath = resolvePath(e.path);
    if (e.tool === "read_file") {
      const m = sessions.get(sid) ?? new Map<string, number>();
      m.set(filePath, (m.get(filePath) ?? 0) + 1);
      sessions.set(sid, m);
    } else if (e.tool === "write_file" && e.skipped) {
      const m = noOpSessions.get(sid) ?? new Map<string, number>();
      m.set(filePath, (m.get(filePath) ?? 0) + 1);
      noOpSessions.set(sid, m);
    }
  }

  const totalSessions = Math.max(sessions.size, noOpSessions.size);
  if (totalSessions === 0) {
    return { totalSessions: 0, persistentHotFiles: [], persistentNoOpWrites: [] };
  }

  const EXCLUDED_PATH_PATTERNS = [/[/\\][Tt]emp[/\\]/, /[/\\]tmp[/\\]/, /mcp-bench-/];

  const fileStats = aggregateFileStats(sessions);
  const persistentHotFiles: CrossSessionHotFile[] = [];
  for (const [filePath, stat] of fileStats.entries()) {
    if (stat.sessionCount < 3) continue;
    if (EXCLUDED_PATH_PATTERNS.some((re) => re.test(filePath))) continue;
    const prevalence = stat.sessionCount / totalSessions;
    if (prevalence < 0.5) continue;
    persistentHotFiles.push({
      path: filePath,
      sessionCount: stat.sessionCount,
      totalSessions,
      readsPerSession: Math.round((stat.totalReads / stat.sessionCount) * 10) / 10,
      prevalence,
    });
  }
  persistentHotFiles.sort((a, b) => b.prevalence - a.prevalence || b.readsPerSession - a.readsPerSession);

  const noOpFileStats = aggregateFileStats(noOpSessions);
  const persistentNoOpWrites: CrossSessionNoOpWriteFile[] = [];
  for (const [filePath, stat] of noOpFileStats.entries()) {
    if (stat.sessionCount < 2) continue;
    if (EXCLUDED_PATH_PATTERNS.some((re) => re.test(filePath))) continue;
    const prevalence = stat.sessionCount / totalSessions;
    if (prevalence < 0.3) continue;
    persistentNoOpWrites.push({
      path: filePath,
      sessionCount: stat.sessionCount,
      totalSessions,
      skipsPerSession: Math.round((stat.totalReads / stat.sessionCount) * 10) / 10,
      prevalence,
    });
  }
  persistentNoOpWrites.sort((a, b) => b.prevalence - a.prevalence || b.skipsPerSession - a.skipsPerSession);

  return { totalSessions, persistentHotFiles, persistentNoOpWrites };
}

// ---------------------------------------------------------------------------
// Log management
// ---------------------------------------------------------------------------

export interface ClearMcpLogsResult {
  clearedGlobal: boolean;
  clearedWorkspace: boolean;
  clearedHints: boolean;
}

/**
 * Truncates MCP usage logs and the hints file in place (preserves the files so
 * the MCP server can keep appending without an ENOENT on the next write).
 * Pass `workspaceLogPath` to also clear the workspace-scoped log.
 */
export function clearMcpLogs(workspaceLogPath?: string): ClearMcpLogsResult {
  const result: ClearMcpLogsResult = { clearedGlobal: false, clearedWorkspace: false, clearedHints: false };

  try {
    if (fs.existsSync(MCP_USAGE_LOG_PATH)) {
      fs.writeFileSync(MCP_USAGE_LOG_PATH, "", "utf-8");
      result.clearedGlobal = true;
    }
  } catch { /* non-fatal */ }

  // Clear the session index — derived from the usage log, stale after a log clear.
  try {
    if (fs.existsSync(MCP_SESSION_INDEX_PATH)) fs.unlinkSync(MCP_SESSION_INDEX_PATH);
  } catch { /* non-fatal */ }

  if (workspaceLogPath) {
    try {
      if (fs.existsSync(workspaceLogPath)) {
        fs.writeFileSync(workspaceLogPath, "", "utf-8");
        result.clearedWorkspace = true;
      }
    } catch { /* non-fatal */ }
  }

  try {
    if (fs.existsSync(MCP_HINTS_PATH)) {
      fs.writeFileSync(MCP_HINTS_PATH, "", "utf-8");
      result.clearedHints = true;
    }
  } catch { /* non-fatal */ }

  return result;
}
