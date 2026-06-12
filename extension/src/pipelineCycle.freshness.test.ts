import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isPipelineFresh,
  markPipelineAnalyzed,
  markPipelineIndexed,
  readPipelineCycle,
  runsFileFingerprint,
} from "./pipelineCycle";

const workspaces: string[] = [];

function makeWorkspace(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pipefresh-"));
  workspaces.push(ws);
  fs.mkdirSync(path.join(ws, ".claude", "learning"), { recursive: true });
  return ws;
}

afterEach(() => {
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

describe("pipelineCycle freshness", () => {
  it("is not fresh when runs.jsonl changes after index", () => {
    const target = makeWorkspace();
    const runsPath = path.join(target, ".claude", "learning", "runs.jsonl");
    fs.writeFileSync(runsPath, "{}\n", "utf-8");
    markPipelineIndexed(target);
    markPipelineAnalyzed(target);
    const cycle = readPipelineCycle(target);
    expect(isPipelineFresh(target, cycle)).toBe(true);

    fs.appendFileSync(runsPath, '{"ts":"2026-01-01T00:00:00.000Z","skill":"x"}\n', "utf-8");
    expect(isPipelineFresh(target, cycle)).toBe(false);
  });

  it("stores runs fingerprint on index", () => {
    const target = makeWorkspace();
    const runsPath = path.join(target, ".claude", "learning", "runs.jsonl");
    fs.writeFileSync(runsPath, "line\n", "utf-8");
    markPipelineIndexed(target);
    const fp = runsFileFingerprint(target);
    const cycle = readPipelineCycle(target);
    expect(cycle.runsFileMtime).toBe(fp.mtimeMs);
    expect(cycle.runsFileSize).toBe(fp.size);
  });
});
