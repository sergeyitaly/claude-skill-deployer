import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CollectorState } from "./collectorState";
import { pruneBackupFiles, pruneCollectorState, pruneRunsJsonl } from "./learningPrune";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learning-prune-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("pruneCollectorState", () => {
  it("keeps newest processed sessions when over limit", () => {
    const processed: Record<string, number> = {};
    for (let i = 0; i < 2100; i++) {
      processed[`session-${i}`] = i;
    }
    const state: CollectorState = { lastRun: 0, fileMtimes: {}, processedSessions: processed };
    const pruned = pruneCollectorState(state);
    expect(Object.keys(pruned.processedSessions ?? {})).toHaveLength(2000);
    expect(pruned.processedSessions?.["session-2099"]).toBe(2099);
    expect(pruned.processedSessions?.["session-0"]).toBeUndefined();
  });

  it("keeps newest file mtimes when over limit", () => {
    const fileMtimes: Record<string, number> = {};
    for (let i = 0; i < 600; i++) {
      fileMtimes[`file-${i}`] = i;
    }
    const state: CollectorState = { lastRun: 0, fileMtimes, processedSessions: {} };
    const pruned = pruneCollectorState(state);
    expect(Object.keys(pruned.fileMtimes)).toHaveLength(500);
    expect(pruned.fileMtimes["file-599"]).toBe(599);
    expect(pruned.fileMtimes["file-0"]).toBeUndefined();
  });
});

describe("pruneRunsJsonl", () => {
  it("removes rows older than retention window", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "runs.jsonl");
    const oldTs = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
    const newTs = new Date().toISOString();
    fs.writeFileSync(
      file,
      [`{"ts":"${oldTs}","skill":"old"}`, `{"ts":"${newTs}","skill":"fresh"}`].join("\n") + "\n",
      "utf-8"
    );

    const removed = pruneRunsJsonl(file, 90);
    expect(removed).toBe(1);
    const kept = fs.readFileSync(file, "utf-8").trim().split("\n");
    expect(kept).toHaveLength(1);
    expect(kept[0]).toContain("fresh");
  });

  it("returns zero when file is missing", () => {
    expect(pruneRunsJsonl(path.join(makeTempDir(), "missing.jsonl"))).toBe(0);
  });
});

describe("pruneBackupFiles", () => {
  it("deletes oldest backup siblings beyond maxKeep", () => {
    const dir = makeTempDir();
    const names = ["state.pre-reset-1.bak", "state.pre-reset-2.bak", "state.pre-reset-3.bak"];
    for (let i = 0; i < names.length; i++) {
      const file = path.join(dir, names[i]);
      fs.writeFileSync(file, "x", "utf-8");
      const ageMs = (names.length - i) * 1000;
      fs.utimesSync(file, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
    }

    pruneBackupFiles(dir, "state.pre-reset", 2);
    const remaining = fs.readdirSync(dir).sort();
    expect(remaining).toHaveLength(2);
    expect(remaining).not.toContain("state.pre-reset-1.bak");
  });
});
