import { describe, expect, it } from "vitest";
import { computeSkillRoi, roiBandFromMultiple } from "./skillRoi";
import { loadManifest } from "./skillOps";
import * as path from "node:path";

const libraryDir = path.join(__dirname, "..", "skills_library");

describe("skillRoi", () => {
  it("rates deployment-practical as HIGH ROI at default tier cost", () => {
    const manifest = loadManifest(libraryDir);
    const metrics = computeSkillRoi("deployment-practical", manifest);
    expect(metrics.minutesSaved).toBe(20);
    expect(metrics.roiBand).toBe("HIGH");
    expect(metrics.roi).toBeGreaterThanOrEqual(20);
  });

  it("maps roi multiples to bands", () => {
    expect(roiBandFromMultiple(25)).toBe("HIGH");
    expect(roiBandFromMultiple(10)).toBe("MEDIUM");
    expect(roiBandFromMultiple(3)).toBe("LOW");
  });

  it("adjusts minutes saved by success rate when enough runs", () => {
    const manifest = loadManifest(libraryDir);
    const metrics = computeSkillRoi("deployment-practical", manifest, {
      name: "deployment-practical",
      runs: 5,
      successCount: 5,
      failureCount: 0,
      successRate: 100,
      avgDuration: null,
      lastUsed: null,
      daysSinceLastUse: null,
      totalTokens: 5000,
      rating: "active",
    });
    expect(metrics.sessionCostUsd).toBeGreaterThan(0);
    expect(metrics.confidence).toBe("estimated");
  });
});
