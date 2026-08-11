import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeAllSkillPenalties,
  confidenceCalibration,
  getDormantSkills,
} from "./proposalOutcome";
import { isDormantSkill } from "./adoptionIntelligence";
import { encodeWorkspacePath } from "./workspaceTranscripts";

const mockedHome = vi.hoisted(() => ({ value: "" }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockedHome.value || actual.homedir(),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* non-fatal */ }
  }
});

function makeTarget(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proposal-outcome-test-"));
  fs.mkdirSync(path.join(dir, ".claude", "learning"), { recursive: true });
  tempDirs.push(dir);
  return dir;
}

/** Write proposalOutcome.jsonl with the given session records. */
function writeOutcomes(
  target: string,
  records: Array<{ proposed: string[]; invoked: string[]; sessionId?: string }>
): void {
  const file = path.join(target, ".claude", "learning", "proposalOutcome.jsonl");
  const lines = records.map((r, i) => {
    const not_invoked = r.proposed.filter(s => !r.invoked.includes(s));
    return JSON.stringify({
      ts: new Date().toISOString(),
      session_id: r.sessionId ?? `session-${i}`,
      event: "session_end",
      proposed: r.proposed,
      invoked: r.invoked,
      not_invoked,
      acceptance_rate: r.proposed.length > 0 ? r.invoked.length / r.proposed.length : 0,
      skills_proposed_count: r.proposed.length,
      skills_invoked_count: r.invoked.length,
    });
  });
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");
}

/**
 * Write recommendation-feedback.jsonl entries. Defaults to reason: "ignored" — passive
 * non-use, which computeAllSkillPenalties() must NOT treat as a rejection signal (see
 * learningLoopAuditFixes.bugCondition.test.ts, isBugConditionBug3). Pass an explicit active
 * reason (e.g. "dismissed") to test the genuine extra-penalty-for-rejection path instead.
 */
function writeFeedback(
  target: string,
  entries: Array<{ skill: string; count: number; reason?: string }>
): void {
  const file = path.join(target, ".claude", "learning", "recommendation-feedback.jsonl");
  const lines: string[] = [];
  for (const { skill, count, reason } of entries) {
    for (let i = 0; i < count; i++) {
      lines.push(JSON.stringify({
        ts: new Date().toISOString(),
        session_id: "sess",
        skill,
        proposed: true,
        accepted: false,
        reason: reason ?? "ignored",
      }));
    }
  }
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");
}

/** Returns an array of N identical session records all not invoking the skill. */
function nNotInvoked(n: number, skill: string) {
  return Array.from({ length: n }, () => ({ proposed: [skill], invoked: [] as string[] }));
}

// ---------------------------------------------------------------------------
// isDormantSkill
// ---------------------------------------------------------------------------

describe("isDormantSkill", () => {
  it("returns false when skill has no history", () => {
    const target = makeTarget();
    expect(isDormantSkill(target, "unknown-skill")).toBe(false);
  });

  it("returns false when proposedCount is below the threshold (< 5)", () => {
    const target = makeTarget();
    writeOutcomes(target, nNotInvoked(4, "skill-a"));
    expect(isDormantSkill(target, "skill-a")).toBe(false);
  });

  it("returns true when proposedCount >= 5 and invokedCount === 0", () => {
    const target = makeTarget();
    writeOutcomes(target, nNotInvoked(5, "skill-a"));
    expect(isDormantSkill(target, "skill-a")).toBe(true);
  });

  it("remains true beyond the threshold (e.g. 10 proposals, 0 invocations)", () => {
    const target = makeTarget();
    writeOutcomes(target, nNotInvoked(10, "skill-a"));
    expect(isDormantSkill(target, "skill-a")).toBe(true);
  });

  it("returns false when skill has been invoked at least once regardless of proposal count", () => {
    const target = makeTarget();
    writeOutcomes(target, [
      { proposed: ["skill-a"], invoked: ["skill-a"] },
      ...nNotInvoked(9, "skill-a"),
    ]);
    expect(isDormantSkill(target, "skill-a")).toBe(false);
  });

  it("only considers the queried skill, not other skills in the same sessions", () => {
    const target = makeTarget();
    writeOutcomes(target, nNotInvoked(5, "skill-b").map(r => ({
      ...r,
      proposed: ["skill-a", "skill-b"],
    })));
    expect(isDormantSkill(target, "skill-a")).toBe(true);
    expect(isDormantSkill(target, "skill-b")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getDormantSkills
// ---------------------------------------------------------------------------

describe("getDormantSkills", () => {
  it("returns an empty set when no proposal data exists", () => {
    const target = makeTarget();
    expect(getDormantSkills(target).size).toBe(0);
  });

  it("includes a skill proposed >= 5 times with 0 invocations", () => {
    const target = makeTarget();
    writeOutcomes(target, nNotInvoked(5, "lazy-skill"));
    expect(getDormantSkills(target).has("lazy-skill")).toBe(true);
  });

  it("excludes a skill proposed fewer than 5 times even with 0 invocations", () => {
    const target = makeTarget();
    writeOutcomes(target, nNotInvoked(4, "new-skill"));
    expect(getDormantSkills(target).has("new-skill")).toBe(false);
  });

  it("excludes a skill whose acceptance rate >= 5% (1 invocation / 10 proposals = 10%)", () => {
    const target = makeTarget();
    writeOutcomes(target, [
      { proposed: ["active-skill"], invoked: ["active-skill"] },
      ...nNotInvoked(9, "active-skill"),
    ]);
    expect(getDormantSkills(target).has("active-skill")).toBe(false);
  });

  it("includes a skill at exactly the 5% boundary (acceptance < 5%)", () => {
    // 5 proposals, 0 invocations → 0% < 5% → dormant
    const target = makeTarget();
    writeOutcomes(target, nNotInvoked(5, "borderline"));
    expect(getDormantSkills(target).has("borderline")).toBe(true);
  });

  it("correctly separates dormant and non-dormant skills in the same sessions", () => {
    const target = makeTarget();
    writeOutcomes(target, [
      { proposed: ["dormant-skill", "active-skill"], invoked: ["active-skill"] },
      ...Array.from({ length: 4 }, () => ({
        proposed: ["dormant-skill", "active-skill"],
        invoked: [] as string[],
      })),
    ]);
    const dormant = getDormantSkills(target);
    expect(dormant.has("dormant-skill")).toBe(true);
    expect(dormant.has("active-skill")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// confidenceCalibration
// ---------------------------------------------------------------------------

describe("confidenceCalibration", () => {
  it("returns 1.0 when skill has no proposal history (no data)", () => {
    const target = makeTarget();
    expect(confidenceCalibration(target, "unknown-skill")).toBe(1.0);
  });

  it("returns 1.0 when proposed sessions < 3 (insufficient signal)", () => {
    const target = makeTarget();
    writeOutcomes(target, nNotInvoked(2, "skill-x"));
    expect(confidenceCalibration(target, "skill-x")).toBe(1.0);
  });

  it("returns 0.5 when sessions is 3 and acceptance is 0% (3 <= sessions < 5, rate < 10%)", () => {
    const target = makeTarget();
    writeOutcomes(target, nNotInvoked(3, "skill-x"));
    expect(confidenceCalibration(target, "skill-x")).toBe(0.5);
  });

  it("returns 0.5 when sessions is 4 and acceptance is 0%", () => {
    const target = makeTarget();
    writeOutcomes(target, nNotInvoked(4, "skill-x"));
    expect(confidenceCalibration(target, "skill-x")).toBe(0.5);
  });

  it("returns 0.0 when sessions >= 5 and acceptance is 0% (dormant — fully suppressed)", () => {
    const target = makeTarget();
    writeOutcomes(target, nNotInvoked(5, "skill-x"));
    expect(confidenceCalibration(target, "skill-x")).toBe(0.0);
  });

  it("returns 0.0 when sessions >= 5 and acceptance rate is below 5%", () => {
    // 1 invocation / 100 proposals = 1% < 5%
    const target = makeTarget();
    writeOutcomes(target, [
      { proposed: ["skill-x"], invoked: ["skill-x"] },
      ...nNotInvoked(99, "skill-x"),
    ]);
    expect(confidenceCalibration(target, "skill-x")).toBe(0.0);
  });

  it("returns 0.5 when sessions >= 5 and acceptance is exactly 5% (at the dormancy boundary)", () => {
    // 1/20 = 5% — not < 5%, so first gate passes; rate < 10% triggers the half-confidence gate
    const target = makeTarget();
    writeOutcomes(target, [
      { proposed: ["skill-x"], invoked: ["skill-x"] },
      ...nNotInvoked(19, "skill-x"),
    ]);
    expect(confidenceCalibration(target, "skill-x")).toBe(0.5);
  });

  it("returns 1.0 when acceptance rate reaches 10%", () => {
    // 1/10 = 10% — not < 10%, both gates pass → full confidence
    const target = makeTarget();
    writeOutcomes(target, [
      { proposed: ["skill-x"], invoked: ["skill-x"] },
      ...nNotInvoked(9, "skill-x"),
    ]);
    expect(confidenceCalibration(target, "skill-x")).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// computeAllSkillPenalties
// ---------------------------------------------------------------------------

describe("computeAllSkillPenalties", () => {
  it("returns an empty object when no data exists", () => {
    const target = makeTarget();
    expect(computeAllSkillPenalties(target)).toEqual({});
  });

  it("adds PENALTY_PER_NOT_USED (10) for each not_invoked session", () => {
    const target = makeTarget();
    writeOutcomes(target, nNotInvoked(2, "skill-a"));
    expect(computeAllSkillPenalties(target)["skill-a"]).toBe(20);
  });

  it("caps penalty at MAX_PENALTY (40) regardless of not_invoked count", () => {
    const target = makeTarget();
    writeOutcomes(target, nNotInvoked(10, "skill-a")); // would be 100 uncapped
    expect(computeAllSkillPenalties(target)["skill-a"]).toBe(40);
  });

  it("decays penalty by PENALTY_DECAY_ON_USE (20) when the skill is invoked", () => {
    const target = makeTarget();
    writeOutcomes(target, [
      { proposed: ["skill-a"], invoked: [] },       // +10 → 10
      { proposed: ["skill-a"], invoked: [] },       // +10 → 20
      { proposed: ["skill-a"], invoked: [] },       // +10 → 30
      { proposed: ["skill-a"], invoked: ["skill-a"] }, // -20 → 10
    ]);
    expect(computeAllSkillPenalties(target)["skill-a"]).toBe(10);
  });

  it("floors penalty at 0 — cannot go negative even when invoked with zero prior penalty", () => {
    const target = makeTarget();
    writeOutcomes(target, [
      { proposed: ["skill-a"], invoked: ["skill-a"] }, // max(0, 0-20) = 0
    ]);
    expect(computeAllSkillPenalties(target)["skill-a"]).toBe(0);
  });

  it("independently tracks penalties for different skills in the same sessions", () => {
    const target = makeTarget();
    writeOutcomes(target, [
      { proposed: ["skill-a", "skill-b"], invoked: ["skill-b"] },
      { proposed: ["skill-a"], invoked: [] },
    ]);
    const penalties = computeAllSkillPenalties(target);
    expect(penalties["skill-a"]).toBe(20); // 2 not_invoked sessions × 10
    expect(penalties["skill-b"]).toBe(0);  // invoked once → max(0, 0-20)
  });

  it("adds extra penalty when active-rejection feedback count >= 3", () => {
    // 2 sessions of non-use → base penalty = 20
    // 3 records with an active rejection reason (not "ignored" — passive non-use gets
    // no weight at all, see isBugConditionBug3) → weight 4 each → rejectionCount = 12
    // → extra = min(10, floor(12/3)×2) = 8
    const target = makeTarget();
    writeOutcomes(target, nNotInvoked(2, "skill-a"));
    writeFeedback(target, [{ skill: "skill-a", count: 3, reason: "dismissed" }]);
    expect(computeAllSkillPenalties(target)["skill-a"]).toBe(28);
  });

  it("scales extra penalty with more active-rejection feedback records", () => {
    // 6 records × weight 4 = rejectionCount 24 → extra = min(10, floor(24/3)×2) = 10 (capped)
    const target = makeTarget();
    writeOutcomes(target, nNotInvoked(2, "skill-a"));
    writeFeedback(target, [{ skill: "skill-a", count: 6, reason: "dismissed" }]);
    expect(computeAllSkillPenalties(target)["skill-a"]).toBe(30);
  });

  it("reason:'ignored' feedback records contribute zero extra penalty regardless of count", () => {
    // Passive non-use is not a rejection signal — even 9 reason:"ignored" records must
    // add nothing on top of the base session penalty (isBugConditionBug3).
    const target = makeTarget();
    writeOutcomes(target, nNotInvoked(2, "skill-a"));
    writeFeedback(target, [{ skill: "skill-a", count: 9 }]); // default reason: "ignored"
    expect(computeAllSkillPenalties(target)["skill-a"]).toBe(20);
  });

  it("does not add extra penalty when feedback count is below 3", () => {
    const target = makeTarget();
    writeOutcomes(target, nNotInvoked(1, "skill-a")); // base = 10
    writeFeedback(target, [{ skill: "skill-a", count: 2 }]);
    expect(computeAllSkillPenalties(target)["skill-a"]).toBe(10);
  });

  it("caps total penalty (session + feedback) at MAX_PENALTY (40)", () => {
    // Sessions already at max (40); feedback adds extra but final is still capped
    const target = makeTarget();
    writeOutcomes(target, nNotInvoked(10, "skill-a")); // 40 (max)
    writeFeedback(target, [{ skill: "skill-a", count: 15 }]); // extra = min(10,10) = 10
    expect(computeAllSkillPenalties(target)["skill-a"]).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// Attribution-gap awareness — confidenceCalibration / getDormantSkills must not
// punish a skill for "not_invoked" data that the known Claude VS Code
// PostToolUse gap (anthropics/claude-code#27014) makes unreliable.
// ---------------------------------------------------------------------------

describe("attribution-gap awareness", () => {
  /** Configures target's .claude/settings.json with a PostToolUse attribution hook,
   *  then points HOME at a fake dir containing a VS Code transcript with real tool use
   *  and zero PostToolUse hook fires — reproducing the known gap deterministically. */
  function simulateActiveGap(target: string): () => void {
    fs.writeFileSync(
      path.join(target, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            { matcher: "Skill|Read", hooks: [{ command: "node .claude/hooks/skill-invoke-watch.js claude" }] },
          ],
        },
      }),
      "utf-8"
    );

    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "proposal-outcome-home-"));
    tempDirs.push(fakeHome);
    const sessionDir = path.join(fakeHome, ".claude", "projects", encodeWorkspacePath(target));
    fs.mkdirSync(sessionDir, { recursive: true });
    const lines = [
      '{"sessionId":"sess-gap","entrypoint":"claude-vscode"}',
      ...Array.from({ length: 6 }, () => '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}'),
    ];
    const transcript = path.join(sessionDir, "sess-gap.jsonl");
    fs.writeFileSync(transcript, lines.join("\n") + "\n", "utf-8");
    fs.utimesSync(transcript, new Date(), new Date());

    const previousHome = mockedHome.value;
    mockedHome.value = fakeHome;
    return () => {
      mockedHome.value = previousHome;
    };
  }

  it("confidenceCalibration stays at 1.0 (no suppression) while the attribution gap is active", () => {
    const target = makeTarget();
    writeOutcomes(target, nNotInvoked(6, "gapped-skill")); // would normally suppress (>=5, 0%)
    const restore = simulateActiveGap(target);
    try {
      expect(confidenceCalibration(target, "gapped-skill")).toBe(1.0);
    } finally {
      restore();
    }
  });

  it("getDormantSkills excludes a skill while the attribution gap is active", () => {
    const target = makeTarget();
    writeOutcomes(target, nNotInvoked(6, "gapped-skill"));
    const restore = simulateActiveGap(target);
    try {
      expect(getDormantSkills(target).has("gapped-skill")).toBe(false);
    } finally {
      restore();
    }
  });

  it("still suppresses/dormant-flags normally when no attribution gap is configured", () => {
    // No .claude/settings.json PostToolUse hook -> assessClaudeVscodeAttributionGap()
    // short-circuits to detected:false regardless of the real ~/.claude/projects contents
    // on whatever machine runs this test.
    const target = makeTarget();
    writeOutcomes(target, nNotInvoked(6, "genuinely-ignored"));
    expect(confidenceCalibration(target, "genuinely-ignored")).toBe(0.0);
    expect(getDormantSkills(target).has("genuinely-ignored")).toBe(true);
  });
});
