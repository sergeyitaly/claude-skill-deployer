import { describe, expect, it } from "vitest";
import {
  buildScenarioResult,
  compareTierBenefits,
  teamCapabilityPct,
  TEAM_CAPABILITY_WEIGHTS,
} from "./tierBenefitBenchmark";

describe("tierBenefitBenchmark", () => {
  it("scores zero team capability when all tier features are off", () => {
    const off = Object.fromEntries(
      Object.keys(TEAM_CAPABILITY_WEIGHTS).map((k) => [k, false])
    ) as Record<string, boolean>;
    expect(teamCapabilityPct(off)).toBe(0);
  });

  it("scores full team capability for team-multi-agent preset keys", () => {
    const full = {
      multiAgent: true,
      attributionCollector: true,
      costIntelligence: true,
      teamCostSharing: true,
      sessionSkillAdaptation: true,
      branchProfiles: true,
      autoOptimizer: true,
      taskSkillFocus: true,
      costAwareSearch: true,
    };
    expect(teamCapabilityPct(full)).toBe(100);
  });

  it("computes team benefit when auto-tier is solo on a team repo", () => {
    const allOff = {
      multiAgent: false,
      attributionCollector: false,
      costIntelligence: false,
      teamCostSharing: false,
      sessionSkillAdaptation: false,
      branchProfiles: false,
      autoOptimizer: false,
      taskSkillFocus: false,
      costAwareSearch: false,
    };
    const noExt = buildScenarioResult({
      id: "no-extension",
      label: "No extension",
      enabledFeatures: allOff,
      pipelineP50Ms: 0,
      pipelineSkipped: true,
      multiAgentSyncEnabled: false,
      featuresEnabledCount: 0,
    });
    const naive = buildScenarioResult({
      id: "naive-full-stack",
      label: "Naive full stack",
      profileType: "team-multi-agent",
      enabledFeatures: {
        multiAgent: true,
        attributionCollector: true,
        costIntelligence: true,
        teamCostSharing: true,
        sessionSkillAdaptation: true,
        autoOptimizer: true,
        taskSkillFocus: true,
      },
      pipelineP50Ms: 120,
      pipelineSkipped: false,
      multiAgentSyncEnabled: true,
      featuresEnabledCount: 18,
    });
    const auto = buildScenarioResult({
      id: "auto-detected-local",
      label: "Auto-detected",
      profileType: "solo-dev",
      enabledFeatures: {
        multiAgent: false,
        attributionCollector: false,
        costIntelligence: true,
        sessionSkillAdaptation: true,
        taskSkillFocus: true,
      },
      pipelineP50Ms: 45,
      pipelineSkipped: false,
      multiAgentSyncEnabled: false,
      featuresEnabledCount: 12,
      confidencePct: 80,
    });

    const cmp = compareTierBenefits(auto, noExt, naive);
    expect(cmp.monthlySavingsUsd).toBe(19);
    expect(cmp.overheadSavingsPct).toBeGreaterThan(60);
    expect(cmp.extensionValueUpliftPct).toBeGreaterThan(0);
    expect(cmp.capabilityRetainedPct).toBeLessThan(100);
    expect(cmp.netTeamBenefitPct).toBeGreaterThan(0);
  });
});
