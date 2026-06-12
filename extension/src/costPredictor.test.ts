import { describe, expect, it } from "vitest";
import {
  calculateTrendFromSummary,
  formatTrendLabel,
  predictWeeklyCostFromTrend,
  weeklyCostFromSummary,
} from "./costPredictor";
import { CreditUsageSummary } from "./usageCost";

function summary(byDay: { date: string; cost: number }[]): CreditUsageSummary {
  const totalCost = byDay.reduce((s, d) => s + d.cost, 0);
  return {
    byDay: byDay.map((d) => ({
      date: d.date,
      cost: d.cost,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    })),
    byModel: [],
    totalTokens: 0,
    totalCost,
    sessionCount: byDay.length,
    daysBack: 14,
    workspaceScoped: true,
  };
}

describe("costPredictor", () => {
  it("rejects absurd WoW % when prior week is a single low-spend day", () => {
    const s = summary([
      { date: "2026-06-13", cost: 0.58 },
      { date: "2026-06-12", cost: 22.18 },
      { date: "2026-06-11", cost: 66.24 },
      { date: "2026-06-10", cost: 27.47 },
      { date: "2026-06-09", cost: 84.47 },
      { date: "2026-06-05", cost: 157.68 },
      { date: "2026-06-04", cost: 152.04 },
      { date: "2026-06-03", cost: 1.7 },
    ]);
    const window = weeklyCostFromSummary(s);
    expect(window.lastWeekUsd).toBeCloseTo(510.66, 1);
    expect(window.priorWeekUsd).toBeCloseTo(1.7, 2);

    const trend = calculateTrendFromSummary(s);
    expect(trend.reliable).toBe(false);
    expect(trend.direction).toBe("flat");
    expect(trend.percentage).toBe(0);
    expect(predictWeeklyCostFromTrend(trend)).toBeCloseTo(trend.lastWeekUsd, 2);
    expect(predictWeeklyCostFromTrend(trend)).toBeLessThan(600);
  });

  it("caps reliable uptrend percentage and projects with bounded growth", () => {
    const s = summary([
      { date: "2026-06-13", cost: 10 },
      { date: "2026-06-12", cost: 10 },
      { date: "2026-06-11", cost: 10 },
      { date: "2026-06-10", cost: 10 },
      { date: "2026-06-09", cost: 10 },
      { date: "2026-06-08", cost: 10 },
      { date: "2026-06-07", cost: 10 },
      { date: "2026-06-06", cost: 5 },
      { date: "2026-06-05", cost: 5 },
      { date: "2026-06-04", cost: 5 },
    ]);
    const trend = calculateTrendFromSummary(s);
    expect(trend.reliable).toBe(true);
    expect(trend.direction).toBe("up");
    expect(trend.percentage).toBe(200);
    expect(trend.lastWeekUsd).toBe(70);
    expect(trend.priorWeekUsd).toBe(15);
    expect(predictWeeklyCostFromTrend(trend)).toBe(105);
  });

  it("formatTrendLabel shows insufficient data when prior week unreliable", () => {
    const trend = calculateTrendFromSummary(
      summary([
        { date: "2026-06-12", cost: 40 },
        { date: "2026-06-11", cost: 50 },
      ])
    );
    expect(formatTrendLabel(trend)).toBe("Insufficient prior-week data");
  });
});
