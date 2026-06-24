import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { computeApiScore } from "./agentPerformanceIndex";
import { Manifest } from "./skillOps";

const manifest: Manifest = {
  skills: {
    "self-learning": { description: "Project-local accumulated-experience store", detect_globs: ["**/*"] },
    "terraform-plan-review": { description: "Terraform plan review", detect_globs: ["**/*.tf"] },
  },
};

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "api-score-"));
  fs.mkdirSync(path.join(dir, ".claude", "learning"), { recursive: true });
  return dir;
}

describe("computeApiScore", () => {
  it("returns a score between 0 and 100 for an empty workspace", () => {
    const target = makeWorkspace();
    const result = computeApiScore(target, manifest);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(["A", "B", "C", "D", "F"]).toContain(result.grade);
  });

  it("empty workspace scores F (no telemetry, low attribution)", () => {
    const target = makeWorkspace();
    const result = computeApiScore(target, manifest);
    expect(result.grade).toBe("F");
    // taskCompletion and humanCorrection return NO_DATA (exposed as 0) when no runs/feedback exist —
    // they are excluded from the composite so they don't inflate empty-state scores.
    expect(result.breakdown.taskCompletion).toBe(0);
    expect(result.breakdown.humanCorrection).toBe(0);
    expect(result.breakdown.learningRate).toBe(0);
    expect(result.breakdown.attribution).toBe(0);
  });

  it("high attribution trust pushes attribution sub-score up", () => {
    const target = makeWorkspace();
    // Trust file stores scorePct on 0–100 scale (not 0–1)
    fs.writeFileSync(
      path.join(target, ".claude", "learning", "attribution-trust.json"),
      JSON.stringify({ scorePct: 90 }),
      "utf-8"
    );
    const result = computeApiScore(target, manifest);
    expect(result.breakdown.attribution).toBe(90);
  });

  it("recent skill runs increase learning rate sub-score", () => {
    const target = makeWorkspace();
    const runs = [1, 2, 3, 4, 5].map((i) => ({
      ts: new Date(Date.now() - i * 3_600_000).toISOString(),
      timestamp: new Date(Date.now() - i * 3_600_000).toISOString(),
      skill: "self-learning",
      action: "skill_invoke",
      agent: "claude",
      tokens: 500,
      cost: 0.01,
      rc: 0,
      success: true,
      session_id: `sess-${i}`,
      project: target,
      branch: null,
      metadata: { source: "skill-invoke-hook-v2", invoked: true },
    }));
    fs.writeFileSync(
      path.join(target, ".claude", "learning", "runs.jsonl"),
      runs.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf-8"
    );
    const result = computeApiScore(target, manifest);
    expect(result.breakdown.learningRate).toBeGreaterThan(0);
  });

  it("skill feedback entries lower the human correction sub-score", () => {
    const target = makeWorkspace();
    // Write 5 feedback entries (each costs 10 points)
    const feedback = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({ ts: new Date().toISOString(), skill: "self-learning", feedback: "wrong", i })
    ).join("\n");
    fs.writeFileSync(
      path.join(target, ".claude", "learning", "skill-feedback.jsonl"),
      feedback + "\n",
      "utf-8"
    );
    const result = computeApiScore(target, manifest);
    expect(result.breakdown.humanCorrection).toBe(50); // 100 - 5×10
  });

  it("perfect inputs produce score close to 100", () => {
    const target = makeWorkspace();

    // High attribution trust — scorePct stored as 0–100
    fs.writeFileSync(
      path.join(target, ".claude", "learning", "attribution-trust.json"),
      JSON.stringify({ scorePct: 100 }),
      "utf-8"
    );

    // Many successful runs across many sessions
    const runs = Array.from({ length: 30 }, (_, i) => ({
      ts: new Date(Date.now() - i * 3_600_000).toISOString(),
      timestamp: new Date(Date.now() - i * 3_600_000).toISOString(),
      skill: "self-learning",
      action: "skill_invoke",
      agent: "claude",
      tokens: 500,
      cost: 0.01,
      rc: 0,
      success: true,
      session_id: `sess-${i}`,
      project: target,
      branch: null,
      metadata: { source: "skill-invoke-hook-v2", invoked: true },
    }));
    fs.writeFileSync(
      path.join(target, ".claude", "learning", "runs.jsonl"),
      runs.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf-8"
    );

    // High ROI in team economics
    fs.writeFileSync(
      path.join(target, ".claude", "learning", "team-economics-cache.json"),
      JSON.stringify({ teamEconomics: { netRoi: 50 } }),
      "utf-8"
    );

    // Self-learning in last proposals
    fs.writeFileSync(
      path.join(target, ".claude", "learning", "task-skill-proposals.json"),
      JSON.stringify({ proposals: [{ name: "self-learning" }] }),
      "utf-8"
    );

    const result = computeApiScore(target, manifest);
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.grade).toBe("A");
  });
});
