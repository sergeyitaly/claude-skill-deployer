import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OptimizationSuggestion } from "./costOptimizer";
import {
  applyOptimizerSafetyCaps,
  capAutoApplySuggestions,
  protectedDisableSkills,
} from "./optimizerSafety";
import { SkillUsageStat } from "./usageStats";

const workspaces: string[] = [];

function makeWorkspace(skills: string[]): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "optsafe-"));
  workspaces.push(ws);
  const skillsDir = path.join(ws, ".claude", "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  for (const skill of skills) {
    fs.mkdirSync(path.join(skillsDir, skill), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, skill, "SKILL.md"), "---\nname: x\n---\n", "utf-8");
  }
  return ws;
}

afterEach(() => {
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

function stat(name: string, runs: number, lastUsed: string | null): SkillUsageStat {
  return {
    name,
    runs,
    successRate: 1,
    totalTokens: 1000,
    agentRuns: {},
    agentTokens: {},
    rating: "active",
    lastUsed,
    daysSinceLastUse: lastUsed ? 0 : null,
  };
}

describe("optimizerSafety", () => {
  it("protects top-used skills and recent usage from disable suggestions", () => {
    const usage = [
      stat("alpha", 10, new Date().toISOString()),
      stat("beta", 5, "2020-01-01T00:00:00.000Z"),
      stat("gamma", 4, "2020-01-01T00:00:00.000Z"),
      stat("delta", 1, "2020-01-01T00:00:00.000Z"),
    ];
    const protectedSet = protectedDisableSkills(usage);
    expect(protectedSet.has("alpha")).toBe(true);
    expect(protectedSet.has("beta")).toBe(true);
    expect(protectedSet.has("gamma")).toBe(true);
    expect(protectedSet.has("delta")).toBe(false);
  });

  it("caps disable suggestions to 30% of enabled skills", () => {
    const target = makeWorkspace(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]);
    const usage = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((n, i) =>
      stat(n, i === 0 ? 20 : 1, "2020-01-01T00:00:00.000Z")
    );
    const suggestions: OptimizationSuggestion[] = ["b", "c", "d", "e", "f", "g", "h", "i", "j"].map(
      (skill) => ({
        type: "disable" as const,
        skill,
        reason: "test",
        action: "disable",
        priority: 90,
      })
    );
    const capped = applyOptimizerSafetyCaps(suggestions, target, usage);
    expect(capped.filter((s) => s.type === "disable")).toHaveLength(3);
    expect(capped.some((s) => s.skill === "a")).toBe(false);
  });

  it("caps auto-apply disable suggestions to one per cycle", () => {
    const suggestions: OptimizationSuggestion[] = [
      { type: "disable", skill: "a", reason: "", action: "", priority: 90 },
      { type: "unused", skill: "b", reason: "", action: "", priority: 80 },
      { type: "switch_agent", skill: "c", reason: "", action: "", priority: 70, to: "cursor" },
    ];
    const capped = capAutoApplySuggestions(suggestions);
    expect(capped.filter((s) => s.type === "disable" || s.type === "unused")).toHaveLength(1);
    expect(capped.some((s) => s.type === "switch_agent")).toBe(true);
  });
});
