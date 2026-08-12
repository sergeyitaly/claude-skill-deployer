import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  adoptionConfidenceAdjustment,
  adoptionLogPath,
  appendAdoptionEvent,
  appendAdoptionEvents,
  backfillMissedAdoptionOutcomes,
  classifyReuseWindow,
  computeAdoptionFunnel,
  computePerSkillAdoption,
  computeRecommendationQuality,
  computeSuccessConfidence,
  formatAdoptionFunnelPanelHtml,
  formatAdoptionReport,
  getSkillReuseStats,
  readAdoptionEvents,
  recordAcceptedSkills,
  recordInvokedSkill,
  recordProposedSkills,
  recordRejectedSkills,
  recordSessionAdoptionOutcomes,
} from "./skillAdoption";

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-adoption-"));
  fs.mkdirSync(path.join(dir, ".claude", "learning"), { recursive: true });
  return dir;
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
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
// Phase 1: event store
// ---------------------------------------------------------------------------

describe("adoption event store", () => {
  it("auto-creates the file and appends/reads events", () => {
    const target = makeWorkspace();
    expect(fs.existsSync(adoptionLogPath(target))).toBe(false);
    appendAdoptionEvent(target, {
      taskId: "s1",
      skill: "vitest-extension-testing",
      event: "invoked",
      source: "auto",
      confidence: 80,
      agent: "claude",
    });
    expect(fs.existsSync(adoptionLogPath(target))).toBe(true);
    const events = readAdoptionEvents(target);
    expect(events).toHaveLength(1);
    expect(events[0].skill).toBe("vitest-extension-testing");
    expect(events[0].event).toBe("invoked");
    expect(events[0].workspace).toBe(target);
    expect(typeof events[0].timestamp).toBe("string");
    expect(new Date(events[0].timestamp).getTime()).not.toBeNaN();
  });

  it("tolerates corrupt lines and invalid records", () => {
    const target = makeWorkspace();
    appendAdoptionEvent(target, { taskId: "s1", skill: "a", event: "proposed", source: "auto" });
    fs.appendFileSync(adoptionLogPath(target), "{not json}\n", "utf-8");
    fs.appendFileSync(adoptionLogPath(target), JSON.stringify({ skill: "x", event: "bogus" }) + "\n", "utf-8");
    fs.appendFileSync(adoptionLogPath(target), JSON.stringify({ event: "invoked" }) + "\n", "utf-8");
    appendAdoptionEvent(target, { taskId: "s2", skill: "b", event: "invoked", source: "manual" });
    const events = readAdoptionEvents(target);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.skill)).toEqual(["a", "b"]);
  });

  it("drops entries with invalid event types at write time", () => {
    const target = makeWorkspace();
    appendAdoptionEvents(target, [
      { taskId: "s1", skill: "a", event: "nonsense" as never, source: "auto" },
    ]);
    expect(readAdoptionEvents(target)).toHaveLength(0);
  });

  it("returns [] for a missing file", () => {
    const target = makeWorkspace();
    expect(readAdoptionEvents(target)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 2/3: proposal, acceptance, rejection recording
// ---------------------------------------------------------------------------

describe("proposal recording", () => {
  it("records one proposed event per skill in a batch", () => {
    const target = makeWorkspace();
    const recorded = recordProposedSkills(target, {
      generatedAt: "2026-07-01T10:00:00.000Z",
      proposals: [
        { name: "vitest-extension-testing", confidence: 80 },
        { name: "ci-preflight", confidence: 55 },
      ],
    });
    expect(recorded).toBe(true);
    const events = readAdoptionEvents(target);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.event === "proposed")).toBe(true);
    expect(events[0].confidence).toBe(80);
    expect(events[0].taskId).toBe("2026-07-01T10:00:00.000Z");
  });

  it("dedupes repeated writes of the same batch (generatedAt)", () => {
    const target = makeWorkspace();
    const batch = {
      generatedAt: "2026-07-01T10:00:00.000Z",
      proposals: [{ name: "ci-preflight", confidence: 60 }],
    };
    expect(recordProposedSkills(target, batch)).toBe(true);
    expect(recordProposedSkills(target, batch)).toBe(false);
    expect(readAdoptionEvents(target)).toHaveLength(1);

    // A new batch id records again
    expect(
      recordProposedSkills(target, { ...batch, generatedAt: "2026-07-01T11:00:00.000Z" })
    ).toBe(true);
    expect(readAdoptionEvents(target)).toHaveLength(2);
  });
});

describe("acceptance recording", () => {
  it("records accepted only for skills that were proposed", () => {
    const target = makeWorkspace();
    const proposals = [
      { name: "ci-preflight", confidence: 60 },
      { name: "pdf", confidence: 40 },
    ];
    const n = recordAcceptedSkills(
      target,
      ["ci-preflight", "never-proposed-skill"],
      proposals,
      "manual",
      "batch-1"
    );
    expect(n).toBe(1);
    const events = readAdoptionEvents(target);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "accepted",
      skill: "ci-preflight",
      source: "manual",
      confidence: 60,
      taskId: "batch-1",
    });
  });

  it("is idempotent per (batch, skill)", () => {
    const target = makeWorkspace();
    const proposals = [{ name: "ci-preflight", confidence: 60 }];
    expect(recordAcceptedSkills(target, ["ci-preflight"], proposals, "auto", "b1")).toBe(1);
    expect(recordAcceptedSkills(target, ["ci-preflight"], proposals, "auto", "b1")).toBe(0);
    expect(readAdoptionEvents(target)).toHaveLength(1);
  });
});

describe("rejection recording", () => {
  it("records rejected events for dismissed proposals", () => {
    const target = makeWorkspace();
    recordRejectedSkills(target, "sess-1", [{ name: "pdf", confidence: 40 }, { name: "docx" }]);
    const events = readAdoptionEvents(target);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.event === "rejected" && e.taskId === "sess-1")).toBe(true);
  });

  it("is idempotent per (session, skill) across repeated Stop firings", () => {
    const target = makeWorkspace();
    recordRejectedSkills(target, "sess-1", [{ name: "pdf" }]);
    recordRejectedSkills(target, "sess-1", [{ name: "pdf" }, { name: "docx" }]);
    const events = readAdoptionEvents(target);
    expect(events.filter((e) => e.skill === "pdf")).toHaveLength(1);
    expect(events.filter((e) => e.skill === "docx")).toHaveLength(1);

    // A different session records its own rejection
    recordRejectedSkills(target, "sess-2", [{ name: "pdf" }]);
    expect(readAdoptionEvents(target).filter((e) => e.skill === "pdf")).toHaveLength(2);
  });
});

describe("invocation recording", () => {
  it("records an implicit acceptance for proposed skills on first invocation", () => {
    const target = makeWorkspace();
    recordInvokedSkill(target, {
      skill: "ci-preflight",
      sessionId: "sess-1",
      agent: "claude",
      confidence: 70,
      proposed: true,
    });
    const events = readAdoptionEvents(target);
    expect(events.map((e) => e.event)).toEqual(["accepted", "invoked"]);

    // Second invocation: acceptance already exists, only invoked is added
    recordInvokedSkill(target, { skill: "ci-preflight", sessionId: "sess-2", proposed: true });
    expect(readAdoptionEvents(target).filter((e) => e.event === "accepted")).toHaveLength(1);
    expect(readAdoptionEvents(target).filter((e) => e.event === "invoked")).toHaveLength(2);
  });

  it("does not record acceptance for non-proposed invocations", () => {
    const target = makeWorkspace();
    recordInvokedSkill(target, { skill: "pdf", sessionId: "sess-1", proposed: false });
    const events = readAdoptionEvents(target);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("invoked");
  });
});

// ---------------------------------------------------------------------------
// Phase 4: success detection
// ---------------------------------------------------------------------------

describe("success detection", () => {
  it("computeSuccessConfidence rewards clean successes and punishes corrections", () => {
    expect(computeSuccessConfidence({ invocations: 0, successes: 0, corrections: 0 })).toBe(0);
    const clean = computeSuccessConfidence({ invocations: 1, successes: 1, corrections: 0 });
    expect(clean).toBeGreaterThanOrEqual(80);
    const corrected = computeSuccessConfidence({ invocations: 1, successes: 1, corrections: 2 });
    expect(corrected).toBeLessThan(clean - 30);
    expect(computeSuccessConfidence({ invocations: 5, successes: 0, corrections: 3 })).toBe(0);
    for (const c of [clean, corrected]) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(100);
    }
  });

  it("records successful with a confidence score for clean session invocations", () => {
    const target = makeWorkspace();
    writeRuns(target, [
      { skill: "ci-preflight", session_id: "sess-1", success: true },
      { skill: "ci-preflight", session_id: "sess-1", success: true },
    ]);
    const result = recordSessionAdoptionOutcomes(target, "sess-1");
    expect(result.successful).toEqual(["ci-preflight"]);
    const events = readAdoptionEvents(target).filter((e) => e.event === "successful");
    expect(events).toHaveLength(1);
    expect(events[0].confidence).toBeGreaterThan(50);
    expect(events[0].taskId).toBe("sess-1");
  });

  it("does not record successful when correction feedback exists for the skill", () => {
    const target = makeWorkspace();
    writeRuns(target, [{ skill: "ci-preflight", session_id: "sess-1", success: true }]);
    fs.writeFileSync(
      path.join(target, ".claude", "learning", "skill-feedback.jsonl"),
      JSON.stringify({
        ts: new Date().toISOString(),
        skill: "ci-preflight",
        sentiment: "correction",
        signal: "wrong",
        user_text: "wrong approach",
      }) + "\n",
      "utf-8"
    );
    const result = recordSessionAdoptionOutcomes(target, "sess-1");
    expect(result.successful).toEqual([]);
    expect(readAdoptionEvents(target).filter((e) => e.event === "successful")).toHaveLength(0);
  });

  it("does not record successful when all invocations failed", () => {
    const target = makeWorkspace();
    writeRuns(target, [{ skill: "ci-preflight", session_id: "sess-1", success: false }]);
    const result = recordSessionAdoptionOutcomes(target, "sess-1");
    expect(result.successful).toEqual([]);
  });

  it("is idempotent per session", () => {
    const target = makeWorkspace();
    writeRuns(target, [{ skill: "ci-preflight", session_id: "sess-1", success: true }]);
    recordSessionAdoptionOutcomes(target, "sess-1");
    recordSessionAdoptionOutcomes(target, "sess-1");
    expect(readAdoptionEvents(target).filter((e) => e.event === "successful")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Backfill: a workspace whose Stop hook was never installed (before 1.0.145)
// ---------------------------------------------------------------------------

describe("backfillMissedAdoptionOutcomes", () => {
  it("retroactively records successful/reused outcomes for every historical session, reproducing the reported contradiction (runs.jsonl 100% vs funnel 0%) as fixed", () => {
    const target = makeWorkspace();
    // Three distinct sessions, none of which ever had recordSessionAdoptionOutcomes() run —
    // exactly the state of a workspace whose Stop hook was never installed.
    writeRuns(target, [
      { skill: "ci-preflight", session_id: "sess-old-1", success: true, ts: isoDaysAgo(10) },
      { skill: "ci-preflight", session_id: "sess-old-2", success: true, ts: isoDaysAgo(5) },
      { skill: "pdf", session_id: "sess-old-3", success: true, ts: isoDaysAgo(1) },
    ]);

    const result = backfillMissedAdoptionOutcomes(target);

    expect(result).not.toBeNull();
    expect(result?.sessionsProcessed).toBe(3);
    expect(result?.successful).toBe(3);
    const successEvents = readAdoptionEvents(target).filter((e) => e.event === "successful");
    expect(successEvents.map((e) => e.taskId).sort()).toEqual(["sess-old-1", "sess-old-2", "sess-old-3"]);
  });

  it("is a one-time no-op on the second call — does not re-scan or duplicate events", () => {
    const target = makeWorkspace();
    writeRuns(target, [{ skill: "ci-preflight", session_id: "sess-1", success: true }]);

    const first = backfillMissedAdoptionOutcomes(target);
    expect(first?.successful).toBe(1);

    const second = backfillMissedAdoptionOutcomes(target);
    expect(second).toBeNull();
    expect(readAdoptionEvents(target).filter((e) => e.event === "successful")).toHaveLength(1);
  });

  it("does not duplicate outcomes for a session that already had them recorded normally", () => {
    const target = makeWorkspace();
    writeRuns(target, [{ skill: "ci-preflight", session_id: "sess-1", success: true }]);
    // Simulates a workspace where the Stop hook DID fire for this session already.
    recordSessionAdoptionOutcomes(target, "sess-1");
    expect(readAdoptionEvents(target).filter((e) => e.event === "successful")).toHaveLength(1);

    const result = backfillMissedAdoptionOutcomes(target);

    expect(result?.successful).toBe(0); // already recorded — correctly a no-op for this session
    expect(readAdoptionEvents(target).filter((e) => e.event === "successful")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 5: reuse detection
// ---------------------------------------------------------------------------

describe("reuse detection", () => {
  it("classifies reuse windows", () => {
    expect(classifyReuseWindow(3)).toBe("7d");
    expect(classifyReuseWindow(7)).toBe("7d");
    expect(classifyReuseWindow(20)).toBe("30d");
    expect(classifyReuseWindow(60)).toBe("90d");
    expect(classifyReuseWindow(120)).toBeNull();
    expect(classifyReuseWindow(-1)).toBeNull();
  });

  it("records reused when a successful use follows a prior session use", () => {
    const target = makeWorkspace();
    // Prior use 5 days ago in another session
    appendAdoptionEvent(target, {
      taskId: "sess-0",
      skill: "ci-preflight",
      event: "invoked",
      source: "auto",
      timestamp: isoDaysAgo(5),
    });
    writeRuns(target, [{ skill: "ci-preflight", session_id: "sess-1", success: true }]);
    const result = recordSessionAdoptionOutcomes(target, "sess-1");
    expect(result.reused).toEqual(["ci-preflight"]);
    const reused = readAdoptionEvents(target).filter((e) => e.event === "reused");
    expect(reused).toHaveLength(1);
    expect(reused[0].reuseWindow).toBe("7d");
    expect(reused[0].daysSincePreviousUse).toBeGreaterThan(4);
  });

  it("classifies 30d and 90d windows from the most recent prior use", () => {
    const target = makeWorkspace();
    appendAdoptionEvent(target, {
      taskId: "sess-0",
      skill: "pdf",
      event: "invoked",
      source: "auto",
      timestamp: isoDaysAgo(45),
    });
    writeRuns(target, [{ skill: "pdf", session_id: "sess-1", success: true }]);
    recordSessionAdoptionOutcomes(target, "sess-1");
    const reused = readAdoptionEvents(target).filter((e) => e.event === "reused");
    expect(reused).toHaveLength(1);
    expect(reused[0].reuseWindow).toBe("90d");
  });

  it("does not record reuse without a prior use or beyond 90 days", () => {
    const target = makeWorkspace();
    appendAdoptionEvent(target, {
      taskId: "sess-0",
      skill: "docx",
      event: "invoked",
      source: "auto",
      timestamp: isoDaysAgo(150),
    });
    writeRuns(target, [
      { skill: "docx", session_id: "sess-1", success: true },
      { skill: "xlsx", session_id: "sess-1", success: true },
    ]);
    const result = recordSessionAdoptionOutcomes(target, "sess-1");
    expect(result.reused).toEqual([]);
  });

  it("tracks first/last use dates and reuse count", () => {
    const target = makeWorkspace();
    appendAdoptionEvents(target, [
      { taskId: "s0", skill: "pdf", event: "invoked", source: "auto", timestamp: isoDaysAgo(10) },
      { taskId: "s1", skill: "pdf", event: "invoked", source: "auto", timestamp: isoDaysAgo(2) },
      { taskId: "s1", skill: "pdf", event: "reused", source: "auto", timestamp: isoDaysAgo(2) },
    ]);
    const stats = getSkillReuseStats(target, "pdf");
    expect(stats.reuseCount).toBe(1);
    expect(stats.firstUseDate).toBe(
      readAdoptionEvents(target).find((e) => e.taskId === "s0")!.timestamp
    );
    expect(new Date(stats.lastUseDate!).getTime()).toBeGreaterThan(
      new Date(stats.firstUseDate!).getTime()
    );
  });
});

// ---------------------------------------------------------------------------
// Phase 2: funnel metrics
// ---------------------------------------------------------------------------

describe("adoption funnel", () => {
  function seedFunnel(target: string): void {
    const events: Array<[string, string]> = [];
    for (let i = 0; i < 10; i++) events.push(["proposed", `sk-${i % 5}`]);
    for (let i = 0; i < 4; i++) events.push(["accepted", `sk-${i}`]);
    for (let i = 0; i < 3; i++) events.push(["invoked", `sk-${i}`]);
    for (let i = 0; i < 2; i++) events.push(["successful", `sk-${i}`]);
    events.push(["reused", "sk-0"]);
    events.push(["rejected", "sk-4"]);
    appendAdoptionEvents(
      target,
      events.map(([event, skill], i) => ({
        taskId: `t-${i}`,
        skill,
        event: event as never,
        source: "auto" as const,
      }))
    );
  }

  it("computes stage counts and rates", () => {
    const target = makeWorkspace();
    seedFunnel(target);
    const funnel = computeAdoptionFunnel(target);
    expect(funnel.hasData).toBe(true);
    expect(funnel.proposed).toBe(10);
    expect(funnel.accepted).toBe(4);
    expect(funnel.invoked).toBe(3);
    expect(funnel.successful).toBe(2);
    expect(funnel.reused).toBe(1);
    expect(funnel.rejected).toBe(1);
    expect(funnel.acceptanceRatePct).toBe(40); // 4/10
    expect(funnel.invocationRatePct).toBe(75); // 3/4
    expect(funnel.successRatePct).toBe(67); // 2/3
    expect(funnel.reuseRatePct).toBe(50); // 1/2
    expect(funnel.globalAdoptionRatePct).toBe(30); // 3/10
    expect(funnel.adoptionScore).toBeGreaterThan(0);
    expect(funnel.adoptionScore).toBeLessThanOrEqual(100);
  });

  it("caps invocationRatePct at 100 when a skill is invoked far more than it was accepted", () => {
    // Mirrors the real-world shape: "accepted" is recorded once per skill (first-ever
    // acceptance), while "invoked" fires on every run — a skill invoked 23x after a single
    // acceptance must never render as 2300%.
    const target = makeWorkspace();
    appendAdoptionEvents(target, [
      { taskId: "t-0", skill: "vitest-extension-testing", event: "accepted", source: "auto" },
      ...Array.from({ length: 23 }, (_, i) => ({
        taskId: `t-${i}`,
        skill: "vitest-extension-testing",
        event: "invoked" as const,
        source: "auto" as const,
      })),
    ]);
    const funnel = computeAdoptionFunnel(target);
    expect(funnel.accepted).toBe(1);
    expect(funnel.invoked).toBe(23);
    expect(funnel.invocationRatePct).toBe(100);
    expect(funnel.avgInvocationsPerAcceptedSkill).toBe(23);
  });

  it("returns zero rates with no data", () => {
    const target = makeWorkspace();
    const funnel = computeAdoptionFunnel(target);
    expect(funnel.hasData).toBe(false);
    expect(funnel.acceptanceRatePct).toBe(0);
    expect(funnel.globalAdoptionRatePct).toBe(0);
  });

  it("excludes events outside the daysBack window", () => {
    const target = makeWorkspace();
    appendAdoptionEvent(target, {
      taskId: "old",
      skill: "pdf",
      event: "proposed",
      source: "auto",
      timestamp: isoDaysAgo(200),
    });
    appendAdoptionEvent(target, { taskId: "new", skill: "pdf", event: "proposed", source: "auto" });
    expect(computeAdoptionFunnel(target, 90).proposed).toBe(1);
    expect(computeAdoptionFunnel(target, 365).proposed).toBe(2);
  });

  it("aggregates per-skill stats", () => {
    const target = makeWorkspace();
    seedFunnel(target);
    const perSkill = computePerSkillAdoption(target);
    const sk0 = perSkill.find((s) => s.skill === "sk-0")!;
    expect(sk0.proposed).toBe(2);
    expect(sk0.accepted).toBe(1);
    expect(sk0.invoked).toBe(1);
    expect(sk0.successful).toBe(1);
    expect(sk0.reused).toBe(1);
    expect(sk0.acceptanceRatePct).toBe(50);
    const sk4 = perSkill.find((s) => s.skill === "sk-4")!;
    expect(sk4.rejected).toBe(1);
    expect(sk4.accepted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 7: precision / recall / F1
// ---------------------------------------------------------------------------

describe("recommendation quality", () => {
  it("computes precision, recall, and F1", () => {
    const target = makeWorkspace();
    const events: Array<[string, number]> = [
      ["proposed", 20],
      ["accepted", 10],
      ["invoked", 8],
      ["successful", 6],
    ];
    appendAdoptionEvents(
      target,
      events.flatMap(([event, n]) =>
        Array.from({ length: n }, (_, i) => ({
          taskId: `t-${event}-${i}`,
          skill: `sk-${i}`,
          event: event as never,
          source: "auto" as const,
        }))
      )
    );
    const q = computeRecommendationQuality(target);
    expect(q.hasData).toBe(true);
    expect(q.precisionPct).toBe(60); // 6/10
    expect(q.recallPct).toBe(30); // 6/20
    expect(q.f1Pct).toBe(40); // 2*60*30/90
  });

  it("caps precision at 100 when successes exceed acceptances", () => {
    const target = makeWorkspace();
    appendAdoptionEvents(target, [
      { taskId: "t1", skill: "a", event: "proposed", source: "auto" },
      { taskId: "t2", skill: "a", event: "successful", source: "auto" },
      { taskId: "t3", skill: "a", event: "successful", source: "auto" },
    ]);
    const q = computeRecommendationQuality(target);
    expect(q.precisionPct).toBeLessThanOrEqual(100);
    expect(q.recallPct).toBe(100);
  });

  it("has no data without proposals", () => {
    const target = makeWorkspace();
    expect(computeRecommendationQuality(target).hasData).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 8: exponentially weighted confidence adjustment
// ---------------------------------------------------------------------------

describe("adoptionConfidenceAdjustment", () => {
  it("returns 0 with no history", () => {
    const target = makeWorkspace();
    expect(adoptionConfidenceAdjustment(target, "pdf")).toBe(0);
  });

  it("boosts accepted/successful/reused skills and penalizes rejected skills", () => {
    const target = makeWorkspace();
    appendAdoptionEvents(target, [
      { taskId: "t1", skill: "good", event: "accepted", source: "auto" },
      { taskId: "t1", skill: "good", event: "invoked", source: "auto" },
      { taskId: "t1", skill: "good", event: "successful", source: "auto" },
      { taskId: "t2", skill: "good", event: "reused", source: "auto" },
      { taskId: "t1", skill: "bad", event: "rejected", source: "auto" },
      { taskId: "t2", skill: "bad", event: "rejected", source: "auto" },
    ]);
    expect(adoptionConfidenceAdjustment(target, "good")).toBeGreaterThan(10);
    expect(adoptionConfidenceAdjustment(target, "bad")).toBeLessThan(-5);
  });

  it("weights recent behavior higher than old behavior (exponential decay)", () => {
    const target = makeWorkspace();
    // Skill A: rejected recently; Skill B: rejected long ago (4 half-lives)
    appendAdoptionEvent(target, {
      taskId: "t1", skill: "recent-reject", event: "rejected", source: "auto",
    });
    appendAdoptionEvent(target, {
      taskId: "t2", skill: "old-reject", event: "rejected", source: "auto",
      timestamp: isoDaysAgo(56),
    });
    const recent = adoptionConfidenceAdjustment(target, "recent-reject");
    const old = adoptionConfidenceAdjustment(target, "old-reject");
    expect(recent).toBeLessThan(old); // more negative
    expect(Math.abs(old)).toBeLessThanOrEqual(1); // 7 * 0.5^4 < 0.5 rounds to 0
  });

  it("penalizes invocations that never became successful", () => {
    const target = makeWorkspace();
    appendAdoptionEvents(
      target,
      Array.from({ length: 3 }, (_, i) => ({
        taskId: `t-${i}`,
        skill: "flaky",
        event: "invoked" as const,
        source: "auto" as const,
      }))
    );
    // 3 invoked (+3 each) minus unsuccessful penalty (3 * -3) => 0
    expect(adoptionConfidenceAdjustment(target, "flaky")).toBeLessThanOrEqual(0);
  });

  it("clamps the adjustment to +/-25", () => {
    const target = makeWorkspace();
    appendAdoptionEvents(
      target,
      Array.from({ length: 30 }, (_, i) => ({
        taskId: `t-${i}`,
        skill: "hot",
        event: "reused" as const,
        source: "auto" as const,
      }))
    );
    appendAdoptionEvents(
      target,
      Array.from({ length: 30 }, (_, i) => ({
        taskId: `t-${i}`,
        skill: "cold",
        event: "rejected" as const,
        source: "auto" as const,
      }))
    );
    expect(adoptionConfidenceAdjustment(target, "hot")).toBe(25);
    expect(adoptionConfidenceAdjustment(target, "cold")).toBe(-25);
  });
});

// ---------------------------------------------------------------------------
// Phases 6 + 9: dashboard panel and report rendering
// ---------------------------------------------------------------------------

describe("rendering", () => {
  it("renders an empty-state panel and report without data", () => {
    const target = makeWorkspace();
    expect(formatAdoptionFunnelPanelHtml(target)).toContain("No adoption events yet");
    expect(formatAdoptionReport(target)).toContain("No adoption events recorded yet");
  });

  it("renders funnel stages, quality metrics, and top lists with data", () => {
    const target = makeWorkspace();
    appendAdoptionEvents(target, [
      { taskId: "b1", skill: "ci-preflight", event: "proposed", source: "auto", confidence: 70 },
      { taskId: "b1", skill: "pdf", event: "proposed", source: "auto", confidence: 40 },
      { taskId: "b1", skill: "pdf", event: "proposed", source: "auto", confidence: 40 },
      { taskId: "b1", skill: "ci-preflight", event: "accepted", source: "manual", confidence: 70 },
      { taskId: "s1", skill: "ci-preflight", event: "invoked", source: "auto" },
      { taskId: "s1", skill: "ci-preflight", event: "successful", source: "auto", confidence: 84 },
      { taskId: "s2", skill: "ci-preflight", event: "invoked", source: "auto" },
      { taskId: "s2", skill: "ci-preflight", event: "successful", source: "auto", confidence: 88 },
      { taskId: "s2", skill: "ci-preflight", event: "reused", source: "auto", reuseWindow: "7d" },
      { taskId: "s1", skill: "pdf", event: "rejected", source: "auto" },
      { taskId: "s2", skill: "pdf", event: "rejected", source: "auto" },
    ]);
    const html = formatAdoptionFunnelPanelHtml(target);
    for (const label of ["Proposed", "Accepted", "Invoked", "Successful", "Reused",
      "Adoption Score", "Precision", "Recall", "F1",
      "Top Accepted Skills", "Top Ignored Skills", "Top Successful Skills",
      "Top Reused Skills", "Least Effective Skills"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("ci-preflight");

    const report = formatAdoptionReport(target);
    expect(report).toContain("Skill Adoption Intelligence");
    expect(report).toContain("Proposed:   3");
    expect(report).toContain("Accepted:   1");
    expect(report).toContain("Invoked:    2");
    expect(report).toContain("Successful: 2");
    expect(report).toContain("Reused:     1");
    expect(report).toContain("Top Performing Skill: ci-preflight");
    expect(report).toContain("Recommendation Precision:");
    expect(report).toContain("Recommendation Recall:");
    expect(report).toContain("Recommendation F1:");
  });

  it("escapes HTML in skill names", () => {
    const target = makeWorkspace();
    appendAdoptionEvents(target, [
      { taskId: "b1", skill: "<img src=x>", event: "proposed", source: "auto" },
      { taskId: "b1", skill: "<img src=x>", event: "accepted", source: "auto" },
    ]);
    const html = formatAdoptionFunnelPanelHtml(target);
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;img src=x&gt;");
  });
});
