import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assessSkillCostConfidence, assessWorkspaceConfidence } from "./attributionConfidence";
import { SKILL_INVOKE_HOOK_SOURCE } from "./runRecording";

const workspaces: string[] = [];

function makeWorkspace(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "conf-"));
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

describe("attributionConfidence", () => {
  it("scores v2-hook skill as high confidence", () => {
    const target = makeWorkspace();
    fs.writeFileSync(
      path.join(target, ".claude", "learning", "runs.jsonl"),
      JSON.stringify({
        ts: "2026-06-12T12:00:00.000Z",
        skill: "deployment-practical",
        action: "skill_invoke",
        agent: "claude",
        tokens: 800,
        cost: 0.007,
        rc: 0,
        success: true,
        session_id: "s1",
        metadata: { source: SKILL_INVOKE_HOOK_SOURCE, invoked: true },
      }) + "\n",
      "utf-8"
    );

    const attribution = {
      "deployment-practical": { claude: { tokens: 800, cost: 0.007, sessions: 1 } },
    };
    const map = assessSkillCostConfidence(target, attribution, {
      usesV2HookRuns: true,
      staleEqualSplit: false,
    });
    const row = map.get("deployment-practical");
    expect(row?.source).toBe("v2-hook");
    expect(row?.level).toBe("high");
  });

  it("grades workspace confidence from health flags", () => {
    const target = makeWorkspace();
    const ws = assessWorkspaceConfidence(
      target,
      path.join(__dirname, "..", "skills_library"),
      {
        reliable: true,
        staleEqualSplit: false,
        highUnattributedRatio: false,
        noPerSkillData: false,
        v2HookRuns: 2,
        confidenceScore: 0,
        confidenceLevel: "estimated",
        summary: "ok",
      },
      0
    );
    expect(ws.level).toBe("high");
    expect(ws.score).toBeGreaterThan(0.7);
  });
});
