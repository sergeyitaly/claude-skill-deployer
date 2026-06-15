import { describe, expect, it } from "vitest";
import { capActiveSkills } from "./taskFocusConfig";

describe("capActiveSkills", () => {
  it("keeps required skills first and caps optional candidates", () => {
    const candidates = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
    const confidence = new Map([
      ["alpha", 90],
      ["beta", 80],
      ["gamma", 70],
      ["delta", 60],
      ["epsilon", 50],
      ["zeta", 40],
    ]);
    const { active, dropped, capped } = capActiveSkills(candidates, {
      maxActiveSkills: 4,
      requiredSkills: ["self-learning", "gamma"],
      confidenceBySkill: confidence,
    });
    expect(active).toEqual(["self-learning", "gamma", "alpha", "beta"]);
    expect(dropped).toContain("delta");
    expect(capped).toBe(true);
  });

  it("does not drop when under cap", () => {
    const { active, capped } = capActiveSkills(["a", "b"], {
      maxActiveSkills: 12,
      requiredSkills: ["a"],
    });
    expect(active).toEqual(["a", "b"]);
    expect(capped).toBe(false);
  });
});
