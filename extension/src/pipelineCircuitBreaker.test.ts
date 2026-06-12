import { describe, expect, it, afterEach } from "vitest";
import { MAX_PIPELINE_RUNS_PER_MINUTE, notePipelineRun, resetPipelineCircuitBreakerForTests } from "./pipelineCircuitBreaker";

describe("pipelineCircuitBreaker", () => {
  afterEach(() => {
    resetPipelineCircuitBreakerForTests();
  });

  it("trips after exceeding the per-minute budget", () => {
    const target = "/tmp/circuit-test";
    let tripped = false;
    for (let i = 0; i < MAX_PIPELINE_RUNS_PER_MINUTE; i++) {
      const budget = notePipelineRun(target, 1_000_000 + i);
      expect(budget.tripped).toBe(false);
    }
    tripped = notePipelineRun(target, 1_000_000 + MAX_PIPELINE_RUNS_PER_MINUTE).tripped;
    expect(tripped).toBe(true);
  });
});
