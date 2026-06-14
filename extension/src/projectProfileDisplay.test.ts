import { describe, expect, it } from "vitest";
import {
  buildProjectProfileView,
  estimateMonthlySavings,
  formatProjectProfileStatusBarText,
  PROFILE_TYPE_BADGE,
} from "./projectProfileDisplay";
import { ProjectProfileFile } from "./projectProfile";

function sampleProfile(type: ProjectProfileFile["profileType"], features: Partial<ProjectProfileFile["enabledFeatures"]>): ProjectProfileFile {
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
      hasAidlcWorkflow: false,
      hasPendingProfileInit: false,
      branchCount: 1,
      trackedFileCount: 10,
      repoSizeKb: 50,
      commitsLast30d: 1,
      commitsTotal: 3,
      projectAgeDays: 7,
      authorCount30d: 1,
      activityLevel: "low",
    },
    enabledFeatures: features,
    costTracking: "minimal",
    confidence: 0.8,
    detectedAt: new Date().toISOString(),
    rationale: "test",
  };
}

describe("projectProfileDisplay", () => {
  it("shows TEAM MULTI-AGENT badge with no savings", () => {
    const profile = sampleProfile("team-multi-agent", { multiAgent: true, attributionCollector: true });
    expect(PROFILE_TYPE_BADGE["team-multi-agent"]).toBe("TEAM MULTI-AGENT");
    expect(estimateMonthlySavings(profile)).toBe(0);
    expect(formatProjectProfileStatusBarText(profile)).toContain("TEAM MULTI-AGENT");
    expect(formatProjectProfileStatusBarText(profile)).not.toContain("saves");
  });

  it("shows savings for solo-dev tier", () => {
    const profile = sampleProfile("solo-dev", { multiAgent: false, attributionCollector: false });
    const savings = estimateMonthlySavings(profile);
    expect(savings).toBeGreaterThan(10);
    expect(formatProjectProfileStatusBarText(profile)).toMatch(/saves ~\$/);
  });

  it("lists feature on/off in view", () => {
    const profile = sampleProfile("throwaway", {
      sessionSkillAdaptation: false,
      costIntelligence: false,
    });
    const view = buildProjectProfileView(profile);
    expect(view.features.find((f) => f.key === "sessionSkillAdaptation")?.on).toBe(false);
    expect(view.monthlySavingsUsd).toBeGreaterThan(20);
  });
});
