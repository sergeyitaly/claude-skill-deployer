import { describe, expect, it } from "vitest";
import {
  blendedUsdPerMTokens,
  estimateUsageCostUsd,
  formatModelRateHint,
  pricingForModel,
  tokenCostUsd,
} from "./costRates";

describe("pricingForModel", () => {
  it("maps opus, haiku, and sonnet tiers", () => {
    expect(pricingForModel("claude-opus-4")).toEqual({ input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 });
    expect(pricingForModel("claude-haiku-3")).toEqual({ input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 });
    expect(pricingForModel("claude-sonnet-4")).toEqual({ input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 });
  });

  it("defaults unknown models to sonnet pricing", () => {
    expect(pricingForModel("unknown-model")).toEqual(pricingForModel("claude-sonnet"));
    expect(pricingForModel()).toEqual(pricingForModel("claude-sonnet"));
  });
});

describe("estimateUsageCostUsd", () => {
  it("sums input, output, and cache token rates", () => {
    const cost = estimateUsageCostUsd(
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreationTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
      },
      "claude-sonnet"
    );
    expect(cost).toBeCloseTo(3 + 15 + 3.75 + 0.3, 5);
  });

  it("returns zero for empty usage", () => {
    expect(estimateUsageCostUsd({}, "claude-opus")).toBe(0);
  });
});

describe("tokenCostUsd", () => {
  it("uses blended rate when split is unknown", () => {
    const blended = blendedUsdPerMTokens("claude-sonnet");
    expect(tokenCostUsd(2_000_000, "claude-sonnet")).toBeCloseTo((2_000_000 / 1_000_000) * blended, 5);
  });

  it("returns zero for non-positive token counts", () => {
    expect(tokenCostUsd(0)).toBe(0);
    expect(tokenCostUsd(-100)).toBe(0);
  });
});

describe("formatModelRateHint", () => {
  it("includes per-million input and output rates", () => {
    expect(formatModelRateHint("claude-haiku")).toContain("$1/M in");
    expect(formatModelRateHint("claude-haiku")).toContain("$5/M out");
  });
});
