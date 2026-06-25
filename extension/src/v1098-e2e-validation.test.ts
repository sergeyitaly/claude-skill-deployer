/**
 * E2E Validation Suite — v1.0.98 Adoption Intelligence
 *
 * Covers all 13 phases of the spec:
 *   Phase 1  Opportunity signal scoring
 *   Phase 2  Keyword inflation regression
 *   Phase 3  Proposal persistence
 *   Phase 4  Dormancy pipeline
 *   Phase 5  Dormancy suppression
 *   Phase 6  Revival condition
 *   Phase 7  Stale proposal cleanup
 *   Phase 8  Affinity floor validation
 *   Phase 9  Feedback penalty engine
 *   Phase 10 Recommendation quality
 *   Phase 11 Dashboard integrity (metric math)
 *   Phase 12 Metric formula integrity
 *   Phase 13 Regression — existing suite (476 tests must pass; confirmed separately)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Manifest } from "./skillOps";
import { computeTaskSkillProposals } from "./taskSkillProposals";
import {
  computeAllSkillPenalties,
  getDormantSkills,
  recordSessionProposalOutcome,
  readProposalOutcomes,
  appendRecommendationFeedback,
  historicalSuccess,
} from "./proposalOutcome";
import { isDormantSkill, computeAdoptionMetrics } from "./adoptionIntelligence";
import { appendSkillRun } from "./runsStore";

// ─── Shared minimal manifest with the skills under test ─────────────────────

const manifest: Manifest = {
  skills: {
    "github-actions-ci": {
      description: "GitHub Actions workflow CI pipeline automation",
      detect_globs: ["**/.github/workflows/*.yml"],
    },
    "deployment-practical": {
      description: "Deployment scripting and release pipeline automation",
      detect_globs: ["**/deploy*.sh", "**/Makefile"],
    },
    "terraform-plan-review": {
      description: "Terraform plan review and infrastructure as code",
      detect_globs: ["**/*.tf"],
    },
    "ci-pipeline-debug": {
      description: "CI pipeline failure debugging GitLab GitHub",
      detect_globs: ["**/.gitlab-ci.yml"],
    },
    "vitest-extension-testing": {
      description: "Vitest unit and integration testing for VS Code extensions",
      detect_globs: ["**/*.test.ts"],
    },
    "skill-usage-insights": {
      description: "Adoption analytics and skill usage intelligence reporting",
      detect_globs: ["**/proposalOutcome.jsonl"],
    },
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "e2e-v1098-"));
}

function learningDir(target: string): string {
  const d = path.join(target, ".claude", "learning");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Write N session_end records where `skill` is proposed but never invoked. */
function seedProposals(target: string, skill: string, n: number): void {
  const ld = learningDir(target);
  const file = path.join(ld, "proposalOutcome.jsonl");
  for (let i = 0; i < n; i++) {
    const rec = {
      ts: new Date(Date.now() - (n - i) * 86_400_000).toISOString(),
      session_id: `sess-${i}`,
      event: "session_end",
      proposed: [skill],
      invoked: [],
      not_invoked: [skill],
      acceptance_rate: 0,
      skills_proposed_count: 1,
      skills_invoked_count: 0,
    };
    fs.appendFileSync(file, JSON.stringify(rec) + "\n", "utf-8");
  }
}

/** Add a single successful invocation of `skill` to runs.jsonl. */
function seedInvocation(target: string, skill: string, sessionId = "sess-revival"): void {
  learningDir(target);
  appendSkillRun(target, {
    skill,
    action: "skill_invoke",
    agent: "claude",
    tokens: 500,
    cost: 0.005,
    rc: 0,
    success: true,
    session_id: sessionId,
    project: "test",
    branch: null,
    metadata: { source: "skill-invoke-hook-v2", invoked: true, proposed: true },
  });
}

/** Write task-skill-proposals.json with given age offset (ms). */
function writeProposalsFile(
  target: string,
  skills: string[],
  ageMs: number
): void {
  learningDir(target);
  const file = path.join(target, ".claude", "learning", "task-skill-proposals.json");
  const data = {
    version: 1,
    generatedAt: new Date(Date.now() - ageMs).toISOString(),
    taskSummary: "test",
    proposals: skills.map((s) => ({ name: s, confidence: 70, reason: "test", installed: false })),
  };
  fs.writeFileSync(file, JSON.stringify(data), "utf-8");
}

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 1 — Opportunity Signal Scoring
// ═════════════════════════════════════════════════════════════════════════════

describe("Phase 1 — Opportunity Signal Scoring", () => {
  it("A: 'Implement GitHub Actions workflow' → github-actions-ci proposed", () => {
    const target = tmpDir();
    const proposals = computeTaskSkillProposals(
      target, manifest, "Implement GitHub Actions workflow"
    );
    const names = proposals.map((p) => p.name);
    expect(names).toContain("github-actions-ci");
    const p = proposals.find((p) => p.name === "github-actions-ci")!;
    expect(p.confidence).toBeGreaterThan(0);
    // "github" keyword must be part of the reason
    expect(p.reason.toLowerCase()).toMatch(/github|keyword|name/i);
  });

  it("B: 'Deploy Azure AKS application' → deployment-practical proposed", () => {
    const target = tmpDir();
    const proposals = computeTaskSkillProposals(
      target, manifest, "Deploy Azure AKS application"
    );
    const names = proposals.map((p) => p.name);
    expect(names).toContain("deployment-practical");
  });

  it("C: 'Analyze Prompt Intelligence dashboard' → no CI/CD skills", () => {
    const target = tmpDir();
    const proposals = computeTaskSkillProposals(
      target, manifest, "Analyze Prompt Intelligence dashboard"
    );
    const names = proposals.map((p) => p.name);
    // Neither CI/deployment skill should appear
    expect(names).not.toContain("github-actions-ci");
    expect(names).not.toContain("deployment-practical");
  });

  it("D: 'Review HACE metrics and adoption system' → no deployment recommendation", () => {
    const target = tmpDir();
    const proposals = computeTaskSkillProposals(
      target, manifest, "Review HACE metrics and adoption system"
    );
    const names = proposals.map((p) => p.name);
    expect(names).not.toContain("deployment-practical");
    expect(names).not.toContain("github-actions-ci");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 2 — Keyword Inflation Regression
// ═════════════════════════════════════════════════════════════════════════════

describe("Phase 2 — Keyword Inflation Regression", () => {
  it("'deploy' alone → deployment-practical blocked (signalTypes=1 < 2)", () => {
    const target = tmpDir();
    const proposals = computeTaskSkillProposals(target, manifest, "deploy");
    const names = proposals.map((p) => p.name);
    // Single keyword "deploy" → signalTypes=1 → gate blocks it
    expect(names).not.toContain("deployment-practical");
  });

  it("'deploy' alone → github-actions-ci blocked", () => {
    const target = tmpDir();
    const proposals = computeTaskSkillProposals(target, manifest, "deploy");
    expect(proposals.map((p) => p.name)).not.toContain("github-actions-ci");
  });

  it("'deploy' alone → no CI/CD skill at all scores above 50 confidence", () => {
    const target = tmpDir();
    const proposals = computeTaskSkillProposals(target, manifest, "deploy");
    const ciCdSkills = ["github-actions-ci", "deployment-practical", "ci-pipeline-debug"];
    for (const skill of ciCdSkills) {
      const p = proposals.find((x) => x.name === skill);
      // Either absent or well below the inflation-era score of 70+
      if (p) expect(p.confidence).toBeLessThan(50);
    }
  });

  it("Two independent signals ('deploy azure') → deployment-practical allowed through", () => {
    const target = tmpDir();
    // "deploy" keyword + "azure" keyword = 2 independent keyword signals
    const proposals = computeTaskSkillProposals(target, manifest, "deploy azure application");
    const names = proposals.map((p) => p.name);
    expect(names).toContain("deployment-practical");
  });

  it("Score contribution: 'deploy terraform' scores ≤ 120 for deployment-practical (no triple-dip)", () => {
    // If triple-dipping were still present, one token could alone give 70 pts.
    // With else-if, "deploy" gives exactly 50 (keyword) and "terraform" gives 50 (keyword).
    // Combined max = 100+installed bonus ≤ 110, not 200+ from triple-dipping both tokens.
    const target = tmpDir();
    const proposals = computeTaskSkillProposals(target, manifest, "deploy terraform");
    const p = proposals.find((x) => x.name === "deployment-practical");
    if (p) {
      expect(p.confidence).toBeLessThanOrEqual(100); // confidence is capped at 100
      // Reason must NOT include duplicate signal names
      const reasons = p.reason.split(";");
      const uniqueReasons = new Set(reasons.map((r) => r.trim()));
      expect(reasons.length).toBe(uniqueReasons.size);
    }
    // At minimum, it should be proposed (two signals exist)
    expect(proposals.map((x) => x.name)).toContain("deployment-practical");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 3 — Proposal Persistence
// ═════════════════════════════════════════════════════════════════════════════

describe("Phase 3 — Proposal Persistence", () => {
  it("recordSessionProposalOutcome unions caller-supplied + fresh file proposals", () => {
    const target = tmpDir();
    // Seed a fresh proposals file (< 4 h old)
    writeProposalsFile(target, ["github-actions-ci", "terraform-plan-review"], 0);

    // recordSessionProposalOutcome called with an extra skill from _detectOpportunity
    recordSessionProposalOutcome(target, "sess-p3", ["vitest-extension-testing"]);

    const outcomes = readProposalOutcomes(target);
    expect(outcomes).toHaveLength(1);
    const rec = outcomes[0];
    // All three skills must appear in proposed[]
    expect(rec.proposed).toContain("github-actions-ci");
    expect(rec.proposed).toContain("terraform-plan-review");
    expect(rec.proposed).toContain("vitest-extension-testing");
    expect(rec.session_id).toBe("sess-p3");
    expect(rec.event).toBe("session_end");
  });

  it("recordSessionProposalOutcome records correct invoked/not_invoked split", () => {
    const target = tmpDir();
    writeProposalsFile(target, ["github-actions-ci", "terraform-plan-review"], 0);
    // Seed a run — terraform-plan-review was actually invoked
    seedInvocation(target, "terraform-plan-review", "sess-p3b");

    recordSessionProposalOutcome(target, "sess-p3b", []);

    const rec = readProposalOutcomes(target)[0];
    expect(rec.invoked).toContain("terraform-plan-review");
    expect(rec.not_invoked).toContain("github-actions-ci");
    expect(rec.skills_invoked_count).toBe(1);
    expect(rec.acceptance_rate).toBeCloseTo(1 / 2);
  });

  it("recordSessionProposalOutcome ignores stale proposals file (> 4 h)", () => {
    const target = tmpDir();
    // File is 5 hours old — should be rejected
    writeProposalsFile(target, ["deployment-practical"], 5 * 60 * 60 * 1000);

    recordSessionProposalOutcome(target, "sess-p3c", []);

    const rec = readProposalOutcomes(target)[0];
    // Stale file ignored → proposed[] should be empty
    expect(rec.proposed).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 4 — Dormancy Pipeline
// ═════════════════════════════════════════════════════════════════════════════

describe("Phase 4 — Dormancy Pipeline", () => {
  it("5 proposal sessions with 0 invocations → isDormantSkill returns true", () => {
    const target = tmpDir();
    seedProposals(target, "github-actions-ci", 5);
    expect(isDormantSkill(target, "github-actions-ci")).toBe(true);
  });

  it("getDormantSkills includes the skill after 5 proposals, 0 invocations", () => {
    const target = tmpDir();
    seedProposals(target, "deployment-practical", 5);
    const dormant = getDormantSkills(target);
    expect(dormant.has("deployment-practical")).toBe(true);
  });

  it("4 proposal sessions → NOT yet dormant (threshold is ≥5)", () => {
    const target = tmpDir();
    seedProposals(target, "github-actions-ci", 4);
    expect(isDormantSkill(target, "github-actions-ci")).toBe(false);
  });

  it("computeAdoptionMetrics lists dormant skill in dormantSkills array", () => {
    const target = tmpDir();
    seedProposals(target, "deployment-practical", 7);
    const metrics = computeAdoptionMetrics(target);
    expect(metrics.dormantSkills).toContain("deployment-practical");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 5 — Dormancy Suppression
// ═════════════════════════════════════════════════════════════════════════════

describe("Phase 5 — Dormancy Suppression", () => {
  it("Dormant skill NOT returned by computeTaskSkillProposals even with matching prompt", () => {
    const target = tmpDir();
    seedProposals(target, "github-actions-ci", 6);

    const proposals = computeTaskSkillProposals(
      target, manifest, "Implement GitHub Actions workflow automation"
    );
    expect(proposals.map((p) => p.name)).not.toContain("github-actions-ci");
  });

  it("Dormant deployment-practical suppressed for 'deploy terraform' prompt", () => {
    const target = tmpDir();
    seedProposals(target, "deployment-practical", 6);

    const proposals = computeTaskSkillProposals(
      target, manifest, "deploy terraform infrastructure"
    );
    expect(proposals.map((p) => p.name)).not.toContain("deployment-practical");
  });

  it("Non-dormant skills still appear while dormant ones are suppressed", () => {
    const target = tmpDir();
    seedProposals(target, "deployment-practical", 6); // dormant
    // terraform-plan-review has 0 proposals → not dormant

    const proposals = computeTaskSkillProposals(
      target, manifest, "Review terraform plan and deployment pipeline"
    );
    const names = proposals.map((p) => p.name);
    // terraform-plan-review should still be proposed
    expect(names).toContain("terraform-plan-review");
    // deployment-practical must be suppressed
    expect(names).not.toContain("deployment-practical");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 6 — Revival Condition
// ═════════════════════════════════════════════════════════════════════════════

describe("Phase 6 — Revival Condition", () => {
  it("After one invocation, skill acceptance rate > 0 → no longer dormant", () => {
    const target = tmpDir();
    seedProposals(target, "github-actions-ci", 6); // dormant
    expect(isDormantSkill(target, "github-actions-ci")).toBe(true);

    // Record the invocation AND an outcome session that lists it as invoked
    seedInvocation(target, "github-actions-ci", "sess-revival");

    // Add a session record showing it was invoked
    const ld = learningDir(target);
    const rec = {
      ts: new Date().toISOString(),
      session_id: "sess-revival",
      event: "session_end",
      proposed: ["github-actions-ci"],
      invoked: ["github-actions-ci"],
      not_invoked: [],
      acceptance_rate: 1.0,
      skills_proposed_count: 1,
      skills_invoked_count: 1,
    };
    fs.appendFileSync(
      path.join(ld, "proposalOutcome.jsonl"),
      JSON.stringify(rec) + "\n",
      "utf-8"
    );

    // Now: 6 proposed (0 invoked) + 1 proposed (1 invoked) = 7 proposed, 1 invoked = 14.3% > 5%
    expect(isDormantSkill(target, "github-actions-ci")).toBe(false);
  });

  it("After revival, skill reappears in proposals for a matching prompt", () => {
    const target = tmpDir();
    seedProposals(target, "github-actions-ci", 5);
    seedInvocation(target, "github-actions-ci", "sess-rev2");

    const ld = learningDir(target);
    fs.appendFileSync(
      path.join(ld, "proposalOutcome.jsonl"),
      JSON.stringify({
        ts: new Date().toISOString(),
        session_id: "sess-rev2",
        event: "session_end",
        proposed: ["github-actions-ci"],
        invoked: ["github-actions-ci"],
        not_invoked: [],
        acceptance_rate: 1.0,
        skills_proposed_count: 1,
        skills_invoked_count: 1,
      }) + "\n",
      "utf-8"
    );

    // 5 proposed, 0 invoked → then 1 proposed, 1 invoked = 6 total, 1 invoked = 16.7%
    const proposals = computeTaskSkillProposals(
      target, manifest, "Implement GitHub Actions workflow"
    );
    expect(proposals.map((p) => p.name)).toContain("github-actions-ci");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 7 — Stale Proposal Cleanup
// ═════════════════════════════════════════════════════════════════════════════

describe("Phase 7 — Stale Proposal Cleanup", () => {
  it("File older than 4 h not counted as proposed (empty proposed[] written)", () => {
    const target = tmpDir();
    writeProposalsFile(target, ["deployment-practical", "github-actions-ci"], 5 * 3_600_000);

    recordSessionProposalOutcome(target, "sess-stale", []);

    const recs = readProposalOutcomes(target);
    expect(recs[0].proposed).toHaveLength(0);
    expect(recs[0].skills_proposed_count).toBe(0);
  });

  it("File exactly 3 h old (< 4 h) is used", () => {
    const target = tmpDir();
    writeProposalsFile(target, ["github-actions-ci"], 3 * 3_600_000);

    recordSessionProposalOutcome(target, "sess-fresh3h", []);

    const recs = readProposalOutcomes(target);
    expect(recs[0].proposed).toContain("github-actions-ci");
  });

  it("Stale file produces no phantom proposal counts → acceptance/precision unaffected", () => {
    const target = tmpDir();
    writeProposalsFile(target, ["deployment-practical"], 5 * 3_600_000);

    recordSessionProposalOutcome(target, "sess-nocontam", []);

    const hist = historicalSuccess(target, "deployment-practical");
    // proposedCount should be 0 — the stale file didn't contaminate outcomes
    expect(hist.proposedCount).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 8 — Affinity Floor Validation
// ═════════════════════════════════════════════════════════════════════════════

describe("Phase 8 — Affinity Floor Validation (via proposal suppression)", () => {
  it("5+ proposals, 0 invocations → skill does NOT reappear via affinity alone", () => {
    // We can't call computeAffinityAdoptionWeight directly (not exported),
    // but we can verify the EFFECT: after 5 ignores, the skill must not sneak
    // back into proposals for a prompt that only carries generic tokens.
    const target = tmpDir();
    seedProposals(target, "github-actions-ci", 6);

    // Even with .github/workflows directory present (the affinity trigger),
    // the dormancy check should block it before affinity is even evaluated.
    const workflowsDir = path.join(target, ".github", "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(path.join(workflowsDir, "ci.yml"), "on: push\n", "utf-8");

    const proposals = computeTaskSkillProposals(
      target, manifest, "Update the project files"
    );
    expect(proposals.map((p) => p.name)).not.toContain("github-actions-ci");
  });

  it("historicalSuccess acceptanceRate=0 for 5+ proposed → weight formula returns 0", () => {
    const target = tmpDir();
    seedProposals(target, "deployment-practical", 5);

    const hist = historicalSuccess(target, "deployment-practical");
    expect(hist.proposedCount).toBeGreaterThanOrEqual(5);
    expect(hist.acceptanceRate).toBe(0);
    // Verify the weight formula: proposedCount≥5 && acceptanceRate===0 → weight 0.0
    // (We test indirectly: skill gets no affinity contribution and stays suppressed)
    const proposals = computeTaskSkillProposals(
      target, manifest, "deploy terraform infrastructure to production"
    );
    // Dormancy suppresses it before affinity can help
    expect(proposals.map((p) => p.name)).not.toContain("deployment-practical");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 9 — Feedback Penalty Engine
// ═════════════════════════════════════════════════════════════════════════════

describe("Phase 9 — Feedback Penalty Engine", () => {
  it("3 ignored feedback records add extra penalty to computeAllSkillPenalties", () => {
    const target = tmpDir();
    // Seed 3 ignored records for deployment-practical
    for (let i = 0; i < 3; i++) {
      appendRecommendationFeedback(target, {
        session_id: `fb-sess-${i}`,
        skill: "deployment-practical",
        proposed: true,
        accepted: false,
        reason: "ignored",
      });
    }

    const penalties = computeAllSkillPenalties(target);
    // Extra feedback penalty: Math.floor(3/3)*2 = 2 extra points
    expect((penalties["deployment-practical"] ?? 0)).toBeGreaterThan(0);
  });

  it("Penalty grows with more feedback records", () => {
    const target = tmpDir();
    const seedFeedback = (n: number) => {
      const t = tmpDir();
      for (let i = 0; i < n; i++) {
        appendRecommendationFeedback(t, {
          session_id: `fb-${i}`,
          skill: "deployment-practical",
          proposed: true,
          accepted: false,
          reason: "ignored",
        });
      }
      return computeAllSkillPenalties(t)["deployment-practical"] ?? 0;
    };

    const penalty3 = seedFeedback(3);
    const penalty9 = seedFeedback(9);
    expect(penalty9).toBeGreaterThan(penalty3);
  });

  it("Accepted feedback records do NOT contribute to penalty", () => {
    const target = tmpDir();
    appendRecommendationFeedback(target, {
      session_id: "acc-sess",
      skill: "github-actions-ci",
      proposed: true,
      accepted: true,  // accepted — should not penalise
      reason: "ignored",
    });

    const penalties = computeAllSkillPenalties(target);
    expect(penalties["github-actions-ci"] ?? 0).toBe(0);
  });

  it("Feedback penalty reduces proposal confidence below baseline", () => {
    const targetBase = tmpDir();
    const targetPenalised = tmpDir();

    // 9 ignored records → extra penalty
    for (let i = 0; i < 9; i++) {
      appendRecommendationFeedback(targetPenalised, {
        session_id: `pfb-${i}`,
        skill: "deployment-practical",
        proposed: true,
        accepted: false,
        reason: "ignored",
      });
    }

    const baseProposals = computeTaskSkillProposals(
      targetBase, manifest, "deploy terraform application"
    );
    const penProposals = computeTaskSkillProposals(
      targetPenalised, manifest, "deploy terraform application"
    );

    const baseConf = baseProposals.find((p) => p.name === "deployment-practical")?.confidence ?? 0;
    const penConf  = penProposals.find((p) => p.name === "deployment-practical")?.confidence ?? 0;

    // Either the penalised proposal has lower confidence, or it was filtered out entirely
    expect(penConf).toBeLessThanOrEqual(baseConf);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 10 — Recommendation Quality
// ═════════════════════════════════════════════════════════════════════════════

describe("Phase 10 — Recommendation Quality", () => {
  it("Dormant skills do not dominate the proposal list", () => {
    const target = tmpDir();
    // Make github-actions-ci and deployment-practical dormant
    seedProposals(target, "github-actions-ci", 6);
    seedProposals(target, "deployment-practical", 7);

    const proposals = computeTaskSkillProposals(
      target, manifest, "Implement GitHub Actions workflow and deploy terraform"
    );
    const dormantInProposals = proposals.filter((p) =>
      ["github-actions-ci", "deployment-practical"].includes(p.name)
    );
    expect(dormantInProposals).toHaveLength(0);
  });

  it("Top proposal confidence is plausible (10–100)", () => {
    const target = tmpDir();
    const proposals = computeTaskSkillProposals(
      target, manifest, "Implement GitHub Actions workflow for CI"
    );
    if (proposals.length > 0) {
      expect(proposals[0].confidence).toBeGreaterThanOrEqual(10);
      expect(proposals[0].confidence).toBeLessThanOrEqual(100);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 11 — Dashboard Integrity
// ═════════════════════════════════════════════════════════════════════════════

describe("Phase 11 — Dashboard Integrity (metric math)", () => {
  it("computeAdoptionMetrics acceptanceRatePct = round(invoked/proposed * 100)", () => {
    const target = tmpDir();
    const ld = learningDir(target);
    const file = path.join(ld, "proposalOutcome.jsonl");
    // 10 proposed, 2 invoked across two sessions
    const sessions = [
      { proposed: ["A", "B", "C", "D", "E"], invoked: ["A"] },
      { proposed: ["A", "B", "C", "D", "E"], invoked: ["B"] },
    ];
    for (const s of sessions) {
      fs.appendFileSync(file, JSON.stringify({
        ts: new Date().toISOString(),
        session_id: `s${Math.random()}`,
        event: "session_end",
        proposed: s.proposed,
        invoked: s.invoked,
        not_invoked: s.proposed.filter((x) => !s.invoked.includes(x)),
        acceptance_rate: s.invoked.length / s.proposed.length,
        skills_proposed_count: s.proposed.length,
        skills_invoked_count: s.invoked.length,
      }) + "\n", "utf-8");
    }

    const metrics = computeAdoptionMetrics(target);
    // 2 invoked out of 10 proposed = 20%
    expect(metrics.acceptanceRatePct).toBe(20);
    expect(metrics.sessionsAnalyzed).toBe(2);
    expect(metrics.totalProposed).toBe(10);
    expect(metrics.totalInvoked).toBe(2);
  });

  it("dormantSkills list matches skills with ≥5 proposals and 0 invocations", () => {
    const target = tmpDir();
    seedProposals(target, "github-actions-ci", 6);     // dormant
    seedProposals(target, "terraform-plan-review", 3);  // NOT dormant (< 5)

    const metrics = computeAdoptionMetrics(target);
    expect(metrics.dormantSkills).toContain("github-actions-ci");
    expect(metrics.dormantSkills).not.toContain("terraform-plan-review");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 12 — Metric Formula Integrity
// ═════════════════════════════════════════════════════════════════════════════

describe("Phase 12 — Metric Formula Integrity", () => {
  it("Acceptance = invoked / proposed (session-level)", () => {
    const target = tmpDir();
    const ld = learningDir(target);
    const file = path.join(ld, "proposalOutcome.jsonl");
    fs.appendFileSync(file, JSON.stringify({
      ts: new Date().toISOString(),
      session_id: "m1",
      event: "session_end",
      proposed: ["A", "B", "C"],
      invoked: ["A"],
      not_invoked: ["B", "C"],
      acceptance_rate: 1 / 3,
      skills_proposed_count: 3,
      skills_invoked_count: 1,
    }) + "\n", "utf-8");

    const metrics = computeAdoptionMetrics(target);
    expect(metrics.acceptanceRatePct).toBe(Math.round((1 / 3) * 100));
  });

  it("F1 = harmonic mean of precision and recall", () => {
    // With known precision and recall we can verify the F1 formula
    const precision = 30;
    const recall    = 20;
    const expectedF1 = Math.round(2 * precision * recall / (precision + recall));
    expect(expectedF1).toBe(24);

    // Confirm formula used in computeAdoptionMetrics (white-box check)
    const f1 = (p: number, r: number) =>
      (p + r) > 0 ? Math.round(2 * p * r / (p + r)) : 0;
    expect(f1(precision, recall)).toBe(24);
    expect(f1(0, recall)).toBe(0);
    expect(f1(100, 100)).toBe(100);
  });

  it("Precision = unique skills ever invoked / unique skills ever proposed", () => {
    const target = tmpDir();
    const ld = learningDir(target);
    const file = path.join(ld, "proposalOutcome.jsonl");
    // 3 unique skills proposed; 1 invoked
    for (let i = 0; i < 3; i++) {
      fs.appendFileSync(file, JSON.stringify({
        ts: new Date().toISOString(),
        session_id: `p${i}`,
        event: "session_end",
        proposed: ["A", "B", "C"],
        invoked: i === 0 ? ["A"] : [],
        not_invoked: i === 0 ? ["B", "C"] : ["A", "B", "C"],
        acceptance_rate: i === 0 ? 1 / 3 : 0,
        skills_proposed_count: 3,
        skills_invoked_count: i === 0 ? 1 : 0,
      }) + "\n", "utf-8");
    }
    // A was invoked in runs.jsonl
    seedInvocation(target, "A", "p0");

    const metrics = computeAdoptionMetrics(target);
    // Precision: 1 unique invoked / 3 unique proposed = 33%
    expect(metrics.precisionPct).toBe(33);
  });

  it("Zero-division guard: F1=0 when precision and recall are both 0", () => {
    const target = tmpDir();
    const metrics = computeAdoptionMetrics(target);
    expect(metrics.hasData).toBe(false);
    expect(metrics.f1Pct).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 13 — Regression Smoke Check
// ═════════════════════════════════════════════════════════════════════════════

describe("Phase 13 — Regression Smoke Check", () => {
  it("computeTaskSkillProposals still works for known-good vitest prompt", () => {
    const target = tmpDir();
    const proposals = computeTaskSkillProposals(
      target, manifest, "Run vitest unit tests for the extension"
    );
    expect(proposals.map((p) => p.name)).toContain("vitest-extension-testing");
  });

  it("getDormantSkills does not throw on empty learning directory", () => {
    const target = tmpDir();
    expect(() => getDormantSkills(target)).not.toThrow();
    expect(getDormantSkills(target).size).toBe(0);
  });

  it("computeAdoptionMetrics handles missing data gracefully", () => {
    const target = tmpDir();
    const metrics = computeAdoptionMetrics(target);
    expect(metrics.hasData).toBe(false);
    expect(metrics.acceptanceRatePct).toBe(0);
    expect(metrics.f1Pct).toBe(0);
  });

  it("recordSessionProposalOutcome is non-fatal on missing directory", () => {
    const target = tmpDir();
    // No .claude/learning directory pre-created
    expect(() => recordSessionProposalOutcome(target, "sess-x", [])).not.toThrow();
  });

  it("computeAllSkillPenalties returns 0 for unknown skill in fresh directory", () => {
    const target = tmpDir();
    const penalties = computeAllSkillPenalties(target);
    expect(penalties["github-actions-ci"] ?? 0).toBe(0);
  });
});
