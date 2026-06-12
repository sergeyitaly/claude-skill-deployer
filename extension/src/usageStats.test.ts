import { describe, expect, it } from "vitest";
import { enrichUsageStatsWithAttribution, SkillUsageStat } from "./usageStats";

function stat(name: string, runs: number, totalTokens: number | null): SkillUsageStat {
  return {
    name,
    runs,
    successCount: runs,
    failureCount: 0,
    successRate: runs > 0 ? 100 : null,
    avgDuration: null,
    lastUsed: null,
    daysSinceLastUse: null,
    totalTokens,
    rating: runs > 0 ? "low-usage" : "unused",
  };
}

describe("enrichUsageStatsWithAttribution", () => {
  it("fills tokens from attribution when runs.jsonl has none", () => {
    const stats = [stat("ci-pipeline-debug", 1, null)];
    const attribution = {
      "ci-pipeline-debug": { claude: { tokens: 42_000, cost: 0.38, sessions: 1 } },
    };
    const enriched = enrichUsageStatsWithAttribution(stats, attribution);
    expect(enriched[0].totalTokens).toBe(42_000);
  });

  it("does not fill tokens from attribution when skill has zero usage runs", () => {
    const stats = [stat("ci-pipeline-debug", 0, null)];
    const attribution = {
      "ci-pipeline-debug": { claude: { tokens: 42_000, cost: 0.38, sessions: 1 } },
    };
    const enriched = enrichUsageStatsWithAttribution(stats, attribution);
    expect(enriched[0].totalTokens).toBeNull();
  });

  it("keeps runs.jsonl tokens when already recorded", () => {
    const stats = [stat("ci-pipeline-debug", 2, 10_000)];
    const attribution = {
      "ci-pipeline-debug": { claude: { tokens: 99_000, cost: 0.9, sessions: 2 } },
    };
    const enriched = enrichUsageStatsWithAttribution(stats, attribution);
    expect(enriched[0].totalTokens).toBe(10_000);
  });

  it("sums tokens across agents in attribution when runs exist", () => {
    const stats = [stat("adx-schema-check", 1, null)];
    const attribution = {
      "adx-schema-check": {
        claude: { tokens: 5_000, cost: 0.05, sessions: 1 },
        cursor: { tokens: 3_000, cost: 0.03, sessions: 1 },
      },
    };
    const enriched = enrichUsageStatsWithAttribution(stats, attribution);
    expect(enriched[0].totalTokens).toBe(8_000);
  });
});
