import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

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
