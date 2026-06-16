import { describe, expect, it } from "vitest";
import {
  blendedUsdPerMTokens,
  estimateUsageCostFromRaw,
  estimateUsageCostUsd,
  formatModelRateHint,
  pricingForModel,
  tokenCostUsd,
} from "./costRates";

describe("pricingForModel", () => {
  it("maps opus, haiku, sonnet, and fable tiers", () => {
    expect(pricingForModel("claude-opus-4")).toEqual({ input: 5, output: 25, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.5 });
    expect(pricingForModel("claude-haiku-3")).toEqual({ input: 1, output: 5, cacheWrite: 1.25, cacheWrite1h: 2, cacheRead: 0.1 });
    expect(pricingForModel("claude-sonnet-4")).toEqual({ input: 3, output: 15, cacheWrite: 3.75, cacheWrite1h: 6, cacheRead: 0.3 });
    expect(pricingForModel("claude-fable-5")).toEqual({ input: 10, output: 50, cacheWrite: 12.5, cacheWrite1h: 20, cacheRead: 1 });
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

describe("estimateUsageCostFromRaw", () => {
  it("maps snake_case transcript usage to model rates", () => {
    const cost = estimateUsageCostFromRaw(
      {
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1_000_000,
      },
      "claude-sonnet-4-6"
    );
    expect(cost).toBeCloseTo(3.3, 5);
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
