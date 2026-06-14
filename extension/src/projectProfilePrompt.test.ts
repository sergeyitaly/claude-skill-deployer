import { describe, expect, it } from "vitest";
import { buildProjectTierQuickPickItems } from "./projectProfilePrompt";
import { ProjectProfileFile } from "./projectProfile";

function sampleProfile(type: ProjectProfileFile["profileType"]): ProjectProfileFile {
  return {
    version: 1,
    profileType: type,
    detectedFrom: {
      gitRemotes: [],
      teamSize: "solo",
      aiTools: ["claude"],
      budgetPattern: "none",
      hasSharedClaudeSkills: false,
      isGitRepo: true,
    },
    enabledFeatures: {},
    costTracking: "minimal",
    confidence: 0.75,
    detectedAt: new Date().toISOString(),
    rationale: "test",
  };
}

describe("projectProfilePrompt", () => {
  it("lists team-multi-agent in quick pick for fresh solo-detected project", () => {
    const items = buildProjectTierQuickPickItems(sampleProfile("solo-dev"));
    const team = items.find((i) => i.id === "team-multi-agent");
    expect(team).toBeDefined();
    expect(team?.label).toBe("TEAM MULTI-AGENT");
    expect(items.find((i) => i.id === "solo-dev")?.picked).toBe(true);
  });
});
