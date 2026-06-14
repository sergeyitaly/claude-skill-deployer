import { describe, expect, it } from "vitest";
import { buildProjectPlanQuickPickItems, formatDetectedTierSummary } from "./projectProfilePrompt";
import { ProjectProfileFile } from "./projectProfile";

function sampleProfile(
  type: ProjectProfileFile["profileType"],
  overrides: Partial<ProjectProfileFile["detectedFrom"]> = {}
): ProjectProfileFile {
  return {
    version: 1,
    profileType: type,
    detectedFrom: {
      gitRemotes: [],
      teamSize: "solo",
      aiTools: [],
      budgetPattern: "none",
      hasSharedClaudeSkills: false,
      isGitRepo: true,
      hasAidlcWorkflow: false,
      hasPendingProfileInit: false,
      branchCount: 1,
      trackedFileCount: 8,
      repoSizeKb: 50,
      commitsLast30d: 1,
      commitsTotal: 2,
      projectAgeDays: 3,
      authorCount30d: 1,
      activityLevel: "low",
      ...overrides,
    },
    enabledFeatures: {},
    costTracking: "minimal",
    confidence: 0.75,
    detectedAt: new Date().toISOString(),
    rationale:
      "Git analysis: 8 tracked files, 1 branch, 2 commits (1 last 30d), 1 author (30d), low activity. New repo — solo tier by default; choose AIDLC or multi-agent in plans if you use several AI tools.",
  };
}

describe("projectProfilePrompt", () => {
  it("highlights AIDLC greenfield for nascent solo-detected projects", () => {
    const detected = sampleProfile("solo-dev");
    const items = buildProjectPlanQuickPickItems(detected);
    const greenfield = items.find((i) => i.id === "aidlc-greenfield");
    expect(greenfield).toBeDefined();
    expect(greenfield?.picked).toBe(true);
    expect(items.find((i) => i.id === "accept-detected")?.picked).toBe(false);
  });

  it("defaults to accept-detected when multi-agent already detected", () => {
    const detected = sampleProfile("team-multi-agent", { hasAidlcWorkflow: true });
    const items = buildProjectPlanQuickPickItems(detected);
    expect(items.find((i) => i.id === "accept-detected")?.picked).toBe(true);
  });

  it("lists multi-agent and budget plan options", () => {
    const detected = sampleProfile("solo-dev");
    const items = buildProjectPlanQuickPickItems(detected);
    expect(items.find((i) => i.id === "multi-agent-workflow")).toBeDefined();
    expect(items.find((i) => i.id === "budget-focused")).toBeDefined();
    expect(items.find((i) => i.id === "quick-spike")).toBeDefined();
  });

  it("includes repo evidence in detected summary", () => {
    const summary = formatDetectedTierSummary(sampleProfile("solo-dev"));
    expect(summary).toContain("Detected: SOLO DEV");
    expect(summary).toContain("8 tracked files");
  });
});
