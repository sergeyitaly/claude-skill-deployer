/**
 * Unit tests for Skill Enrichment Intelligence (skillEnrichment.ts + skillEnrichmentProposal.ts)
 *
 * Covers:
 *   Phase 1  — detectSuccessfulRuns
 *   Phase 2  — detectPattern, mineSuccessfulRunPatterns, readSkillLearningEntries
 *   Phase 3  — computeProvenExamples
 *   Phase 4  — buildSkillProfile, refreshSkillProfiles
 *   Phase 5  — findEnrichmentCandidates
 *   Phase 6  — generateEnrichmentProposals, approve/reject/apply
 *   Phase 7  — computeQualityScore
 *   Phase 8  — getSkillEvolution
 *   Phase 9  — DEVOPS_PATTERNS keyword coverage
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, beforeEach } from "vitest";

import {
  detectSuccessfulRuns,
  detectPattern,
  mineSuccessfulRunPatterns,
  readSkillLearningEntries,
  computeProvenExamples,
  buildSkillProfile,
  refreshSkillProfiles,
  findEnrichmentCandidates,
  computeQualityScore,
  getSkillEvolution,
  DEVOPS_PATTERNS,
  MIN_PATTERN_OCCURRENCES,
  writeSkillProfileIndex,
} from "./skillEnrichment";

import {
  generateEnrichmentProposals,
  approveEnrichmentProposal,
  rejectEnrichmentProposal,
  applyEnrichmentProposal,
  readEnrichmentProposals,
  enrichmentProposalsPath,
  getApprovedUnappliedSummary,
  formatApprovedEnrichmentReminderText,
  formatEnrichmentSummaryHtml,
} from "./skillEnrichmentProposal";

import { appendSkillRun } from "./runsStore";

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "enrich-test-"));
}

function seedRun(
  target: string,
  skill: string,
  opts: {
    success?: boolean;
    tokens?: number;
    cost?: number;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  } = {}
): void {
  appendSkillRun(target, {
    skill,
    agent: "claude",
    tokens: opts.tokens ?? 5000,
    cost: opts.cost ?? 0.05,
    success: opts.success ?? true,
    session_id: opts.sessionId ?? `session-${Date.now()}-${Math.random()}`,
    metadata: { source: "skill-invoke-hook-v2", invoked: true, ...(opts.metadata ?? {}) },
  });
}

function seedSkillMd(dir: string, skillName: string): string {
  const skillDir = path.join(dir, skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `# ${skillName}\n## Description\nTest skill.\n`);
  return path.join(skillDir, "SKILL.md");
}

// ── Phase 1: detectSuccessfulRuns ─────────────────────────────────────────────

describe("Phase 1 — detectSuccessfulRuns", () => {
  it("returns empty array when no runs exist", () => {
    const target = tmpDir();
    expect(detectSuccessfulRuns(target)).toEqual([]);
  });

  it("detects run with success=true and tokens>0", () => {
    const target = tmpDir();
    seedRun(target, "deployment-practical", { success: true, tokens: 10000, cost: 0.01 });
    const events = detectSuccessfulRuns(target);
    expect(events).toHaveLength(1);
    expect(events[0].skill).toBe("deployment-practical");
    expect(events[0].success).toBe(true);
    expect(events[0].tokens).toBe(10000);
  });

  it("detects run with success=true and cost>0 (tokens=0)", () => {
    const target = tmpDir();
    seedRun(target, "ci-pipeline-debug", { success: true, tokens: 0, cost: 0.02 });
    const events = detectSuccessfulRuns(target);
    expect(events).toHaveLength(1);
    expect(events[0].skill).toBe("ci-pipeline-debug");
  });

  it("excludes failed runs", () => {
    const target = tmpDir();
    seedRun(target, "deployment-practical", { success: false, tokens: 5000, cost: 0.05 });
    expect(detectSuccessfulRuns(target)).toHaveLength(0);
  });

  it("excludes zero-cost zero-token successful run without outcome=success", () => {
    const target = tmpDir();
    seedRun(target, "self-learning", { success: true, tokens: 0, cost: 0 });
    expect(detectSuccessfulRuns(target)).toHaveLength(0);
  });

  it("includes run with metadata.outcome=success even if cost/tokens=0", () => {
    const target = tmpDir();
    seedRun(target, "self-learning", {
      success: true, tokens: 0, cost: 0,
      metadata: { outcome: "success", source: "skill-invoke-hook-v2", invoked: true },
    });
    const events = detectSuccessfulRuns(target);
    expect(events).toHaveLength(1);
  });

  it("emits correct SkillSuccessEvent fields", () => {
    const target = tmpDir();
    const sid = "test-session-abc";
    seedRun(target, "github-actions-ci", { success: true, tokens: 8000, cost: 0.08, sessionId: sid });
    const events = detectSuccessfulRuns(target);
    expect(events[0].sessionId).toBe(sid);
    expect(events[0].agent).toBe("claude");
    expect(typeof events[0].timestamp).toBe("string");
  });
});

// ── Phase 2: detectPattern ────────────────────────────────────────────────────

describe("Phase 2 — detectPattern", () => {
  it("matches argocd-sync-failure when skill has argocd affinity and keyword present", () => {
    const matches = detectPattern("deployment-practical", { task_type: "argocd sync failed" });
    const hit = matches.find(m => m.patternId === "argocd-sync-failure");
    expect(hit).toBeDefined();
    expect(hit!.confidence).toBeGreaterThan(0.3);
  });

  it("matches k3s-cluster-setup from skill name keyword", () => {
    const matches = detectPattern("deployment-practical", { hint: "k3s install" });
    const hit = matches.find(m => m.patternId === "k3s-cluster-setup");
    expect(hit).toBeDefined();
  });

  it("matches helm-deployment from affinity alone", () => {
    // deployment-practical has helm affinity
    const matches = detectPattern("deployment-practical", {});
    const hit = matches.find(m => m.patternId === "helm-deployment");
    // affinity-only gives confidence ~0.30 which is above 0.15 threshold
    expect(hit).toBeDefined();
    expect(hit!.confidence).toBeGreaterThanOrEqual(0.15);
  });

  it("returns empty array when no pattern matches", () => {
    const matches = detectPattern("pdf", { task_type: "convert document" });
    expect(matches).toHaveLength(0);
  });

  it("sorts matches by descending confidence", () => {
    const matches = detectPattern("deployment-practical", {
      task_type: "argocd sync failed argocd application argocd",
    });
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1].confidence).toBeGreaterThanOrEqual(matches[i].confidence);
    }
  });

  it("matches github-actions-failure for ci-pipeline-debug skill", () => {
    const matches = detectPattern("ci-pipeline-debug", { task_type: "github actions pipeline failed" });
    const hit = matches.find(m => m.patternId === "github-actions-failure");
    expect(hit).toBeDefined();
  });

  it("matches terraform-state-lock from metadata keywords", () => {
    const matches = detectPattern("deployment-practical", {
      hint: "terraform state locked backend",
    });
    const hit = matches.find(m => m.patternId === "terraform-state-lock");
    expect(hit).toBeDefined();
  });

  it("confidence is capped at 0.99", () => {
    const matches = detectPattern("deployment-practical", {
      task_type: "argocd sync failed argocd argo application out-of-sync",
    });
    for (const m of matches) {
      expect(m.confidence).toBeLessThanOrEqual(0.99);
    }
  });
});

// ── Phase 2: mineSuccessfulRunPatterns ───────────────────────────────────────

describe("Phase 2 — mineSuccessfulRunPatterns", () => {
  it("writes 0 entries when no successful runs exist", () => {
    const target = tmpDir();
    expect(mineSuccessfulRunPatterns(target)).toBe(0);
    expect(readSkillLearningEntries(target)).toHaveLength(0);
  });

  it("mines pattern entries from a successful run with matching metadata", () => {
    const target = tmpDir();
    seedRun(target, "deployment-practical", {
      success: true, tokens: 8000, cost: 0.08,
      metadata: {
        source: "skill-invoke-hook-v2", invoked: true,
        task_type: "argocd sync application failed",
      },
    });
    const count = mineSuccessfulRunPatterns(target);
    expect(count).toBeGreaterThan(0);
    const entries = readSkillLearningEntries(target);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some(e => e.skill === "deployment-practical")).toBe(true);
  });

  it("does not duplicate entries on repeated calls", () => {
    const target = tmpDir();
    seedRun(target, "deployment-practical", {
      success: true, tokens: 5000, cost: 0.05,
      sessionId: "session-dedupe",
      metadata: { source: "skill-invoke-hook-v2", invoked: true, task_type: "argocd sync" },
    });
    const first  = mineSuccessfulRunPatterns(target);
    const second = mineSuccessfulRunPatterns(target);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBe(0); // idempotent
  });

  it("mines no entries from failed runs", () => {
    const target = tmpDir();
    seedRun(target, "deployment-practical", { success: false, tokens: 5000, cost: 0.05 });
    expect(mineSuccessfulRunPatterns(target)).toBe(0);
  });

  it("persists entries to skill-learning.jsonl", () => {
    const target = tmpDir();
    seedRun(target, "ci-pipeline-debug", {
      success: true, tokens: 6000, cost: 0.06,
      metadata: { source: "skill-invoke-hook-v2", invoked: true, task_type: "github actions pipeline" },
    });
    mineSuccessfulRunPatterns(target);
    const file = path.join(target, ".claude", "learning", "skill-learning.jsonl");
    expect(fs.existsSync(file)).toBe(true);
    const lines = fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const entry = JSON.parse(lines[0]);
    expect(entry.skill).toBe("ci-pipeline-debug");
    expect(entry.sessionId).toBeDefined();
  });
});

// ── Phase 3: computeProvenExamples ───────────────────────────────────────────

describe("Phase 3 — computeProvenExamples", () => {
  it("returns empty array when no learning entries", () => {
    const target = tmpDir();
    expect(computeProvenExamples(target, "deployment-practical")).toHaveLength(0);
  });

  it("aggregates pattern occurrences across multiple sessions", () => {
    const target = tmpDir();
    for (let i = 0; i < 4; i++) {
      seedRun(target, "deployment-practical", {
        success: true, tokens: 5000, cost: 0.05,
        sessionId: `sess-argocd-${i}`,
        metadata: { source: "skill-invoke-hook-v2", invoked: true, task_type: "argocd sync failed" },
      });
    }
    mineSuccessfulRunPatterns(target);
    const examples = computeProvenExamples(target, "deployment-practical");
    const argocd = examples.find(e => e.pattern === "argocd-sync-failure");
    expect(argocd).toBeDefined();
    expect(argocd!.occurrences).toBe(4);
  });

  it("computes successRate correctly (all successful)", () => {
    const target = tmpDir();
    for (let i = 0; i < 3; i++) {
      seedRun(target, "deployment-practical", {
        success: true, tokens: 5000, cost: 0.05,
        sessionId: `sess-helm-${i}`,
        metadata: { source: "skill-invoke-hook-v2", invoked: true, task_type: "helm chart deployment" },
      });
    }
    mineSuccessfulRunPatterns(target);
    const examples = computeProvenExamples(target, "deployment-practical");
    const helm = examples.find(e => e.pattern === "helm-deployment");
    expect(helm).toBeDefined();
    expect(helm!.successRate).toBeCloseTo(1.0, 2);
  });

  it("sorts by occurrences descending", () => {
    const target = tmpDir();
    // 4 argocd sessions
    for (let i = 0; i < 4; i++) {
      seedRun(target, "deployment-practical", {
        success: true, tokens: 5000, cost: 0.05,
        sessionId: `sess-argo-${i}`,
        metadata: { source: "skill-invoke-hook-v2", invoked: true, task_type: "argocd sync failed" },
      });
    }
    // 2 helm sessions
    for (let i = 0; i < 2; i++) {
      seedRun(target, "deployment-practical", {
        success: true, tokens: 5000, cost: 0.05,
        sessionId: `sess-helm2-${i}`,
        metadata: { source: "skill-invoke-hook-v2", invoked: true, task_type: "helm upgrade" },
      });
    }
    mineSuccessfulRunPatterns(target);
    const examples = computeProvenExamples(target, "deployment-practical");
    expect(examples[0].occurrences).toBeGreaterThanOrEqual(examples[1]?.occurrences ?? 0);
  });
});

// ── Phase 4: buildSkillProfile ────────────────────────────────────────────────

describe("Phase 4 — buildSkillProfile", () => {
  it("returns zero-invocation profile when no runs", () => {
    const target = tmpDir();
    const p = buildSkillProfile(target, "deployment-practical");
    expect(p.invocations).toBe(0);
    expect(p.successRate).toBe(0);
    expect(p.qualityScore).toBeGreaterThanOrEqual(0);
  });

  it("reflects correct invocation count and success rate", () => {
    const target = tmpDir();
    seedRun(target, "deployment-practical", { success: true, tokens: 5000, cost: 0.05 });
    seedRun(target, "deployment-practical", { success: true, tokens: 4000, cost: 0.04 });
    seedRun(target, "deployment-practical", { success: false, tokens: 3000, cost: 0.03 });
    const p = buildSkillProfile(target, "deployment-practical");
    expect(p.invocations).toBe(3);
    expect(p.successes).toBe(2);
    expect(p.successRate).toBeCloseTo(2 / 3, 4);
  });

  it("computes qualityDelta against previous profile", () => {
    const target = tmpDir();
    const prev = buildSkillProfile(target, "deployment-practical");
    seedRun(target, "deployment-practical", { success: true, tokens: 5000, cost: 0.05 });
    const curr = buildSkillProfile(target, "deployment-practical", prev);
    expect(curr.qualityDelta).not.toBe(undefined);
    expect(typeof curr.qualityDelta).toBe("number");
  });

  it("refreshSkillProfiles writes skill-profile.json", () => {
    const target = tmpDir();
    seedRun(target, "deployment-practical", { success: true, tokens: 5000, cost: 0.05 });
    const index = refreshSkillProfiles(target, ["deployment-practical"]);
    const profileFile = path.join(target, ".claude", "learning", "skill-profile.json");
    expect(fs.existsSync(profileFile)).toBe(true);
    expect(index.profiles["deployment-practical"]).toBeDefined();
  });

  it("avgTokens and avgCostUsd are computed", () => {
    const target = tmpDir();
    seedRun(target, "ci-pipeline-debug", { success: true, tokens: 6000, cost: 0.06 });
    seedRun(target, "ci-pipeline-debug", { success: true, tokens: 4000, cost: 0.04 });
    const p = buildSkillProfile(target, "ci-pipeline-debug");
    expect(p.avgTokens).toBe(5000);
    expect(p.avgCostUsd).toBeCloseTo(0.05, 4);
  });
});

// ── Phase 5: findEnrichmentCandidates ────────────────────────────────────────

describe("Phase 5 — findEnrichmentCandidates", () => {
  it("returns no candidates when pattern count < MIN_PATTERN_OCCURRENCES", () => {
    const target = tmpDir();
    for (let i = 0; i < MIN_PATTERN_OCCURRENCES - 1; i++) {
      seedRun(target, "deployment-practical", {
        success: true, tokens: 5000, cost: 0.05,
        sessionId: `sess-below-${i}`,
        metadata: { source: "skill-invoke-hook-v2", invoked: true, task_type: "argocd sync" },
      });
    }
    mineSuccessfulRunPatterns(target);
    const cands = findEnrichmentCandidates(target, ["deployment-practical"]);
    expect(cands).toHaveLength(0);
  });

  it("returns a candidate when pattern count >= MIN_PATTERN_OCCURRENCES", () => {
    const target = tmpDir();
    for (let i = 0; i < MIN_PATTERN_OCCURRENCES; i++) {
      seedRun(target, "deployment-practical", {
        success: true, tokens: 5000, cost: 0.05,
        sessionId: `sess-above-${i}`,
        metadata: { source: "skill-invoke-hook-v2", invoked: true, task_type: "argocd sync failed" },
      });
    }
    mineSuccessfulRunPatterns(target);
    const cands = findEnrichmentCandidates(target, ["deployment-practical"]);
    expect(cands.some(c => c.patternId === "argocd-sync-failure")).toBe(true);
  });

  it("candidate includes proposedContent and sectionTitle from pattern library", () => {
    const target = tmpDir();
    for (let i = 0; i < MIN_PATTERN_OCCURRENCES; i++) {
      seedRun(target, "deployment-practical", {
        success: true, tokens: 5000, cost: 0.05,
        sessionId: `sess-content-${i}`,
        metadata: { source: "skill-invoke-hook-v2", invoked: true, task_type: "argocd sync failed" },
      });
    }
    mineSuccessfulRunPatterns(target);
    const cands = findEnrichmentCandidates(target, ["deployment-practical"]);
    const c = cands.find(c => c.patternId === "argocd-sync-failure");
    expect(c).toBeDefined();
    expect(c!.sectionTitle).toBe("ArgoCD Troubleshooting");
    expect(c!.proposedContent).toContain("argocd app sync");
    expect(c!.affectedFiles).toContain("argocd/*");
  });

  it("confidence is between 0.50 and 0.99 for qualifying candidates", () => {
    const target = tmpDir();
    for (let i = 0; i < 5; i++) {
      seedRun(target, "deployment-practical", {
        success: true, tokens: 5000, cost: 0.05,
        sessionId: `sess-conf-${i}`,
        metadata: { source: "skill-invoke-hook-v2", invoked: true, task_type: "argocd sync" },
      });
    }
    mineSuccessfulRunPatterns(target);
    const cands = findEnrichmentCandidates(target, ["deployment-practical"]);
    for (const c of cands) {
      expect(c.confidence).toBeGreaterThanOrEqual(0.50);
      expect(c.confidence).toBeLessThanOrEqual(0.99);
    }
  });

  it("sorts candidates by occurrences descending", () => {
    const target = tmpDir();
    // More argocd (5) than helm (3)
    for (let i = 0; i < 5; i++) {
      seedRun(target, "deployment-practical", {
        success: true, tokens: 5000, cost: 0.05,
        sessionId: `sess-sort-argo-${i}`,
        metadata: { source: "skill-invoke-hook-v2", invoked: true, task_type: "argocd sync failed" },
      });
    }
    for (let i = 0; i < 3; i++) {
      seedRun(target, "deployment-practical", {
        success: true, tokens: 5000, cost: 0.05,
        sessionId: `sess-sort-helm-${i}`,
        metadata: { source: "skill-invoke-hook-v2", invoked: true, task_type: "helm chart upgrade" },
      });
    }
    mineSuccessfulRunPatterns(target);
    const cands = findEnrichmentCandidates(target, ["deployment-practical"]);
    for (let i = 1; i < cands.length; i++) {
      expect(cands[i - 1].occurrences).toBeGreaterThanOrEqual(cands[i].occurrences);
    }
  });
});

// ── Phase 6: generateEnrichmentProposals / approve / reject / apply ───────────

describe("Phase 6 — enrichment proposal lifecycle", () => {
  function seedCandidate(target: string): void {
    for (let i = 0; i < MIN_PATTERN_OCCURRENCES; i++) {
      seedRun(target, "deployment-practical", {
        success: true, tokens: 5000, cost: 0.05,
        sessionId: `sess-lc-${i}-${Date.now()}`,
        metadata: { source: "skill-invoke-hook-v2", invoked: true, task_type: "argocd sync failed" },
      });
    }
    mineSuccessfulRunPatterns(target);
  }

  it("generateEnrichmentProposals creates a pending proposal", () => {
    const target = tmpDir();
    seedCandidate(target);
    const cands = findEnrichmentCandidates(target, ["deployment-practical"]);
    const count = generateEnrichmentProposals(target, cands);
    expect(count).toBeGreaterThan(0);
    const proposals = readEnrichmentProposals(target);
    expect(proposals.some(p => p.status === "pending")).toBe(true);
  });

  it("generateEnrichmentProposals is idempotent (no duplicates on second call)", () => {
    const target = tmpDir();
    seedCandidate(target);
    const cands = findEnrichmentCandidates(target, ["deployment-practical"]);
    const first  = generateEnrichmentProposals(target, cands);
    const second = generateEnrichmentProposals(target, cands);
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
  });

  it("approveEnrichmentProposal marks status as approved", () => {
    const target = tmpDir();
    seedCandidate(target);
    const cands = findEnrichmentCandidates(target, ["deployment-practical"]);
    generateEnrichmentProposals(target, cands);

    const pending = readEnrichmentProposals(target).find(p => p.status === "pending")!;
    const approved = approveEnrichmentProposal(target, pending.id);
    expect(approved).toBeDefined();
    expect(approved!.status).toBe("approved");

    const reloaded = readEnrichmentProposals(target).find(p => p.id === pending.id)!;
    expect(reloaded.status).toBe("approved");
  });

  it("rejectEnrichmentProposal marks status as rejected", () => {
    const target = tmpDir();
    seedCandidate(target);
    const cands = findEnrichmentCandidates(target, ["deployment-practical"]);
    generateEnrichmentProposals(target, cands);

    const pending = readEnrichmentProposals(target).find(p => p.status === "pending")!;
    const ok = rejectEnrichmentProposal(target, pending.id, "not relevant");
    expect(ok).toBe(true);

    const reloaded = readEnrichmentProposals(target).find(p => p.id === pending.id)!;
    expect(reloaded.status).toBe("rejected");
    expect(reloaded.reviewNote).toBe("not relevant");
  });

  it("applyEnrichmentProposal fails if proposal is pending (not approved)", () => {
    const target = tmpDir();
    seedCandidate(target);
    const cands = findEnrichmentCandidates(target, ["deployment-practical"]);
    generateEnrichmentProposals(target, cands);
    const pending = readEnrichmentProposals(target).find(p => p.status === "pending")!;

    const result = applyEnrichmentProposal(target, pending.id, []);
    expect(result.applied).toBe(false);
    expect(result.message).toContain("must be approved");
  });

  it("applyEnrichmentProposal appends section to SKILL.md and marks applied", () => {
    const target = tmpDir();
    const skillsDir = path.join(target, "skills");
    const skillMdPath = seedSkillMd(skillsDir, "deployment-practical");

    seedCandidate(target);
    const cands = findEnrichmentCandidates(target, ["deployment-practical"]);
    generateEnrichmentProposals(target, cands);

    const pending = readEnrichmentProposals(target).find(p => p.status === "pending")!;
    approveEnrichmentProposal(target, pending.id);

    const result = applyEnrichmentProposal(target, pending.id, [skillsDir]);
    expect(result.applied).toBe(true);

    const content = fs.readFileSync(skillMdPath, "utf-8");
    expect(content).toContain("ArgoCD Troubleshooting");
    expect(content).toContain("Enrichment:");

    const applied = readEnrichmentProposals(target).find(p => p.id === pending.id)!;
    expect(applied.status).toBe("applied");
  });

  it("generateEnrichmentProposals does not re-propose a pattern that was already applied (Fix 4 regression)", () => {
    // Reproduces the real-data bug: re-mining the same successful pattern after its
    // proposal was already applied to SKILL.md previously created a duplicate proposal
    // for identical content, stuck forever in "approved" since the section already exists.
    const target = tmpDir();
    const skillsDir = path.join(target, "skills");
    seedSkillMd(skillsDir, "deployment-practical");

    seedCandidate(target);
    const cands = findEnrichmentCandidates(target, ["deployment-practical"]);
    generateEnrichmentProposals(target, cands);

    const pending = readEnrichmentProposals(target).find(p => p.status === "pending")!;
    approveEnrichmentProposal(target, pending.id);
    const applyResult = applyEnrichmentProposal(target, pending.id, [skillsDir]);
    expect(applyResult.applied).toBe(true);
    expect(readEnrichmentProposals(target).find(p => p.id === pending.id)!.status).toBe("applied");

    // Re-running the mining pipeline with the identical candidate set must not create a
    // second proposal for a pattern that's already shipped — other candidates from the
    // same seed may legitimately still be pending (findEnrichmentCandidates can mine more
    // than one pattern per skill), so assert on the specific dedup key, not the whole set.
    const key = `${pending.skill}::${pending.patternId}`;
    const secondRunCount = generateEnrichmentProposals(target, cands);
    expect(secondRunCount).toBe(0);

    const matchingKey = readEnrichmentProposals(target).filter(
      p => `${p.skill}::${p.patternId}` === key
    );
    expect(matchingKey.length).toBe(1);
    expect(matchingKey[0].status).toBe("applied");
  });

  it("applyEnrichmentProposal prevents double-application of the same section", () => {
    const target = tmpDir();
    const skillsDir = path.join(target, "skills");
    seedSkillMd(skillsDir, "deployment-practical");

    seedCandidate(target);
    const cands = findEnrichmentCandidates(target, ["deployment-practical"]);
    generateEnrichmentProposals(target, cands);
    const pending = readEnrichmentProposals(target).find(p => p.status === "pending")!;
    approveEnrichmentProposal(target, pending.id);

    applyEnrichmentProposal(target, pending.id, [skillsDir]);
    const second = applyEnrichmentProposal(target, pending.id, [skillsDir]);
    expect(second.applied).toBe(false);
    expect(second.message).toContain("already applied");
  });

  it("applyEnrichmentProposal returns error when SKILL.md not found", () => {
    const target = tmpDir();
    seedCandidate(target);
    const cands = findEnrichmentCandidates(target, ["deployment-practical"]);
    generateEnrichmentProposals(target, cands);
    const pending = readEnrichmentProposals(target).find(p => p.status === "pending")!;
    approveEnrichmentProposal(target, pending.id);

    const result = applyEnrichmentProposal(target, pending.id, ["/nonexistent/path"]);
    expect(result.applied).toBe(false);
    expect(result.message).toContain("not found");
  });
});

// ── Fix 3/5: approved-unapplied summary + SessionStart reminder + dashboard pill ────

function backdateReviewedAt(target: string, proposalId: string, daysAgo: number): void {
  const proposals = readEnrichmentProposals(target).map(p =>
    p.id === proposalId
      ? { ...p, reviewedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString() }
      : p
  );
  fs.writeFileSync(
    enrichmentProposalsPath(target),
    proposals.map(p => JSON.stringify(p)).join("\n") + "\n",
    "utf-8"
  );
}

describe("Fix 3/5 — approved-unapplied summary, reminder text, dashboard pill", () => {
  function seedCandidate(target: string): void {
    for (let i = 0; i < MIN_PATTERN_OCCURRENCES; i++) {
      seedRun(target, "deployment-practical", {
        success: true, tokens: 5000, cost: 0.05,
        sessionId: `sess-fix35-${i}-${Date.now()}`,
        metadata: { source: "skill-invoke-hook-v2", invoked: true, task_type: "argocd sync failed" },
      });
    }
    mineSuccessfulRunPatterns(target);
  }

  it("getApprovedUnappliedSummary returns null when proposals exist but none are approved", () => {
    const target = tmpDir();
    seedCandidate(target);
    generateEnrichmentProposals(target, findEnrichmentCandidates(target, ["deployment-practical"]));
    expect(getApprovedUnappliedSummary(target)).toBeNull();
  });

  it("getApprovedUnappliedSummary counts approved proposals by skill and reports the oldest age", () => {
    const target = tmpDir();
    seedCandidate(target);
    const cands = findEnrichmentCandidates(target, ["deployment-practical"]);
    generateEnrichmentProposals(target, cands);
    const pending = readEnrichmentProposals(target).filter(p => p.status === "pending");
    expect(pending.length).toBeGreaterThan(0);
    for (const p of pending) approveEnrichmentProposal(target, p.id);
    backdateReviewedAt(target, pending[0].id, 12);

    const summary = getApprovedUnappliedSummary(target)!;
    expect(summary).toBeDefined();
    expect(summary.count).toBe(pending.length);
    expect(summary.bySkill["deployment-practical"]).toBe(pending.length);
    expect(summary.oldestAgeDays).toBeGreaterThanOrEqual(12);
  });

  it("getApprovedUnappliedSummary excludes proposals once applied (dedup terminal state carries through)", () => {
    const target = tmpDir();
    const skillsDir = path.join(target, "skills");
    seedSkillMd(skillsDir, "deployment-practical");
    seedCandidate(target);
    const cands = findEnrichmentCandidates(target, ["deployment-practical"]);
    generateEnrichmentProposals(target, cands);
    const pending = readEnrichmentProposals(target).find(p => p.status === "pending")!;
    approveEnrichmentProposal(target, pending.id);
    applyEnrichmentProposal(target, pending.id, [skillsDir]);

    expect(getApprovedUnappliedSummary(target)).toBeNull();
  });

  it("formatApprovedEnrichmentReminderText renders count, per-skill breakdown, and the panel prompt", () => {
    const text = formatApprovedEnrichmentReminderText({
      count: 4,
      bySkill: { "skill-creator": 2, "vitest-extension-testing": 1, "skill-feedback-adaptation": 1 },
      oldestAgeDays: 9,
    });
    expect(text).toContain("4 approved skill improvements are waiting.");
    expect(text).toContain("- skill-creator (2)");
    expect(text).toContain("- vitest-extension-testing (1)");
    expect(text).toContain("- skill-feedback-adaptation (1)");
    expect(text).toContain("Open enrichment panel.");
  });

  it("formatApprovedEnrichmentReminderText uses singular grammar for exactly one approved proposal", () => {
    const text = formatApprovedEnrichmentReminderText({
      count: 1, bySkill: { "skill-creator": 1 }, oldestAgeDays: 2,
    });
    expect(text).toContain("1 approved skill improvement is waiting.");
  });

  it("formatEnrichmentSummaryHtml shows an actionable 'Apply now' pill with the oldest age when approved-unapplied", () => {
    const target = tmpDir();
    seedCandidate(target);
    const cands = findEnrichmentCandidates(target, ["deployment-practical"]);
    generateEnrichmentProposals(target, cands);
    const pending = readEnrichmentProposals(target).find(p => p.status === "pending")!;
    approveEnrichmentProposal(target, pending.id);
    backdateReviewedAt(target, pending.id, 5);

    const html = formatEnrichmentSummaryHtml(target);
    expect(html).toContain("approved — Apply now");
    expect(html).toContain("enrichment-apply-now");
    expect(html).toContain('data-oldest-days="5"');
  });

  it("formatEnrichmentSummaryHtml falls back to a passive pending count when nothing is approved yet", () => {
    const target = tmpDir();
    seedCandidate(target);
    generateEnrichmentProposals(target, findEnrichmentCandidates(target, ["deployment-practical"]));

    const html = formatEnrichmentSummaryHtml(target);
    expect(html).toContain("pending");
    expect(html).not.toContain("Apply now");
  });

  it("formatEnrichmentSummaryHtml returns empty string when there are no proposals at all", () => {
    expect(formatEnrichmentSummaryHtml(tmpDir())).toBe("");
  });
});

// ── Phase 7: computeQualityScore ─────────────────────────────────────────────

describe("Phase 7 — computeQualityScore", () => {
  it("returns 0 for no invocations, 0 success rate, no patterns", () => {
    expect(computeQualityScore(0, 0, 0, [])).toBe(0);
  });

  it("increases with more invocations (usage score)", () => {
    const s1 = computeQualityScore(1,  0, 0, []);
    const s2 = computeQualityScore(10, 0, 0, []);
    expect(s2).toBeGreaterThan(s1);
  });

  it("increases with higher success rate", () => {
    const s1 = computeQualityScore(5, 0.5, 5, []);
    const s2 = computeQualityScore(5, 1.0, 5, []);
    expect(s2).toBeGreaterThan(s1);
  });

  it("increases with proven scenarios (knowledge growth)", () => {
    const noScenarios  = computeQualityScore(5, 0.8, 5, []);
    const withScenario = computeQualityScore(5, 0.8, 5, [
      { pattern: "argocd-sync-failure", label: "ArgoCD", category: "argocd", occurrences: 4, successRate: 1.0 },
    ]);
    expect(withScenario).toBeGreaterThan(noScenarios);
  });

  it("is capped at 100", () => {
    const score = computeQualityScore(1000, 1.0, 1000, [
      { pattern: "a", label: "A", category: "argocd", occurrences: 10, successRate: 1.0 },
      { pattern: "b", label: "B", category: "helm", occurrences: 10, successRate: 1.0 },
      { pattern: "c", label: "C", category: "ci-cd", occurrences: 10, successRate: 1.0 },
      { pattern: "d", label: "D", category: "cloud", occurrences: 10, successRate: 1.0 },
      { pattern: "e", label: "E", category: "terraform", occurrences: 10, successRate: 1.0 },
    ]);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("returns integer", () => {
    expect(Number.isInteger(computeQualityScore(5, 0.75, 4, []))).toBe(true);
  });
});

// ── Phase 8: getSkillEvolution ────────────────────────────────────────────────

describe("Phase 8 — getSkillEvolution", () => {
  it("returns empty array when no profile index exists", () => {
    const target = tmpDir();
    expect(getSkillEvolution(target, ["deployment-practical"])).toHaveLength(0);
  });

  it("returns only skills with positive qualityDelta", () => {
    const target = tmpDir();
    writeSkillProfileIndex(target, {
      version: 1,
      computedAt: new Date().toISOString(),
      profiles: {
        "deployment-practical": {
          skill: "deployment-practical",
          invocations: 5, successes: 4, successRate: 0.8,
          avgTokens: 5000, avgCostUsd: 0.05,
          commonScenarios: [],
          qualityScore: 60,
          qualityDelta: 12,
          lastUpdated: new Date().toISOString(),
        },
        "self-learning": {
          skill: "self-learning",
          invocations: 2, successes: 2, successRate: 1.0,
          avgTokens: 2000, avgCostUsd: 0.02,
          commonScenarios: [],
          qualityScore: 30,
          qualityDelta: 0,
          lastUpdated: new Date().toISOString(),
        },
      },
    });

    const ev = getSkillEvolution(target, ["deployment-practical", "self-learning"]);
    expect(ev).toHaveLength(1);
    expect(ev[0].skill).toBe("deployment-practical");
    expect(ev[0].qualityDelta).toBe(12);
  });

  it("sorts by qualityDelta descending and respects topN limit", () => {
    const target = tmpDir();
    writeSkillProfileIndex(target, {
      version: 1,
      computedAt: new Date().toISOString(),
      profiles: {
        "skill-a": { skill: "skill-a", invocations: 1, successes: 1, successRate: 1, avgTokens: 0, avgCostUsd: 0, commonScenarios: [], qualityScore: 50, qualityDelta: 5, lastUpdated: "" },
        "skill-b": { skill: "skill-b", invocations: 1, successes: 1, successRate: 1, avgTokens: 0, avgCostUsd: 0, commonScenarios: [], qualityScore: 70, qualityDelta: 20, lastUpdated: "" },
        "skill-c": { skill: "skill-c", invocations: 1, successes: 1, successRate: 1, avgTokens: 0, avgCostUsd: 0, commonScenarios: [], qualityScore: 40, qualityDelta: 10, lastUpdated: "" },
      },
    });

    const ev = getSkillEvolution(target, ["skill-a", "skill-b", "skill-c"], 2);
    expect(ev).toHaveLength(2);
    expect(ev[0].skill).toBe("skill-b"); // highest delta
    expect(ev[1].skill).toBe("skill-c");
  });

  it("includes topPattern from first commonScenario", () => {
    const target = tmpDir();
    writeSkillProfileIndex(target, {
      version: 1,
      computedAt: new Date().toISOString(),
      profiles: {
        "deployment-practical": {
          skill: "deployment-practical",
          invocations: 5, successes: 5, successRate: 1.0,
          avgTokens: 5000, avgCostUsd: 0.05,
          commonScenarios: [
            { pattern: "argocd-sync-failure", label: "ArgoCD Sync Failure", category: "argocd", occurrences: 4, successRate: 1.0 },
          ],
          qualityScore: 65,
          qualityDelta: 8,
          lastUpdated: new Date().toISOString(),
        },
      },
    });

    const ev = getSkillEvolution(target, ["deployment-practical"]);
    expect(ev[0].topPattern).toBe("ArgoCD Sync Failure");
  });
});

// ── Phase 9: DEVOPS_PATTERNS coverage ────────────────────────────────────────

describe("Phase 9 — DEVOPS_PATTERNS library", () => {
  it("contains patterns for all required platforms", () => {
    const ids = DEVOPS_PATTERNS.map(p => p.id);
    // AWS / Azure / GCP
    expect(ids.some(id => id.includes("eks"))).toBe(true);
    expect(ids.some(id => id.includes("aks"))).toBe(true);
    expect(ids.some(id => id.includes("gke"))).toBe(true);
    // Kubernetes
    expect(ids.some(id => id.includes("k3s"))).toBe(true);
    expect(ids.some(id => id.includes("ingress"))).toBe(true);
    // Helm / ArgoCD
    expect(ids.some(id => id.includes("helm"))).toBe(true);
    expect(ids.some(id => id.includes("argocd"))).toBe(true);
    // Terraform
    expect(ids.some(id => id.includes("terraform"))).toBe(true);
    // CI/CD
    expect(ids.some(id => id.includes("github-actions"))).toBe(true);
    // KubeRocketCI
    expect(ids.some(id => id.includes("kuberocketci"))).toBe(true);
  });

  it("every pattern has non-empty keywords, affinity, typicalCommands, and proposalTemplate", () => {
    for (const p of DEVOPS_PATTERNS) {
      expect(p.keywords.length, `${p.id} keywords`).toBeGreaterThan(0);
      expect(p.affinity.length, `${p.id} affinity`).toBeGreaterThan(0);
      expect(p.typicalCommands.length, `${p.id} typicalCommands`).toBeGreaterThan(0);
      expect(p.proposalTemplate.length, `${p.id} proposalTemplate`).toBeGreaterThan(50);
    }
  });

  it("every pattern id is unique", () => {
    const ids = DEVOPS_PATTERNS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("proposalTemplate for argocd-sync-failure contains kubectl and argocd commands", () => {
    const p = DEVOPS_PATTERNS.find(p => p.id === "argocd-sync-failure")!;
    expect(p.proposalTemplate).toContain("argocd app sync");
    expect(p.proposalTemplate).toContain("kubectl describe");
  });

  it("proposalTemplate for terraform-state-lock contains force-unlock", () => {
    const p = DEVOPS_PATTERNS.find(p => p.id === "terraform-state-lock")!;
    expect(p.proposalTemplate).toContain("force-unlock");
  });

  it("proposalTemplate for k3s-cluster-setup contains k3sup", () => {
    const p = DEVOPS_PATTERNS.find(p => p.id === "k3s-cluster-setup")!;
    expect(p.proposalTemplate).toContain("k3sup");
  });
});
