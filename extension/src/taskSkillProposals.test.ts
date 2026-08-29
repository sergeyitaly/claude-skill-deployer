import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Manifest } from "./skillOps";
import { appendAdoptionEvents } from "./skillAdoption";
import {
  areTaskSkillProposalsFresh,
  computeAffinityAdoptionWeight,
  computeTaskSkillProposals,
  ensureWorkspaceTaskProposals,
  filterProposalsByMinConfidence,
  formatPromptTimeSkillRecommendation,
  formatSessionStartSkillRecommendations,
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

  it("generic near-universal filename globs score no higher than bare extension globs", () => {
    // Reproduces a live false-positive from a real workspace: vscode-extension-publishing /
    // cursor-kiro-extension-publishing matched **/package.json + **/CHANGELOG.md alone and
    // reached 83-87% confidence in a pure Kubernetes/Terraform repo with no VS Code extension
    // anywhere in it, because those globs scored the same "specific" 20pts as a targeted path
    // glob like **/.vscodeignore. package.json/README.md/CHANGELOG.md/etc. appear in nearly
    // every repo regardless of stack and must not be treated as a strong relevance signal.
    const genericGlobManifest: Manifest = {
      skills: {
        "generic-file-skill": {
          description: "Some unrelated tool",
          detect_globs: ["**/package.json", "**/CHANGELOG.md"],
        },
        "extension-glob-skill": {
          description: "Some other unrelated tool",
          detect_globs: ["**/*.pdf"],
        },
        "specific-path-skill": {
          description: "Yet another unrelated tool",
          detect_globs: ["**/.vscodeignore"],
        },
      },
    };
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "task-proposals-generic-glob-"));
    fs.writeFileSync(path.join(target, "package.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(target, "CHANGELOG.md"), "# Changelog\n", "utf-8");
    fs.writeFileSync(path.join(target, "sample.pdf"), "", "utf-8");
    fs.writeFileSync(path.join(target, ".vscodeignore"), "out/**\n", "utf-8");

    const proposals = computeTaskSkillProposals(target, genericGlobManifest, "Unrelated neutral task");
    const generic = proposals.find((p) => p.name === "generic-file-skill");
    const extGlob = proposals.find((p) => p.name === "extension-glob-skill");
    const specific = proposals.find((p) => p.name === "specific-path-skill");

    expect(generic?.confidence ?? 0).toBe(extGlob?.confidence ?? 0);
    expect(generic?.confidence ?? 0).toBeLessThan(specific?.confidence ?? 100);
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

    // "terraform" alone scores ≥70 via name+description+keyword-hint tokens, which
    // clears the minProposalConfidence=70 threshold even without history.
    // With 7-day history the score rises by +25, giving a measurable diff.
    const scoreWith = computeTaskSkillProposals(withHistory, manifest, "terraform")
      .find((p) => p.name === "terraform-plan-review")?.confidence ?? 0;
    const scoreWithout = computeTaskSkillProposals(noHistory, manifest, "terraform")
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

  it("confidenceBreakdown reports a workspaceAffinity boost for a workspace-proven skill", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "task-proposals-breakdown-"));
    const events = Array.from({ length: 20 }, (_, i) => ({
      taskId: `s${i}`, skill: "terraform-plan-review", event: "invoked" as const, source: "manual" as const,
    }));
    appendAdoptionEvents(target, [...events, ...events.map((e) => ({ ...e, event: "successful" as const }))]);

    const proposals = computeTaskSkillProposals(target, manifest, "debug terraform plan failure");
    const proposal = proposals.find((p) => p.name === "terraform-plan-review");

    expect(proposal?.confidenceBreakdown).toBeDefined();
    expect(proposal!.confidenceBreakdown!.workspaceAffinity).toBeGreaterThan(0);
    expect([10, 15, 25]).toContain(proposal!.confidenceBreakdown!.workspaceAffinity);
    expect(proposal!.confidenceBreakdown!.semanticMatch).toBeGreaterThan(0);
  });

  it("a workspace-proven skill scores higher than the same skill with no workspace history", () => {
    const withAffinity = fs.mkdtempSync(path.join(os.tmpdir(), "task-proposals-affinity-with-"));
    const events = Array.from({ length: 20 }, (_, i) => ({
      taskId: `s${i}`, skill: "terraform-plan-review", event: "invoked" as const, source: "manual" as const,
    }));
    appendAdoptionEvents(withAffinity, [...events, ...events.map((e) => ({ ...e, event: "successful" as const }))]);

    const withoutAffinity = fs.mkdtempSync(path.join(os.tmpdir(), "task-proposals-affinity-without-"));

    const scoreWith = computeTaskSkillProposals(withAffinity, manifest, "debug terraform plan failure")
      .find((p) => p.name === "terraform-plan-review")?.confidence ?? 0;
    const scoreWithout = computeTaskSkillProposals(withoutAffinity, manifest, "debug terraform plan failure")
      .find((p) => p.name === "terraform-plan-review")?.confidence ?? 0;

    expect(scoreWith).toBeGreaterThan(scoreWithout);
  });
});

describe("formatSessionStartSkillRecommendations", () => {
  it("returns empty string when no proposals file exists", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "task-proposals-recs-empty-"));
    expect(formatSessionStartSkillRecommendations(target)).toBe("");
  });

  it("returns empty string when all proposals are below the confidence threshold", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "task-proposals-recs-low-"));
    writeTaskSkillProposals(target, {
      version: 1,
      generatedAt: new Date().toISOString(),
      taskSummary: "Test",
      proposals: [
        { name: "drawio-diagrams", reason: "weak match", confidence: 40, installed: true },
      ],
    });
    expect(formatSessionStartSkillRecommendations(target)).toBe("");
  });

  it("renders a numbered top-3 recommendation block, capped even with more eligible entries", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "task-proposals-recs-top3-"));
    writeTaskSkillProposals(target, {
      version: 1,
      generatedAt: new Date().toISOString(),
      taskSummary: "Test",
      proposals: [
        {
          name: "vitest-extension-testing",
          reason: "vitest.config.ts detected",
          whyText: "vitest.config.ts detected, used successfully 21 times",
          confidence: 88,
          installed: true,
        },
        { name: "skill-creator", reason: "skill authoring", confidence: 80, installed: true },
        { name: "github-actions-ci", reason: "CI work detected", confidence: 75, installed: false },
        { name: "self-learning", reason: "meta", confidence: 72, installed: true },
        { name: "drawio-diagrams", reason: "weak match", confidence: 40, installed: true },
      ],
    });

    const text = formatSessionStartSkillRecommendations(target);
    expect(text).toContain("Recommended skills for this workspace:");
    expect(text).toContain("1. vitest-extension-testing (88%)");
    expect(text).toContain("Reason: vitest.config.ts detected, used successfully 21 times");
    expect(text).toContain("Invoke:\n   /vitest-extension-testing");
    // capped at 3 even though 4 entries (88/80/75/72) clear the 70 default threshold
    expect((text.match(/^\d+\./gm) ?? []).length).toBe(3);
    expect(text).not.toContain("drawio-diagrams");
  });
});

describe("formatPromptTimeSkillRecommendation", () => {
  it("returns null when no proposals file exists", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "task-proposals-prompt-empty-"));
    expect(formatPromptTimeSkillRecommendation(target, new Set())).toBeNull();
  });

  it("returns the highest-confidence eligible entry not in excludeNames", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "task-proposals-prompt-top-"));
    writeTaskSkillProposals(target, {
      version: 1,
      generatedAt: new Date().toISOString(),
      taskSummary: "Test",
      proposals: [
        { name: "vitest-extension-testing", reason: "vitest.config.ts detected", confidence: 88, installed: true },
        { name: "skill-creator", reason: "skill authoring", confidence: 80, installed: true },
      ],
    });

    const first = formatPromptTimeSkillRecommendation(target, new Set());
    expect(first?.skillName).toBe("vitest-extension-testing");
    expect(first?.text).toContain("[Skill Recommendation] vitest-extension-testing (88%)");
    expect(first?.text).toContain("Invoke: /vitest-extension-testing");

    const second = formatPromptTimeSkillRecommendation(target, new Set(["vitest-extension-testing"]));
    expect(second?.skillName).toBe("skill-creator");
  });

  it("returns null once all eligible proposals are excluded", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "task-proposals-prompt-exhausted-"));
    writeTaskSkillProposals(target, {
      version: 1,
      generatedAt: new Date().toISOString(),
      taskSummary: "Test",
      proposals: [
        { name: "vitest-extension-testing", reason: "vitest.config.ts detected", confidence: 88, installed: true },
      ],
    });
    expect(
      formatPromptTimeSkillRecommendation(target, new Set(["vitest-extension-testing"]))
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeAffinityAdoptionWeight — recency window + floor, not permanent hard zero
// ---------------------------------------------------------------------------

describe("computeAffinityAdoptionWeight", () => {
  function writeProposalOutcomes(
    target: string,
    records: Array<{ proposed: string[]; invoked: string[]; ts: string }>
  ): void {
    const file = path.join(target, ".claude", "learning", "proposalOutcome.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lines = records.map((r, i) =>
      JSON.stringify({
        ts: r.ts,
        session_id: `sess-${i}`,
        event: "session_end",
        proposed: r.proposed,
        invoked: r.invoked,
        not_invoked: r.proposed.filter((s) => !r.invoked.includes(s)),
        acceptance_rate: r.proposed.length > 0 ? r.invoked.length / r.proposed.length : 0,
        skills_proposed_count: r.proposed.length,
        skills_invoked_count: r.invoked.length,
      })
    );
    fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");
  }

  const isoDaysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

  it("regression: a floor (0.3), not a permanent hard zero, once a skill is proposed >=5 times with 0% recent acceptance", () => {
    // Live-reported bug: this returned 0.0, contradicting its own docstring ("0.3 (hard
    // floor, not 0 — affinity still valid signal)") and eliminating repositoryAffinity
    // entirely rather than discounting it.
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "affinity-weight-"));
    writeProposalOutcomes(
      target,
      Array.from({ length: 5 }, (_, i) => ({
        proposed: ["never-picked"],
        invoked: [],
        ts: isoDaysAgo(i),
      }))
    );

    expect(computeAffinityAdoptionWeight(target, "never-picked")).toBe(0.3);
  });

  it("regression: old (pre-window) rejection history does not permanently zero a skill's affinity forever", () => {
    // Reproduces the reported self-reinforcing pattern: a skill rejected 5+ times entirely
    // outside the 30-day window must not still register as "≥5 proposals, 0% acceptance" —
    // recentProposalStats() should see it as having no recent history at all.
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "affinity-weight-old-"));
    writeProposalOutcomes(
      target,
      Array.from({ length: 6 }, (_, i) => ({
        proposed: ["ancient-history-skill"],
        invoked: [],
        ts: isoDaysAgo(60 + i),
      }))
    );

    expect(computeAffinityAdoptionWeight(target, "ancient-history-skill")).toBe(1.0);
  });

  it("returns 1.0 for a skill with too little history to judge (proposedCount < 3)", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "affinity-weight-sparse-"));
    writeProposalOutcomes(target, [{ proposed: ["rare-skill"], invoked: [], ts: isoDaysAgo(1) }]);

    expect(computeAffinityAdoptionWeight(target, "rare-skill")).toBe(1.0);
  });
});
