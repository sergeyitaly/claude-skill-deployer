import { describe, expect, it } from "vitest";
import { formatRoutingSuggestion, getOptimalAgent } from "./costRouter";
import type { SkillAttributionMap } from "./costAttribution";

const profileInitAttribution: SkillAttributionMap = {
  "profile-init": {
    claude: { tokens: 131_907, cost: 0.198, sessions: 4 },
  },
};

describe("getOptimalAgent", () => {
  it("returns cheapest agent when budget allows", () => {
    expect(getOptimalAgent("profile-init", profileInitAttribution, { remainingBudgetUsd: 5 })).toBe("claude");
  });

  it("routes to copilot when daily budget is nearly exhausted", () => {
    expect(getOptimalAgent("profile-init", profileInitAttribution, { remainingBudgetUsd: 0.25 })).toBe("copilot");
  });
});

describe("formatRoutingSuggestion", () => {
  it("explains budget-driven copilot routing", () => {
    const msg = formatRoutingSuggestion("profile-init", profileInitAttribution, "copilot", {
      remainingBudgetUsd: 0.25,
    });
    expect(msg).toContain("copilot");
    expect(msg).toContain("Daily budget nearly exhausted");
    expect(msg).toContain("measured cheapest is **claude**");
    expect(msg).toContain("~$0.05/run");
  });
});
