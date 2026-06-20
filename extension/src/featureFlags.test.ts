import { afterEach, describe, expect, it, vi } from "vitest";
import { resetActiveProjectProfileContextForTests, setActiveProjectProfileContext } from "./activeProjectProfile";
import { isFeatureEnabled } from "./featureFlags";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: (section: string) => ({
      get: <T>(key: string, defaultValue: T): T => {
        if (section === "claudeSkills.features" && key === "autoOptimizer") {
          return false as T;
        }
        return defaultValue;
      },
    }),
  },
}));

describe("featureFlags + project profile", () => {
  afterEach(() => {
    resetActiveProjectProfileContextForTests();
  });

  it("isFeatureEnabled respects tier override when applyTier is on", () => {
    setActiveProjectProfileContext({ autoOptimizer: true }, true);
    expect(isFeatureEnabled("autoOptimizer")).toBe(true);
  });

  it("isFeatureEnabled uses VS Code settings when tier does not specify key", () => {
    setActiveProjectProfileContext({ communityBenchmarks: false }, true);
    expect(isFeatureEnabled("autoOptimizer")).toBe(false);
  });

  it("isFeatureEnabled ignores tier when applyTier is off", () => {
    setActiveProjectProfileContext({ autoOptimizer: true }, false);
    expect(isFeatureEnabled("autoOptimizer")).toBe(false);
  });
});
