import { describe, expect, it } from "vitest";
import {
  estimateSessionCostUsd,
  estimateSessionTokens,
  formatCompactUsd,
  sumInstallCostEstimate,
  tierForSkill,
  TIER_SESSION_TOKENS,
} from "./skillCost";

describe("tierForSkill", () => {
  it("defaults missing tier to medium", () => {
    expect(tierForSkill(undefined)).toBe("medium");
  });

  it("preserves explicit tier", () => {
    expect(tierForSkill("high")).toBe("high");
  });
});

describe("estimateSessionTokens", () => {
  it("maps tiers to reference token loads", () => {
    expect(estimateSessionTokens("low")).toBe(TIER_SESSION_TOKENS.low);
    expect(estimateSessionTokens("high")).toBe(TIER_SESSION_TOKENS.high);
  });
});

describe("sumInstallCostEstimate", () => {
  it("aggregates tokens and blended cost across skills", () => {
    const { totalTokens, totalCostUsd } = sumInstallCostEstimate(["low", "high"]);
    expect(totalTokens).toBe(TIER_SESSION_TOKENS.low + TIER_SESSION_TOKENS.high);
    expect(totalCostUsd).toBeGreaterThan(0);
    expect(estimateSessionCostUsd("low") + estimateSessionCostUsd("high")).toBeCloseTo(totalCostUsd, 5);
  });
});

describe("formatCompactUsd", () => {
  it("formats normal amounts to two decimals", () => {
    expect(formatCompactUsd(1.234)).toBe("$1.23");
  });

  it("shows <$0.01 for tiny positive amounts", () => {
    expect(formatCompactUsd(0.001)).toBe("<$0.01");
  });
});
