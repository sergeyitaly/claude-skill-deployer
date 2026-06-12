import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateUsageRemoval,
  planSkillSetResolution,
  shouldRunSkillSetResolver,
  SkillSetResolverConfig,
  SkillSetUsageRules,
  SkillUsageMetrics,
} from "./skillSetResolver";

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "csr-plan-"));
}

const baseUsageRules = (): SkillSetUsageRules => ({
  enabled: false,
  removeNeverUsed: false,
  removeNeverUsedEvenIfRelevant: true,
  removeIdleSkills: false,
  unusedIdleDays: 14,
  minAttributedCostUsd: 0.5,
  removeStaleLowUsage: false,
  lowUsageIdleDays: 30,
  removeBySessions: false,
  minSessionsToKeep: 2,
  removeByTokens: false,
  minTotalTokensToKeep: 50_000,
  removeByCost: false,
  maxCostPerUseUsd: 1,
  maxRunsForCostRemoval: 5,
  requireReliableAttribution: true,
  archiveInsteadOfRemove: false,
  skipHighCostInstall: false,
});

const baseConfig = (overrides?: Partial<SkillSetResolverConfig>): SkillSetResolverConfig => ({
  enabled: true,
  dayOfWeek: 1,
  hour: 8,
  minute: 0,
  installRelevant: true,
  removeIrrelevant: true,
  keepActiveSkills: true,
  protectedSkills: ["self-learning"],
  usageRules: baseUsageRules(),
  ...overrides,
});

describe("planSkillSetResolution", () => {
  const libraryDir = path.join(__dirname, "..", "skills_library");

  it("installs relevant missing skills and removes irrelevant installed ones", () => {
    const target = makeWorkspace();
    const claudeSkills = path.join(target, ".claude", "skills");
    fs.mkdirSync(claudeSkills, { recursive: true });
    fs.mkdirSync(path.join(claudeSkills, "terraform-plan-review"), { recursive: true });
    fs.writeFileSync(path.join(claudeSkills, "terraform-plan-review", "SKILL.md"), "---\nname: terraform-plan-review\n---\n");
    fs.mkdirSync(path.join(target, "extension", "src"), { recursive: true });
    fs.writeFileSync(path.join(target, "extension", "src", "extension.ts"), "// ext");

    const plan = planSkillSetResolution(target, libraryDir, baseConfig());
    expect(plan.toRemove).toContain("terraform-plan-review");
    expect(plan.toInstall).toContain("vscode-extension-publishing");
    expect(plan.keep).not.toContain("terraform-plan-review");
  });

  it("never removes project-local skills", () => {
    const target = makeWorkspace();
    const claudeSkills = path.join(target, ".claude", "skills");
    fs.mkdirSync(path.join(claudeSkills, "my-custom-skill"), { recursive: true });
    fs.writeFileSync(path.join(claudeSkills, "my-custom-skill", "SKILL.md"), "---\nname: my-custom-skill\n---\n");

    const plan = planSkillSetResolution(
      target,
      libraryDir,
      baseConfig({ installRelevant: false, removeIrrelevant: true, keepActiveSkills: false })
    );

    expect(plan.toRemove).not.toContain("my-custom-skill");
    expect(plan.keep).toContain("my-custom-skill");
  });

  it("removes never-used skills when usage rules enabled", () => {
    const target = makeWorkspace();
    const claudeSkills = path.join(target, ".claude", "skills");
    fs.mkdirSync(claudeSkills, { recursive: true });
    fs.mkdirSync(path.join(claudeSkills, "claude-api"), { recursive: true });
    fs.writeFileSync(path.join(claudeSkills, "claude-api", "SKILL.md"), "---\nname: claude-api\n---\n");

    const plan = planSkillSetResolution(
      target,
      libraryDir,
      baseConfig({
        removeIrrelevant: false,
        usageRules: { ...baseUsageRules(), enabled: true, removeNeverUsed: true },
      })
    );

    expect(plan.toRemove).toContain("claude-api");
    expect(plan.reasons["claude-api"]).toContain("never used");
  });
});

describe("evaluateUsageRemoval", () => {
  const metrics = (over: Partial<SkillUsageMetrics>): SkillUsageMetrics => ({
    runs: 1,
    totalTokens: 1000,
    attributedCost: 2,
    attributedSessions: 1,
    costPerUse: 2,
    rating: "low-usage",
    daysSinceLastUse: 20,
    ...over,
  });

  it("flags expensive low-use skills by cost", () => {
    const rules = { ...baseUsageRules(), enabled: true, removeByCost: true };
    const reason = evaluateUsageRemoval(metrics({ runs: 2, attributedCost: 3, costPerUse: 1.5 }), rules, true);
    expect(reason).toContain("/session");
  });

  it("flags skills below session threshold", () => {
    const rules = { ...baseUsageRules(), enabled: true, removeBySessions: true, minSessionsToKeep: 3 };
    expect(evaluateUsageRemoval(metrics({ runs: 1 }), rules, true)).toContain("session");
  });
});

describe("shouldRunSkillSetResolver", () => {
  it("runs once per ISO week after scheduled time", () => {
    const config = baseConfig({
      dayOfWeek: new Date().getDay(),
      hour: 0,
      minute: 0,
    });
    expect(shouldRunSkillSetResolver(config, undefined)).toBe(true);
    expect(shouldRunSkillSetResolver({ ...config, enabled: false }, undefined)).toBe(false);
  });
});
