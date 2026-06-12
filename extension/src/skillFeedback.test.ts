import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendSkillFeedback,
  computeSkillInefficiencyStats,
  detectNegativeFeedbackSignal,
  readSkillFeedbackRecords,
} from "./skillFeedback";

describe("detectNegativeFeedbackSignal", () => {
  it("detects common disagreement phrases", () => {
    expect(detectNegativeFeedbackSignal("No, that's the wrong file")).toBe("no");
    expect(detectNegativeFeedbackSignal("That's wrong — use the other branch")).toBe("that's wrong");
    expect(detectNegativeFeedbackSignal("please continue")).toBeNull();
  });
});

describe("skill feedback records", () => {
  it("appends and aggregates inefficiency by skill", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "skill-feedback-"));
    appendSkillFeedback(target, {
      skill: "ci-pipeline-debug",
      sentiment: "negative",
      signal: "no",
      user_text: "no wrong stage",
      context: "Suggested lint job",
    });
    appendSkillFeedback(target, {
      skill: "ci-pipeline-debug",
      sentiment: "negative",
      signal: "wrong",
      user_text: "wrong pipeline",
      context: "Wrong include path",
    });
    appendSkillFeedback(target, {
      skill: "terraform-plan-review",
      sentiment: "negative",
      signal: "no",
      user_text: "no",
      context: "Bad module path",
    });

    const records = readSkillFeedbackRecords(target);
    expect(records).toHaveLength(3);

    const stats = computeSkillInefficiencyStats(target, ["ci-pipeline-debug", "terraform-plan-review"]);
    expect(stats[0].name).toBe("ci-pipeline-debug");
    expect(stats[0].negativeCount).toBe(2);
    expect(stats[0].inefficiencyPct).toBeGreaterThan(stats[1].inefficiencyPct);
    expect(stats[0].heatLevel).toBeGreaterThanOrEqual(stats[1].heatLevel);
    expect(stats[0].updateSuggestion).toContain("ci-pipeline-debug");
  });
});
