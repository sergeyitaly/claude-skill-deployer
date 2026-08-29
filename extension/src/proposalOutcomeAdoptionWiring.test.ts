/**
 * Real-runtime regression test for the 1.0.127 "ignored" adoption-funnel fix.
 *
 * v1.0.126 removed proposalOutcome.ts's call to skillAdoption.ts's
 * recordRejectedSkills() for passively-ignored skills (correctly — passive
 * non-use isn't a rejection) but never replaced it with anything, so
 * computeAdoptionFunnel().ignored stayed permanently 0 against real session
 * data even though recommendation-feedback.jsonl correctly recorded the skill
 * as ignored.
 *
 * v1.0.127 added recordIgnoredSkills() and wired it into
 * recordSessionRejectionFeedback(). This test calls the real, unmocked
 * recordSessionRejectionFeedback() (hookHandlers.test.ts mocks it out, so this
 * wiring was never actually exercised end-to-end) and asserts a real "ignored"
 * event lands in skill-adoption.jsonl and is reflected in the computed funnel.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordSessionRejectionFeedback } from "./proposalOutcome";
import { computeAdoptionFunnel, readAdoptionEvents } from "./skillAdoption";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* non-fatal */ }
  }
});

function makeTarget(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adoption-wiring-"));
  fs.mkdirSync(path.join(dir, ".claude", "learning"), { recursive: true });
  tempDirs.push(dir);
  return dir;
}

describe("recordSessionRejectionFeedback wiring into the adoption funnel", () => {
  it("a passively-ignored skill produces a real ignored adoption event, not a rejected one", () => {
    const target = makeTarget();

    recordSessionRejectionFeedback(target, "sess-1", ["skill-invoked", "skill-ignored"], ["skill-invoked"]);

    const events = readAdoptionEvents(target);
    const ignoredEvents = events.filter((e) => e.event === "ignored");
    const rejectedEvents = events.filter((e) => e.event === "rejected");

    expect(ignoredEvents).toHaveLength(1);
    expect(ignoredEvents[0]).toMatchObject({ skill: "skill-ignored", taskId: "sess-1" });
    expect(rejectedEvents).toHaveLength(0);

    // The invoked skill must not be recorded as ignored — only the not-invoked one.
    expect(events.some((e) => e.skill === "skill-invoked")).toBe(false);
  });

  it("computeAdoptionFunnel().ignored reflects the recorded event instead of staying 0", () => {
    const target = makeTarget();

    recordSessionRejectionFeedback(target, "sess-1", ["skill-invoked", "skill-ignored"], ["skill-invoked"]);

    const funnel = computeAdoptionFunnel(target);
    expect(funnel.ignored).toBe(1);
  });

  it("is idempotent per (session, skill) across repeated Stop-hook firings", () => {
    const target = makeTarget();

    recordSessionRejectionFeedback(target, "sess-1", ["skill-ignored"], []);
    recordSessionRejectionFeedback(target, "sess-1", ["skill-ignored"], []);

    const ignoredEvents = readAdoptionEvents(target).filter((e) => e.event === "ignored");
    expect(ignoredEvents).toHaveLength(1);
  });

  it("still writes the recommendation-feedback.jsonl reason:ignored record alongside the adoption event", () => {
    const target = makeTarget();

    recordSessionRejectionFeedback(target, "sess-1", ["skill-ignored"], []);

    const feedbackFile = path.join(target, ".claude", "learning", "recommendation-feedback.jsonl");
    const feedback = fs.readFileSync(feedbackFile, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(feedback).toHaveLength(1);
    // No `accepted` field — removed as a structurally-always-false dead field (every
    // recommendation-feedback.jsonl record is a rejection by construction).
    expect(feedback[0]).toMatchObject({ skill: "skill-ignored", reason: "ignored" });
    expect(feedback[0]).not.toHaveProperty("accepted");

    expect(readAdoptionEvents(target).filter((e) => e.event === "ignored")).toHaveLength(1);
  });
});
