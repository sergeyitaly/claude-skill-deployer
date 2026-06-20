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

  it("scores full team capability when all current weights are enabled", () => {
    const full = {
      autoOptimizer: true,
      communityBenchmarks: true,
      prCostEstimate: true,
    };
    expect(teamCapabilityPct(full)).toBe(100);
  });

  it("computes team benefit when auto-tier is solo on a team repo", () => {
    const noExt = buildScenarioResult({
      id: "no-extension",
      label: "No extension",
      enabledFeatures: { autoOptimizer: false, communityBenchmarks: false, prCostEstimate: false },
      pipelineP50Ms: 0,
      pipelineSkipped: true,
      multiAgentSyncEnabled: false,
      featuresEnabledCount: 0,
    });
    const naive = buildScenarioResult({
      id: "naive-full-stack",
      label: "Naive full stack",
      profileType: "team-multi-agent",
      enabledFeatures: { autoOptimizer: true, communityBenchmarks: true, prCostEstimate: true },
      pipelineP50Ms: 120,
      pipelineSkipped: false,
      multiAgentSyncEnabled: true,
      featuresEnabledCount: 3,
    });
    const auto = buildScenarioResult({
      id: "auto-detected-local",
      label: "Auto-detected solo",
      profileType: "solo-dev",
      enabledFeatures: { autoOptimizer: false, communityBenchmarks: false, prCostEstimate: false },
      pipelineP50Ms: 45,
      pipelineSkipped: false,
      multiAgentSyncEnabled: false,
      featuresEnabledCount: 0,
      confidencePct: 80,
    });

    const cmp = compareTierBenefits(auto, noExt, naive);
    expect(cmp.overheadSavingsPct).toBeGreaterThan(0);
    expect(cmp.capabilityRetainedPct).toBeLessThan(100);
    expect(cmp.netTeamBenefitPct).toBeGreaterThanOrEqual(0);
  });
});
