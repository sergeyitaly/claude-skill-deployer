import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBudgetTierGating } from "./budgetTierGating";
import { writeTodayCostSnapshot } from "./todayCostSnapshot";
import * as taskSkillFocus from "./taskSkillFocus";
import { writeTaskActiveSkills } from "./taskSkillFocus";
import { Manifest } from "./skillOps";

vi.mock("./featureFlags", () => ({
  isFeatureEnabled: () => true,
}));

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "btg-"));
}

const manifest: Manifest = {
  skills: {
    "heavy-skill": { description: "Heavy", cost_estimate: "high" },
    "mid-skill": { description: "Mid", cost_estimate: "medium" },
    "light-skill": { description: "Light", cost_estimate: "low" },
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("applyBudgetTierGating", () => {
  it("disables high-tier skills outside active set at warn threshold", () => {
    const target = makeWorkspace();
    fs.mkdirSync(path.join(target, ".claude", "learning"), { recursive: true });
    writeTaskActiveSkills(target, {
      version: 1,
      generatedAt: new Date().toISOString(),
      source: "manual",
      activeSkills: ["light-skill"],
      ignoredSkills: [],
    });
    writeTodayCostSnapshot(target, 4.5, 1000);

    const result = applyBudgetTierGating(target, manifest, {
      mode: "normal",
      dailyBudgetUsd: 5,
      warnThresholdPercent: 80,
      economyWarnUsd: 0.1,
      unlimitedNotifyUsd: 10,
      autoDisableHighTierOnBudgetHit: true,
      highTierSkills: ["heavy-skill"],
      mediumTierSkills: ["mid-skill"],
      lowTierSkills: ["light-skill"],
    });

    expect(result.disabled).toContain("heavy-skill");
    expect(result.reason).toBe("budget-warn");
    const local = JSON.parse(
      fs.readFileSync(path.join(target, ".claude", "settings.local.json"), "utf-8")
    ) as { skillOverrides?: Record<string, string> };
    expect(local.skillOverrides?.["heavy-skill"]).toBe("off");
  });

  it("regression: reports reason 'task-focus-disabled' when skipped above the warn threshold with task focus off — previously gave zero signal anywhere", () => {
    vi.spyOn(taskSkillFocus, "taskSkillFocusEnabled").mockReturnValue(false);
    const target = makeWorkspace();
    writeTodayCostSnapshot(target, 4.5, 1000); // 90% of a $5 budget — above the 80% warn threshold

    const result = applyBudgetTierGating(target, manifest, {
      mode: "normal",
      dailyBudgetUsd: 5,
      warnThresholdPercent: 80,
      economyWarnUsd: 0.1,
      unlimitedNotifyUsd: 10,
      autoDisableHighTierOnBudgetHit: true,
      highTierSkills: ["heavy-skill"],
      mediumTierSkills: ["mid-skill"],
      lowTierSkills: ["light-skill"],
    });

    expect(result.disabled).toEqual([]);
    expect(result.reason).toBe("task-focus-disabled");
  });

  it("stays silent (no reason) when task focus is off but spend is well under the warn threshold", () => {
    vi.spyOn(taskSkillFocus, "taskSkillFocusEnabled").mockReturnValue(false);
    const target = makeWorkspace();
    writeTodayCostSnapshot(target, 0.5, 100); // 10% of a $5 budget

    const result = applyBudgetTierGating(target, manifest, {
      mode: "normal",
      dailyBudgetUsd: 5,
      warnThresholdPercent: 80,
      economyWarnUsd: 0.1,
      unlimitedNotifyUsd: 10,
      autoDisableHighTierOnBudgetHit: true,
      highTierSkills: ["heavy-skill"],
      mediumTierSkills: ["mid-skill"],
      lowTierSkills: ["light-skill"],
    });

    expect(result.disabled).toEqual([]);
    expect(result.reason).toBeUndefined();
  });
});
