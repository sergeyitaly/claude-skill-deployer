import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const MCP_USAGE_LOG_PATH = path.join(os.homedir(), ".claude", "learning", "mcp-usage.jsonl");
export const MCP_HINTS_PATH = path.join(os.homedir(), ".claude", "learning", "mcp-agent-hints.md");

/** Returns the workspace-scoped MCP usage log path for hybrid telemetry. */
export function workspaceMcpLogPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".claude", "mcp-usage.jsonl");
}

/** One line written by the MCP filesystem server per tool call. */
export interface McpUsageEntry {
  ts: string;
  tool: string;
  path: string;
  durationMs: number;
  /** Byte size of content read or written. */
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

// ---------------------------------------------------------------------------
// Log I/O
// ---------------------------------------------------------------------------

interface LogCache { mtime: number; entries: McpUsageEntry[] }
const logCache = new Map<string, LogCache>();

export function readMcpUsageLog(logPath = MCP_USAGE_LOG_PATH): McpUsageEntry[] {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  try {
    const mtime = fs.statSync(logPath).mtimeMs;
    const cached = logCache.get(logPath);
    if (cached && cached.mtime === mtime) return cached.entries;
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
    logCache.set(logPath, { mtime, entries });
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
  const writes = entries.filter((e) => e.tool === "write_file" && !e.error && !e.skipped);
  const reads = entries.filter((e) => e.tool === "read_file" && !e.error);
  const warnings: ReadAfterWriteWarning[] = [];
  const seen = new Set<string>();

  for (const w of writes) {
    const wTime = new Date(w.ts).getTime();
    const match = reads.find((r) => {
      const rTime = new Date(r.ts).getTime();
      return r.path === w.path && rTime > wTime && rTime - wTime <= windowSecs * 1000;
    });
    if (match && !seen.has(w.path)) {
      seen.add(w.path);
      const secondsAfter = Math.round((new Date(match.ts).getTime() - wTime) / 1000);
      warnings.push({
        path: w.path,
        secondsAfter,
        description: `Read ${secondsAfter}s after write — reuse written content instead of re-reading`,
      });
    }
  }
  return warnings.slice(0, 5);
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
    for (const read of sorted) {
      const windowStart = new Date(read.ts).getTime();
      const inWindow = sorted.filter((r) => {
        const t = new Date(r.ts).getTime();
        return t >= windowStart && t <= windowStart + windowMs;
      });
      if (inWindow.length >= LOOP_THRESHOLD) {
        const avgBytes = sorted.reduce((s, r) => s + (r.bytes ?? 0), 0) / sorted.length;
        const wastedTokens = bytesToTokens(avgBytes * (inWindow.length - 1));
        warnings.push({
          path: filePath,
          reads: inWindow.length,
          windowMinutes: LOOP_WINDOW_MINUTES,
          estimatedWastedTokens: wastedTokens,
          description: `Read ${inWindow.length}× in ${LOOP_WINDOW_MINUTES}min — possible agent reasoning loop`,
        });
        break;
      }
    }
  }
  const sortedWarnings = [...warnings].sort((a, b) => b.estimatedWastedTokens - a.estimatedWastedTokens);
  return sortedWarnings.slice(0, 5);
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
    .sort((a, b) => b.estimatedWastedEntries - a.estimatedWastedEntries || b.scans - a.scans)
    .slice(0, 5);
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
  const wastefulOps =
    waste.reduce((s, w) => s + Math.max(0, w.reads - 1), 0) +
    readAfterWrite.length +
    loops.reduce((s, l) => s + Math.max(0, l.reads - 1), 0) +
    noOpWrites.reduce((s, n) => s + n.skippedCount, 0) +
    excessiveScans.reduce((s, sc) => s + Math.max(1, Math.ceil(sc.estimatedWastedEntries / 50)), 0);
  const score = Math.max(0, Math.round(((totalOps - wastefulOps) / totalOps) * 100));
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

function accumulateEntries(goodEntries: McpUsageEntry[]): AccumulatedRaw {
  const byToolRaw: AccumulatedRaw["byToolRaw"] = {};
  const byFileRaw: AccumulatedRaw["byFileRaw"] = {};
  let totalMs = 0;
  let totalEstimatedTokens = 0;
  for (const e of goodEntries) {
    const tool = (byToolRaw[e.tool] ??= { calls: 0, totalMs: 0 });
    tool.calls += 1;
    tool.totalMs += e.durationMs;
    const normalized = e.path ? resolvePath(e.path) : "";
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

  const { byToolRaw, byFileRaw, totalMs, totalEstimatedTokens } = accumulateEntries(goodEntries);

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
  const resolvedEntries = goodEntries.map((e) =>
    e.path ? { ...e, path: resolvePath(e.path) } : e
  );

  // Detections
  const readAfterWrite = detectReadAfterWrite(resolvedEntries);
  const agentLoops = detectAgentLoops(resolvedEntries);
  const largeFiles = detectLargeFiles(resolvedEntries);
  // Exclude files already surfaced as agent loops — the loop warning is more specific.
  const loopPaths = new Set(agentLoops.map((l) => l.path));
  const wasteWarnings = detectWaste(resolvedEntries).warnings
    .filter((w) => !loopPaths.has(w.path))
    .slice(0, 5);
  const noOpWrites = detectNoOpWrites(resolvedEntries);
  const excessiveScans = detectExcessiveScans(resolvedEntries);

  const totalWastedTokens =
    wasteWarnings.reduce((s, w) => s + w.wastedTokens, 0) +
    agentLoops.reduce((s, l) => s + l.estimatedWastedTokens, 0);

  // Suggestions
  const suggestions: McpOptimizationSuggestion[] = [];
  if (wasteWarnings.length > 0) {
    suggestions.push({
      kind: "cache",
      description: `Cache ${wasteWarnings.length} hot file(s) read 3× or more — avoid re-reading content already in context`,
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
  if (excessiveScans.length > 0) {
    const totalWastedEntries = excessiveScans.reduce((s, sc) => s + sc.estimatedWastedEntries, 0);
    const entrySuffix = totalWastedEntries > 0 ? ` (${totalWastedEntries.toLocaleString()} wasted entries total)` : "";
    suggestions.push({
      kind: "deduplicate_scans",
      description: `Cache directory listings instead of re-scanning — ${excessiveScans.length} path(s) scanned 3× or more${entrySuffix}`,
    });
  }

  const efficiencyScore = computeScore(goodEntries.length, wasteWarnings, readAfterWrite, agentLoops, noOpWrites, excessiveScans);

  // Latest session ID for per-session alert deduplication.
  const latestSessionId = [...entries].reverse().find((e) => e.sessionId)?.sessionId;

  return {
    totalCalls: goodEntries.length,
    byTool,
    topFiles,
    avgDurationMs: goodEntries.length > 0 ? Math.round(totalMs / goodEntries.length) : 0,
    totalEstimatedTokens,
    wasteWarnings,
    readAfterWrite,
    agentLoops,
    largeFiles,
    noOpWrites,
    excessiveScans,
    suggestions,
    efficiencyScore,
    totalWastedTokens,
    latestSessionId,
  };
}

// ---------------------------------------------------------------------------
// Auto-remediation: write a hints file agents can read at session start
// ---------------------------------------------------------------------------

export function writeMcpHints(summary: McpUsageSummary): void {
  const lines: string[] = [
    "# MCP Optimization Hints (auto-generated — do not edit)",
    `# Last updated: ${new Date().toISOString()}`,
    "#",
    "# Read this at the start of your session. Follow these rules to avoid",
    "# token waste and redundant file operations.",
    "",
  ];

  if (summary.wasteWarnings.length > 0) {
    lines.push("## Files to cache in memory (read repeatedly — do not re-read)");
    for (const w of summary.wasteWarnings) {
      lines.push(`- \`${w.path}\` — read ${w.reads}×, ~${w.wastedTokens.toLocaleString()} tokens wasted`);
    }
    lines.push("", "→ Rule: if a file is already in your context, do NOT call read_file again.", "");
  }

  if (summary.agentLoops.length > 0) {
    lines.push("## Detected reasoning loops (same file read many times in short window)");
    for (const l of summary.agentLoops) {
      lines.push(`- \`${l.path}\` — read ${l.reads}× in ${l.windowMinutes}min`);
    }
    lines.push("", "→ Rule: analyze once, store the result in your reasoning. Do not re-read to 'verify'.", "");
  }

  if (summary.largeFiles.length > 0) {
    lines.push("## Large files (>100KB) — avoid full reads");
    for (const f of summary.largeFiles) {
      lines.push(`- \`${f.path}\` — ${Math.round(f.bytes / 1024)}KB — ${f.suggestion}`);
    }
    lines.push("");
  }

  if (summary.readAfterWrite.length > 0) {
    lines.push("## Read-after-write patterns (reuse content you just wrote)");
    for (const r of summary.readAfterWrite) {
      lines.push(`- \`${r.path}\` — read ${r.secondsAfter}s after write`);
    }
    lines.push("", "→ Rule: after write_file, keep the written content in memory — no need to read it back.", "");
  }

  if (summary.efficiencyScore.score < 80) {
    lines.push(
      `## Session efficiency: ${summary.efficiencyScore.score}% (grade ${summary.efficiencyScore.grade})`,
      `- Total ops: ${summary.efficiencyScore.totalOps}  Wasteful: ${summary.efficiencyScore.wastefulOps}`,
      ""
    );
  }

  lines.push(
    "## General rules (always apply)",
    "- Do not call list_directory on the same path more than once per session",
    "- Do not call read_file on a file already present in your context",
    "- After write_file, reuse the content you already have",
    "- For files > 100KB, request only the relevant section",
    ""
  );

  try {
    fs.mkdirSync(path.dirname(MCP_HINTS_PATH), { recursive: true });
    fs.writeFileSync(MCP_HINTS_PATH, lines.join("\n"), "utf-8");
  } catch {
    // non-fatal
  }
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

export interface CrossSessionSummary {
  totalSessions: number;
  /** Files read in >50% of sessions, sorted by prevalence desc. */
  persistentHotFiles: CrossSessionHotFile[];
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

export function summarizeCrossSessionPatterns(daysBack = 30): CrossSessionSummary {
  const cutoff = Date.now() - daysBack * 86_400_000;
  const entries = readMcpUsageLog().filter(
    (e) => !e.error && e.tool === "read_file" && new Date(e.ts).getTime() >= cutoff
  );

  // session → path → read count
  const sessions = new Map<string, Map<string, number>>();
  for (const e of entries) {
    const sid = e.sessionId ?? e.ts.slice(0, 10); // fallback: date bucket
    const filePath = e.path ? resolvePath(e.path) : e.path;
    if (!filePath) continue;
    const sessionFiles = sessions.get(sid) ?? new Map<string, number>();
    sessionFiles.set(filePath, (sessionFiles.get(filePath) ?? 0) + 1);
    sessions.set(sid, sessionFiles);
  }

  const totalSessions = sessions.size;
  if (totalSessions === 0) {
    return { totalSessions: 0, persistentHotFiles: [] };
  }

  const fileStats = aggregateFileStats(sessions);

  const EXCLUDED_PATH_PATTERNS = [/[/\\][Tt]emp[/\\]/, /[/\\]tmp[/\\]/, /mcp-bench-/];

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
  return { totalSessions, persistentHotFiles };
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
