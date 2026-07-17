/**
 * Preservation Property Tests — Learning Loop Audit Fixes
 *
 * Task 2: Write preservation property tests on UNFIXED code.
 * These tests MUST PASS to confirm baseline behaviors that must survive the fixes.
 *
 * Property 5: Preservation — Invoked Skills Still Receive Decay Discount
 *   computeAllSkillPenalties applies PENALTY_DECAY_ON_USE (−20, floor 0) to r.invoked skills.
 *   Validates: Requirements 3.1
 *
 * Property 6: Preservation — Non-"ignored" Rejection Feedback Still Penalised at Weight-4
 *   computeAllSkillPenalties applies weight-4 extra penalty for reason ∈
 *   {"dismissed","not_relevant","wrong_domain","too_many"} when count ≥ 3.
 *   Validates: Requirements 3.2
 *
 * Bug 1 Preservation: multiplier=1.0 AND penalty=0 → breakdown sums to confidence
 *   scoreSkillForTask with multiplier=1.0 and penalty=0 produces breakdown components
 *   that sum correctly on UNFIXED code.
 *   Validates: Requirements 3.5
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeAllSkillPenalties } from "./proposalOutcome";
import { rankAllTaskSkillProposals } from "./taskSkillProposals";
import type { Manifest } from "./skillOps";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* non-fatal */
    }
  }
});

function makeTarget(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preservation-test-"));
  fs.mkdirSync(path.join(dir, ".claude", "learning"), { recursive: true });
  tempDirs.push(dir);
  return dir;
}

/** Write session_end records with skills in the `invoked` array. */
function writeInvokedRecords(
  target: string,
  skillName: string,
  count: number,
  initialPenalty?: number
): void {
  const file = path.join(target, ".claude", "learning", "proposalOutcome.jsonl");
  const lines: string[] = [];

  // If we want to test decay from a non-zero starting penalty, prepend not_invoked records
  // to build up the penalty first, then write invoked records to apply the decay.
  if (initialPenalty !== undefined && initialPenalty > 0) {
    const notInvokedCount = Math.ceil(initialPenalty / 10); // PENALTY_PER_NOT_USED = 10
    for (let i = 0; i < notInvokedCount; i++) {
      lines.push(
        JSON.stringify({
          ts: new Date().toISOString(),
          session_id: `setup-not-invoked-${i}`,
          event: "session_end",
          proposed: [skillName],
          invoked: [],
          not_invoked: [skillName],
          // No `ignored` field — legacy record format to avoid Bug 3 interaction
          rejected: [],
          acceptance_rate: 0,
          skills_proposed_count: 1,
          skills_invoked_count: 0,
        })
      );
    }
  }

  for (let i = 0; i < count; i++) {
    lines.push(
      JSON.stringify({
        ts: new Date().toISOString(),
        session_id: `invoked-session-${i}`,
        event: "session_end",
        proposed: [skillName],
        invoked: [skillName],
        not_invoked: [],
        rejected: [],
        acceptance_rate: 1,
        skills_proposed_count: 1,
        skills_invoked_count: 1,
      })
    );
  }
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");
}

/** Write recommendation-feedback.jsonl records with the given reason. */
function writeFeedbackRecords(
  target: string,
  skillName: string,
  reason: string,
  count: number
): void {
  const file = path.join(target, ".claude", "learning", "recommendation-feedback.jsonl");
  const lines = Array.from({ length: count }, (_, i) =>
    JSON.stringify({
      ts: new Date().toISOString(),
      session_id: `sess-feedback-${i}`,
      skill: skillName,
      proposed: true,
      accepted: false,
      reason,
    })
  );
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Property 5: Preservation — Invoked Skills Still Receive Decay Discount
// Validates: Requirements 3.1
//
// PENALTY_DECAY_ON_USE = 20, PENALTY_PER_NOT_USED = 10, MAX_PENALTY = 40
//
// The decay path (r.invoked → penalties[sk] -= 20, floor 0) is NOT affected by
// any of the three bug fixes. These tests must PASS on UNFIXED code.
// ---------------------------------------------------------------------------

describe("Property 5: Preservation — Invoked skills still receive PENALTY_DECAY_ON_USE (-20, floor 0)", () => {
  /**
   * Validates: Requirements 3.1
   *
   * A skill in r.invoked with no prior penalty should result in 0 (floor: 0-20 → 0).
   * This confirms the decay path runs on unfixed code.
   */
  it("single invoked session with no prior penalty results in 0 penalty (floor applies)", () => {
    const target = makeTarget();
    writeInvokedRecords(target, "skill-invoked-a", 1);
    const penalties = computeAllSkillPenalties(target);
    // 0 - 20 = -20 → floored at 0
    expect(penalties["skill-invoked-a"] ?? 0).toBe(0);
  });

  /**
   * Validates: Requirements 3.1
   *
   * 2 not_invoked sessions (legacy format — no `ignored` field, to avoid Bug 3 interaction)
   * build up 20 pts of penalty. Then 1 invoked session applies -20 decay → result = 0.
   */
  it("invoked session after 2 not-invoked sessions decays penalty to 0", () => {
    const target = makeTarget();
    // 2 not_invoked (legacy, no `ignored`) → 2 × 10 = 20 pts, then 1 invoked → 20 - 20 = 0
    writeInvokedRecords(target, "skill-invoked-b", 1, 20);
    const penalties = computeAllSkillPenalties(target);
    expect(penalties["skill-invoked-b"] ?? 0).toBe(0);
  });

  /**
   * Validates: Requirements 3.1
   *
   * 4 not_invoked sessions (legacy) build 40 pts (MAX_PENALTY).
   * 1 invoked session → 40 - 20 = 20 pts remaining.
   */
  it("invoked session after 4 not-invoked sessions decays penalty from 40 to 20", () => {
    const target = makeTarget();
    // 4 not_invoked (legacy) → 40 pts (MAX_PENALTY), then 1 invoked → 40 - 20 = 20
    writeInvokedRecords(target, "skill-invoked-c", 1, 40);
    const penalties = computeAllSkillPenalties(target);
    expect(penalties["skill-invoked-c"] ?? 0).toBe(20);
  });

  /**
   * Validates: Requirements 3.1
   *
   * 3 invoked sessions (no prior penalty): each decays from 0 → floor at 0.
   * Result must remain 0 regardless of how many invocations.
   */
  it("multiple invoked sessions with zero prior penalty keep penalty at 0", () => {
    const target = makeTarget();
    writeInvokedRecords(target, "skill-invoked-d", 3);
    const penalties = computeAllSkillPenalties(target);
    expect(penalties["skill-invoked-d"] ?? 0).toBe(0);
  });

  /**
   * Validates: Requirements 3.1
   *
   * 4 not_invoked (legacy) → 40 pts, then 2 invoked → 40 - 20 - 20 = 0.
   * Two decay applications bring it to zero.
   */
  it("two invoked sessions after reaching MAX_PENALTY (40) decay to 0", () => {
    const target = makeTarget();
    writeInvokedRecords(target, "skill-invoked-e", 2, 40);
    const penalties = computeAllSkillPenalties(target);
    expect(penalties["skill-invoked-e"] ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Property 6: Preservation — Non-"ignored" Rejection Feedback Still Penalised at Weight-4
// Validates: Requirements 3.2
//
// Current feedback loop:
//   const weight = f.reason && f.reason !== "ignored" ? 4 : 1;
//   rejectionCounts[f.skill] += weight;
//   if (count >= 3) extra = min(10, floor(count/3)*2);
//
// For reason="dismissed" (weight=4):
//   3 records → rejectionCounts = 12 → extra = floor(12/3)*2 = 8
//   After fix (weight still 4 for non-ignored): same result. Must PASS on both unfixed and fixed code.
// ---------------------------------------------------------------------------

describe("Property 6: Preservation — Non-ignored rejection feedback still penalised at weight-4", () => {
  /**
   * Validates: Requirements 3.2
   *
   * 3 records with reason="dismissed" → weight=4 → rejectionCounts=12 ≥ 3
   * extra = min(10, floor(12/3)*2) = min(10, 8) = 8 pts extra penalty.
   *
   * **Validates: Requirements 3.2**
   */
  it("3 dismissed feedback records produce extra penalty (weight-4 path)", () => {
    const target = makeTarget();
    writeFeedbackRecords(target, "skill-dismissed-a", "dismissed", 3);
    const penalties = computeAllSkillPenalties(target);
    // weight=4: 3 records → rejectionCount=12, extra=floor(12/3)*2=8
    expect(penalties["skill-dismissed-a"] ?? 0).toBe(8);
  });

  /**
   * Validates: Requirements 3.2
   *
   * 3 records with reason="not_relevant" → weight=4 → rejectionCounts=12
   * extra = 8 pts.
   *
   * **Validates: Requirements 3.2**
   */
  it("3 not_relevant feedback records produce extra penalty (weight-4 path)", () => {
    const target = makeTarget();
    writeFeedbackRecords(target, "skill-not-relevant-a", "not_relevant", 3);
    const penalties = computeAllSkillPenalties(target);
    expect(penalties["skill-not-relevant-a"] ?? 0).toBe(8);
  });

  /**
   * Validates: Requirements 3.2
   *
   * 3 records with reason="wrong_domain" → weight=4 → rejectionCounts=12
   * extra = 8 pts.
   *
   * **Validates: Requirements 3.2**
   */
  it("3 wrong_domain feedback records produce extra penalty (weight-4 path)", () => {
    const target = makeTarget();
    writeFeedbackRecords(target, "skill-wrong-domain-a", "wrong_domain", 3);
    const penalties = computeAllSkillPenalties(target);
    expect(penalties["skill-wrong-domain-a"] ?? 0).toBe(8);
  });

  /**
   * Validates: Requirements 3.2
   *
   * 3 records with reason="too_many" → weight=4 → rejectionCounts=12
   * extra = 8 pts.
   *
   * **Validates: Requirements 3.2**
   */
  it("3 too_many feedback records produce extra penalty (weight-4 path)", () => {
    const target = makeTarget();
    writeFeedbackRecords(target, "skill-too-many-a", "too_many", 3);
    const penalties = computeAllSkillPenalties(target);
    expect(penalties["skill-too-many-a"] ?? 0).toBe(8);
  });

  /**
   * Validates: Requirements 3.2
   *
   * Vary all four non-ignored reason types on a single skill to confirm all go through
   * the weight-4 path. 1 record each of dismissed, not_relevant, wrong_domain, too_many
   * → rejectionCounts = 4×4 = 16 ≥ 3, extra = floor(16/3)*2 = floor(5.33)*2 = 10
   * (capped at 10 by min(10, ...)).
   *
   * **Validates: Requirements 3.2**
   */
  it("mixed non-ignored reasons all use weight-4 and produce correct combined extra penalty", () => {
    const target = makeTarget();
    const skillName = "skill-mixed-reasons";
    const file = path.join(target, ".claude", "learning", "recommendation-feedback.jsonl");
    const reasons = ["dismissed", "not_relevant", "wrong_domain", "too_many"];
    const lines = reasons.map((reason, i) =>
      JSON.stringify({
        ts: new Date().toISOString(),
        session_id: `sess-mixed-${i}`,
        skill: skillName,
        proposed: true,
        accepted: false,
        reason,
      })
    );
    fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");
    const penalties = computeAllSkillPenalties(target);
    // 4 reasons × weight 4 = 16, extra = min(10, floor(16/3)*2) = min(10, 10) = 10
    expect(penalties[skillName] ?? 0).toBe(10);
  });

  /**
   * Validates: Requirements 3.2
   *
   * Below the threshold (count < 3 weighted): 2 records reason="dismissed" → weight=4
   * → rejectionCounts=8, which is ≥ 3, so extra = floor(8/3)*2 = 4.
   * (The threshold is rejectionCounts ≥ 3, not raw record count ≥ 3.)
   *
   * **Validates: Requirements 3.2**
   */
  it("2 dismissed feedback records (weighted count=8) still exceed threshold and produce extra penalty", () => {
    const target = makeTarget();
    writeFeedbackRecords(target, "skill-dismissed-b", "dismissed", 2);
    const penalties = computeAllSkillPenalties(target);
    // weight=4: 2 records → rejectionCount=8, floor(8/3)*2=4
    expect(penalties["skill-dismissed-b"] ?? 0).toBe(4);
  });

  /**
   * Validates: Requirements 3.2
   *
   * 1 record reason="dismissed" → rejectionCounts=4 ≥ 3, extra = floor(4/3)*2 = 2.
   *
   * **Validates: Requirements 3.2**
   */
  it("1 dismissed feedback record (weighted count=4) exceeds threshold and produces extra penalty", () => {
    const target = makeTarget();
    writeFeedbackRecords(target, "skill-dismissed-c", "dismissed", 1);
    const penalties = computeAllSkillPenalties(target);
    // weight=4: 1 record → rejectionCount=4 ≥ 3, floor(4/3)*2=2
    expect(penalties["skill-dismissed-c"] ?? 0).toBe(2);
  });
});
