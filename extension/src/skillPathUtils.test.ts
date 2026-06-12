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

  it("extracts cursor built-in skills-cursor paths", () => {
    expect(skillNameFromFilePath("C:\\Users\\me\\.cursor\\skills-cursor\\create-skill\\SKILL.md")).toBe("create-skill");
  });

  it("extracts skills_library paths", () => {
    expect(skillNameFromFilePath("C:\\repo\\skills_library\\self-learning\\SKILL.md")).toBe("self-learning");
  });

  it("extracts .agents/skills paths", () => {
    expect(skillNameFromFilePath("/home/me/.agents/skills/azure-cost/SKILL.md")).toBe("azure-cost");
  });

  it("denylists bogus names", () => {
    expect(skillNameFromFilePath("/proj/.claude/skills/api/SKILL.md")).toBeNull();
    expect(isPlausibleSkillName("api")).toBe(false);
  });
});
