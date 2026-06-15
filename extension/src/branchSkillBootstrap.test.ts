import { describe, expect, it } from "vitest";
import { inferBranchSkillFlavor } from "./branchSkillBootstrap";

describe("inferBranchSkillFlavor", () => {
  it("detects infra branches", () => {
    expect(inferBranchSkillFlavor("feature/infra/terraform")).toBe("infra");
    expect(inferBranchSkillFlavor("devops/pipeline-fix")).toBe("infra");
    expect(inferBranchSkillFlavor("release/deploy")).toBe("infra");
  });

  it("detects app branches", () => {
    expect(inferBranchSkillFlavor("feature/frontend-dashboard")).toBe("app");
    expect(inferBranchSkillFlavor("api/auth")).toBe("app");
    expect(inferBranchSkillFlavor("web/checkout")).toBe("app");
  });

  it("falls back to general", () => {
    expect(inferBranchSkillFlavor("main")).toBe("general");
    expect(inferBranchSkillFlavor("hotfix/login")).toBe("general");
  });
});
