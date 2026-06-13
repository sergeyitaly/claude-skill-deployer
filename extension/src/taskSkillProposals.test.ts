import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Manifest } from "./skillOps";
import {
  areTaskSkillProposalsFresh,
  computeTaskSkillProposals,
  ensureWorkspaceTaskProposals,
  readTaskSkillProposals,
  writeTaskSkillProposals,
} from "./taskSkillProposals";

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
    "pdf": {
      description: "PDF files",
      detect_globs: ["**/*.pdf"],
    },
  },
};

describe("computeTaskSkillProposals", () => {
  it("matches task keywords and workspace globs", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "task-proposals-"));
    fs.mkdirSync(path.join(target, ".gitlab"), { recursive: true });
    fs.writeFileSync(path.join(target, ".gitlab-ci.yml"), "stages: [test]\n", "utf-8");

    const proposals = computeTaskSkillProposals(
      target,
      manifest,
      "Fix GitLab CI pipeline deploy stage failure"
    );

    expect(proposals.some((p) => p.name === "ci-pipeline-debug")).toBe(true);
    expect(proposals[0].confidence).toBeGreaterThan(0);
  });

  it("reads and writes proposals file", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "task-proposals-file-"));
    writeTaskSkillProposals(target, {
      version: 1,
      generatedAt: new Date().toISOString(),
      taskSummary: "Test task",
      proposals: [{ name: "pdf", reason: "User asked for PDF", confidence: 80, installed: false }],
    });

    const saved = readTaskSkillProposals(target);
    expect(saved?.taskSummary).toBe("Test task");
    expect(saved?.proposals[0].name).toBe("pdf");
  });

  it("detects fresh proposals within 24h", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "task-proposals-fresh-"));
    writeTaskSkillProposals(target, {
      version: 1,
      generatedAt: new Date().toISOString(),
      taskSummary: "Fresh",
      proposals: [{ name: "pdf", reason: "test", confidence: 80, installed: true }],
    });
    expect(areTaskSkillProposalsFresh(target)).toBe(true);
  });

  it("ensureWorkspaceTaskProposals skips refresh when fresh", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "task-proposals-ensure-"));
    writeTaskSkillProposals(target, {
      version: 1,
      generatedAt: new Date().toISOString(),
      taskSummary: "Fresh",
      proposals: [{ name: "pdf", reason: "test", confidence: 80, installed: true }],
    });
    const out = ensureWorkspaceTaskProposals(target, manifest);
    expect(out.refreshed).toBe(false);
  });
});
