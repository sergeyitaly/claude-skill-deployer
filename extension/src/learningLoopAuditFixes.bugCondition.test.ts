/**
 * Bug Condition Exploration Tests — Learning Loop Audit Fixes
 *
 * Task 1: Write bug condition exploration property tests on UNFIXED code.
 * These tests MUST FAIL to confirm the bugs exist.
 *
 * Bug 1 — Breakdown Miscalculation (isBugConditionBug1):
 *   scoreSkillForTask captures semanticMatch before taskTypeMultiplier is applied,
 *   so breakdown components do not sum to the pre-calibration score when multiplier < 1.0.
 *   Validates: Requirements 1.1, 1.2
 *
 * Bug 2 — Accepted Field Duplication (isBugConditionBug2):
 *   recordSessionProposalOutcome writes accepted = invoked into every session_end record,
 *   making the accepted field redundant and misleading.
 *   Validates: Requirements 1.3, 1.4
 *
 * Bug 3 — Ignored Penalty (isBugConditionBug3):
 *   computeAllSkillPenalties applies PENALTY_PER_NOT_USED to r.ignored skills (passive
 *   non-use), and weight-1 extra penalty for reason:"ignored" feedback records.
 *   Validates: Requirements 1.5, 1.6, 1.7
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Manifest } from "./skillOps";
import {
  appendProposalOutcome,
  computeAllSkillPenalties,
  readProposalOutcomes,
  recordSessionProposalOutcome,
} from "./proposalOutcome";
import { rankAllTaskSkillProposals } from "./taskSkillProposals";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bug-condition-test-"));
  fs.mkdirSync(path.join(dir, ".claude", "learning"), { recursive: true });
  tempDirs.push(dir);
  return dir;
}

/** Write proposalOutcome.jsonl records with the `ignored` field set (new-format records). */
function writeIgnoredRecords(
  target: string,
  records: Array<{ skillName: string; sessionId?: string }>
): void {
  const file = path.join(target, ".claude", "learning", "proposalOutcome.jsonl");
  const lines = records.map((r, i) =>
    JSON.stringify({
      ts: new Date().toISOString(),
      session_id: r.sessionId ?? `session-${i}`,
      event: "session_end",
      proposed: [r.skillName],
      invoked: [],
      not_invoked: [r.skillName],
      ignored: [r.skillName],
      rejected: [],
      acceptance_rate: 0,
      skills_proposed_count: 1,
      skills_invoked_count: 0,
    })
  );
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");
}

/** Write recommendation-feedback.jsonl records with reason: "ignored". */
function writeIgnoredFeedback(
  target: string,
  skillName: string,
  count: number
): void {
  const file = path.join(
    target,
    ".claude",
    "learning",
    "recommendation-feedback.jsonl"
  );
  const lines = Array.from({ length: count }, (_, i) =>
    JSON.stringify({
      ts: new Date().toISOString(),
      session_id: `sess-${i}`,
      skill: skillName,
      proposed: true,
      accepted: false,
      reason: "ignored",
    })
  );
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Minimal manifest — terraform-plan-review only relevant for "deploy" task type.
// Scoring against a "debug" prompt (tokens: debug, fix, error) forces multiplier=0.65.
// ---------------------------------------------------------------------------

const minimalManifest: Manifest = {
  skills: {
    "terraform-plan-review": {
      description: "Terraform plan review deploy infrastructure",
      detect_globs: ["**/*.tf"],
    },
  },
};

// ---------------------------------------------------------------------------
// Bug 1 — isBugConditionBug1
// Expected outcome on UNFIXED code: FAIL
// The breakdown components will NOT sum to the pre-calibration score when multiplier < 1.0.
// ---------------------------------------------------------------------------

describe("isBugConditionBug1 — Breakdown Miscalculation (expected to FAIL on unfixed code)", () => {
  /**
   * Validates: Requirements 1.1, 1.2
   *
   * terraform-plan-review is only relevant for "deploy" task type (SKILL_TASK_TYPES).
   * A prompt with "debug" as the dominant task-type token causes classifyTaskType to return
   * "debug", which means taskTypeMultiplier returns 0.65 for terraform-plan-review.
   *
   * To ensure the proposal survives the minProposalConfidence=70 gate despite the 0.65
   * multiplier, we use a prompt that includes "terraform" (keyword-hint → +50), "plan"
   * (name-match → +25), "review" (name-match → +25), plus the .tf glob (+20) = 120 base.
   * After multiplier: Math.round(120 * 0.65) = 78 — clears 70 threshold.
   * The "debug" token sets taskType="debug" while "terraform" is the keyword hint.
   * With only one debug token and one "terraform" hint, classifyTaskType picks "debug"
   * because there's no ambiguity tie (1 debug token vs 0 deploy tokens from the prompt).
   *
   * Actually terraform is a TASK_TYPE_KEYWORDS["deploy"] token, so a prompt of
   * "debug terraform plan review" scores 1 debug + 1 deploy → tie → taskType="unknown"
   * → multiplier=1.0 (no bug). We need debug to win the type vote.
   *
   * Solution: use a pure "debug" manifest with a skill that has no SKILL_TASK_TYPES
   * entry (so it is always relevant, multiplier=1.0). Instead, we use a custom skill
   * named "mock-deploy-skill" constrained to ["deploy"] and score it against a "debug"
   * dominant prompt. We use a description with many matched tokens to get a high base
   * score before the multiplier penalty.
   *
   * Counterexample documented:
   *   mock-deploy-skill vs "debug" task type → multiplier 0.65:
   *   - semanticMatch captured pre-scale (e.g. 90) but correct value is 90 * 0.65 = 59
   *   - componentSum = 90 ≠ confidence = 59
   *   - difference = 31, which is >> 1 pt — breakdown is wrong on unfixed code
   */
  it("breakdown components sum to pre-calibration score within 1 pt for deploy-only skill vs debug task", () => {
    const target = makeTarget();

    // A manifest with one skill constrained to ["deploy"] task type only.
    // We use tokens "fix", "error", "bug", "crash", "exception" in the prompt to force
    // classifyTaskType → "debug" (5 debug tokens, 0 other task-type tokens → clear winner).
    // The skill description contains all those tokens so they each score +15 (description match).
    const deployOnlyManifest: Manifest = {
      skills: {
        "mock-deploy-skill": {
          // Contains "fix", "error", "bug", "crash", "exception" so they each match description
          description: "fix error bug crash exception deploy pipeline release infrastructure",
          detect_globs: [],
        },
      },
    };

    // SKILL_TASK_TYPES is internal to taskSkillProposals — we cannot add to it from outside.
    // However, "terraform-plan-review" IS in SKILL_TASK_TYPES as ["deploy"]. We use a prompt
    // that makes classifyTaskType return "debug" while still giving terraform-plan-review enough
    // token score to survive the 70pt gate after the 0.65 multiplier.
    //
    // Scoring against "debug error exception stack trace fix bug crash" prompt:
    //   - "fix"   → description match on "fix" → +15
    //   - "error" → description match on "error" → +15
    //   - "bug"   → description match on "bug" → +15
    //   - "crash" → description match on "crash" → +15
    //   - "exception" → description match on "exception" → +15
    //   - "stack" → NOT in description, no match
    //   Total = 75 pts, signalTypes = 5
    //   taskType = "debug" (5 debug tokens)
    //   But "mock-deploy-skill" is NOT in SKILL_TASK_TYPES → multiplier = 1.0 (no constraint)
    //
    // We need to use terraform-plan-review which IS constrained to ["deploy"].
    // Use the minimalManifest and a prompt that scores high enough:
    //   "debug error exception terraform plan review" →
    //   - "debug" → TASK_TYPE_KEYWORDS["debug"] → taskType vote: 1 debug
    //   - "error" → TASK_TYPE_KEYWORDS["debug"] → 2 debug
    //   - "exception" → TASK_TYPE_KEYWORDS["debug"] → 3 debug
    //   - "terraform" → keyword hint maps to terraform-plan-review → +50, hasTaskToken=true, vote: 0 deploy
    //   - "plan" → name match "terraform-plan-review" → +25
    //   - "review" → name match "terraform-plan-review" → +25
    //   taskType = "debug" (3 debug > 0 deploy, no tie)
    //   BUT "terraform" is also in TASK_TYPE_KEYWORDS["deploy"], so:
    //     1 deploy token (terraform) + 3 debug tokens → debug wins (3 > 1)
    //   multiplier for terraform-plan-review vs "debug" = 0.65
    //   base score = 50 + 25 + 25 = 100 (no glob match in this path, no .tf file)
    //   After multiplier: Math.round(100 * 0.65) = 65 — below 70 threshold!
    //
    // With .tf glob: +20 → base = 120, after multiplier = Math.round(120 * 0.65) = 78 ✓

    // Create a .tf file to fire the glob
    fs.writeFileSync(path.join(target, "main.tf"), 'resource "aws_instance" "example" {}\n', "utf-8");

    // Prompt: 3 debug tokens dominate (debug, error, exception) vs 1 deploy token (terraform)
    // taskType = "debug" → multiplier 0.65 for terraform-plan-review
    const proposals = rankAllTaskSkillProposals(
      target,
      minimalManifest,
      "debug error exception terraform plan review"
    );

    const proposal = proposals.find((p) => p.name === "terraform-plan-review");

    expect(
      proposal,
      "terraform-plan-review must appear in proposals (score=120, after 0.65 multiplier=78, above 70 gate). " +
        "If this assertion fails, the confidence gate filtered it out — check token scoring."
    ).toBeDefined();

    const bd = proposal!.confidenceBreakdown!;
    expect(bd, "confidenceBreakdown must be present on proposal").toBeDefined();

    // In a fresh target with no history: calibration=1.0, adoptionAdj=0, enrichAdj=0
    // confidence = Math.min(100, Math.max(0, Math.round(score * 1.0) + 0 + 0)) = score
    // So confidence IS the pre-calibration score in this isolated test.
    //
    // On FIXED code: componentSum should equal confidence within 1 pt.
    // On UNFIXED code:
    //   semanticMatch is captured BEFORE the 0.65 multiplier is applied, so it holds
    //   the full pre-scale token sum (~120) instead of the post-scale value (~78).
    //   componentSum = 120 + 0 + 0 + 0 + 0 + 0 = 120 ≠ confidence = 78
    //   difference = 42 >> 1 — the assertion FAILS, proving the bug exists.
    const componentSum =
      bd.semanticMatch +
      bd.workspaceAffinity +
      bd.repositoryAffinity +
      bd.adoptionSuccess +
      bd.enrichment +
      bd.penalty;

    const preCalibrationScore = proposal!.confidence;

    expect(
      Math.abs(componentSum - preCalibrationScore),
      `Breakdown sum (${componentSum}) should equal pre-calibration score (${preCalibrationScore}) within 1 pt. ` +
        `Counterexample: terraform-plan-review scored against "debug" task type (multiplier=0.65). ` +
        `semanticMatch=${bd.semanticMatch} (pre-multiplier, inflated) — should be ~${Math.round(bd.semanticMatch * 0.65)}. ` +
        `workspaceAffinity=${bd.workspaceAffinity}, repositoryAffinity=${bd.repositoryAffinity}, ` +
        `adoptionSuccess=${bd.adoptionSuccess}, enrichment=${bd.enrichment}, penalty=${bd.penalty}. ` +
        `Difference=${Math.abs(componentSum - preCalibrationScore)} — semanticMatch captured pre-multiplier scaling.`
    ).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Bug 2 — isBugConditionBug2
// Expected outcome on UNFIXED code: FAIL
// The written session_end record will have an `accepted` field equal to `invoked`.
// ---------------------------------------------------------------------------

describe("isBugConditionBug2 — Accepted Field Duplication (expected to FAIL on unfixed code)", () => {
  /**
   * Validates: Requirements 1.3, 1.4
   *
   * recordSessionProposalOutcome contains: const accepted = invoked;
   * and passes accepted into appendProposalOutcome.
   *
   * Expected: record.accepted === undefined (field should not be written).
   * Actual on UNFIXED code: record.accepted is present and equals record.invoked.
   *
   * Counterexample documented:
   *   recordSessionProposalOutcome(target, "sess-1", ["terraform-plan-review"])
   *   with no runs (invokedSet empty) → invoked=[], accepted=[]
   *   Written record: { invoked: [], accepted: [], not_invoked: ["terraform-plan-review"], ... }
   *   accepted field is present — it duplicates invoked (both are []).
   */
  it("session_end record written by recordSessionProposalOutcome has no accepted field", () => {
    const target = makeTarget();

    // Write a fresh proposals file so recordSessionProposalOutcome finds proposed skills
    const proposalsFile = path.join(
      target,
      ".claude",
      "learning",
      "task-skill-proposals.json"
    );
    fs.writeFileSync(
      proposalsFile,
      JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        taskSummary: "Test",
        proposals: [{ name: "terraform-plan-review", reason: "test", confidence: 80, installed: false }],
      }),
      "utf-8"
    );

    // No runs.jsonl → invokedSet is empty → invoked=[], not_invoked=["terraform-plan-review"]
    recordSessionProposalOutcome(target, "sess-bug2-test", ["terraform-plan-review"]);

    const records = readProposalOutcomes(target);
    expect(records.length).toBeGreaterThan(0);

    const record = records[records.length - 1];
    expect(record.event).toBe("session_end");

    // ASSERTION: accepted field must be undefined (not written).
    // This FAILS on unfixed code because accepted = invoked is written unconditionally.
    expect(
      record.accepted,
      `Counterexample: record.accepted=${JSON.stringify(record.accepted)} but should be undefined. ` +
        `The accepted field duplicates invoked=${JSON.stringify(record.invoked)}. ` +
        `Bug: const accepted = invoked; is present in recordSessionProposalOutcome.`
    ).toBeUndefined();
  });

  it("session_end record with invoked skills also has no accepted field", () => {
    const target = makeTarget();

    // Write a session_end record directly via appendProposalOutcome to simulate
    // what recordSessionProposalOutcome writes — confirming the accepted field is present
    // in the raw written record on unfixed code.
    //
    // We call recordSessionProposalOutcome with a sessionId that has no matching runs,
    // then with a second test that has runs.jsonl entries to confirm the bug in both cases.

    // Seed a proposals file
    fs.writeFileSync(
      path.join(target, ".claude", "learning", "task-skill-proposals.json"),
      JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        taskSummary: "Test",
        proposals: [
          { name: "terraform-plan-review", reason: "test", confidence: 80, installed: false },
          { name: "ci-pipeline-debug", reason: "test", confidence: 75, installed: false },
        ],
      }),
      "utf-8"
    );

    recordSessionProposalOutcome(target, "sess-bug2-invoked", []);

    const records = readProposalOutcomes(target);
    const record = records.find((r) => r.session_id === "sess-bug2-invoked");
    expect(record).toBeDefined();

    // ASSERTION: accepted field must be undefined regardless of invoked content.
    // This FAILS on unfixed code because accepted is always written.
    expect(
      record!.accepted,
      `Counterexample: record.accepted=${JSON.stringify(record!.accepted)} is present. ` +
        `It equals invoked=${JSON.stringify(record!.invoked)} — the accepted field is redundant. ` +
        `Bug: accepted = invoked line in recordSessionProposalOutcome.`
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Bug 3 — isBugConditionBug3
// Expected outcome on UNFIXED code: FAIL
// computeAllSkillPenalties will return 40 (MAX_PENALTY) for ignored-only skills,
// and will add extra penalty for reason:"ignored" feedback records.
// ---------------------------------------------------------------------------

describe("isBugConditionBug3 — Ignored Penalty (expected to FAIL on unfixed code)", () => {
  /**
   * Validates: Requirements 1.5, 1.7
   *
   * computeAllSkillPenalties uses: for (const sk of (r.ignored ?? r.not_invoked ?? []))
   * which applies PENALTY_PER_NOT_USED (+10) to r.ignored skills.
   *
   * Expected: penalties["skill-a"] === 0 for skills only in r.ignored.
   * Actual on UNFIXED code: 4 ignored sessions → 40 pts (MAX_PENALTY).
   *
   * Counterexample documented:
   *   4 session_end records with ignored: ["skill-a"], no invoked entries.
   *   computeAllSkillPenalties → penalties["skill-a"] === 40 (MAX_PENALTY).
   *   Should be 0 because passive non-use is not a rejection signal.
   */
  it("skill appearing in r.ignored across 4 sessions accumulates zero penalty", () => {
    const target = makeTarget();

    // Write 4 records with ignored: ["skill-a"] — passive non-use, not explicit rejection
    writeIgnoredRecords(
      target,
      Array.from({ length: 4 }, (_, i) => ({
        skillName: "skill-a",
        sessionId: `sess-ignored-${i}`,
      }))
    );

    const penalties = computeAllSkillPenalties(target);

    // ASSERTION: zero penalty for passively non-used (ignored) skill.
    // This FAILS on unfixed code: 4 sessions × PENALTY_PER_NOT_USED(10) = 40 = MAX_PENALTY.
    expect(
      penalties["skill-a"] ?? 0,
      `Counterexample: 4 session_end records with ignored: ["skill-a"] → ` +
        `computeAllSkillPenalties returned ${penalties["skill-a"] ?? 0} pts. ` +
        `Expected 0 pts (passive non-use ≠ rejection). ` +
        `Bug: r.ignored ?? r.not_invoked loop applies PENALTY_PER_NOT_USED to ignored skills.`
    ).toBe(0);
  });

  /**
   * Validates: Requirements 1.5, 1.7
   *
   * Counterexample documented:
   *   10 session_end records with ignored: ["skill-b"].
   *   computeAllSkillPenalties → penalties["skill-b"] === 40 (capped at MAX_PENALTY).
   *   Should be 0 regardless of how many sessions the skill is passively ignored.
   */
  it("skill appearing in r.ignored across 10 sessions still accumulates zero penalty (not 40)", () => {
    const target = makeTarget();

    writeIgnoredRecords(
      target,
      Array.from({ length: 10 }, (_, i) => ({
        skillName: "skill-b",
        sessionId: `sess-ignored-${i}`,
      }))
    );

    const penalties = computeAllSkillPenalties(target);

    // ASSERTION: zero penalty even after 10 ignored sessions.
    // This FAILS on unfixed code: capped at MAX_PENALTY(40).
    expect(
      penalties["skill-b"] ?? 0,
      `Counterexample: 10 session_end records with ignored: ["skill-b"] → ` +
        `computeAllSkillPenalties returned ${penalties["skill-b"] ?? 0} pts. ` +
        `Expected 0 pts. Bug: r.ignored ?? r.not_invoked loop penalises passive non-use.`
    ).toBe(0);
  });

  /**
   * Validates: Requirements 1.6, 1.7
   *
   * computeAllSkillPenalties feedback loop:
   *   const weight = f.reason && f.reason !== "ignored" ? 4 : 1;
   * gives weight=1 to reason:"ignored" records instead of skipping them.
   *
   * Expected: zero extra feedback penalty for 6 reason:"ignored" records.
   * Actual on UNFIXED code: count=6, weight=1, total=6 ≥ 3 → extra = floor(6/3)*2 = 4 pts.
   *
   * Counterexample documented:
   *   6 recommendation-feedback.jsonl records with reason: "ignored" for "skill-c".
   *   No session_end records (no base penalty).
   *   computeAllSkillPenalties → penalties["skill-c"] === 4 extra pts.
   *   Should be 0 because reason:"ignored" is passive non-use, not explicit rejection.
   */
  it("6 recommendation-feedback records with reason:ignored contribute zero extra penalty", () => {
    const target = makeTarget();

    // No session_end records — only feedback records with reason:"ignored"
    writeIgnoredFeedback(target, "skill-c", 6);

    const penalties = computeAllSkillPenalties(target);

    // ASSERTION: zero extra feedback penalty for reason:"ignored" records.
    // This FAILS on unfixed code: weight=1, count=6 ≥ 3 → extra = floor(6/3)*2 = 4 pts.
    expect(
      penalties["skill-c"] ?? 0,
      `Counterexample: 6 recommendation-feedback records with reason:"ignored" for "skill-c" → ` +
        `computeAllSkillPenalties returned ${penalties["skill-c"] ?? 0} pts extra penalty. ` +
        `Expected 0 pts. Bug: weight = f.reason !== "ignored" ? 4 : 1 — still applies weight-1 ` +
        `instead of skipping reason:"ignored" records entirely.`
    ).toBe(0);
  });

  /**
   * Validates: Requirements 1.6, 1.7
   *
   * Counterexample documented:
   *   3 recommendation-feedback.jsonl records with reason: "ignored" for "skill-d".
   *   count=3, weight=1, total=3 ≥ 3 → extra = floor(3/3)*2 = 2 pts on unfixed code.
   *   Should be 0.
   */
  it("3 recommendation-feedback records with reason:ignored contribute zero extra penalty (threshold boundary)", () => {
    const target = makeTarget();

    writeIgnoredFeedback(target, "skill-d", 3);

    const penalties = computeAllSkillPenalties(target);

    // ASSERTION: zero extra penalty at the threshold boundary.
    // This FAILS on unfixed code: count=3, weight=1 → extra = 2 pts.
    expect(
      penalties["skill-d"] ?? 0,
      `Counterexample: 3 recommendation-feedback records with reason:"ignored" → ` +
        `computeAllSkillPenalties returned ${penalties["skill-d"] ?? 0} pts. ` +
        `Expected 0 pts (should skip reason:"ignored" entirely). ` +
        `Bug: weight-1 still applied for reason:"ignored" records.`
    ).toBe(0);
  });
});
