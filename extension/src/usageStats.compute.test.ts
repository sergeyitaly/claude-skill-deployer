import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resetMisattributedData } from "./costAttribution";
import { ATTRIBUTION_COLLECTOR_SOURCE, SKILL_INVOKE_HOOK_SOURCE } from "./runsStore";
import { computeUsageStats } from "./usageStats";
import { Manifest } from "./skillOps";

const manifest: Manifest = {
  skills: {
    "profile-init": { description: "init" },
    "ci-pipeline-debug": { description: "ci" },
  },
};

function writeRuns(target: string, rows: object[]): void {
  const dir = path.join(target, ".claude", "learning");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "runs.jsonl"),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf-8"
  );
}

function installSkill(target: string, name: string): void {
  const skillDir = path.join(target, ".claude", "skills", name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\ndescription: test\n---\n`, "utf-8");
}

describe("computeUsageStats", () => {
  it("ignores attribution-collector transcript rows", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "usage-stats-"));
    installSkill(target, "ci-pipeline-debug");
    installSkill(target, "profile-init");
    writeRuns(target, [
      {
        ts: "2026-06-12T12:00:00.000Z",
        skill: "ci-pipeline-debug",
        action: "transcript",
        agent: "claude",
        tokens: 2_500_000,
        rc: 0,
        metadata: { source: ATTRIBUTION_COLLECTOR_SOURCE, invoked: true },
      },
      {
        ts: "2026-06-12T12:01:00.000Z",
        skill: "profile-init",
        action: "skill_invoke",
        agent: "claude",
        tokens: 32_000,
        rc: 0,
        metadata: { source: SKILL_INVOKE_HOOK_SOURCE, invoked: true },
      },
    ]);

    const stats = computeUsageStats(target, manifest);
    const ci = stats.find((s) => s.name === "ci-pipeline-debug");
    const profile = stats.find((s) => s.name === "profile-init");

    expect(ci?.runs).toBe(0);
    expect(ci?.totalTokens).toBeNull();
    expect(profile?.runs).toBe(1);
    expect(profile?.totalTokens).toBe(32_000);
  });

  it("aggregates per-agent runs for the same skill", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "usage-stats-agent-"));
    installSkill(target, "ci-pipeline-debug");
    writeRuns(target, [
      {
        ts: "2026-06-12T12:00:00.000Z",
        skill: "ci-pipeline-debug",
        action: "skill_invoke",
        agent: "claude",
        tokens: 12_000,
        rc: 0,
        metadata: { source: SKILL_INVOKE_HOOK_SOURCE, invoked: true },
      },
      {
        ts: "2026-06-12T12:05:00.000Z",
        skill: "ci-pipeline-debug",
        action: "skill_invoke",
        agent: "cursor",
        tokens: 8_000,
        rc: 0,
        metadata: { source: SKILL_INVOKE_HOOK_SOURCE, invoked: true },
      },
    ]);

    const stats = computeUsageStats(target, manifest);
    const ci = stats.find((s) => s.name === "ci-pipeline-debug");
    expect(ci?.runs).toBe(2);
    expect(ci?.agentRuns).toEqual({ claude: 1, cursor: 1 });
    expect(ci?.agentTokens).toEqual({ claude: 12_000, cursor: 8_000 });
  });

  it("aggregates measured cost from hook runs", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "usage-stats-cost-"));
    installSkill(target, "profile-init");
    writeRuns(target, [
      {
        ts: "2026-06-12T12:01:00.000Z",
        skill: "profile-init",
        action: "skill_invoke",
        agent: "claude",
        tokens: 32_000,
        cost: 0.12,
        rc: 0,
        metadata: {
          source: SKILL_INVOKE_HOOK_SOURCE,
          invoked: true,
          cost_method: "usage_breakdown",
          usage: { input_tokens: 10_000, output_tokens: 2_000 },
        },
      },
    ]);

    const stats = computeUsageStats(target, manifest);
    const profile = stats.find((s) => s.name === "profile-init");
    expect(profile?.totalCost).toBeCloseTo(0.06, 2);
    expect(profile?.avgCostUsd).toBeCloseTo(0.06, 2);
    expect(profile?.measuredRuns).toBe(1);
  });
});

describe("resetMisattributedData", () => {
  it("removes collector transcript rows but keeps hook runs", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "usage-reset-"));
    installSkill(target, "ci-pipeline-debug");
    installSkill(target, "profile-init");
    writeRuns(target, [
      {
        ts: "2026-06-12T12:00:00.000Z",
        skill: "ci-pipeline-debug",
        action: "transcript",
        agent: "claude",
        tokens: 2_500_000,
        rc: 0,
        metadata: { source: ATTRIBUTION_COLLECTOR_SOURCE },
      },
      {
        ts: "2026-06-12T12:01:00.000Z",
        skill: "profile-init",
        action: "skill_invoke",
        agent: "claude",
        tokens: 32_000,
        rc: 0,
        metadata: { source: SKILL_INVOKE_HOOK_SOURCE, invoked: true },
      },
    ]);

    const result = resetMisattributedData(target);
    expect(result.removedRuns).toBe(1);
    expect(result.keptRuns).toBe(1);

    const stats = computeUsageStats(target, manifest);
    expect(stats.find((s) => s.name === "profile-init")?.runs).toBe(1);
    expect(stats.find((s) => s.name === "ci-pipeline-debug")?.runs).toBe(0);
  });
});
