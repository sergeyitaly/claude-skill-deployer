import { describe, expect, it } from "vitest";
import { buildGlobalTrustBadge, buildSkillTrustLine, skillCostSourceLabel } from "./attributionTrust";

describe("attributionTrust", () => {
  it("builds reliable global badge when hooks are active", () => {
    const badge = buildGlobalTrustBadge(
      { confidenceLevel: "high", confidenceScore: 0.82, summary: "Hooks active", v2HookRuns: 3 },
      { attribution: { allConfigured: true, applicableCount: 2, configuredCount: 2, agents: [] } }
    );
    expect(badge.tier).toBe("reliable");
    expect(badge.label).toContain("Reliable");
  });

  it("builds estimated badge for transcript-only attribution", () => {
    const badge = buildGlobalTrustBadge(
      { confidenceLevel: "estimated", confidenceScore: 0.52, summary: "Mixed sources", v2HookRuns: 0 },
      { attribution: { allConfigured: false, applicableCount: 2, configuredCount: 0, agents: [] } }
    );
    expect(badge.tier).toBe("estimated");
    expect(badge.label).toContain("Estimated");
  });

  it("formats per-skill trust with ROI and confidence percent", () => {
    const line = buildSkillTrustLine(
      { skill: "terraform-plan-review", level: "estimated", score: 0.62, source: "transcript-split" },
      "HIGH"
    );
    expect(line.summary).toContain("ROI: HIGH");
    expect(line.summary).toContain("62%");
    expect(line.summary).toContain(skillCostSourceLabel("transcript-split"));
  });
});
