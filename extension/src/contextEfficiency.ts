/**
 * Context Efficiency Intelligence — Phases 1, 3, 5, 6, 7, 9
 *
 * Proactively reduces Claude token pressure by detecting waste patterns in
 * real-time from existing mcp-usage.jsonl (no new telemetry added).
 *
 *   Phase 1  — computeContextPressure()         real-time pressure scoring
 *   Phase 3  — detectHotFiles()                  files read repeatedly
 *   Phase 5  — detectRepeatedReadsInWindow()     same file ≥N× in 30 min
 *   Phase 6  — detectDirectoryScanWaste()        same dir scanned ≥N× times
 *   Phase 7  — computeContextEfficiencyScore()   useful / total tokens (0-100)
 *   Phase 9  — Learning loop: advisor events in context-advisor-log.jsonl
 *
 * Reuses without modification:
 *   readMcpUsageLog()      — raw log entries
 *   McpUsageEntry          — entry type
 *   workspaceMcpLogPath()  — workspace-scoped log
 *   MCP_USAGE_LOG_PATH     — global log fallback
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  readMcpUsageLog,
  McpUsageEntry,
  MCP_USAGE_LOG_PATH,
  workspaceMcpLogPath,
} from "./mcpUsageLog";

// ── Constants ─────────────────────────────────────────────────────────────────

const HOT_FILES_REL   = path.join(".claude", "learning", "hot-files.json");
const DIR_CACHE_REL   = path.join(".claude", "learning", "directory-cache.json");
const ADVISOR_LOG_REL = path.join(".claude", "learning", "context-advisor-log.jsonl");

/** bytes → tokens estimate (4 bytes per token, consistent with mcpUsageLog.ts) */
const BYTES_PER_TOKEN = 4;

/** Repeated read window for Phase 5. */
export const REPEATED_READ_WINDOW_MS = 30 * 60_000;
/** Min reads within window to flag as repeated. */
export const REPEATED_READ_THRESHOLD = 3;
/** Min directory scans to flag as excessive. */
export const DIR_SCAN_THRESHOLD = 3;
/** MCP tokens in the window that triggers compact advice (Phase 2 input). */
export const COMPACT_TOKEN_THRESHOLD = 120_000;
/** Wasted tokens that trigger compact advice. */
export const COMPACT_WASTE_THRESHOLD = 200_000;
/** Reads of the same file in window that trigger compact advice. */
export const COMPACT_REPEATED_THRESHOLD = 5;

// ── Helpers ───────────────────────────────────────────────────────────────────

export function bytesToTokens(bytes: number): number {
  return Math.round(bytes / BYTES_PER_TOKEN);
}

function normPath(p: string): string {
  // Normalize backslashes and lowercase the drive letter so C:/foo and c:/foo
  // map to the same key on Windows — without this the same file is counted twice.
  return p.replace(/\\/g, "/").replace(/^[A-Z]:/, m => m.toLowerCase());
}

function selectLogPath(target: string): string {
  const wsLog = workspaceMcpLogPath(target);
  return fs.existsSync(wsLog) ? wsLog : MCP_USAGE_LOG_PATH;
}

// ── Phase 1: Context Pressure ─────────────────────────────────────────────────

export type PressureLevel = "low" | "medium" | "high" | "critical";

export interface ContextPressureResult {
  /** 0-100 composite pressure score. */
  pressureScore: number;
  level: PressureLevel;
  /** Human-readable driver list, highest-impact first. */
  reasons: string[];
}

/**
 * Computes real-time context pressure from MCP usage signals.
 * All inputs come from a short-window (e.g. 24h or current session) analysis.
 */
export function computeContextPressure(
  totalMcpTokens: number,
  wastedMcpTokens: number,
  repeatedReadCount: number,
  dirScanExcessCount: number,
  sessionTokenHint = 0
): ContextPressureResult {
  let score = 0;
  const reasons: string[] = [];

  const contextProxy = Math.max(totalMcpTokens, sessionTokenHint);

  if (contextProxy > 400_000) {
    score += 40;
    reasons.push(`Context very large: ~${Math.round(contextProxy / 1_000)}k MCP tokens this session`);
  } else if (contextProxy > 200_000) {
    score += 30;
    reasons.push(`Context large: ~${Math.round(contextProxy / 1_000)}k MCP tokens`);
  } else if (contextProxy > COMPACT_TOKEN_THRESHOLD) {
    score += 20;
    reasons.push(`Context approaching limit: ~${Math.round(contextProxy / 1_000)}k MCP tokens`);
  }

  if (wastedMcpTokens > 500_000) {
    score += 30;
    reasons.push(`High MCP waste: ~${Math.round(wastedMcpTokens / 1_000)}k tokens wasted`);
  } else if (wastedMcpTokens > COMPACT_WASTE_THRESHOLD) {
    score += 20;
    reasons.push(`MCP waste elevated: ~${Math.round(wastedMcpTokens / 1_000)}k tokens wasted`);
  } else if (wastedMcpTokens > 50_000) {
    score += 10;
    reasons.push(`Some MCP waste: ~${Math.round(wastedMcpTokens / 1_000)}k tokens wasted`);
  }

  if (repeatedReadCount > 20) {
    score += 20;
    reasons.push(`${repeatedReadCount} repeated file reads detected`);
  } else if (repeatedReadCount > 10) {
    score += 15;
    reasons.push(`${repeatedReadCount} repeated file reads`);
  } else if (repeatedReadCount > REPEATED_READ_THRESHOLD) {
    score += 8;
    reasons.push(`${repeatedReadCount} repeated file reads`);
  }

  if (dirScanExcessCount > 10) {
    score += 10;
    reasons.push(`${dirScanExcessCount} excessive directory scans`);
  } else if (dirScanExcessCount > DIR_SCAN_THRESHOLD) {
    score += 5;
    reasons.push(`${dirScanExcessCount} repeated directory scans`);
  }

  score = Math.min(100, score);
  const level: PressureLevel =
    score >= 75 ? "critical" :
    score >= 50 ? "high" :
    score >= 25 ? "medium" : "low";

  if (reasons.length === 0) reasons.push("Context pressure is low");

  return { pressureScore: score, level, reasons };
}

// ── Phase 3: Hot File Detection ───────────────────────────────────────────────

export interface HotFile {
  path: string;
  reads: number;
  estimatedTokens: number;
  wastedReads: number;
  wastedTokens: number;
  lastSeen: string;
  sessionCount: number;
}

export interface HotFilesIndex {
  version: 1;
  computedAt: string;
  windowHours: number;
  files: HotFile[];
  totalWastedTokens: number;
}

export function detectHotFiles(entries: McpUsageEntry[]): HotFile[] {
  const byFile = new Map<string, {
    reads: number;
    totalBytes: number;
    sessions: Set<string>;
    lastSeen: string;
  }>();

  for (const e of entries) {
    if (e.tool !== "read_file" || typeof e.bytes !== "number") continue;
    const key = normPath(e.path ?? "");
    if (!key) continue;
    const rec = byFile.get(key) ?? { reads: 0, totalBytes: 0, sessions: new Set<string>(), lastSeen: "" };
    rec.reads++;
    rec.totalBytes += e.bytes;
    if (e.sessionId) rec.sessions.add(e.sessionId);
    if (!rec.lastSeen || e.ts > rec.lastSeen) rec.lastSeen = e.ts;
    byFile.set(key, rec);
  }

  return [...byFile.entries()]
    .filter(([, d]) => d.reads >= 2)
    .map(([fp, d]) => {
      const avgBytes   = d.reads > 0 ? d.totalBytes / d.reads : 0;
      const wastedReads  = d.reads - 1;
      const wastedTokens = bytesToTokens(avgBytes * wastedReads);
      return {
        path: fp,
        reads: d.reads,
        estimatedTokens: bytesToTokens(d.totalBytes),
        wastedReads,
        wastedTokens,
        lastSeen: d.lastSeen,
        sessionCount: d.sessions.size,
      };
    })
    .sort((a, b) => b.wastedTokens - a.wastedTokens);
}

export function readHotFilesIndex(target: string): HotFilesIndex | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(target, HOT_FILES_REL), "utf-8")) as HotFilesIndex;
  } catch { return undefined; }
}

function writeHotFilesIndex(target: string, index: HotFilesIndex): void {
  const file = path.join(target, HOT_FILES_REL);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(index, null, 2), "utf-8");
  } catch { /* non-fatal */ }
}

// ── Phase 5: Repeated Read Detection ─────────────────────────────────────────

export interface RepeatedReadEvent {
  path: string;
  reads: number;
  windowMinutes: number;
  estimatedWasteTokens: number;
  recommendation: string;
}

export function detectRepeatedReadsInWindow(
  entries: McpUsageEntry[],
  windowMs = REPEATED_READ_WINDOW_MS,
  threshold = REPEATED_READ_THRESHOLD
): RepeatedReadEvent[] {
  const readEntries = entries
    .filter(e => e.tool === "read_file")
    .sort((a, b) => a.ts.localeCompare(b.ts));

  // Group by file path
  const byFile = new Map<string, McpUsageEntry[]>();
  for (const e of readEntries) {
    const key = normPath(e.path ?? "");
    if (!key) continue;
    const list = byFile.get(key) ?? [];
    list.push(e);
    byFile.set(key, list);
  }

  const events: RepeatedReadEvent[] = [];
  for (const [fp, reads] of byFile) {
    // Find the worst window for this file
    let maxInWindow = 0;
    let worstTotalBytes = 0;
    for (let i = 0; i < reads.length; i++) {
      const windowStart = new Date(reads[i].ts).getTime();
      const windowEnd   = windowStart + windowMs;
      let count = 0, totalBytes = 0;
      for (let j = i; j < reads.length; j++) {
        if (new Date(reads[j].ts).getTime() <= windowEnd) {
          count++;
          totalBytes += reads[j].bytes ?? 0;
        } else break;
      }
      if (count > maxInWindow) { maxInWindow = count; worstTotalBytes = totalBytes; }
    }
    if (maxInWindow < threshold) continue;

    const avgBytes = maxInWindow > 0 ? worstTotalBytes / maxInWindow : 0;
    const estimatedWasteTokens = bytesToTokens(avgBytes * (maxInWindow - 1));
    const name = path.basename(fp);
    const recommendation = /CHANGELOG|README|LICENCE|LICENSE/i.test(name)
      ? `Use search_in_file to target specific sections of ${name} instead of loading the full file`
      : `${name} is already in context — reference it without re-reading`;

    events.push({
      path: fp,
      reads: maxInWindow,
      windowMinutes: Math.round(windowMs / 60_000),
      estimatedWasteTokens,
      recommendation,
    });
  }
  return events.sort((a, b) => b.estimatedWasteTokens - a.estimatedWasteTokens);
}

// ── Phase 6: Directory Scan Cache ─────────────────────────────────────────────

export interface DirectoryScanWaste {
  path: string;
  scans: number;
  totalEntries: number;
  estimatedWasteTokens: number;
  lastScanned: string;
}

export interface DirectoryCache {
  version: 1;
  computedAt: string;
  directories: Record<string, {
    scans: number;
    totalEntries: number;
    lastScanned: string;
    estimatedWasteTokens: number;
  }>;
}

export function detectDirectoryScanWaste(entries: McpUsageEntry[]): DirectoryScanWaste[] {
  const byPath = new Map<string, { scans: number; totalEntries: number; lastScanned: string }>();
  for (const e of entries) {
    if (e.tool !== "list_directory" && e.tool !== "search_files") continue;
    const key = normPath(e.path ?? "");
    if (!key) continue;
    const rec = byPath.get(key) ?? { scans: 0, totalEntries: 0, lastScanned: "" };
    rec.scans++;
    rec.totalEntries += e.entryCount ?? 0;
    if (!rec.lastScanned || e.ts > rec.lastScanned) rec.lastScanned = e.ts;
    byPath.set(key, rec);
  }

  return [...byPath.entries()]
    .filter(([, d]) => d.scans >= DIR_SCAN_THRESHOLD)
    .map(([fp, d]) => {
      const avgEntries = d.scans > 0 ? d.totalEntries / d.scans : 0;
      const estimatedWasteTokens = Math.round(avgEntries * (d.scans - 1) * 4);
      return {
        path: fp, scans: d.scans,
        totalEntries: d.totalEntries,
        estimatedWasteTokens,
        lastScanned: d.lastScanned,
      };
    })
    .sort((a, b) => b.estimatedWasteTokens - a.estimatedWasteTokens);
}

export function buildDirectoryCache(entries: McpUsageEntry[]): DirectoryCache {
  const dirs: DirectoryCache["directories"] = {};
  const byPath = new Map<string, { scans: number; totalEntries: number; lastScanned: string }>();
  for (const e of entries) {
    if (e.tool !== "list_directory" && e.tool !== "search_files") continue;
    const key = normPath(e.path ?? "");
    if (!key) continue;
    const rec = byPath.get(key) ?? { scans: 0, totalEntries: 0, lastScanned: "" };
    rec.scans++;
    rec.totalEntries += e.entryCount ?? 0;
    if (!rec.lastScanned || e.ts > rec.lastScanned) rec.lastScanned = e.ts;
    byPath.set(key, rec);
  }
  for (const [p, d] of byPath) {
    const avgEntries = d.scans > 0 ? d.totalEntries / d.scans : 0;
    dirs[p] = {
      scans: d.scans,
      totalEntries: d.totalEntries,
      lastScanned: d.lastScanned,
      estimatedWasteTokens: d.scans >= 2 ? Math.round(avgEntries * (d.scans - 1) * 4) : 0,
    };
  }
  return { version: 1, computedAt: new Date().toISOString(), directories: dirs };
}

export function readDirectoryCache(target: string): DirectoryCache | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(target, DIR_CACHE_REL), "utf-8")) as DirectoryCache;
  } catch { return undefined; }
}

function writeDirectoryCache(target: string, cache: DirectoryCache): void {
  const file = path.join(target, DIR_CACHE_REL);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache, null, 2), "utf-8");
  } catch { /* non-fatal */ }
}

// ── Phase 7: Context Efficiency Score ────────────────────────────────────────

export interface ContextEfficiencyResult {
  /** 0-100 — useful tokens / total tokens × 100. Target: 80+. */
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  usefulTokens: number;
  wastedTokens: number;
  totalTokens: number;
  usefulReadCount: number;
  wastedReadCount: number;
  totalReadCount: number;
  /** Tokens that could be saved by eliminating redundant reads. */
  potentialSavings: number;
}

export function computeContextEfficiencyScore(
  totalTokens: number,
  wastedTokens: number,
  totalReadCount: number,
  wastedReadCount: number
): ContextEfficiencyResult {
  const usefulTokens   = Math.max(0, totalTokens - wastedTokens);
  const usefulReadCount = Math.max(0, totalReadCount - wastedReadCount);
  const score = totalTokens > 0 ? Math.round((usefulTokens / totalTokens) * 100) : 100;

  const grade: ContextEfficiencyResult["grade"] =
    score >= 85 ? "A" :
    score >= 70 ? "B" :
    score >= 55 ? "C" :
    score >= 40 ? "D" : "F";

  return {
    score, grade,
    usefulTokens, wastedTokens, totalTokens,
    usefulReadCount, wastedReadCount, totalReadCount,
    potentialSavings: wastedTokens,
  };
}

// ── Full Analysis ─────────────────────────────────────────────────────────────

export interface ContextEfficiencyAnalysis {
  pressure: ContextPressureResult;
  hotFiles: HotFile[];
  repeatedReads: RepeatedReadEvent[];
  directoryScanWaste: DirectoryScanWaste[];
  efficiency: ContextEfficiencyResult;
  compactOpportunities: number;
  analyzedAt: string;
}

/**
 * Run the full context efficiency analysis for a workspace.
 * Reads from workspace mcp-usage.jsonl (or global fallback); writes hot-files.json
 * and directory-cache.json as cached artifacts.
 */
export function analyzeContextEfficiency(
  target: string,
  windowHours = 24,
  sessionTokenHint = 0
): ContextEfficiencyAnalysis {
  const cutoffMs = Date.now() - windowHours * 3_600_000;
  const logPath  = selectLogPath(target);
  const entries  = readMcpUsageLog(logPath).filter(
    e => new Date(e.ts).getTime() >= cutoffMs && !e.error
  );

  // Phase 3 — hot files
  const hotFiles = detectHotFiles(entries);
  writeHotFilesIndex(target, {
    version: 1,
    computedAt: new Date().toISOString(),
    windowHours,
    files: hotFiles,
    totalWastedTokens: hotFiles.reduce((s, f) => s + f.wastedTokens, 0),
  });

  // Phase 5 — repeated reads
  const repeatedReads = detectRepeatedReadsInWindow(entries);

  // Phase 6 — directory scans
  const dirScanWaste = detectDirectoryScanWaste(entries);
  writeDirectoryCache(target, buildDirectoryCache(entries));

  // Phase 7 — efficiency score
  const readEntries = entries.filter(e => e.tool === "read_file" && typeof e.bytes === "number");
  const totalReadCount = readEntries.length;
  const totalTokens    = readEntries.reduce((s, e) => s + bytesToTokens(e.bytes ?? 0), 0);
  const wastedTokens   = hotFiles.reduce((s, f) => s + f.wastedTokens, 0);
  const wastedReadCount = hotFiles.reduce((s, f) => s + f.wastedReads, 0);
  const efficiency = computeContextEfficiencyScore(totalTokens, wastedTokens, totalReadCount, wastedReadCount);

  // Phase 1 — pressure (uses derived signals)
  const pressure = computeContextPressure(
    totalTokens,
    wastedTokens,
    repeatedReads.reduce((s, r) => s + r.reads, 0),
    dirScanWaste.filter(d => d.scans >= DIR_SCAN_THRESHOLD).length,
    sessionTokenHint
  );

  const compactOpportunities =
    (totalTokens > COMPACT_TOKEN_THRESHOLD ? 1 : 0) +
    (wastedTokens > COMPACT_WASTE_THRESHOLD ? 1 : 0) +
    repeatedReads.filter(r => r.reads >= COMPACT_REPEATED_THRESHOLD).length;

  return {
    pressure,
    hotFiles: hotFiles.slice(0, 10),
    repeatedReads: repeatedReads.slice(0, 10),
    directoryScanWaste: dirScanWaste.slice(0, 10),
    efficiency,
    compactOpportunities,
    analyzedAt: new Date().toISOString(),
  };
}

// ── Phase 9: Advisor Learning Loop ───────────────────────────────────────────

export type AdvisorEventKind = "shown" | "followed" | "dismissed";

export interface AdvisorEvent {
  ts: string;
  event: AdvisorEventKind;
  estimatedSavingsTokens: number;
  triggerReason: string;
}

export interface AdvisorROI {
  shown: number;
  followed: number;
  dismissed: number;
  followRate: number;
  estimatedTokensSaved: number;
}

function advisorLogPath(target: string): string {
  return path.join(target, ADVISOR_LOG_REL);
}

export function recordAdvisorEvent(
  target: string,
  event: AdvisorEventKind,
  opts: { estimatedSavingsTokens?: number; triggerReason?: string } = {}
): void {
  const file = advisorLogPath(target);
  const record: AdvisorEvent = {
    ts: new Date().toISOString(),
    event,
    estimatedSavingsTokens: opts.estimatedSavingsTokens ?? 0,
    triggerReason: opts.triggerReason ?? "",
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf-8");
  } catch { /* non-fatal */ }
}

export function readAdvisorEvents(target: string): AdvisorEvent[] {
  const file = advisorLogPath(target);
  if (!fs.existsSync(file)) return [];
  const events: AdvisorEvent[] = [];
  try {
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line) as AdvisorEvent); } catch { /* skip */ }
    }
  } catch { /* non-fatal */ }
  return events;
}

export function computeAdvisorROI(target: string): AdvisorROI {
  const events = readAdvisorEvents(target);
  let shown = 0, followed = 0, dismissed = 0, estimatedTokensSaved = 0;
  for (const e of events) {
    if (e.event === "shown") shown++;
    else if (e.event === "followed") { followed++; estimatedTokensSaved += e.estimatedSavingsTokens; }
    else if (e.event === "dismissed") dismissed++;
  }
  return { shown, followed, dismissed, followRate: shown > 0 ? followed / shown : 0, estimatedTokensSaved };
}
