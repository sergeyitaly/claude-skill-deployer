import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Manifest } from "./skillOps";
import {
  areTaskSkillProposalsFresh,
  computeTaskSkillProposals,
  ensureWorkspaceTaskProposals,
  filterProposalsByMinConfidence,
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
    "theme-factory": {
      description: "Apply or generate themes for artifacts and designs",
      detect_globs: ["**/*"],
    },
    "claude-api": {
      description: "Reference for the Claude API and Anthropic SDK models and pricing",
      detect_globs: ["**/*"],
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

  it("filterProposalsByMinConfidence drops low scores but keeps required platform skills", () => {
    const filtered = filterProposalsByMinConfidence(
      [
        { name: "drawio-diagrams", reason: "weak", confidence: 35, installed: true },
        { name: "ci-pipeline-debug", reason: "strong", confidence: 80, installed: true },
        { name: "self-learning", reason: "required", confidence: 10, installed: true },
      ],
      50
    );
    expect(filtered.map((p) => p.name)).toContain("ci-pipeline-debug");
    expect(filtered.map((p) => p.name)).toContain("self-learning");
    expect(filtered.map((p) => p.name)).not.toContain("drawio-diagrams");
  });

  it("stop-word tokens do not generate proposals for unrelated skills", () => {
    // A prompt composed entirely of stop words should not score theme-factory or claude-api
    // as high-confidence proposals — they only match via universal globs, not meaningful tokens.
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "task-proposals-stopword-"));
    const proposals = computeTaskSkillProposals(
      target,
      manifest,
      "Read and follow the profile-init skill immediately and do not wait for the user"
    );
    const themeProposal = proposals.find((p) => p.name === "theme-factory");
    const claudeApiProposal = proposals.find((p) => p.name === "claude-api");
    // Neither should score above 25 from stop-word-only matches
    expect(themeProposal?.confidence ?? 0).toBeLessThan(26);
    expect(claudeApiProposal?.confidence ?? 0).toBeLessThan(26);
    // Reason must not reference stop words as signal
    expect(themeProposal?.reason ?? "").not.toMatch(/matches "the"|mentions "and"/);
  });

  it("meaningful tokens still score correctly after stop-word filtering", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "task-proposals-meaningful-"));
    const proposals = computeTaskSkillProposals(
      target,
      manifest,
      "Debug terraform plan and fix the pipeline failure"
    );
    const tfProposal = proposals.find((p) => p.name === "terraform-plan-review");
    expect(tfProposal).toBeDefined();
    expect(tfProposal!.confidence).toBeGreaterThan(25);
    expect(tfProposal!.reason).toMatch(/terraform|pipeline/i);
  });

  it("skill used in last 7 days gets ≥25 confidence boost over unused skill", () => {
    const makeRun = (skillName: string, daysAgo: number) => ({
      ts: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
      timestamp: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
      skill: skillName,
      action: "skill_invoke",
      agent: "claude",
      tokens: 1000,
      cost: 0.01,
      rc: 0,
      success: true,
      session_id: "test-session",
      project: "test",
      branch: null,
      metadata: { source: "skill-invoke-hook-v2", invoked: true },
    });

    const withHistory = fs.mkdtempSync(path.join(os.tmpdir(), "task-proposals-hist7-"));
    fs.mkdirSync(path.join(withHistory, ".claude", "learning"), { recursive: true });
    fs.writeFileSync(
      path.join(withHistory, ".claude", "learning", "runs.jsonl"),
      JSON.stringify(makeRun("terraform-plan-review", 2)) + "\n",
      "utf-8"
    );

    const noHistory = fs.mkdtempSync(path.join(os.tmpdir(), "task-proposals-nohist-"));

    const scoreWith = computeTaskSkillProposals(withHistory, manifest, "fix plan")
      .find((p) => p.name === "terraform-plan-review")?.confidence ?? 0;
    const scoreWithout = computeTaskSkillProposals(noHistory, manifest, "fix plan")
      .find((p) => p.name === "terraform-plan-review")?.confidence ?? 0;

    expect(scoreWith - scoreWithout).toBeGreaterThanOrEqual(25);
  });

  it("skill used 35 days ago gets no recent usage boost", () => {
    const makeRun = (skillName: string, daysAgo: number) => ({
      ts: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
      timestamp: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
      skill: skillName,
      action: "skill_invoke",
      agent: "claude",
      tokens: 1000,
      cost: 0.01,
      rc: 0,
      success: true,
      session_id: "test-session",
      project: "test",
      branch: null,
      metadata: { source: "skill-invoke-hook-v2", invoked: true },
    });

    const staleHistory = fs.mkdtempSync(path.join(os.tmpdir(), "task-proposals-stale-"));
    fs.mkdirSync(path.join(staleHistory, ".claude", "learning"), { recursive: true });
    fs.writeFileSync(
      path.join(staleHistory, ".claude", "learning", "runs.jsonl"),
      JSON.stringify(makeRun("terraform-plan-review", 35)) + "\n",
      "utf-8"
    );

    const noHistory = fs.mkdtempSync(path.join(os.tmpdir(), "task-proposals-nohist2-"));

    const scoreStale = computeTaskSkillProposals(staleHistory, manifest, "fix plan")
      .find((p) => p.name === "terraform-plan-review")?.confidence ?? 0;
    const scoreNone = computeTaskSkillProposals(noHistory, manifest, "fix plan")
      .find((p) => p.name === "terraform-plan-review")?.confidence ?? 0;

    // 35-day-old run is outside the 30-day window — no boost applied
    expect(scoreStale).toBe(scoreNone);
  });

  it("catch-all-only glob (**/*) does not add score — must come from tokens or history", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "task-proposals-catchall-"));
    // theme-factory has only **/* as its detect_glob; prompt has no theme-related tokens
    const proposals = computeTaskSkillProposals(
      target,
      manifest,
      "debug terraform plan failure"
    );
    // terraform-plan-review must appear (specific glob *.tf + token match)
    expect(proposals.find((p) => p.name === "terraform-plan-review")).toBeDefined();
    // theme-factory must NOT appear — only catch-all glob, no token match, no history
    expect(proposals.find((p) => p.name === "theme-factory")).toBeUndefined();
  });
});
