import { describe, expect, it } from "vitest";
import {
  isIndexStaleForCollection,
  isPipelineReadyForOptimizer,
  PipelineCycleTimestamps,
} from "./pipelineCycle";

describe("pipelineCycle", () => {
  it("treats index as stale when collectedAt is newer than indexedAt", () => {
    const cycle: PipelineCycleTimestamps = {
      collectedAt: "2026-06-12T12:00:00.000Z",
      indexedAt: "2026-06-12T11:00:00.000Z",
      analyzedAt: "2026-06-12T11:30:00.000Z",
    };
    expect(isIndexStaleForCollection(cycle)).toBe(true);
    expect(isPipelineReadyForOptimizer(cycle)).toBe(false);
  });

  it("is ready when analyzed and indexed are at least as fresh as collection", () => {
    const cycle: PipelineCycleTimestamps = {
      collectedAt: "2026-06-12T11:00:00.000Z",
      indexedAt: "2026-06-12T11:05:00.000Z",
      analyzedAt: "2026-06-12T11:06:00.000Z",
    };
    expect(isIndexStaleForCollection(cycle)).toBe(false);
    expect(isPipelineReadyForOptimizer(cycle)).toBe(true);
  });

  it("is not ready when timestamps are missing", () => {
    expect(isPipelineReadyForOptimizer({})).toBe(false);
    expect(isPipelineReadyForOptimizer({ indexedAt: "2026-06-12T11:00:00.000Z" })).toBe(false);
  });
});
