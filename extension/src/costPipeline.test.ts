import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCostPipelineSync } from "./costPipeline";
import { readPipelineCycle } from "./pipelineCycle";
import { systemStatePath } from "./workspaceSystemState";

const repoLibraryDir = path.join(__dirname, "..", "..", "skills_library");
const extLibraryDir = path.join(__dirname, "..", "skills_library");
const libraryDir = fs.existsSync(path.join(repoLibraryDir, "agents.json"))
  ? repoLibraryDir
  : extLibraryDir;

const workspaces: string[] = [];

function makeWorkspace(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "costpipe-"));
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

describe("costPipeline", () => {
  it("indexes and analyzes on sync run", () => {
    const target = makeWorkspace();
    fs.writeFileSync(
      path.join(target, ".claude", "learning", "runs.jsonl"),
      JSON.stringify({
        ts: new Date().toISOString(),
        skill: "self-learning",
        outcome: "success",
        agent: "cursor",
      }) + "\n",
      "utf-8"
    );

    const result = runCostPipelineSync(target, libraryDir);
    const cycle = readPipelineCycle(target);

    expect(result.state.version).toBe(1);
    expect(cycle.indexedAt).toBeDefined();
    expect(cycle.analyzedAt).toBeDefined();
    expect(fs.existsSync(systemStatePath(target))).toBe(true);
    expect(result.ready).toBe(true);
  });

  it("becomes ready after collect timestamp when sync follows", () => {
    const target = makeWorkspace();
    const cyclePath = path.join(target, ".claude", "learning", "pipeline-cycle.json");
    fs.writeFileSync(
      cyclePath,
      JSON.stringify({ collectedAt: new Date().toISOString() }) + "\n",
      "utf-8"
    );

    expect(runCostPipelineSync(target, libraryDir).ready).toBe(true);
  });
});
