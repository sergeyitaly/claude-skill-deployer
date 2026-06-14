import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProjectProfile, writeProjectProfile } from "./projectProfile";
import {
  compareTierBenefitsFromProfile,
  formatWeeklyBenefitsLines,
  summarizeWeeklyRunsBenefits,
} from "./weeklyReportBenefits";

const workspaces: string[] = [];

function makeWorkspace(name: string, files: Record<string, string> = {}): string {
  const dir = path.join(os.tmpdir(), `weekly-benefits-${name}-${Date.now()}`);
  fs.mkdirSync(path.join(dir, ".claude", "learning"), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf-8");
  }
  workspaces.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of workspaces.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const DISK_BENEFITS_TIMEOUT = 15_000;

describe("summarizeWeeklyRunsBenefits", () => {
  it("counts hook-tracked skill runs from runs.jsonl", () => {
    const target = makeWorkspace("runs");
    const now = new Date().toISOString();
    const runs = [
      {
        ts: now,
        skill: "ci-preflight",
        action: "invoke",
        agent: "cursor",
        tokens: 1000,
        cost: 0.01,
        rc: 0,
        success: true,
        session_id: "sess-1",
        project: target,
        metadata: { source: "skill-invoke-hook-v2", invoked: true },
      },
      {
        ts: now,
        skill: "ci-preflight",
        action: "invoke",
        agent: "claude",
        tokens: 2000,
        cost: 0.02,
        rc: 1,
        success: false,
        session_id: "sess-2",
        project: target,
        metadata: { source: "skill-invoke-hook-v2", invoked: true },
      },
    ];
    fs.writeFileSync(
      path.join(target, ".claude", "learning", "runs.jsonl"),
      runs.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf-8"
    );

    const summary = summarizeWeeklyRunsBenefits(target, 7);
    expect(summary.totalRuns).toBe(2);
    expect(summary.successCount).toBe(1);
    expect(summary.failureCount).toBe(1);
    expect(summary.distinctSkills).toBe(1);
    expect(summary.v2HookRuns).toBe(2);
    expect(summary.v2Sessions).toBe(2);
  });
});

describe("formatWeeklyBenefitsLines", { timeout: DISK_BENEFITS_TIMEOUT }, () => {
  it("includes tier savings and skill outcomes in report body", () => {
    const target = makeWorkspace("report", { "package.json": "{}", "README.md": "# x" });
    writeProjectProfile(target, buildProjectProfile(target, "solo-dev", "solo-focused"));
    const now = new Date().toISOString();
    fs.writeFileSync(
      path.join(target, ".claude", "learning", "runs.jsonl"),
      `${JSON.stringify({
        ts: now,
        skill: "ci-preflight",
        action: "run",
        agent: "claude",
        tokens: 500,
        cost: 0.005,
        rc: 0,
        success: true,
        session_id: "s1",
        project: target,
        metadata: {},
      })}\n`,
      "utf-8"
    );

    const lines = formatWeeklyBenefitsLines(target, {}, [], []);
    const body = lines.join("\n");
    expect(body).toContain("Extension benefits this week");
    expect(body).toContain("SOLO DEV");
    expect(body).toContain("solo focused");
    expect(body).toContain("Skill outcomes");
    expect(body).toContain("ci-preflight");
    expect(body).toContain("Team capability delivered");
  });
});

describe("compareTierBenefitsFromProfile", { timeout: DISK_BENEFITS_TIMEOUT }, () => {
  it("shows overhead savings for solo tier vs naive full stack", () => {
    const target = makeWorkspace("tier-cmp", { "package.json": "{}", "README.md": "# x" });
    const profile = buildProjectProfile(target, "solo-dev", "solo-focused");
    const cmp = compareTierBenefitsFromProfile(profile);
    expect(cmp.overheadSavingsPct).toBeGreaterThan(50);
    expect(cmp.extensionValueUpliftPct).toBeGreaterThan(0);
    expect(cmp.monthlySavingsUsd).toBeGreaterThan(0);
  });
});
