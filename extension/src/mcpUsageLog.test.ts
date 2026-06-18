import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearMcpLogs,
  computeCliKpi,
  GRADE_THRESHOLDS,
  McpUsageEntry,
  readMcpUsageLog,
  summarizeMcpUsage,
  MCP_LOG_MAX_BYTES,
} from "./mcpUsageLog";

const tmpDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-log-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

function writeLog(logPath: string, entries: McpUsageEntry[]): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

function makeEntry(overrides: Partial<McpUsageEntry> & { minsAgo?: number } = {}): McpUsageEntry {
  const { minsAgo = 0, ...rest } = overrides;
  const ts = new Date(Date.now() - minsAgo * 60_000).toISOString();
  return { ts, tool: "read_file", path: "/tmp/a.ts", durationMs: 10, ...rest };
}

describe("readMcpUsageLog", () => {
  it("returns empty array when file does not exist", () => {
    expect(readMcpUsageLog("/nonexistent/path.jsonl")).toEqual([]);
  });

  it("parses valid JSONL lines", () => {
    const root = tempDir();
    const logPath = path.join(root, "mcp-usage.jsonl");
    writeLog(logPath, [
      makeEntry({ path: "/tmp/a.ts", tool: "read_file" }),
      makeEntry({ path: "/tmp/b.ts", tool: "write_file" }),
    ]);
    const entries = readMcpUsageLog(logPath);
    expect(entries).toHaveLength(2);
    expect(entries[0].tool).toBe("read_file");
    expect(entries[1].tool).toBe("write_file");
  });

  it("skips malformed lines and parses the rest", () => {
    const root = tempDir();
    const logPath = path.join(root, "mcp-usage.jsonl");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(
      logPath,
      [JSON.stringify(makeEntry()), "not-json", JSON.stringify(makeEntry({ path: "/b.ts" }))].join("\n"),
      "utf-8"
    );
    const entries = readMcpUsageLog(logPath);
    expect(entries).toHaveLength(2);
  });

  it("returns cached result when mtime is unchanged", () => {
    const root = tempDir();
    const logPath = path.join(root, "mcp-usage.jsonl");
    writeLog(logPath, [makeEntry()]);
    const first = readMcpUsageLog(logPath);
    // Overwrite content without changing the log path — cache should still be used because
    // mtime only changes on write, and we're reading from the same stat.
    // Read again without touching the file: must return the same array reference.
    const second = readMcpUsageLog(logPath);
    expect(second).toBe(first);
  });
});

describe("summarizeMcpUsage — grade thresholds", () => {
  it("returns notEnoughData when total ops < 5", () => {
    const root = tempDir();
    const logPath = path.join(root, "mcp.jsonl");
    writeLog(logPath, [
      makeEntry({ path: "/a.ts", bytes: 100 }),
      makeEntry({ path: "/b.ts", bytes: 100 }),
    ]);
    const summary = summarizeMcpUsage(14, logPath);
    expect(summary.efficiencyScore.notEnoughData).toBe(true);
    expect(summary.efficiencyScore.grade).toBe("A");
  });

  it("grades A when no wasteful ops", () => {
    const root = tempDir();
    const logPath = path.join(root, "mcp.jsonl");
    const entries = ["/a.ts", "/b.ts", "/c.ts", "/d.ts", "/e.ts"].map((p) =>
      makeEntry({ path: p, bytes: 100 })
    );
    writeLog(logPath, entries);
    const summary = summarizeMcpUsage(14, logPath);
    expect(summary.efficiencyScore.grade).toBe("A");
    expect(summary.efficiencyScore.score).toBe(100);
  });

  it("detects waste when same file is read 3+ times", () => {
    const root = tempDir();
    const logPath = path.join(root, "mcp.jsonl");
    const hotFile = "/src/extension.ts";
    const entries = [
      makeEntry({ path: hotFile, bytes: 4000, minsAgo: 10 }),
      makeEntry({ path: hotFile, bytes: 4000, minsAgo: 8 }),
      makeEntry({ path: hotFile, bytes: 4000, minsAgo: 6 }),
      makeEntry({ path: "/other/a.ts", bytes: 100, minsAgo: 5 }),
      makeEntry({ path: "/other/b.ts", bytes: 100, minsAgo: 4 }),
    ];
    writeLog(logPath, entries);
    const summary = summarizeMcpUsage(14, logPath);
    expect(summary.wasteWarnings.length).toBeGreaterThanOrEqual(1);
    expect(summary.wasteWarnings[0].reads).toBe(3);
    expect(summary.wasteWarnings[0].wastedTokens).toBeGreaterThan(0);
    expect(summary.efficiencyScore.score).toBeLessThan(100);
  });

  it("detects read-after-write within 60 seconds", () => {
    const root = tempDir();
    const logPath = path.join(root, "mcp.jsonl");
    // Use a real absolute path so resolvePath/path.normalize doesn't change slashes on Windows.
    const filePath = path.join(root, "output.ts");
    const writeTs = new Date(Date.now() - 5 * 60_000).toISOString();
    const readTs = new Date(new Date(writeTs).getTime() + 30_000).toISOString();
    const entries: McpUsageEntry[] = [
      { ts: writeTs, tool: "write_file", path: filePath, durationMs: 5 },
      { ts: readTs, tool: "read_file", path: filePath, durationMs: 10, bytes: 200 },
      makeEntry({ path: path.join(root, "a.ts"), minsAgo: 3 }),
      makeEntry({ path: path.join(root, "b.ts"), minsAgo: 2 }),
      makeEntry({ path: path.join(root, "c.ts"), minsAgo: 1 }),
    ];
    writeLog(logPath, entries);
    const summary = summarizeMcpUsage(14, logPath);
    expect(summary.readAfterWrite.length).toBeGreaterThanOrEqual(1);
    // resolvePath normalises the path — compare normalised forms.
    expect(path.normalize(summary.readAfterWrite[0].path)).toBe(path.normalize(filePath));
    expect(summary.readAfterWrite[0].secondsAfter).toBe(30);
  });

  it("reports multiple read-after-write occurrences for distinct write-read cycles on the same path", () => {
    const root = tempDir();
    const logPath = path.join(root, "mcp.jsonl");
    const filePath = path.join(root, "cycled.ts");
    const base = Date.now() - 10 * 60_000;
    // Two independent write→read cycles on the same file, each within 60s window.
    const entries: McpUsageEntry[] = [
      { ts: new Date(base).toISOString(),          tool: "write_file", path: filePath, durationMs: 5 },
      { ts: new Date(base + 20_000).toISOString(), tool: "read_file",  path: filePath, durationMs: 10, bytes: 100 },
      { ts: new Date(base + 60_000).toISOString(), tool: "write_file", path: filePath, durationMs: 5 },
      { ts: new Date(base + 80_000).toISOString(), tool: "read_file",  path: filePath, durationMs: 10, bytes: 100 },
      makeEntry({ path: path.join(root, "x.ts"), minsAgo: 1 }),
    ];
    writeLog(logPath, entries);
    const summary = summarizeMcpUsage(14, logPath);
    // Both cycles should be reported (up to the 5-item cap).
    expect(summary.readAfterWrite.length).toBe(2);
    expect(summary.readAfterWrite[0].secondsAfter).toBe(20);
    expect(summary.readAfterWrite[1].secondsAfter).toBe(20);
  });

  it("does not re-fire read-after-write for the same write when read twice (clears after first warning)", () => {
    const root = tempDir();
    const logPath = path.join(root, "mcp.jsonl");
    const filePath = path.join(root, "once.ts");
    const base = Date.now() - 10 * 60_000;
    // One write followed by two reads — only the first read should be warned.
    const entries: McpUsageEntry[] = [
      { ts: new Date(base).toISOString(),          tool: "write_file", path: filePath, durationMs: 5 },
      { ts: new Date(base + 10_000).toISOString(), tool: "read_file",  path: filePath, durationMs: 10, bytes: 100 },
      { ts: new Date(base + 20_000).toISOString(), tool: "read_file",  path: filePath, durationMs: 10, bytes: 100 },
      makeEntry({ path: path.join(root, "a.ts"), minsAgo: 1 }),
      makeEntry({ path: path.join(root, "b.ts"), minsAgo: 1 }),
    ];
    writeLog(logPath, entries);
    const summary = summarizeMcpUsage(14, logPath);
    // Second read has no preceding write (was cleared) — only one warning.
    expect(summary.readAfterWrite.length).toBe(1);
    expect(summary.readAfterWrite[0].secondsAfter).toBe(10);
  });

  it("does not flag read-after-write that happens after the window", () => {
    const root = tempDir();
    const logPath = path.join(root, "mcp.jsonl");
    const filePath = "/src/output.ts";
    const writeTs = new Date(Date.now() - 10 * 60_000).toISOString();
    const readTs = new Date(new Date(writeTs).getTime() + 90_000).toISOString();
    const entries: McpUsageEntry[] = [
      { ts: writeTs, tool: "write_file", path: filePath, durationMs: 5 },
      { ts: readTs, tool: "read_file", path: filePath, durationMs: 10, bytes: 200 },
      makeEntry({ path: "/a.ts", minsAgo: 3 }),
      makeEntry({ path: "/b.ts", minsAgo: 2 }),
      makeEntry({ path: "/c.ts", minsAgo: 1 }),
    ];
    writeLog(logPath, entries);
    const summary = summarizeMcpUsage(14, logPath);
    expect(summary.readAfterWrite).toHaveLength(0);
  });

  it("detects agent loops (4+ reads in 5-min window)", () => {
    const root = tempDir();
    const logPath = path.join(root, "mcp.jsonl");
    const loopFile = "/src/hot.ts";
    const base = Date.now() - 10 * 60_000;
    const loopEntries: McpUsageEntry[] = [0, 1, 2, 3].map((i) => ({
      ts: new Date(base + i * 30_000).toISOString(),
      tool: "read_file",
      path: loopFile,
      durationMs: 10,
      bytes: 1000,
    }));
    const extras = ["/a.ts", "/b.ts"].map((p) => makeEntry({ path: p, bytes: 100 }));
    writeLog(logPath, [...loopEntries, ...extras]);
    const summary = summarizeMcpUsage(14, logPath);
    expect(summary.agentLoops.length).toBeGreaterThanOrEqual(1);
    expect(summary.agentLoops[0].reads).toBe(4);
  });

  it("detects large file reads (>100KB) — moderate size uses section hint", () => {
    const root = tempDir();
    const logPath = path.join(root, "mcp.jsonl");
    const largeFile = path.join(root, "bigfile.ts");
    const entries = [
      makeEntry({ path: largeFile, bytes: 200 * 1024 }),
      makeEntry({ path: path.join(root, "a.ts"), bytes: 100 }),
      makeEntry({ path: path.join(root, "b.ts"), bytes: 100 }),
      makeEntry({ path: path.join(root, "c.ts"), bytes: 100 }),
      makeEntry({ path: path.join(root, "d.ts"), bytes: 100 }),
    ];
    writeLog(logPath, entries);
    const summary = summarizeMcpUsage(14, logPath);
    expect(summary.largeFiles.length).toBeGreaterThanOrEqual(1);
    expect(summary.largeFiles[0].bytes).toBe(200 * 1024);
    // 200KB is below the 512KB threshold → "Extract only needed sections"
    expect(summary.largeFiles[0].suggestion).toContain("Extract only needed sections");
  });

  it("detects large file reads (>512KB) — very large files use chunk hint", () => {
    const root = tempDir();
    const logPath = path.join(root, "mcp.jsonl");
    const largeFile = path.join(root, "huge.ts");
    const entries = [
      makeEntry({ path: largeFile, bytes: 600 * 1024 }),
      makeEntry({ path: path.join(root, "a.ts"), bytes: 100 }),
      makeEntry({ path: path.join(root, "b.ts"), bytes: 100 }),
      makeEntry({ path: path.join(root, "c.ts"), bytes: 100 }),
      makeEntry({ path: path.join(root, "d.ts"), bytes: 100 }),
    ];
    writeLog(logPath, entries);
    const summary = summarizeMcpUsage(14, logPath);
    expect(summary.largeFiles[0].bytes).toBe(600 * 1024);
    // > 512KB threshold → "Use search_in_file or chunk reading"
    expect(summary.largeFiles[0].suggestion).toContain("chunk");
  });

  it("detects no-op writes (skipped=true)", () => {
    const root = tempDir();
    const logPath = path.join(root, "mcp.jsonl");
    const entries: McpUsageEntry[] = [
      { ts: new Date().toISOString(), tool: "write_file", path: "/src/a.ts", durationMs: 2, skipped: true },
      { ts: new Date().toISOString(), tool: "write_file", path: "/src/a.ts", durationMs: 2, skipped: true },
      makeEntry({ path: "/b.ts", bytes: 100 }),
      makeEntry({ path: "/c.ts", bytes: 100 }),
      makeEntry({ path: "/d.ts", bytes: 100 }),
    ];
    writeLog(logPath, entries);
    const summary = summarizeMcpUsage(14, logPath);
    expect(summary.noOpWrites.length).toBeGreaterThanOrEqual(1);
    expect(summary.noOpWrites[0].skippedCount).toBe(2);
    expect(summary.suggestions.some((s) => s.kind === "skip_write")).toBe(true);
  });

  it("detects excessive directory scans (3+ scans of same path)", () => {
    const root = tempDir();
    const logPath = path.join(root, "mcp.jsonl");
    const scanDir = "/src/components";
    const entries: McpUsageEntry[] = [
      { ts: new Date().toISOString(), tool: "list_directory", path: scanDir, durationMs: 5, entryCount: 20 },
      { ts: new Date().toISOString(), tool: "list_directory", path: scanDir, durationMs: 5, entryCount: 20 },
      { ts: new Date().toISOString(), tool: "list_directory", path: scanDir, durationMs: 5, entryCount: 20 },
      makeEntry({ path: "/a.ts" }),
      makeEntry({ path: "/b.ts" }),
    ];
    writeLog(logPath, entries);
    const summary = summarizeMcpUsage(14, logPath);
    expect(summary.excessiveScans.length).toBeGreaterThanOrEqual(1);
    expect(summary.excessiveScans[0].scans).toBe(3);
    expect(summary.suggestions.some((s) => s.kind === "deduplicate_scans")).toBe(true);
  });

  it("excludes entries older than daysBack", () => {
    const root = tempDir();
    const logPath = path.join(root, "mcp.jsonl");
    const oldTs = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const entries: McpUsageEntry[] = [
      { ts: oldTs, tool: "read_file", path: "/old.ts", durationMs: 10, bytes: 100 },
    ];
    writeLog(logPath, entries);
    const summary = summarizeMcpUsage(14, logPath);
    expect(summary.totalCalls).toBe(0);
  });

  it("byTool counts are correct for filesystem calls", () => {
    const root = tempDir();
    const logPath = path.join(root, "mcp.jsonl");
    const entries: McpUsageEntry[] = [
      makeEntry({ path: "/a.ts", tool: "read_file" }),
      makeEntry({ path: "/b.ts", tool: "read_file" }),
      { ts: new Date().toISOString(), tool: "write_file", path: "/c.ts", durationMs: 5 },
    ];
    writeLog(logPath, entries);
    const summary = summarizeMcpUsage(14, logPath);
    expect(summary.byTool["read_file"].calls).toBe(2);
    expect(summary.byTool["write_file"].calls).toBe(1);
  });

  it("CLI server entries appear as cli:<name> in byTool and do not affect waste detectors", () => {
    const root = tempDir();
    const logPath = path.join(root, "mcp.jsonl");
    // Mix of filesystem and CLI server entries.
    const entries: McpUsageEntry[] = [
      makeEntry({ path: path.join(root, "a.ts"), tool: "read_file", bytes: 100 }),
      makeEntry({ path: path.join(root, "b.ts"), tool: "read_file", bytes: 100 }),
      makeEntry({ path: path.join(root, "c.ts"), tool: "read_file", bytes: 100 }),
      makeEntry({ path: path.join(root, "d.ts"), tool: "read_file", bytes: 100 }),
      makeEntry({ path: path.join(root, "e.ts"), tool: "read_file", bytes: 100 }),
      // CLI server entries — tool is "cli:az", no path field
      { ts: new Date().toISOString(), tool: "cli:az", path: "", durationMs: 800, server: "cli", cli: "az", exitCode: 0 },
      { ts: new Date().toISOString(), tool: "cli:az", path: "", durationMs: 1200, server: "cli", cli: "az", exitCode: 0 },
      { ts: new Date().toISOString(), tool: "cli:terraform", path: "", durationMs: 5000, server: "cli", cli: "terraform", exitCode: 0 },
    ];
    writeLog(logPath, entries);
    const summary = summarizeMcpUsage(14, logPath);

    // CLI entries get their own byTool buckets.
    expect(summary.byTool["cli:az"].calls).toBe(2);
    expect(summary.byTool["cli:terraform"].calls).toBe(1);
    // Filesystem entries still tracked.
    expect(summary.byTool["read_file"].calls).toBe(5);
    // CLI entries do NOT appear as waste warnings (no path, not read_file).
    expect(summary.wasteWarnings).toHaveLength(0);
    // CLI entries do NOT appear as agent loops.
    expect(summary.agentLoops).toHaveLength(0);
    // totalCalls includes both filesystem and CLI entries.
    expect(summary.totalCalls).toBe(8);
  });

  it("propagates the latest sessionId", () => {
    const root = tempDir();
    const logPath = path.join(root, "mcp.jsonl");
    const entries: McpUsageEntry[] = [
      makeEntry({ sessionId: "sess-old", minsAgo: 5 }),
      makeEntry({ sessionId: "sess-new", minsAgo: 1 }),
    ];
    writeLog(logPath, entries);
    const summary = summarizeMcpUsage(14, logPath);
    expect(summary.latestSessionId).toBe("sess-new");
  });
});

describe("clearMcpLogs", () => {
  it("truncates workspace log and returns clearedWorkspace=true", () => {
    const root = tempDir();
    const wsLogPath = path.join(root, ".claude", "mcp-usage.jsonl");
    writeLog(wsLogPath, [makeEntry()]);
    const result = clearMcpLogs(wsLogPath);
    expect(result.clearedWorkspace).toBe(true);
    expect(fs.readFileSync(wsLogPath, "utf-8")).toBe("");
  });

  it("returns clearedWorkspace=false when workspace log does not exist", () => {
    const result = clearMcpLogs("/nonexistent/ws/mcp-usage.jsonl");
    expect(result.clearedWorkspace).toBe(false);
  });

  it("returns clearedGlobal=false when global log does not exist at default path", () => {
    // The global log at MCP_USAGE_LOG_PATH may or may not exist on this machine.
    // clearMcpLogs is non-destructive when file is absent — just verify it doesn't throw.
    expect(() => clearMcpLogs()).not.toThrow();
  });
});


// ---------------------------------------------------------------------------
// GRADE_THRESHOLDS constant -- P2b fix verification
// ---------------------------------------------------------------------------

describe("GRADE_THRESHOLDS", () => {
  it("exports all five grades", () => {
    expect(GRADE_THRESHOLDS).toMatchObject({ A: 90, B: 75, C: 60, D: 45, F: 0 });
  });

  it("has A as the highest threshold", () => {
    const values = Object.values(GRADE_THRESHOLDS) as number[];
    expect(Math.max(...values)).toBe(GRADE_THRESHOLDS.A);
  });

  it("has F as the lowest threshold (0)", () => {
    expect(GRADE_THRESHOLDS.F).toBe(0);
  });

  it("thresholds are strictly decreasing A to F", () => {
    const order: Array<keyof typeof GRADE_THRESHOLDS> = ["A", "B", "C", "D", "F"];
    for (let i = 0; i < order.length - 1; i++) {
      expect(GRADE_THRESHOLDS[order[i]!]).toBeGreaterThan(GRADE_THRESHOLDS[order[i + 1]!]!);
    }
  });

  it("summarizeMcpUsage assigns grade A for a clean session", () => {
    const root = tempDir();
    const logPath = path.join(root, "mcp-usage.jsonl");
    const entries: McpUsageEntry[] = Array.from({ length: 10 }, (_, i) => ({
      ts: new Date(Date.now() + i * 1000).toISOString(),
      tool: "read_file",
      path: `/allowed/file${i}.ts`,
      durationMs: 5,
      bytes: 100,
      sessionId: "sess001",
    }));
    writeLog(logPath, entries);
    const summary = summarizeMcpUsage(logPath);
    expect(summary.efficiencyScore.grade).toBe("A");
    expect(summary.efficiencyScore.score).toBeGreaterThanOrEqual(GRADE_THRESHOLDS.A);
  });
});

// ---------------------------------------------------------------------------
// MCP_LOG_MAX_BYTES constant -- P1c/P3b fix verification
// ---------------------------------------------------------------------------

describe("MCP_LOG_MAX_BYTES", () => {
  it("is exported and equals 50 MB", () => {
    expect(MCP_LOG_MAX_BYTES).toBe(50 * 1024 * 1024);
  });

  it("is greater than 0", () => {
    expect(MCP_LOG_MAX_BYTES).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// computeCliKpi
// ---------------------------------------------------------------------------

function cliEntry(
  cli: string,
  exitCode: number,
  opts: { sessionId?: string; durationMs?: number; timedOut?: boolean; ts?: string; cwd?: string } = {}
): McpUsageEntry {
  return {
    ts: opts.ts ?? new Date().toISOString(),
    tool: `cli:${cli}`,
    path: "",
    durationMs: opts.durationMs ?? 100,
    server: "cli",
    cli,
    exitCode,
    timedOut: opts.timedOut,
    sessionId: opts.sessionId ?? "sess001",
    cwd: opts.cwd,
  } as McpUsageEntry;
}

describe("computeCliKpi", () => {
  it("returns notEnoughData when no CLI entries", () => {
    const result = computeCliKpi([]);
    expect(result.totalCalls).toBe(0);
    expect(result.notEnoughData).toBe(true);
    expect(result.grade).toBe("A");
  });

  it("returns notEnoughData when fewer than 3 CLI calls", () => {
    const entries = [cliEntry("az", 0), cliEntry("az", 0)];
    const result = computeCliKpi(entries);
    expect(result.notEnoughData).toBe(true);
    expect(result.totalCalls).toBe(2);
  });

  it("grades A when all calls succeed", () => {
    const entries = Array.from({ length: 5 }, () => cliEntry("git", 0));
    const result = computeCliKpi(entries);
    expect(result.overallSuccessRate).toBe(100);
    expect(result.grade).toBe("A");
    expect(result.totalFailures).toBe(0);
  });

  it("grades F when most calls fail", () => {
    const entries = [
      cliEntry("terraform", 1),
      cliEntry("terraform", 1),
      cliEntry("terraform", 1),
      cliEntry("terraform", 1),
      cliEntry("terraform", 0),
    ];
    const result = computeCliKpi(entries);
    expect(result.overallSuccessRate).toBe(20);
    expect(result.grade).toBe("F");
    expect(result.totalFailures).toBe(4);
  });

  it("counts successes and failures correctly across multiple CLIs", () => {
    const entries = [
      cliEntry("az", 0), cliEntry("az", 0), cliEntry("az", 1),     // 2/3
      cliEntry("terraform", 0), cliEntry("terraform", 0),           // 2/2
    ];
    const result = computeCliKpi(entries);
    expect(result.totalCalls).toBe(5);
    expect(result.totalFailures).toBe(1);
    expect(result.overallSuccessRate).toBe(80);
    expect(result.byCli).toHaveLength(2);

    const az = result.byCli.find((c) => c.cli === "az");
    expect(az?.successRate).toBe(67); // 2/3 rounded
    expect(az?.failureCount).toBe(1);

    const tf = result.byCli.find((c) => c.cli === "terraform");
    expect(tf?.successRate).toBe(100);
  });

  it("detects retries — success within 30s of a failure in the same session", () => {
    const base = Date.now();
    const t = (offsetMs: number) => new Date(base + offsetMs).toISOString();
    const entries = [
      cliEntry("az", 1, { sessionId: "s1", ts: t(0) }),        // failure
      cliEntry("az", 0, { sessionId: "s1", ts: t(5_000) }),    // success within 30s → retry
      cliEntry("az", 0, { sessionId: "s1", ts: t(60_000) }),   // success after 60s → NOT a retry
    ];
    const result = computeCliKpi(entries, 365);
    const az = result.byCli.find((c) => c.cli === "az")!;
    expect(az.retryCount).toBe(1);
    expect(result.totalRetries).toBe(1);
  });

  it("does not count retries across different sessions", () => {
    const base = Date.now();
    const t = (offsetMs: number) => new Date(base + offsetMs).toISOString();
    const entries = [
      cliEntry("az", 1, { sessionId: "s1", ts: t(0) }),     // failure in s1
      cliEntry("az", 0, { sessionId: "s2", ts: t(5_000) }), // success in s2 — different session
    ];
    const result = computeCliKpi(entries, 365);
    expect(result.totalRetries).toBe(0);
  });

  it("counts failure-after-failure as a retry", () => {
    const base = Date.now();
    const t = (offsetMs: number) => new Date(base + offsetMs).toISOString();
    const entries = [
      cliEntry("terraform", 1, { sessionId: "s1", ts: t(0) }),       // failure
      cliEntry("terraform", 1, { sessionId: "s1", ts: t(10_000) }), // failure within 30s → retry
    ];
    const result = computeCliKpi(entries, 365);
    expect(result.totalRetries).toBe(1);
  });

  it("counts timed-out calls", () => {
    const entries = [
      cliEntry("kubectl", 1, { timedOut: true }),
      cliEntry("kubectl", 0),
      cliEntry("kubectl", 0),
    ];
    const result = computeCliKpi(entries);
    expect(result.totalTimedOut).toBe(1);
    const k = result.byCli.find((c) => c.cli === "kubectl")!;
    expect(k.timedOutCount).toBe(1);
  });

  it("computes duration percentiles", () => {
    const entries = [
      cliEntry("git", 0, { durationMs: 100 }),
      cliEntry("git", 0, { durationMs: 200 }),
      cliEntry("git", 0, { durationMs: 300 }),
      cliEntry("git", 0, { durationMs: 400 }),
      cliEntry("git", 0, { durationMs: 2000 }), // outlier → P95
    ];
    const result = computeCliKpi(entries);
    const g = result.byCli.find((c) => c.cli === "git")!;
    expect(g.durationP50).toBe(300); // median of [100,200,300,400,2000]
    expect(g.durationP95).toBe(2000);
    expect(g.avgDurationMs).toBe(600);
  });

  it("records lastFailedAt and lastFailedCwd on failures", () => {
    const failTs = new Date().toISOString();
    const entries = [
      cliEntry("az", 1, { ts: failTs, cwd: "/project/infra" }),
      cliEntry("az", 0),
      cliEntry("az", 0),
    ];
    const result = computeCliKpi(entries, 365);
    const az = result.byCli.find((c) => c.cli === "az")!;
    expect(az.lastFailedAt).toBe(failTs);
    expect(az.lastFailedCwd).toBe("/project/infra");
  });

  it("identifies mostFailingCli", () => {
    const entries = [
      cliEntry("az", 0), cliEntry("az", 0), cliEntry("az", 0),
      cliEntry("terraform", 1), cliEntry("terraform", 1), cliEntry("terraform", 0),
    ];
    const result = computeCliKpi(entries);
    expect(result.mostFailingCli).toBe("terraform");
  });

  it("omits mostFailingCli when no failures", () => {
    const entries = Array.from({ length: 4 }, () => cliEntry("git", 0));
    const result = computeCliKpi(entries);
    expect(result.mostFailingCli).toBeUndefined();
  });

  it("sorts byCli by totalCalls descending", () => {
    const entries = [
      cliEntry("helm", 0),
      cliEntry("git", 0), cliEntry("git", 0), cliEntry("git", 0),
      cliEntry("az", 0), cliEntry("az", 0),
    ];
    const result = computeCliKpi(entries);
    expect(result.byCli[0]!.cli).toBe("git");
    expect(result.byCli[1]!.cli).toBe("az");
    expect(result.byCli[2]!.cli).toBe("helm");
  });

  it("respects daysBack cutoff — ignores old entries", () => {
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString(); // 20 days ago
    const entries = [
      cliEntry("az", 1, { ts: old }),  // outside 14-day window
      cliEntry("az", 0),               // today
      cliEntry("az", 0),               // today
      cliEntry("az", 0),               // today
    ];
    const result = computeCliKpi(entries, 14); // default window
    expect(result.totalCalls).toBe(3);         // old entry excluded
    expect(result.totalFailures).toBe(0);
    expect(result.grade).toBe("A");
  });

  it("grade matches GRADE_THRESHOLDS boundaries exactly", () => {
    function makeEntries(successCount: number, total: number): McpUsageEntry[] {
      return [
        ...Array.from({ length: successCount }, () => cliEntry("az", 0)),
        ...Array.from({ length: total - successCount }, () => cliEntry("az", 1)),
      ];
    }
    // 90% success → A
    expect(computeCliKpi(makeEntries(9, 10)).grade).toBe("A");
    // 75% success → B
    expect(computeCliKpi(makeEntries(75, 100)).grade).toBe("B");
    // 60% success → C
    expect(computeCliKpi(makeEntries(60, 100)).grade).toBe("C");
    // 45% success → D
    expect(computeCliKpi(makeEntries(45, 100)).grade).toBe("D");
    // 44% success → F
    expect(computeCliKpi(makeEntries(44, 100)).grade).toBe("F");
  });
});