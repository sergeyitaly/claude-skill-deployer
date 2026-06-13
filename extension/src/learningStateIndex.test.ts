import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { invalidateLearningCache, learningCacheSize, readCachedEnrichedRuns, countCachedV2HookRuns } from "./learningStateIndex";
import { SKILL_INVOKE_HOOK_SOURCE } from "./runRecording";

const workspaces: string[] = [];

function makeWorkspace(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cache-"));
  workspaces.push(ws);
  fs.mkdirSync(path.join(ws, ".claude", "learning"), { recursive: true });
  return ws;
}

afterEach(() => {
  invalidateLearningCache();
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

describe("learningStateIndex", () => {
  it("caches runs until file changes", () => {
    const target = makeWorkspace();
    const runsFile = path.join(target, ".claude", "learning", "runs.jsonl");
    fs.writeFileSync(
      runsFile,
      JSON.stringify({ ts: "2026-06-12T12:00:00Z", skill: "a", action: "run", rc: 0 }) + "\n",
      "utf-8"
    );

    const first = readCachedEnrichedRuns(target);
    expect(first).toHaveLength(1);
    expect(learningCacheSize()).toBe(1);

    const second = readCachedEnrichedRuns(target);
    expect(second).toBe(first);

    fs.appendFileSync(
      runsFile,
      JSON.stringify({ ts: "2026-06-12T12:01:00Z", skill: "b", action: "run", rc: 0 }) + "\n",
      "utf-8"
    );
    const third = readCachedEnrichedRuns(target);
    expect(third).toHaveLength(2);
    expect(third).not.toBe(first);
  });

  it("derives v2 hook stats from cached runs", () => {
    const target = makeWorkspace();
    const runsFile = path.join(target, ".claude", "learning", "runs.jsonl");
    fs.writeFileSync(
      runsFile,
      [
        JSON.stringify({
          ts: "2026-06-12T12:00:00Z",
          skill: "a",
          action: "run",
          rc: 0,
          session_id: "sess-1",
          metadata: { source: SKILL_INVOKE_HOOK_SOURCE, invoked: true },
        }),
        JSON.stringify({ ts: "2026-06-12T12:01:00Z", skill: "b", action: "run", rc: 0 }),
      ].join("\n") + "\n",
      "utf-8"
    );

    expect(countCachedV2HookRuns(target)).toBe(1);
    readCachedEnrichedRuns(target);
    expect(countCachedV2HookRuns(target)).toBe(1);
  });

  it("loads runs from snapshot on cold start", () => {
    const target = makeWorkspace();
    const runsFile = path.join(target, ".claude", "learning", "runs.jsonl");
    fs.writeFileSync(
      runsFile,
      JSON.stringify({ ts: "2026-06-12T12:00:00Z", skill: "snap", action: "run", rc: 0 }) + "\n",
      "utf-8"
    );
    readCachedEnrichedRuns(target);
    invalidateLearningCache(target);

    const fromSnapshot = readCachedEnrichedRuns(target);
    expect(fromSnapshot).toHaveLength(1);
    expect(fromSnapshot[0]?.skill).toBe("snap");
    expect(fs.existsSync(path.join(target, ".claude", "learning", "runs.snapshot.json"))).toBe(true);
  });
});
