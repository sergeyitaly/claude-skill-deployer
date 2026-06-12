import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assessUsageSkillConfidence, buildUsageSkillConfidenceMap } from "./attributionConfidence";
import { invalidateLearningCache } from "./learningStateIndex";
import { SKILL_INVOKE_HOOK_SOURCE } from "./runRecording";

const workspaces: string[] = [];

function makeWorkspace(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "conf-"));
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

describe("assessUsageSkillConfidence", () => {
  it("grades v2 hook skill as high", () => {
    const target = makeWorkspace();
    const runsFile = path.join(target, ".claude", "learning", "runs.jsonl");
    fs.writeFileSync(
      runsFile,
      JSON.stringify({
        ts: "2026-06-12T12:00:00Z",
        skill: "ci-preflight",
        action: "run",
        rc: 0,
        metadata: { source: SKILL_INVOKE_HOOK_SOURCE, invoked: true },
      }) + "\n",
      "utf-8"
    );

    const conf = assessUsageSkillConfidence(target, "ci-preflight");
    expect(conf.level).toBe("high");
    expect(conf.source).toBe("v2-hook");
  });

  it("buildUsageSkillConfidenceMap covers all skills", () => {
    const target = makeWorkspace();
    const map = buildUsageSkillConfidenceMap(target, ["a", "b"]);
    expect(map.size).toBe(2);
    expect(map.get("a")?.level).toBe("low");
  });
});
