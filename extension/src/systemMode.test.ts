import { describe, expect, it } from "vitest";
import { AttributionHealth } from "./attributionHealth";
import { PipelineCycleTimestamps } from "./pipelineCycle";
import { buildSystemModeContext, resolveSystemMode } from "./systemMode";

function health(partial: Partial<AttributionHealth>): AttributionHealth {
  return {
    reliable: false,
    staleEqualSplit: false,
    highUnattributedRatio: false,
    noPerSkillData: true,
    v2HookRuns: 0,
    confidenceScore: 0.5,
    confidenceLevel: "estimated",
    summary: "test",
    ...partial,
  };
}

const readyCycle: PipelineCycleTimestamps = {
  collectedAt: "2026-06-12T10:00:00.000Z",
  indexedAt: "2026-06-12T10:01:00.000Z",
  analyzedAt: "2026-06-12T10:02:00.000Z",
};

describe("systemMode", () => {
  it("enters safe mode when pipeline is stale or confidence is low", () => {
    expect(resolveSystemMode(health({ confidenceScore: 0.4 }), readyCycle)).toBe("safe");
    expect(
      resolveSystemMode(health({ confidenceScore: 0.8, reliable: true }), {
        collectedAt: "2026-06-12T12:00:00.000Z",
        indexedAt: "2026-06-12T11:00:00.000Z",
      })
    ).toBe("safe");
  });

  it("allows manual apply in degraded but not auto-apply", () => {
    const ctx = buildSystemModeContext(
      health({ confidenceScore: 0.6, reliable: false, noPerSkillData: false }),
      readyCycle
    );
    expect(ctx.mode).toBe("degraded");
    expect(ctx.canApplyOptimizations).toBe(true);
    expect(ctx.canAutoApplyOptimizations).toBe(false);
  });

  it("allows auto-apply only in normal mode", () => {
    const ctx = buildSystemModeContext(
      health({ confidenceScore: 0.8, reliable: true, noPerSkillData: false }),
      readyCycle
    );
    expect(ctx.mode).toBe("normal");
    expect(ctx.canAutoApplyOptimizations).toBe(true);
  });
});
