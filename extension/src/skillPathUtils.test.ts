import { describe, expect, it } from "vitest";
import { isPlausibleSkillName, skillNameFromFilePath } from "./skillPathUtils";

describe("skillNameFromFilePath", () => {
  it("extracts claude skill paths", () => {
    expect(skillNameFromFilePath("/proj/.claude/skills/ci-pipeline-debug/SKILL.md")).toBe("ci-pipeline-debug");
  });

  it("extracts cursor skill paths", () => {
    expect(skillNameFromFilePath("C:\\proj\\.cursor\\skills\\adx-schema-check\\SKILL.md")).toBe("adx-schema-check");
  });

  it("extracts kiro skill paths", () => {
    expect(skillNameFromFilePath("/proj/.kiro/skills/terraform-plan-review/SKILL.md")).toBe("terraform-plan-review");
  });

  it("extracts copilot instruction paths", () => {
    expect(skillNameFromFilePath("/proj/.github/instructions/self-learning.instructions.md")).toBe("self-learning");
  });

  it("denylists bogus names", () => {
    expect(skillNameFromFilePath("/proj/.claude/skills/api/SKILL.md")).toBeNull();
    expect(isPlausibleSkillName("api")).toBe(false);
  });
});
