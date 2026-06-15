import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeTaskSkillSetOptions,
  rankAllTaskSkillProposals,
  readTaskSkillProposals,
  selectTaskSkillSetOption,
  taskSkillSetApprovalPending,
  writeTaskSkillProposals,
} from "./taskSkillProposals";
import { Manifest } from "./skillOps";

const manifest: Manifest = {
  skills: {
    "ci-pipeline-debug": {
      description: "CI pipeline failure debugging GitLab GitHub",
      detect_globs: ["**/.gitlab-ci.yml"],
    },
    "terraform-plan-review": {
      description: "Terraform plan review",
      detect_globs: ["**/*.tf"],
    },
    pdf: {
      description: "PDF files",
      detect_globs: ["**/*.pdf"],
    },
  },
};

describe("task skill set options", () => {
  it("builds distinct option sets from ranked proposals", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "task-options-"));
    fs.mkdirSync(path.join(target, ".gitlab"), { recursive: true });
    fs.writeFileSync(path.join(target, ".gitlab-ci.yml"), "stages: [test]\n", "utf-8");

    const ranked = rankAllTaskSkillProposals(target, manifest, "Fix GitLab CI and terraform plan");
    const options = computeTaskSkillSetOptions(ranked, {
      enabled: true,
      maxActiveSkills: 12,
      minProposals: 8,
      minProposalConfidence: 50,
      approveSkillSets: true,
    });

    expect(options.length).toBeGreaterThan(0);
    expect(options[0].skills.length).toBeGreaterThan(0);
  });

  it("selectTaskSkillSetOption marks approval and syncs proposals", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "task-select-"));
    writeTaskSkillProposals(target, {
      version: 1,
      generatedAt: new Date().toISOString(),
      taskSummary: "Test",
      proposals: [
        { name: "pdf", reason: "a", confidence: 80, installed: false },
        { name: "ci-pipeline-debug", reason: "b", confidence: 70, installed: true },
      ],
      options: [
        { id: "focused", label: "Focused", description: "Top picks", skills: ["pdf"] },
        { id: "broad", label: "Broad", description: "More", skills: ["pdf", "ci-pipeline-debug"] },
      ],
      approvalStatus: "pending",
    });

    expect(taskSkillSetApprovalPending(readTaskSkillProposals(target))).toBe(true);
    const updated = selectTaskSkillSetOption(target, "broad");
    expect(updated?.approvalStatus).toBe("approved");
    expect(updated?.selectedOptionId).toBe("broad");
    expect(updated?.proposals.map((p) => p.name)).toEqual(["pdf", "ci-pipeline-debug"]);
    expect(taskSkillSetApprovalPending(updated)).toBe(false);
  });
});
