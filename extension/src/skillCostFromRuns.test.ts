import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { summarizeSkillCostsFromRuns, topSkillsFromRuns } from "./skillCostFromRuns";

const workspaces: string[] = [];

function writeRuns(target: string, rows: object[]): void {
  const dir = path.join(target, ".claude", "learning");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "runs.jsonl"),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf-8"
  );
}

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-cost-runs-"));
  workspaces.push(root);
  return root;
}

afterEach(() => {
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

describe("summarizeSkillCostsFromRuns", () => {
  it("aggregates hook rows with usage_breakdown pricing", () => {
    const target = makeWorkspace();
    const ts = new Date().toISOString();
    writeRuns(target, [
      {
        ts,
        skill: "profile-init",
        action: "skill_invoke",
        agent: "claude",
        tokens: 1000,
        cost: 0.5,
        rc: 0,
        success: true,
        session_id: "s1",
        project: target,
        metadata: {
          source: "skill-invoke-hook-v2",
          invoked: true,
          cost_method: "usage_breakdown",
          model: "claude-sonnet-4-6",
        },
      },
      {
        ts,
        skill: "profile-init",
        action: "transcript",
        agent: "claude",
        tokens: 3_000_000,
        cost: 27,
        rc: 0,
        success: true,
        session_id: "s2",
        project: target,
        metadata: { source: "attribution-collector", file: "/tmp/x.jsonl" },
      },
    ]);

    const summary = summarizeSkillCostsFromRuns(target, 30);
    expect(summary.includedRuns).toBe(1);
    expect(summary.excludedCollectorRuns).toBe(1);
    expect(summary.skills).toHaveLength(1);
    expect(summary.skills[0].skill).toBe("profile-init");
    expect(summary.skills[0].cost).toBeCloseTo(0.5, 2);
    expect(summary.skills[0].usageBreakdownRuns).toBe(1);
  });

  it("ranks skills by computed cost", () => {
    const target = makeWorkspace();
    const ts = new Date().toISOString();
    writeRuns(target, [
      {
        ts,
        skill: "cheap-skill",
        action: "skill_invoke",
        agent: "claude",
        tokens: 100,
        cost: 0.01,
        rc: 0,
        success: true,
        session_id: "a",
        project: target,
        metadata: { source: "skill-invoke-hook-v2", invoked: true },
      },
      {
        ts,
        skill: "pricey-skill",
        action: "skill_invoke",
        agent: "claude",
        tokens: 5000,
        cost: 0.45,
        rc: 0,
        success: true,
        session_id: "b",
        project: target,
        metadata: { source: "skill-invoke-hook-v2", invoked: true },
      },
    ]);

    const top = topSkillsFromRuns(target, 2, 30);
    expect(top[0].skill).toBe("pricey-skill");
    expect(top[1].skill).toBe("cheap-skill");
  });
});
