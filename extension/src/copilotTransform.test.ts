import { describe, expect, it } from "vitest";
import { buildCopilotBootstrapInstructions, skillBodyWithoutFrontmatter } from "./copilotTransform";

describe("copilotTransform", () => {
  it("strips frontmatter from SKILL.md body", () => {
    const raw = "---\ndescription: test\n---\n\n# Hello\n";
    expect(skillBodyWithoutFrontmatter(raw)).toBe("# Hello");
  });

  it("builds bootstrap index with skill table", () => {
    const md = buildCopilotBootstrapInstructions([
      { name: "terraform-plan-review", detectGlobs: ["**/*.tf"], description: "Review plans" },
    ]);
    expect(md).toContain(".github/instructions/");
    expect(md).toContain("terraform-plan-review");
    expect(md).toContain("**/*.tf");
  });
});
