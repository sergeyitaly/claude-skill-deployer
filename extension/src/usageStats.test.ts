import { describe, expect, it } from "vitest";
import {
  computeCrossAgentUsage,
  enrichUsageStatsWithAttribution,
  formatAgentBreakdown,
  formatCrossAgentUsageBrief,
  formatUsageReport,
  SkillUsageStat,
} from "./usageStats";

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

  it("fills per-agent breakdown from attribution when runs.jsonl lacks agent rows", () => {
    const stats: SkillUsageStat[] = [
      {
        ...stat("ci-pipeline-debug", 2, null),
        agentRuns: { claude: 2 },
      },
    ];
    const attribution = {
      "ci-pipeline-debug": {
        claude: { tokens: 10_000, cost: 0.1, sessions: 2 },
        cursor: { tokens: 4_000, cost: 0.04, sessions: 1 },
      },
    };
    const enriched = enrichUsageStatsWithAttribution(stats, attribution)[0];
    expect(enriched.agentRuns?.cursor).toBe(1);
    expect(enriched.agentTokens?.cursor).toBe(4_000);
    expect(enriched.agentRuns?.claude).toBe(2);
  });
});

describe("computeCrossAgentUsage", () => {
  it("lists skills used by multiple agents and totals per agent", () => {
    const stats: SkillUsageStat[] = [
      {
        ...stat("ci-pipeline-debug", 3, 14_000),
        agentRuns: { claude: 2, cursor: 1 },
        agentTokens: { claude: 10_000, cursor: 4_000 },
      },
      {
        ...stat("profile-init", 1, 2_000),
        agentRuns: { claude: 1 },
        agentTokens: { claude: 2_000 },
      },
    ];
    const cross = computeCrossAgentUsage(stats);
    expect(cross.byAgent.map((row) => row.agent)).toEqual(["claude", "cursor"]);
    expect(cross.byAgent[0].runs).toBe(3);
    expect(cross.byAgent[1].runs).toBe(1);
    expect(cross.multiAgentSkills).toHaveLength(1);
    expect(cross.multiAgentSkills[0].name).toBe("ci-pipeline-debug");
    expect(formatAgentBreakdown(cross.multiAgentSkills[0].agentRuns, cross.multiAgentSkills[0].agentTokens)).toContain(
      "Cursor IDE"
    );
  });

  it("counts token-only attribution as one invocation per agent", () => {
    const stats: SkillUsageStat[] = [
      {
        ...stat("adx-schema-check", 1, 8_000),
        agentRuns: { claude: 1 },
        agentTokens: { claude: 5_000, cursor: 3_000 },
      },
    ];
    const cross = computeCrossAgentUsage(stats);
    expect(cross.byAgent.map((row) => row.agent)).toEqual(["claude", "cursor"]);
    expect(cross.multiAgentSkills).toHaveLength(1);
  });
});

describe("formatUsageReport", () => {
  const emptyCredit = {
    byDay: [],
    byModel: [],
    totalTokens: 0,
    totalCost: 0,
    sessionCount: 0,
    daysBack: 14,
  };

  it("includes cross-agent section when multiple agents invoked skills", () => {
    const stats: SkillUsageStat[] = [
      {
        ...stat("ci-pipeline-debug", 2, 20_000),
        agentRuns: { claude: 1, cursor: 1 },
        agentTokens: { claude: 12_000, cursor: 8_000 },
        rating: "active",
      },
    ];
    const report = formatUsageReport(stats, [], "/tmp/ws", emptyCredit);
    expect(report).toContain("## Skill usage by agent");
    expect(report).toContain("Same skill across multiple agents");
    expect(report).toContain("Cursor IDE");
    expect(report).toContain("Claude Code");
  });
});

describe("formatCrossAgentUsageBrief", () => {
  it("returns empty lines when no agent data", () => {
    expect(formatCrossAgentUsageBrief([stat("unused-skill", 0, null)])).toEqual([]);
  });
});
