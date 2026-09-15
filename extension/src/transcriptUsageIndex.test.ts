import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockedHome = vi.hoisted(() => ({ value: "" }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockedHome.value || actual.homedir(),
  };
});

import {
  computeTodayCreditUsageCached,
  fingerprintTranscriptRoots,
  invalidateTranscriptUsageCache,
  readCachedCreditUsageFromRoots,
  transcriptCacheSize,
} from "./transcriptUsageIndex";

const workspaces: string[] = [];

function makeTranscriptRoot(): { root: string; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tx-"));
  workspaces.push(root);
  const file = path.join(root, "session.jsonl");
  fs.writeFileSync(
    file,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      sessionId: "s1",
      message: {
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    }) + "\n",
    "utf-8"
  );
  return { root, file };
}

afterEach(() => {
  invalidateTranscriptUsageCache();
  mockedHome.value = "";
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

function makeFakeHomeWithTodayTranscript(): { home: string; file: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tx-home-"));
  workspaces.push(home);
  const projectsDir = path.join(home, ".claude", "projects");
  fs.mkdirSync(projectsDir, { recursive: true });
  const file = path.join(projectsDir, "session.jsonl");
  fs.writeFileSync(
    file,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      sessionId: "today-session",
      message: {
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 1000, output_tokens: 500 },
      },
    }) + "\n",
    "utf-8"
  );
  return { home, file };
}

describe("transcriptUsageIndex", () => {
  it("caches credit usage until transcript mtime changes", () => {
    const { root, file } = makeTranscriptRoot();
    const first = readCachedCreditUsageFromRoots([root], 14);
    expect(first.totalTokens).toBeGreaterThan(0);
    expect(transcriptCacheSize()).toBe(1);

    const second = readCachedCreditUsageFromRoots([root], 14);
    expect(second).toBe(first);

    const later = new Date(Date.now() + 2000);
    fs.utimesSync(file, later, later);
    const third = readCachedCreditUsageFromRoots([root], 14);
    expect(third).not.toBe(first);
  });

  it("fingerprint detects file count changes", () => {
    const { root } = makeTranscriptRoot();
    const fp1 = fingerprintTranscriptRoots([root], 14);
    expect(fp1.fileCount).toBe(1);

    fs.writeFileSync(
      path.join(root, "session2.jsonl"),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        sessionId: "s2",
        message: {
          model: "claude-sonnet-4-20250514",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }) + "\n",
      "utf-8"
    );
    const fp2 = fingerprintTranscriptRoots([root], 14);
    expect(fp2.fileCount).toBe(2);
  });
});

describe("computeTodayCreditUsageCached", () => {
  it("returns today's usage from a transcript under ~/.claude/projects", () => {
    const { home } = makeFakeHomeWithTodayTranscript();
    mockedHome.value = home;

    const result = computeTodayCreditUsageCached();
    expect(result.totalTokens).toBeGreaterThan(0);
    expect(result.totalCost).toBeGreaterThan(0);
  });

  it("reuses the cache on repeated calls instead of re-parsing (fingerprint unchanged)", () => {
    const { home } = makeFakeHomeWithTodayTranscript();
    mockedHome.value = home;

    const first = computeTodayCreditUsageCached();
    // A cache hit means readCachedCreditUsageFromRoots() returns the SAME summary object
    // internally on the second call — assert on the cache size instead of object identity
    // here since computeTodayCreditUsageCached() derives a fresh { totalTokens, totalCost }
    // literal each time; transcriptCacheSize() staying at 1 (not growing) across repeated
    // calls with an unchanged transcript is the real signal caching is working.
    expect(transcriptCacheSize()).toBe(1);
    const second = computeTodayCreditUsageCached();
    expect(transcriptCacheSize()).toBe(1);
    expect(second).toEqual(first);
  });

  it("returns zero when no transcripts exist for today", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tx-home-empty-"));
    workspaces.push(home);
    fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
    mockedHome.value = home;

    const result = computeTodayCreditUsageCached();
    expect(result).toEqual({ totalTokens: 0, totalCost: 0 });
  });
});
