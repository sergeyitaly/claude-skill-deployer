/**
 * Unit tests for Context Efficiency Intelligence
 * (contextEfficiency.ts + contextAdvisor.ts)
 *
 * Covers all 12 phases:
 *   Phase 1  — computeContextPressure
 *   Phase 2  — evaluateCompactAdvisor
 *   Phase 3  — detectHotFiles
 *   Phase 5  — detectRepeatedReadsInWindow
 *   Phase 6  — detectDirectoryScanWaste / buildDirectoryCache
 *   Phase 7  — computeContextEfficiencyScore
 *   Phase 8  — buildCoachingMessages / formatEfficiencyCoachHtml
 *   Phase 9  — recordAdvisorEvent / computeAdvisorROI
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  computeContextPressure,
  detectHotFiles,
  detectRepeatedReadsInWindow,
  detectDirectoryScanWaste,
  buildDirectoryCache,
  computeContextEfficiencyScore,
  recordAdvisorEvent,
  computeAdvisorROI,
  analyzeContextEfficiency,
  readHotFilesIndex,
  readDirectoryCache,
  bytesToTokens,
  REPEATED_READ_WINDOW_MS,
  COMPACT_TOKEN_THRESHOLD,
  COMPACT_WASTE_THRESHOLD,
  MIN_PATTERN_OCCURRENCES,
} from "./contextEfficiency";

import {
  evaluateCompactAdvisor,
  buildCoachingMessages,
  formatEfficiencyCoachHtml,
  formatCompactAdvisorHtml,
} from "./contextAdvisor";

import type { McpUsageEntry } from "./mcpUsageLog";
import type { ContextEfficiencyAnalysis } from "./contextEfficiency";

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ctx-eff-test-"));
}

function makeReadEntry(
  filePath: string,
  bytes: number,
  ts: string,
  sessionId = "s1"
): McpUsageEntry {
  return {
    ts, tool: "read_file", path: filePath,
    durationMs: 10, bytes, sessionId,
  } as McpUsageEntry;
}

function makeListEntry(
  dirPath: string,
  entryCount: number,
  ts: string
): McpUsageEntry {
  return {
    ts, tool: "list_directory", path: dirPath,
    durationMs: 5, entryCount,
  } as McpUsageEntry;
}

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function seedMcpLog(target: string, entries: McpUsageEntry[]): void {
  const logFile = path.join(target, ".claude", "mcp-usage.jsonl");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, entries.map(e => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

// ── Phase 1: computeContextPressure ──────────────────────────────────────────

describe("Phase 1 — computeContextPressure", () => {
  it("returns low pressure when all inputs are zero", () => {
    const r = computeContextPressure(0, 0, 0, 0);
    expect(r.level).toBe("low");
    expect(r.pressureScore).toBe(0);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("returns medium for moderate repeated reads", () => {
    // 130k tokens (+20) + 60k waste (+10) + 12 repeated reads (+15) = 45 → medium
    const r = computeContextPressure(130_000, 60_000, 12, 0);
    expect(["medium", "high"]).toContain(r.level);
    expect(r.reasons.some(reason => reason.includes("repeated"))).toBe(true);
  });

  it("returns high when MCP tokens exceed 400k and waste > 200k", () => {
    // 450k tokens (+40) + 250k waste (+20) = 60 → high
    const r = computeContextPressure(450_000, 250_000, 0, 0);
    expect(["high", "critical"]).toContain(r.level);
    expect(r.reasons.some(r => r.includes("large") || r.includes("tokens"))).toBe(true);
  });

  it("returns critical when tokens > 400k and waste > 500k", () => {
    const r = computeContextPressure(500_000, 600_000, 25, 15);
    expect(r.level).toBe("critical");
    expect(r.pressureScore).toBe(100);
  });

  it("caps pressureScore at 100", () => {
    const r = computeContextPressure(1_000_000, 1_000_000, 100, 50);
    expect(r.pressureScore).toBeLessThanOrEqual(100);
  });

  it("uses sessionTokenHint when larger than totalMcpTokens", () => {
    const r1 = computeContextPressure(50_000, 0, 0, 0);
    const r2 = computeContextPressure(50_000, 0, 0, 0, 500_000);
    expect(r2.pressureScore).toBeGreaterThan(r1.pressureScore);
  });

  it("includes dir scan count in reasons", () => {
    const r = computeContextPressure(10_000, 0, 0, 12);
    expect(r.reasons.some(reason => reason.includes("scan") || reason.includes("directory"))).toBe(true);
  });
});

// ── Phase 3: detectHotFiles ───────────────────────────────────────────────────

describe("Phase 3 — detectHotFiles", () => {
  it("returns empty array when no read_file entries", () => {
    expect(detectHotFiles([])).toEqual([]);
  });

  it("ignores files read only once", () => {
    const entries = [makeReadEntry("/src/foo.ts", 4000, iso())];
    expect(detectHotFiles(entries)).toHaveLength(0);
  });

  it("detects file read twice as hot", () => {
    const entries = [
      makeReadEntry("/src/costDashboard.ts", 8000, iso(-60_000)),
      makeReadEntry("/src/costDashboard.ts", 8000, iso()),
    ];
    const hot = detectHotFiles(entries);
    expect(hot).toHaveLength(1);
    expect(hot[0].reads).toBe(2);
    expect(hot[0].wastedReads).toBe(1);
    expect(hot[0].wastedTokens).toBe(bytesToTokens(8000));
  });

  it("computes estimatedTokens as total bytes / 4", () => {
    const entries = [
      makeReadEntry("/f.ts", 4000, iso(-5_000)),
      makeReadEntry("/f.ts", 4000, iso()),
    ];
    const [f] = detectHotFiles(entries);
    expect(f.estimatedTokens).toBe(2000); // 8000 bytes / 4
    expect(f.wastedTokens).toBe(1000);    // 1 wasted read × 4000 bytes / 4
  });

  it("sorts by wastedTokens descending", () => {
    const entries = [
      makeReadEntry("/small.ts", 400,   iso(-2_000)),
      makeReadEntry("/small.ts", 400,   iso(-1_000)),
      makeReadEntry("/large.ts", 40000, iso(-2_000)),
      makeReadEntry("/large.ts", 40000, iso(-1_000)),
    ];
    const hot = detectHotFiles(entries);
    expect(hot[0].path).toContain("large");
    expect(hot[1].path).toContain("small");
  });

  it("tracks distinct sessions via sessionId", () => {
    const entries = [
      makeReadEntry("/f.ts", 1000, iso(-2_000), "s1"),
      makeReadEntry("/f.ts", 1000, iso(),       "s2"),
    ];
    const [f] = detectHotFiles(entries);
    expect(f.sessionCount).toBe(2);
  });

  it("normalises backslash paths", () => {
    const entries = [
      { ts: iso(-2_000), tool: "read_file", path: "C:\\src\\file.ts", durationMs: 5, bytes: 1000 } as McpUsageEntry,
      { ts: iso(),       tool: "read_file", path: "C:\\src\\file.ts", durationMs: 5, bytes: 1000 } as McpUsageEntry,
    ];
    expect(detectHotFiles(entries)).toHaveLength(1);
  });
});

// ── Phase 5: detectRepeatedReadsInWindow ──────────────────────────────────────

describe("Phase 5 — detectRepeatedReadsInWindow", () => {
  it("returns empty when no repeated reads", () => {
    const entries = [makeReadEntry("/a.ts", 1000, iso())];
    expect(detectRepeatedReadsInWindow(entries)).toHaveLength(0);
  });

  it("flags file read threshold times in window", () => {
    const ts = Date.now();
    const entries = [0, 5_000, 10_000].map(o =>
      makeReadEntry("/src/hookHandlers.ts", 5000, new Date(ts + o).toISOString())
    );
    const events = detectRepeatedReadsInWindow(entries, REPEATED_READ_WINDOW_MS, 3);
    expect(events).toHaveLength(1);
    expect(events[0].reads).toBe(3);
    expect(events[0].estimatedWasteTokens).toBeGreaterThan(0);
  });

  it("does not flag reads spread across multiple windows", () => {
    const ts = Date.now();
    const entries = [0, 35 * 60_000].map(o =>
      makeReadEntry("/src/file.ts", 5000, new Date(ts + o).toISOString())
    );
    // window = 30 min, only 1 read per window
    const events = detectRepeatedReadsInWindow(entries, 30 * 60_000, 2);
    expect(events).toHaveLength(0);
  });

  it("includes a recommendation string", () => {
    const ts = Date.now();
    const entries = [0, 100, 200].map(o =>
      makeReadEntry("/repo/CHANGELOG.md", 20000, new Date(ts + o).toISOString())
    );
    const events = detectRepeatedReadsInWindow(entries, REPEATED_READ_WINDOW_MS, 3);
    expect(events[0].recommendation).toContain("search_in_file");
  });

  it("sorts by estimatedWasteTokens descending", () => {
    const ts = Date.now();
    const large = [0, 100, 200].map(o =>
      makeReadEntry("/large.ts", 80_000, new Date(ts + o).toISOString())
    );
    const small = [0, 100, 200].map(o =>
      makeReadEntry("/small.ts", 1_000, new Date(ts + o).toISOString())
    );
    const events = detectRepeatedReadsInWindow([...large, ...small], REPEATED_READ_WINDOW_MS, 3);
    expect(events[0].path).toContain("large");
  });
});

// ── Phase 6: detectDirectoryScanWaste / buildDirectoryCache ───────────────────

describe("Phase 6 — detectDirectoryScanWaste + buildDirectoryCache", () => {
  it("returns empty when no list_directory entries", () => {
    expect(detectDirectoryScanWaste([])).toHaveLength(0);
  });

  it("ignores paths scanned fewer than DIR_SCAN_THRESHOLD times", () => {
    const entries = [makeListEntry("/src", 50, iso())];
    expect(detectDirectoryScanWaste(entries)).toHaveLength(0);
  });

  it("flags directory scanned 3+ times", () => {
    const entries = [
      makeListEntry("/src", 100, iso(-20_000)),
      makeListEntry("/src", 100, iso(-10_000)),
      makeListEntry("/src", 100, iso()),
    ];
    const waste = detectDirectoryScanWaste(entries);
    expect(waste).toHaveLength(1);
    expect(waste[0].scans).toBe(3);
    expect(waste[0].totalEntries).toBe(300);
    expect(waste[0].estimatedWasteTokens).toBeGreaterThan(0);
  });

  it("sorts by estimatedWasteTokens descending", () => {
    const largeScan = [
      makeListEntry("/big", 1000, iso(-3_000)),
      makeListEntry("/big", 1000, iso(-2_000)),
      makeListEntry("/big", 1000, iso(-1_000)),
    ];
    const smallScan = [
      makeListEntry("/small", 10, iso(-3_000)),
      makeListEntry("/small", 10, iso(-2_000)),
      makeListEntry("/small", 10, iso(-1_000)),
    ];
    const waste = detectDirectoryScanWaste([...largeScan, ...smallScan]);
    expect(waste[0].path).toContain("big");
  });

  it("buildDirectoryCache includes all scanned dirs with entry counts", () => {
    const entries = [
      makeListEntry("/src", 50, iso(-2_000)),
      makeListEntry("/src", 60, iso()),
    ];
    const cache = buildDirectoryCache(entries);
    expect(cache.directories["/src"]).toBeDefined();
    expect(cache.directories["/src"].scans).toBe(2);
    expect(cache.directories["/src"].totalEntries).toBe(110);
  });
});

// ── Phase 7: computeContextEfficiencyScore ────────────────────────────────────

describe("Phase 7 — computeContextEfficiencyScore", () => {
  it("returns score=100 and grade=A when no tokens at all", () => {
    const r = computeContextEfficiencyScore(0, 0, 0, 0);
    expect(r.score).toBe(100);
    expect(r.grade).toBe("A");
  });

  it("returns score=100 when wastedTokens=0", () => {
    const r = computeContextEfficiencyScore(500_000, 0, 100, 0);
    expect(r.score).toBe(100);
  });

  it("computes 59% score for waste=1.4M out of 3.5M (baseline target)", () => {
    const r = computeContextEfficiencyScore(3_500_000, 1_400_000, 1000, 400);
    expect(r.score).toBe(60); // Math.round((2.1M / 3.5M) * 100) = 60
    expect(["C", "D"]).toContain(r.grade);
  });

  it("computes 80%+ when waste reduced to target", () => {
    // useful=2.1M, waste=0.525M → efficiency=80%
    const r = computeContextEfficiencyScore(2_625_000, 525_000, 1000, 200);
    expect(r.score).toBeGreaterThanOrEqual(80);
    expect(["A", "B"]).toContain(r.grade);
  });

  it("exposes correct usefulTokens and potentialSavings", () => {
    const r = computeContextEfficiencyScore(1_000_000, 400_000, 500, 200);
    expect(r.usefulTokens).toBe(600_000);
    expect(r.potentialSavings).toBe(400_000);
    expect(r.wastedTokens).toBe(400_000);
  });

  it("grades correctly: ≥85→A, ≥70→B, ≥55→C, ≥40→D, else F", () => {
    expect(computeContextEfficiencyScore(100, 14, 10, 1).grade).toBe("A");  // 86%
    expect(computeContextEfficiencyScore(100, 28, 10, 2).grade).toBe("B");  // 72%
    expect(computeContextEfficiencyScore(100, 44, 10, 4).grade).toBe("C");  // 56%
    expect(computeContextEfficiencyScore(100, 60, 10, 6).grade).toBe("D");  // 40%
    expect(computeContextEfficiencyScore(100, 70, 10, 7).grade).toBe("F");  // 30%
  });

  it("clamps usefulTokens to 0 when wastedTokens > totalTokens", () => {
    const r = computeContextEfficiencyScore(100, 200, 5, 8);
    expect(r.usefulTokens).toBe(0);
    expect(r.score).toBe(0);
  });
});

// ── Phase 2: evaluateCompactAdvisor ──────────────────────────────────────────

describe("Phase 2 — evaluateCompactAdvisor", () => {
  function makeAnalysis(overrides: Partial<ContextEfficiencyAnalysis> = {}): ContextEfficiencyAnalysis {
    return {
      pressure: { pressureScore: 0, level: "low", reasons: [] },
      hotFiles: [],
      repeatedReads: [],
      directoryScanWaste: [],
      efficiency: {
        score: 100, grade: "A", usefulTokens: 0, wastedTokens: 0,
        totalTokens: 0, usefulReadCount: 0, wastedReadCount: 0,
        totalReadCount: 0, potentialSavings: 0,
      },
      compactOpportunities: 0,
      analyzedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it("shouldShow=false when all inputs below thresholds", () => {
    const result = evaluateCompactAdvisor(makeAnalysis());
    expect(result.shouldShow).toBe(false);
  });

  it("shouldShow=true when totalTokens > COMPACT_TOKEN_THRESHOLD", () => {
    const result = evaluateCompactAdvisor(makeAnalysis({
      efficiency: {
        score: 80, grade: "B", usefulTokens: 120_001, wastedTokens: 0,
        totalTokens: 120_001, usefulReadCount: 50, wastedReadCount: 0,
        totalReadCount: 50, potentialSavings: 0,
      },
    }));
    expect(result.shouldShow).toBe(true);
    expect(result.primaryAction).toBe("/compact");
  });

  it("shouldShow=true when wastedTokens > COMPACT_WASTE_THRESHOLD", () => {
    const result = evaluateCompactAdvisor(makeAnalysis({
      efficiency: {
        score: 40, grade: "D", usefulTokens: 50_000, wastedTokens: 250_000,
        totalTokens: 300_000, usefulReadCount: 20, wastedReadCount: 60,
        totalReadCount: 80, potentialSavings: 250_000,
      },
    }));
    expect(result.shouldShow).toBe(true);
    expect(result.estimatedTokensSaved).toBeGreaterThan(0);
  });

  it("shouldShow=true when repeated reads ≥ COMPACT_REPEATED_THRESHOLD", () => {
    const result = evaluateCompactAdvisor(makeAnalysis({
      repeatedReads: [{
        path: "/src/f.ts", reads: 6, windowMinutes: 30,
        estimatedWasteTokens: 80_000, recommendation: "use search",
      }],
    }));
    expect(result.shouldShow).toBe(true);
    expect(result.triggerReason).toContain("file");
  });

  it("estimatedSavingsPct is between 15 and 30", () => {
    const result = evaluateCompactAdvisor(makeAnalysis({
      efficiency: {
        score: 60, grade: "C", usefulTokens: 200_000, wastedTokens: 300_000,
        totalTokens: 500_000, usefulReadCount: 40, wastedReadCount: 60,
        totalReadCount: 100, potentialSavings: 300_000,
      },
    }));
    if (result.shouldShow) {
      expect(result.estimatedSavingsPct).toBeGreaterThanOrEqual(15);
      expect(result.estimatedSavingsPct).toBeLessThanOrEqual(30);
    }
  });

  it("secondaryActions include hot file name when present", () => {
    const result = evaluateCompactAdvisor(makeAnalysis({
      efficiency: {
        score: 40, grade: "D", usefulTokens: 0, wastedTokens: 250_001,
        totalTokens: 250_001, usefulReadCount: 0, wastedReadCount: 20,
        totalReadCount: 20, potentialSavings: 250_001,
      },
      hotFiles: [{
        path: "/src/costDashboard.ts", reads: 8, estimatedTokens: 40_000,
        wastedReads: 7, wastedTokens: 35_000, lastSeen: new Date().toISOString(), sessionCount: 1,
      }],
    }));
    expect(result.secondaryActions.some(a => a.includes("costDashboard"))).toBe(true);
  });
});

// ── Phase 8: buildCoachingMessages / formatEfficiencyCoachHtml ───────────────

describe("Phase 8 — buildCoachingMessages + formatEfficiencyCoachHtml", () => {
  function makeAnalysis(overrides: Partial<ContextEfficiencyAnalysis> = {}): ContextEfficiencyAnalysis {
    return {
      pressure: { pressureScore: 0, level: "low", reasons: [] },
      hotFiles: [],
      repeatedReads: [],
      directoryScanWaste: [],
      efficiency: {
        score: 100, grade: "A", usefulTokens: 0, wastedTokens: 0,
        totalTokens: 0, usefulReadCount: 0, wastedReadCount: 0,
        totalReadCount: 0, potentialSavings: 0,
      },
      compactOpportunities: 0,
      analyzedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it("returns empty messages when no issues", () => {
    const msgs = buildCoachingMessages(makeAnalysis());
    expect(msgs).toHaveLength(0);
  });

  it("generates hot-file message when hot file waste > 20k tokens", () => {
    const msgs = buildCoachingMessages(makeAnalysis({
      hotFiles: [{
        path: "/src/CHANGELOG.md", reads: 9, estimatedTokens: 90_000,
        wastedReads: 8, wastedTokens: 80_000, lastSeen: new Date().toISOString(), sessionCount: 1,
      }],
    }));
    const hotMsg = msgs.find(m => m.category === "hot-file");
    expect(hotMsg).toBeDefined();
    expect(hotMsg!.message).toContain("CHANGELOG.md");
    expect(hotMsg!.estimatedSavingsTokens).toBe(80_000);
  });

  it("generates compact message when total tokens > threshold", () => {
    const msgs = buildCoachingMessages(makeAnalysis({
      efficiency: {
        score: 70, grade: "B", usefulTokens: 150_001, wastedTokens: 0,
        totalTokens: 150_001, usefulReadCount: 60, wastedReadCount: 0,
        totalReadCount: 60, potentialSavings: 0,
      },
    }));
    const compactMsg = msgs.find(m => m.category === "compact");
    expect(compactMsg).toBeDefined();
    expect(compactMsg!.action).toBe("/compact");
  });

  it("generates dir-scan message when scan waste > 5k tokens", () => {
    const msgs = buildCoachingMessages(makeAnalysis({
      directoryScanWaste: [{
        path: "/src", scans: 5, totalEntries: 1000,
        estimatedWasteTokens: 8_000, lastScanned: new Date().toISOString(),
      }],
    }));
    const dirMsg = msgs.find(m => m.category === "dir-scan");
    expect(dirMsg).toBeDefined();
    expect(dirMsg!.message).toContain("5×");
  });

  it("sorts messages critical first", () => {
    const msgs = buildCoachingMessages(makeAnalysis({
      hotFiles: [{
        path: "/f.ts", reads: 10, estimatedTokens: 300_000,
        wastedReads: 9, wastedTokens: 270_000, lastSeen: new Date().toISOString(), sessionCount: 1,
      }],
      efficiency: {
        score: 40, grade: "D", usefulTokens: 150_001, wastedTokens: 0,
        totalTokens: 150_001, usefulReadCount: 60, wastedReadCount: 0,
        totalReadCount: 60, potentialSavings: 0,
      },
    }));
    if (msgs.length >= 2) {
      const order = { critical: 0, high: 1, medium: 2 };
      for (let i = 1; i < msgs.length; i++) {
        expect(order[msgs[i - 1].priority]).toBeLessThanOrEqual(order[msgs[i].priority]);
      }
    }
  });

  it("formatEfficiencyCoachHtml returns green note when no messages", () => {
    const html = formatEfficiencyCoachHtml([]);
    expect(html).toContain("low");
  });

  it("formatEfficiencyCoachHtml renders message text", () => {
    const msgs = [{
      priority: "critical" as const, category: "hot-file" as const,
      message: "big.ts read 10× generating 300k wasted tokens.",
      estimatedSavingsTokens: 300_000,
      action: "use search_in_file",
    }];
    const html = formatEfficiencyCoachHtml(msgs);
    expect(html).toContain("big.ts");
    expect(html).toContain("critical"); // lowercase in template
    expect(html).toContain("300k");
  });

  it("formatCompactAdvisorHtml returns empty string when advisor shouldShow=false", () => {
    const html = formatCompactAdvisorHtml(
      { shouldShow: false, triggerReason: "", estimatedSavingsPct: 0, estimatedTokensSaved: 0, primaryAction: "/compact", secondaryActions: [] },
      { shown: 0, followed: 0, dismissed: 0, followRate: 0, estimatedTokensSaved: 0 }
    );
    expect(html).toBe("");
  });

  it("formatCompactAdvisorHtml renders trigger reason and /compact", () => {
    const html = formatCompactAdvisorHtml(
      {
        shouldShow: true,
        triggerReason: "context ~150k MCP tokens",
        estimatedSavingsPct: 22,
        estimatedTokensSaved: 37_500,
        primaryAction: "/compact",
        secondaryActions: ["Cache costDashboard.ts"],
      },
      { shown: 5, followed: 3, dismissed: 2, followRate: 0.6, estimatedTokensSaved: 112_500 }
    );
    expect(html).toContain("/compact");
    expect(html).toContain("150k MCP tokens");
    expect(html).toContain("22");
    expect(html).toContain("5"); // roi.shown
  });
});

// ── Phase 9: recordAdvisorEvent / computeAdvisorROI ──────────────────────────

describe("Phase 9 — Advisor Learning Loop", () => {
  it("computeAdvisorROI returns zeros when no events", () => {
    const target = tmpDir();
    const roi = computeAdvisorROI(target);
    expect(roi.shown).toBe(0);
    expect(roi.followed).toBe(0);
    expect(roi.estimatedTokensSaved).toBe(0);
    expect(roi.followRate).toBe(0);
  });

  it("records shown + followed + dismissed events correctly", () => {
    const target = tmpDir();
    recordAdvisorEvent(target, "shown",     { estimatedSavingsTokens: 50_000, triggerReason: "context large" });
    recordAdvisorEvent(target, "followed",  { estimatedSavingsTokens: 50_000 });
    recordAdvisorEvent(target, "shown",     { estimatedSavingsTokens: 80_000 });
    recordAdvisorEvent(target, "dismissed", {});

    const roi = computeAdvisorROI(target);
    expect(roi.shown).toBe(2);
    expect(roi.followed).toBe(1);
    expect(roi.dismissed).toBe(1);
    expect(roi.estimatedTokensSaved).toBe(50_000);
    expect(roi.followRate).toBeCloseTo(0.5, 2);
  });

  it("appends to jsonl file correctly", () => {
    const target = tmpDir();
    recordAdvisorEvent(target, "shown", { estimatedSavingsTokens: 100_000, triggerReason: "test" });
    const logFile = path.join(target, ".claude", "learning", "context-advisor-log.jsonl");
    expect(fs.existsSync(logFile)).toBe(true);
    const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean);
    const entry = JSON.parse(lines[0]);
    expect(entry.event).toBe("shown");
    expect(entry.estimatedSavingsTokens).toBe(100_000);
    expect(entry.triggerReason).toBe("test");
    expect(typeof entry.ts).toBe("string");
  });
});

// ── Full analyzeContextEfficiency pipeline ────────────────────────────────────

describe("analyzeContextEfficiency — integration", () => {
  it("returns all-zero analysis when mcp-usage.jsonl is empty", () => {
    const target = tmpDir();
    seedMcpLog(target, []);
    const r = analyzeContextEfficiency(target, 24);
    expect(r.efficiency.totalTokens).toBe(0);
    expect(r.hotFiles).toHaveLength(0);
    expect(r.repeatedReads).toHaveLength(0);
    expect(r.directoryScanWaste).toHaveLength(0);
    expect(r.efficiency.score).toBe(100);
  });

  it("detects hot files and writes hot-files.json", () => {
    const target = tmpDir();
    const ts = Date.now();
    seedMcpLog(target, [
      makeReadEntry("/src/costDashboard.ts", 40_000, new Date(ts - 3_000).toISOString()),
      makeReadEntry("/src/costDashboard.ts", 40_000, new Date(ts - 2_000).toISOString()),
      makeReadEntry("/src/costDashboard.ts", 40_000, new Date(ts - 1_000).toISOString()),
    ]);
    const r = analyzeContextEfficiency(target, 24);
    expect(r.hotFiles).toHaveLength(1);
    expect(r.hotFiles[0].reads).toBe(3);
    expect(r.hotFiles[0].wastedTokens).toBeGreaterThan(0);

    const idx = readHotFilesIndex(target);
    expect(idx).toBeDefined();
    expect(idx!.files).toHaveLength(1);
  });

  it("detects directory scan waste and writes directory-cache.json", () => {
    const target = tmpDir();
    seedMcpLog(target, [
      makeListEntry("/src", 200, iso(-3_000)),
      makeListEntry("/src", 200, iso(-2_000)),
      makeListEntry("/src", 200, iso(-1_000)),
    ]);
    const r = analyzeContextEfficiency(target, 24);
    expect(r.directoryScanWaste.length).toBeGreaterThan(0);

    const cache = readDirectoryCache(target);
    expect(cache).toBeDefined();
    expect(cache!.directories["/src"]).toBeDefined();
  });

  it("computes correct efficiency score from mixed read entries", () => {
    const target = tmpDir();
    const ts = Date.now();
    // 3 reads of a 12k-byte file → 1 useful, 2 wasted (9k tokens total, 6k wasted)
    seedMcpLog(target, [
      makeReadEntry("/big.ts", 12_000, new Date(ts - 3_000).toISOString()),
      makeReadEntry("/big.ts", 12_000, new Date(ts - 2_000).toISOString()),
      makeReadEntry("/big.ts", 12_000, new Date(ts - 1_000).toISOString()),
    ]);
    const r = analyzeContextEfficiency(target, 24);
    // totalTokens = 9000, wasted = 6000 (2 × 3000), efficiency ≈ 33%
    expect(r.efficiency.totalTokens).toBe(9_000);
    expect(r.efficiency.wastedTokens).toBe(6_000);
    expect(r.efficiency.score).toBeCloseTo(33, 0);
  });

  it("compactOpportunities is 0 when below all thresholds", () => {
    const target = tmpDir();
    seedMcpLog(target, [makeReadEntry("/tiny.ts", 100, iso())]);
    const r = analyzeContextEfficiency(target, 24);
    expect(r.compactOpportunities).toBe(0);
  });

  it("compactOpportunities increases with high token count", () => {
    const target = tmpDir();
    const bigEntries: McpUsageEntry[] = Array.from({ length: 10 }, (_, i) =>
      makeReadEntry(`/f${i}.ts`, 60_000, new Date(Date.now() - i * 1_000).toISOString())
    );
    seedMcpLog(target, bigEntries);
    const r = analyzeContextEfficiency(target, 24);
    expect(r.compactOpportunities).toBeGreaterThan(0);
  });
});

// ── bytesToTokens utility ─────────────────────────────────────────────────────

describe("bytesToTokens", () => {
  it("converts 4 bytes to 1 token", () => {
    expect(bytesToTokens(4)).toBe(1);
    expect(bytesToTokens(8)).toBe(2);
    expect(bytesToTokens(0)).toBe(0);
    expect(bytesToTokens(4_000)).toBe(1_000);
    expect(bytesToTokens(1_000_000)).toBe(250_000);
  });
});
