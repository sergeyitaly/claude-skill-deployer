import { afterEach, describe, expect, it } from "vitest";
import { getPerfPercentiles, measureSync, resetPerfTelemetryForTests } from "./perfTelemetry";

describe("perfTelemetry", () => {
  afterEach(() => {
    resetPerfTelemetryForTests();
  });

  it("records sync durations", () => {
    const value = measureSync("test-op", () => 42);
    expect(value).toBe(42);
    expect(getPerfPercentiles("test-op").count).toBe(1);
  });

  it("computes percentiles", () => {
    for (let i = 1; i <= 10; i += 1) {
      measureSync("tree-refresh", () => i);
    }
    const stats = getPerfPercentiles("tree-refresh");
    expect(stats.count).toBe(10);
    expect(stats.p50).toBeGreaterThan(0);
    expect(stats.p95).toBeGreaterThanOrEqual(stats.p50);
    expect(stats.p99).toBeGreaterThanOrEqual(stats.p95);
  });
});
