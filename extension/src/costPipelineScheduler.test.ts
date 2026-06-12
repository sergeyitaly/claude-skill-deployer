import { describe, expect, it, vi, afterEach } from "vitest";
import {
  resetCostPipelineSchedulerForTests,
  runCostPipelineNow,
  scheduleCostPipelineSync,
} from "./costPipelineScheduler";

vi.mock("./costPipeline", () => ({
  runCostPipelineSync: vi.fn(() => ({
    ready: true,
    fresh: true,
    cycle: {},
    systemMode: "normal",
    state: { version: 1 },
    processedSessions: 0,
  })),
}));

import { runCostPipelineSync } from "./costPipeline";

describe("costPipelineScheduler", () => {
  afterEach(() => {
    resetCostPipelineSchedulerForTests();
    vi.clearAllMocks();
  });

  it("coalesces concurrent immediate runs", async () => {
    const p1 = runCostPipelineNow("/tmp/a", "/lib");
    const p2 = runCostPipelineNow("/tmp/a", "/lib");
    await Promise.all([p1, p2]);
    expect(runCostPipelineSync).toHaveBeenCalledTimes(1);
  });

  it("debounces scheduled runs", async () => {
    vi.useFakeTimers();
    scheduleCostPipelineSync("/tmp/b", "/lib", 1000);
    scheduleCostPipelineSync("/tmp/b", "/lib", 1000);
    await vi.advanceTimersByTimeAsync(999);
    expect(runCostPipelineSync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5);
    await Promise.resolve();
    expect(runCostPipelineSync).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
