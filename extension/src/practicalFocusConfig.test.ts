import { describe, expect, it } from "vitest";
import { PRACTICAL_FOCUS_LEVELS, nextPracticalFocusLevel } from "./practicalFocusConfig";

describe("practicalFocusConfig", () => {
  it("cycles through practical focus levels", () => {
    expect(nextPracticalFocusLevel("exploratory")).toBe("balanced");
    expect(nextPracticalFocusLevel("deploy-ready")).toBe("exploratory");
  });

  it("defines four ordered levels ending in deploy-ready", () => {
    expect(PRACTICAL_FOCUS_LEVELS).toEqual([
      "exploratory",
      "balanced",
      "architecture-first",
      "deploy-ready",
    ]);
  });
});
