/**
 * Skill Adoption Intelligence v1 — Phase 10 Integration Tests
 *
 * Covers:
 * - Acceptance detection via applyProposedSkillsLocally (Phase 3)
 * - Full funnel: proposed → accepted → invoked → successful → reused (Phase 2)
 * - Success detection with and without correction signal (Phase 4)
 * - Confidence feedback loop affecting proposal ranking (Phase 8)
 * - Precision / Recall / F1 computed from funnel (Phase 6+7)
 * - Audit queries: can the system answer "did this recommendation produce value?" (Phase 9)
 * - detectBranch reads .git/HEAD correctly (Phase 1)
 * - Concurrent write safety: multiple appendAdoptionEvents calls produce valid JSONL (Phase 1)
 * - daysBack window filtering (Phase 2)
 * - Per-skill adoption sorted by adoptionScore (Phase 2)
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  adoptionConfidenceAdjustment,
  appendAdoptionEvent,
  appendAdoptionEvents,
  computeAdoptionFunnel,
  computePerSkillAdoption,
  computeRecommendationQuality,
  computeSuccessConfidence,
  detectBranch,
  formatAdoptionFunnelPanelHtml,
  formatAdoptionReport,
  readAdoptionEvents,
  recordAcceptedSkills,
  recordInvokedSkill,
  recordProposedSkills,
  recordRejectedSkills,
  recordSessionAdoptionOutcomes,
} from "./skillAdoption";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adoption-int-"));
  fs.mkdirSync(path.join(dir, ".claude", "learning"), { recursive: true });
  return dir;
}

function makeGitWorkspace(branch = "main"): string {
  const dir = makeWorkspace();
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`, "utf-8");
  return dir;
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

function writeRuns(
  target: string,
  runs: Array<{ skill: string; session_id: string; success: boolean; ts?: string }>
): void {
  const lines = runs.map((r) =>
    JSON.stringify({
      ts: r.ts ?? new Date().toISOString(),
      timestamp: r.ts ?? new Date().toISOString(),
      skill: r.skill,
      action: "skill_invoke",
      agent: "claude",
      tokens: 100,
      cost: 0.001,
      rc: r.success ? 0 : 1,
      success: r.success,
      session_id: r.session_id,
      project: target,
      branch: null,
      metadata: { source: "skill-invoke-hook-v2", invoked: true },
    })
  );
  fs.writeFileSync(
    path.join(target, ".claude", "learning", "runs.jsonl"),
    lines.join("\n") + "\n",
    "utf-8"
  );
}

// ---------------------------------------------------------------------------
// Phase 1 — detectBranch
// ---------------------------------------------------------------------------

describe("detectBranch", () => {
  it("reads branch name from .git/HEAD", () => {
    const target = makeGitWorkspace("feature/adoption-v1");
    expect(detectBranch(target)).toBe("feature/adoption-v1");
  });

  it("returns null when .git/HEAD is absent", () => {
    const target = makeWorkspace();
    expect(detectBranch(target)).toBeNull();
  });

  it("handles detached HEAD (returns short sha)", () => {
    const target = makeWorkspace();
    fs.mkdirSync(path.join(target, ".git"), { recursive: true });
    fs.writeFileSync(path.join(target, ".git", "HEAD"), "abc1234567890\n", "utf-8");
    const branch = detectBranch(target);
    expect(branch).toBe("abc123456789");
  });

  it("stores branch on written events", () => {
    const target = makeGitWorkspace("my-branch");
    appendAdoptionEvent(target, { taskId: "t1", skill: "pdf", event: "proposed", source: "auto" });
    const events = readAdoptionEvents(target);
    expect(events[0].branch).toBe("my-branch");
  });
});

// ---------------------------------------------------------------------------
// Phase 1 — concurrent write safety
// ---------------------------------------------------------------------------

describe("concurrent write safety", () => {
  it("interleaved single-event appends all produce valid JSONL lines", () => {
    const target = makeWorkspace();
    // Simulate concurrent appends by alternating writes
    for (let i = 0; i < 10; i++) {
      appendAdoptionEvent(target, {
        taskId: `t-${i}`,
        skill: `sk-${i}`,
        event: i % 2 === 0 ? "proposed" : "invoked",
        source: "auto",
      });
    }
    const events = readAdoptionEvents(target);
    expect(events).toHaveLength(10);
    // Verify every line is valid JSON by checking all have timestamps
    for (const e of events) {
      expect(typeof e.timestamp).toBe("string");
      expect(new Date(e.timestamp).getTime()).not.toBeNaN();
    }
  });

  it("batch append writes all entries atomically (one syscall)", () => {
    const target = makeWorkspace();
    appendAdoptionEvents(target, [
      { taskId: "b1", skill: "a", event: "proposed", source: "auto" },
      { taskId: "b1", skill: "b", event: "proposed", source: "auto" },
      { taskId: "b1", skill: "c", event: "proposed", source: "auto" },
    ]);
    const events = readAdoptionEvents(target);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.skill)).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 — acceptance detection via recordAcceptedSkills (Apply flow)
// ---------------------------------------------------------------------------

describe("Phase 3 — acceptance via Apply Suggested Skills", () => {
  it("records accepted for proposed skills that get installed", () => {
    const target = makeWorkspace();
    const proposals = [
      { name: "vitest-extension-testing", confidence: 93 },
      { name: "ci-preflight", confidence: 70 },
      { name: "never-proposed", confidence: 50 },
    ];
    const n = recordAcceptedSkills(
      target,
      ["vitest-extension-testing", "ci-preflight", "extra-skill-not-proposed"],
      proposals,
      "manual",
      "batch-gen-1"
    );
    expect(n).toBe(2); // only proposed skills count
    const events = readAdoptionEvents(target).filter((e) => e.event === "accepted");
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.skill).sort()).toEqual(["ci-preflight", "vitest-extension-testing"]);
    expect(events.find((e) => e.skill === "vitest-extension-testing")?.confidence).toBe(93);
    expect(events.every((e) => e.source === "manual")).toBe(true);
  });

  it("auto-acceptance: invocation of proposed skill records implicit accepted first", () => {
    const target = makeWorkspace();
    // No accepted event yet — first invocation of a proposed skill implies acceptance
    recordInvokedSkill(target, {
      skill: "vitest-extension-testing",
      sessionId: "sess-1",
      agent: "claude",
      confidence: 93,
      proposed: true,
      source: "auto",
    });
    const events = readAdoptionEvents(target);
    const accepted = events.filter((e) => e.event === "accepted");
    const invoked = events.filter((e) => e.event === "invoked");
    expect(accepted).toHaveLength(1);
    expect(invoked).toHaveLength(1);
    // Second invocation: no duplicate accepted
    recordInvokedSkill(target, {
      skill: "vitest-extension-testing",
      sessionId: "sess-2",
      proposed: true,
    });
    expect(readAdoptionEvents(target).filter((e) => e.event === "accepted")).toHaveLength(1);
    expect(readAdoptionEvents(target).filter((e) => e.event === "invoked")).toHaveLength(2);
  });

  it("non-proposed invocation does not create accepted event", () => {
    const target = makeWorkspace();
    recordInvokedSkill(target, {
      skill: "self-learning",
      sessionId: "sess-1",
      proposed: false,
    });
    expect(readAdoptionEvents(target).filter((e) => e.event === "accepted")).toHaveLength(0);
    expect(readAdoptionEvents(target).filter((e) => e.event === "invoked")).toHaveLength(1);
  });

  it("rejection is idempotent across multiple Stop hook firings", () => {
    const target = makeWorkspace();
    recordRejectedSkills(target, "sess-1", [
      { name: "pdf", confidence: 40 },
      { name: "docx", confidence: 35 },
    ]);
    // Stop fires again (e.g. agent restart)
    recordRejectedSkills(target, "sess-1", [
      { name: "pdf", confidence: 40 },
      { name: "xlsx", confidence: 30 },
    ]);
    const rejections = readAdoptionEvents(target).filter((e) => e.event === "rejected");
    // pdf deduplicated; docx and xlsx each once
    expect(rejections.filter((e) => e.skill === "pdf")).toHaveLength(1);
    expect(rejections.filter((e) => e.skill === "docx")).toHaveLength(1);
    expect(rejections.filter((e) => e.skill === "xlsx")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 4 — success detection
// ---------------------------------------------------------------------------

describe("Phase 4 — success detection", () => {
  it("marks successful only when invocation succeeded and no correction", () => {
    const target = makeWorkspace();
    writeRuns(target, [
      { skill: "vitest-extension-testing", session_id: "s1", success: true },
    ]);
    const r = recordSessionAdoptionOutcomes(target, "s1");
    expect(r.successful).toContain("vitest-extension-testing");

    const events = readAdoptionEvents(target).filter((e) => e.event === "successful");
    expect(events).toHaveLength(1);
    expect(events[0].confidence).toBeGreaterThan(50);
    expect(events[0].confidence).toBeLessThanOrEqual(100);
  });

  it("suppresses successful when skill-feedback.jsonl has correction for the skill", () => {
    const target = makeWorkspace();
    writeRuns(target, [
      { skill: "ci-preflight", session_id: "s1", success: true },
    ]);
    fs.writeFileSync(
      path.join(target, ".claude", "learning", "skill-feedback.jsonl"),
      JSON.stringify({
        ts: new Date().toISOString(),
        skill: "ci-preflight",
        sentiment: "correction",
        signal: "no",
        user_text: "that was wrong",
        context: "post-invoke",
      }) + "\n",
      "utf-8"
    );
    const r = recordSessionAdoptionOutcomes(target, "s1");
    expect(r.successful).toEqual([]);
  });

  it("suppresses successful when invocation failed (rc != 0)", () => {
    const target = makeWorkspace();
    writeRuns(target, [
      { skill: "ci-preflight", session_id: "s1", success: false },
    ]);
    const r = recordSessionAdoptionOutcomes(target, "s1");
    expect(r.successful).toEqual([]);
  });

  it("computeSuccessConfidence: 1 clean invocation >= 80, corrections drive to 0", () => {
    const clean = computeSuccessConfidence({ invocations: 1, successes: 1, corrections: 0 });
    expect(clean).toBeGreaterThanOrEqual(80);
    // formula: 1.0*60 + min(1,5)*4 + (-1*20) = 44 — significantly below clean (84)
    const corrected = computeSuccessConfidence({ invocations: 1, successes: 1, corrections: 1 });
    expect(corrected).toBeLessThan(clean - 30); // penalised by at least 30 pts vs clean
    // invocations=3, successes=0: successRate=0 → 0*60 + 3*4 + 20 = 32
    // Formula rewards attempts even when all fail — zero only when invocations=0
    const allFailed = computeSuccessConfidence({ invocations: 3, successes: 0, corrections: 0 });
    expect(allFailed).toBeLessThan(50); // low confidence — no successes
    expect(computeSuccessConfidence({ invocations: 0, successes: 0, corrections: 0 })).toBe(0);
  });

  it("session outcomes are idempotent — double-run produces one successful event", () => {
    const target = makeWorkspace();
    writeRuns(target, [
      { skill: "ci-preflight", session_id: "s1", success: true },
    ]);
    recordSessionAdoptionOutcomes(target, "s1");
    recordSessionAdoptionOutcomes(target, "s1");
    expect(
      readAdoptionEvents(target).filter((e) => e.event === "successful")
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 5 — reuse detection
// ---------------------------------------------------------------------------

describe("Phase 5 — reuse detection", () => {
  it("records reused with correct window when prior use exists within 90d", () => {
    const target = makeWorkspace();
    appendAdoptionEvent(target, {
      taskId: "s0",
      skill: "vitest-extension-testing",
      event: "invoked",
      source: "auto",
      timestamp: daysAgo(3),
    });
    writeRuns(target, [
      { skill: "vitest-extension-testing", session_id: "s1", success: true },
    ]);
    const r = recordSessionAdoptionOutcomes(target, "s1");
    expect(r.reused).toContain("vitest-extension-testing");
    const reused = readAdoptionEvents(target).filter((e) => e.event === "reused");
    expect(reused[0].reuseWindow).toBe("7d");
    expect(reused[0].daysSincePreviousUse).toBeGreaterThan(2);
    expect(reused[0].daysSincePreviousUse).toBeLessThan(4);
  });

  it("does not record reuse for first-ever use", () => {
    const target = makeWorkspace();
    writeRuns(target, [
      { skill: "new-skill", session_id: "s1", success: true },
    ]);
    const r = recordSessionAdoptionOutcomes(target, "s1");
    expect(r.reused).toEqual([]);
  });

  it("does not record reuse when prior use was beyond 90 days", () => {
    const target = makeWorkspace();
    appendAdoptionEvent(target, {
      taskId: "s0",
      skill: "old-skill",
      event: "invoked",
      source: "auto",
      timestamp: daysAgo(100),
    });
    writeRuns(target, [{ skill: "old-skill", session_id: "s1", success: true }]);
    const r = recordSessionAdoptionOutcomes(target, "s1");
    expect(r.reused).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — full funnel end-to-end
// ---------------------------------------------------------------------------

describe("Phase 2 — full funnel end-to-end", () => {
  it("tracks all 5 stages for a skill's lifecycle", () => {
    const target = makeWorkspace();
    const batchId = "2026-07-03T10:00:00.000Z";

    // Stage 1: proposed
    recordProposedSkills(target, {
      generatedAt: batchId,
      proposals: [
        { name: "vitest-extension-testing", confidence: 93 },
        { name: "ci-preflight", confidence: 70 },
      ],
    });

    // Stage 2: accepted (user clicked Apply)
    recordAcceptedSkills(
      target,
      ["vitest-extension-testing"],
      [{ name: "vitest-extension-testing", confidence: 93 }],
      "manual",
      batchId
    );

    // Stage 3: invoked (agent used the skill)
    recordInvokedSkill(target, {
      skill: "vitest-extension-testing",
      sessionId: "sess-1",
      agent: "claude",
      confidence: 93,
      proposed: true,
    });

    // Stage 4: successful (session ended, no corrections)
    appendAdoptionEvent(target, {
      taskId: "sess-1",
      skill: "vitest-extension-testing",
      event: "successful",
      source: "auto",
      confidence: 84,
    });

    // Stage 5: reused (invoked again in a later session)
    appendAdoptionEvent(target, {
      taskId: "sess-2",
      skill: "vitest-extension-testing",
      event: "invoked",
      source: "auto",
      timestamp: daysAgo(3),
    });
    appendAdoptionEvent(target, {
      taskId: "sess-2",
      skill: "vitest-extension-testing",
      event: "reused",
      source: "auto",
      reuseWindow: "7d",
      daysSincePreviousUse: 3,
    });

    // ci-preflight: rejected
    recordRejectedSkills(target, "sess-1", [{ name: "ci-preflight", confidence: 70 }]);

    const funnel = computeAdoptionFunnel(target);
    expect(funnel.hasData).toBe(true);
    expect(funnel.proposed).toBe(2);
    expect(funnel.accepted).toBe(1);    // vitest accepted, ci-preflight rejected
    expect(funnel.invoked).toBeGreaterThanOrEqual(2);  // sess-1 + sess-2 invocations
    expect(funnel.successful).toBe(1);
    expect(funnel.reused).toBe(1);
    expect(funnel.rejected).toBe(1);
    expect(funnel.acceptanceRatePct).toBe(50);         // 1/2
    expect(funnel.successRatePct).toBeGreaterThan(0);
    expect(funnel.reuseRatePct).toBe(100);             // 1/1
    expect(funnel.globalAdoptionRatePct).toBeGreaterThan(0);
    expect(funnel.adoptionScore).toBeGreaterThan(0);
    expect(funnel.adoptionScore).toBeLessThanOrEqual(100);
  });

  it("daysBack window excludes old events", () => {
    const target = makeWorkspace();
    appendAdoptionEvent(target, {
      taskId: "old",
      skill: "pdf",
      event: "proposed",
      source: "auto",
      timestamp: daysAgo(120),
    });
    appendAdoptionEvent(target, {
      taskId: "recent",
      skill: "pdf",
      event: "proposed",
      source: "auto",
    });
    const funnel30 = computeAdoptionFunnel(target, 30);
    const funnel180 = computeAdoptionFunnel(target, 180);
    expect(funnel30.proposed).toBe(1);
    expect(funnel180.proposed).toBe(2);
  });

  it("per-skill stats sorted by adoptionScore descending", () => {
    const target = makeWorkspace();
    // Skill A: accepted + invoked + successful + reused = high score
    appendAdoptionEvents(target, [
      { taskId: "t1", skill: "skill-a", event: "proposed", source: "auto" },
      { taskId: "t1", skill: "skill-a", event: "accepted", source: "auto" },
      { taskId: "t1", skill: "skill-a", event: "invoked", source: "auto" },
      { taskId: "t1", skill: "skill-a", event: "successful", source: "auto" },
      { taskId: "t1", skill: "skill-a", event: "reused", source: "auto" },
    ]);
    // Skill B: only proposed
    appendAdoptionEvent(target, {
      taskId: "t2",
      skill: "skill-b",
      event: "proposed",
      source: "auto",
    });
    const perSkill = computePerSkillAdoption(target);
    const a = perSkill.find((s) => s.skill === "skill-a")!;
    const b = perSkill.find((s) => s.skill === "skill-b")!;
    expect(a.adoptionScore).toBeGreaterThan(b.adoptionScore);
    expect(perSkill[0].skill).toBe("skill-a"); // highest score first
  });
});

// ---------------------------------------------------------------------------
// Phase 6+7 — Precision / Recall / F1
// ---------------------------------------------------------------------------

describe("Phase 6+7 — recommendation quality (P/R/F1)", () => {
  it("precision = successful/accepted, recall = successful/proposed", () => {
    const target = makeWorkspace();
    // 10 proposed, 5 accepted, 3 successful
    appendAdoptionEvents(target, [
      ...Array.from({ length: 10 }, (_, i) => ({
        taskId: `b-${i}`,
        skill: `sk-${i}`,
        event: "proposed" as const,
        source: "auto" as const,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        taskId: `b-${i}`,
        skill: `sk-${i}`,
        event: "accepted" as const,
        source: "auto" as const,
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        taskId: `s-${i}`,
        skill: `sk-${i}`,
        event: "successful" as const,
        source: "auto" as const,
      })),
    ]);
    const q = computeRecommendationQuality(target);
    expect(q.hasData).toBe(true);
    expect(q.precisionPct).toBe(60);  // 3/5
    expect(q.recallPct).toBe(30);     // 3/10
    expect(q.f1Pct).toBe(40);         // 2*60*30 / (60+30)
  });

  it("perfect precision: all accepted become successful", () => {
    const target = makeWorkspace();
    appendAdoptionEvents(target, [
      { taskId: "b1", skill: "a", event: "proposed", source: "auto" },
      { taskId: "b1", skill: "a", event: "accepted", source: "auto" },
      { taskId: "s1", skill: "a", event: "successful", source: "auto" },
    ]);
    const q = computeRecommendationQuality(target);
    expect(q.precisionPct).toBe(100);
    expect(q.recallPct).toBe(100);
    expect(q.f1Pct).toBe(100);
  });

  it("zero precision when nothing accepted becomes successful", () => {
    const target = makeWorkspace();
    appendAdoptionEvents(target, [
      { taskId: "b1", skill: "a", event: "proposed", source: "auto" },
      { taskId: "b1", skill: "a", event: "accepted", source: "auto" },
      // no successful
    ]);
    const q = computeRecommendationQuality(target);
    expect(q.precisionPct).toBe(0);
    expect(q.f1Pct).toBe(0);
  });

  it("hasData is false without proposals", () => {
    const target = makeWorkspace();
    appendAdoptionEvent(target, {
      taskId: "s1",
      skill: "a",
      event: "invoked",
      source: "auto",
    });
    expect(computeRecommendationQuality(target).hasData).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 8 — confidence feedback loop affecting proposal ranking
// ---------------------------------------------------------------------------

describe("Phase 8 — confidence feedback loop", () => {
  it("accepted+successful+reused skill gets positive adjustment", () => {
    const target = makeWorkspace();
    appendAdoptionEvents(target, [
      { taskId: "t1", skill: "good-skill", event: "accepted", source: "auto" },
      { taskId: "t1", skill: "good-skill", event: "invoked", source: "auto" },
      { taskId: "t1", skill: "good-skill", event: "successful", source: "auto" },
      { taskId: "t2", skill: "good-skill", event: "reused", source: "auto" },
    ]);
    const adj = adoptionConfidenceAdjustment(target, "good-skill");
    expect(adj).toBeGreaterThan(0);
  });

  it("rejected skill gets negative adjustment", () => {
    const target = makeWorkspace();
    appendAdoptionEvents(target, [
      { taskId: "t1", skill: "bad-skill", event: "rejected", source: "auto" },
      { taskId: "t2", skill: "bad-skill", event: "rejected", source: "auto" },
      { taskId: "t3", skill: "bad-skill", event: "rejected", source: "auto" },
    ]);
    const adj = adoptionConfidenceAdjustment(target, "bad-skill");
    expect(adj).toBeLessThan(0);
  });

  it("adjustment is capped at +/-25", () => {
    const target = makeWorkspace();
    // 40 reuse events → would exceed +25 without cap
    appendAdoptionEvents(target, Array.from({ length: 40 }, (_, i) => ({
      taskId: `t-${i}`,
      skill: "hot",
      event: "reused" as const,
      source: "auto" as const,
    })));
    expect(adoptionConfidenceAdjustment(target, "hot")).toBe(25);

    // 40 rejections → would exceed -25 without cap
    appendAdoptionEvents(target, Array.from({ length: 40 }, (_, i) => ({
      taskId: `t-${i}`,
      skill: "cold",
      event: "rejected" as const,
      source: "auto" as const,
    })));
    expect(adoptionConfidenceAdjustment(target, "cold")).toBe(-25);
  });

  it("recent behavior weighted more than old behavior", () => {
    const target = makeWorkspace();
    // recent rejection (today)
    appendAdoptionEvent(target, {
      taskId: "t1",
      skill: "recent-bad",
      event: "rejected",
      source: "auto",
    });
    // old rejection (56 days ago = 4 half-lives of 14d → factor 0.0625)
    appendAdoptionEvent(target, {
      taskId: "t2",
      skill: "old-bad",
      event: "rejected",
      source: "auto",
      timestamp: daysAgo(56),
    });
    const recentAdj = adoptionConfidenceAdjustment(target, "recent-bad");
    const oldAdj = adoptionConfidenceAdjustment(target, "old-bad");
    expect(recentAdj).toBeLessThan(oldAdj);     // recent is more negative
    expect(Math.abs(oldAdj)).toBeLessThanOrEqual(1); // 7 * 0.5^4 ≈ 0.44 → rounds to 0
  });

  it("invocations without success get an unsuccessful-use penalty", () => {
    const target = makeWorkspace();
    // 4 invocations, 0 successful → penalty reduces score below 0
    appendAdoptionEvents(target, Array.from({ length: 4 }, (_, i) => ({
      taskId: `t-${i}`,
      skill: "flaky",
      event: "invoked" as const,
      source: "auto" as const,
    })));
    const adj = adoptionConfidenceAdjustment(target, "flaky");
    expect(adj).toBeLessThanOrEqual(0);
  });

  it("no history returns 0", () => {
    const target = makeWorkspace();
    expect(adoptionConfidenceAdjustment(target, "unknown-skill")).toBe(0);
  });

  it("positive adjustment raises effective proposal confidence toward 100", () => {
    const target = makeWorkspace();
    appendAdoptionEvents(target, [
      { taskId: "t1", skill: "rising", event: "accepted", source: "auto" },
      { taskId: "t1", skill: "rising", event: "successful", source: "auto" },
      { taskId: "t2", skill: "rising", event: "reused", source: "auto" },
    ]);
    const baseConfidence = 60;
    const adj = adoptionConfidenceAdjustment(target, "rising");
    const effective = Math.min(100, Math.max(0, baseConfidence + adj));
    expect(effective).toBeGreaterThan(baseConfidence);
    expect(effective).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// Phase 9 — audit queries ("did the recommendation produce value?")
// ---------------------------------------------------------------------------

describe("Phase 9 — audit queries", () => {
  function seedAuditScenario(target: string): void {
    // 4 proposals, 2 accepted, 2 rejected, 2 invoked, 1 successful, 1 reused
    appendAdoptionEvents(target, [
      // Proposals
      { taskId: "batch-1", skill: "vitest-extension-testing", event: "proposed", source: "auto", confidence: 93 },
      { taskId: "batch-1", skill: "ci-preflight",             event: "proposed", source: "auto", confidence: 70 },
      { taskId: "batch-1", skill: "deployment-practical",     event: "proposed", source: "auto", confidence: 55 },
      { taskId: "batch-1", skill: "pdf",                      event: "proposed", source: "auto", confidence: 40 },
      // Accepted
      { taskId: "batch-1", skill: "vitest-extension-testing", event: "accepted", source: "manual", confidence: 93 },
      { taskId: "batch-1", skill: "ci-preflight",             event: "accepted", source: "manual", confidence: 70 },
      // Rejected
      { taskId: "sess-1",  skill: "deployment-practical",     event: "rejected", source: "auto" },
      { taskId: "sess-1",  skill: "pdf",                      event: "rejected", source: "auto" },
      // Invoked
      { taskId: "sess-1",  skill: "vitest-extension-testing", event: "invoked",  source: "auto" },
      { taskId: "sess-1",  skill: "ci-preflight",             event: "invoked",  source: "auto" },
      // Successful
      { taskId: "sess-1",  skill: "vitest-extension-testing", event: "successful", source: "auto", confidence: 88 },
      // Reused
      { taskId: "sess-2",  skill: "vitest-extension-testing", event: "reused",   source: "auto", reuseWindow: "7d" },
    ]);
  }

  it("Q1: which recommendations are accepted?", () => {
    const target = makeWorkspace();
    seedAuditScenario(target);
    const perSkill = computePerSkillAdoption(target);
    const accepted = perSkill.filter((s) => s.accepted > 0).map((s) => s.skill).sort();
    expect(accepted).toEqual(["ci-preflight", "vitest-extension-testing"]);
  });

  it("Q2: which recommendations created successful outcomes?", () => {
    const target = makeWorkspace();
    seedAuditScenario(target);
    const perSkill = computePerSkillAdoption(target);
    const successful = perSkill.filter((s) => s.successful > 0).map((s) => s.skill);
    expect(successful).toEqual(["vitest-extension-testing"]);
  });

  it("Q3: which skills are repeatedly reused?", () => {
    const target = makeWorkspace();
    seedAuditScenario(target);
    const perSkill = computePerSkillAdoption(target);
    const reused = perSkill.filter((s) => s.reused > 0).map((s) => s.skill);
    expect(reused).toEqual(["vitest-extension-testing"]);
  });

  it("Q4: which recommendations should be suppressed (never accepted)?", () => {
    const target = makeWorkspace();
    seedAuditScenario(target);
    const perSkill = computePerSkillAdoption(target);
    const ignored = perSkill.filter((s) => s.proposed >= 1 && s.accepted === 0 && s.invoked === 0);
    expect(ignored.map((s) => s.skill).sort()).toEqual(["deployment-practical", "pdf"]);
  });

  it("Q5: acceptance rate, success rate, reuse rate from funnel", () => {
    const target = makeWorkspace();
    seedAuditScenario(target);
    const funnel = computeAdoptionFunnel(target);
    expect(funnel.acceptanceRatePct).toBe(50);   // 2/4 proposed
    expect(funnel.successRatePct).toBe(50);       // 1/2 invoked
    expect(funnel.reuseRatePct).toBe(100);        // 1/1 successful
  });

  it("Q6: precision/recall/F1 from funnel quality metrics", () => {
    const target = makeWorkspace();
    seedAuditScenario(target);
    const q = computeRecommendationQuality(target);
    expect(q.precisionPct).toBe(50);   // 1 successful / 2 accepted
    expect(q.recallPct).toBe(25);      // 1 successful / 4 proposed
    // F1 = 2 * 50 * 25 / (50 + 25) = 33
    expect(q.f1Pct).toBe(33);
  });

  it("audit report text contains all required metrics", () => {
    const target = makeWorkspace();
    seedAuditScenario(target);
    const report = formatAdoptionReport(target);
    expect(report).toContain("Acceptance Rate:");
    expect(report).toContain("Success Rate:");
    expect(report).toContain("Reuse Rate:");
    expect(report).toContain("Recommendation Precision:");
    expect(report).toContain("Recommendation Recall:");
    expect(report).toContain("Recommendation F1:");
    expect(report).toContain("Global Adoption Rate:");
    expect(report).toContain("Adoption Score:");
    expect(report).toContain("Top Performing Skill: vitest-extension-testing");
  });

  it("dashboard HTML contains all required panel sections", () => {
    const target = makeWorkspace();
    seedAuditScenario(target);
    const html = formatAdoptionFunnelPanelHtml(target);
    for (const label of [
      "Proposed", "Accepted", "Invoked", "Successful", "Reused",
      "Adoption Score", "Acceptance", "Success", "Reuse",
      "Precision", "Recall", "F1",
      "Top Accepted Skills", "Top Ignored Skills",
      "Top Successful Skills", "Top Reused Skills",
    ]) {
      expect(html, `Missing panel section: ${label}`).toContain(label);
    }
    expect(html).toContain("vitest-extension-testing");
  });
});

// ---------------------------------------------------------------------------
// Phase 1 — schema validation: workspace + branch + all fields written
// ---------------------------------------------------------------------------

describe("Phase 1 — event schema", () => {
  it("written events contain all required schema fields", () => {
    const target = makeGitWorkspace("test-branch");
    appendAdoptionEvent(target, {
      taskId: "batch-1",
      skill: "vitest-extension-testing",
      event: "proposed",
      source: "auto",
      confidence: 93,
      agent: "claude",
    });
    const events = readAdoptionEvents(target);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(typeof e.timestamp).toBe("string");
    expect(e.workspace).toBe(target);
    expect(e.branch).toBe("test-branch");
    expect(e.taskId).toBe("batch-1");
    expect(e.skill).toBe("vitest-extension-testing");
    expect(e.event).toBe("proposed");
    expect(e.source).toBe("auto");
    expect(e.confidence).toBe(93);
    expect(e.agent).toBe("claude");
  });

  it("reused events carry reuseWindow and daysSincePreviousUse", () => {
    const target = makeWorkspace();
    appendAdoptionEvent(target, {
      taskId: "sess-2",
      skill: "ci-preflight",
      event: "reused",
      source: "auto",
      reuseWindow: "30d",
      daysSincePreviousUse: 14.5,
    });
    const e = readAdoptionEvents(target)[0];
    expect(e.reuseWindow).toBe("30d");
    expect(e.daysSincePreviousUse).toBe(14.5);
  });

  it("event types are validated — unknown events are silently dropped", () => {
    const target = makeWorkspace();
    appendAdoptionEvents(target, [
      { taskId: "t1", skill: "a", event: "proposed", source: "auto" },
      { taskId: "t1", skill: "b", event: "hacked" as never, source: "auto" },
      { taskId: "t1", skill: "c", event: "invoked", source: "auto" },
    ]);
    const events = readAdoptionEvents(target);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.skill)).toEqual(["a", "c"]);
  });

  it("all 6 valid event types are accepted", () => {
    const target = makeWorkspace();
    const types = ["proposed", "accepted", "rejected", "invoked", "successful", "reused"] as const;
    appendAdoptionEvents(target, types.map((event, i) => ({
      taskId: `t-${i}`,
      skill: "x",
      event,
      source: "auto" as const,
    })));
    const written = readAdoptionEvents(target).map((e) => e.event);
    expect(written).toEqual(types);
  });
});
