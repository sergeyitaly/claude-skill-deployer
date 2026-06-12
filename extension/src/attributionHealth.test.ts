import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assessAttributionHealth } from "./attributionHealth";
import { costAttributionPath } from "./costAttribution";
import { SKILL_INVOKE_HOOK_SOURCE } from "./runRecording";

const repoLibraryDir = path.join(__dirname, "..", "..", "skills_library");
const extLibraryDir = path.join(__dirname, "..", "skills_library");
const resolvedLibraryDir = fs.existsSync(path.join(repoLibraryDir, "agents.json"))
  ? repoLibraryDir
  : extLibraryDir;

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "csd-health-"));
}

function writeRuns(target: string, lines: object[]): void {
  const dir = path.join(target, ".claude", "learning");
  fs.mkdirSync(dir, { recursive: true });
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  fs.writeFileSync(path.join(dir, "runs.jsonl"), body, "utf-8");
}

const workspaces: string[] = [];

afterEach(() => {
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

describe("assessAttributionHealth", () => {
  it("reports no per-skill data when runs.jsonl is empty", () => {
    const target = makeWorkspace();
    workspaces.push(target);
    fs.mkdirSync(path.join(target, ".claude", "learning"), { recursive: true });

    const health = assessAttributionHealth(target, resolvedLibraryDir);
    expect(health.reliable).toBe(false);
    expect(health.noPerSkillData).toBe(true);
    expect(health.v2HookRuns).toBe(0);
  });

  it("reports v2 active when hook invokes exist", () => {
    const target = makeWorkspace();
    workspaces.push(target);
    writeRuns(target, [
      {
        ts: "2026-06-11T12:00:00.000Z",
        skill: "ci-pipeline-debug",
        action: "skill_invoke",
        agent: "claude",
        tokens: 1200,
        cost: 0.0108,
        rc: 0,
        success: true,
        session_id: "sess-1",
        project: target,
        metadata: { source: SKILL_INVOKE_HOOK_SOURCE, invoked: true, tool_use_id: "toolu_x" },
      },
    ]);

    const health = assessAttributionHealth(target, resolvedLibraryDir);
    expect(health.v2HookRuns).toBe(1);
    expect(health.summary).toMatch(/v2|confidence/i);
    expect(health.reliable).toBe(true);
    expect(health.confidenceLevel).toBeDefined();
  });

  it("auto-purges stale equal-split transcriptSkills on read", () => {
    const target = makeWorkspace();
    workspaces.push(target);
    fs.mkdirSync(path.dirname(costAttributionPath(target)), { recursive: true });
    fs.writeFileSync(
      costAttributionPath(target),
      JSON.stringify({
        transcriptSkills: {
          a: { claude: { tokens: 100, cost: 579.51, sessions: 1 } },
          b: { claude: { tokens: 100, cost: 579.51, sessions: 1 } },
          c: { claude: { tokens: 100, cost: 579.51, sessions: 1 } },
        },
        unattributed: {},
      }) + "\n",
      "utf-8"
    );

    const health = assessAttributionHealth(target, resolvedLibraryDir);
    expect(health.staleEqualSplit).toBe(false);
    const stored = JSON.parse(fs.readFileSync(costAttributionPath(target), "utf-8")) as {
      transcriptSkills?: Record<string, unknown>;
    };
    expect(stored.transcriptSkills).toEqual({});
  });
});
