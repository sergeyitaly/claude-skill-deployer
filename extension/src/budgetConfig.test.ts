import { describe, expect, it } from "vitest";
import {
  budgetUsagePercent,
  highTierSkillsFromManifest,
  lowTierSkillsFromManifest,
  mediumTierSkillsFromManifest,
} from "./budgetConfig";
import { Manifest } from "./skillOps";

const manifest: Manifest = {
  skills: {
    "light-skill": { cost_estimate: "low" },
    "mid-skill": { cost_estimate: "medium" },
    "heavy-skill": { cost_estimate: "high" },
    "default-tier": {},
  },
};

describe("tierSkillsFromManifest", () => {
  it("groups skills by cost_estimate tier", () => {
    expect(lowTierSkillsFromManifest(manifest)).toEqual(["light-skill"]);
    expect(mediumTierSkillsFromManifest(manifest)).toEqual(["default-tier", "mid-skill"]);
    expect(highTierSkillsFromManifest(manifest)).toEqual(["heavy-skill"]);
  });
});

describe("budgetUsagePercent", () => {
  it("returns percent of daily budget used", () => {
    expect(budgetUsagePercent(4, { dailyBudgetUsd: 5 } as never)).toBe(80);
  });

  it("returns null when daily budget is disabled", () => {
    expect(budgetUsagePercent(10, { dailyBudgetUsd: 0 } as never)).toBeNull();
  });
});
