import { afterEach, describe, expect, it, vi } from "vitest";
import { resetActiveProjectProfileContextForTests, setActiveProjectProfileContext } from "./activeProjectProfile";
import { isFeatureEnabled } from "./featureFlags";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: (section: string) => ({
      get: <T>(key: string, defaultValue: T): T => {
        if (section === "claudeSkills.features" && key === "multiAgent") {
          return true as T;
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
    setActiveProjectProfileContext({ multiAgent: false }, true);
    expect(isFeatureEnabled("multiAgent")).toBe(false);
  });

  it("isFeatureEnabled uses VS Code settings when tier does not specify key", () => {
    setActiveProjectProfileContext({ attributionCollector: false }, true);
    expect(isFeatureEnabled("multiAgent")).toBe(true);
  });

  it("isFeatureEnabled ignores tier when applyTier is off", () => {
    setActiveProjectProfileContext({ multiAgent: false }, false);
    expect(isFeatureEnabled("multiAgent")).toBe(true);
  });
});
