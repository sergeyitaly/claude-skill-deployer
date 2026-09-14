import { describe, expect, it } from "vitest";
import { isCollectorTranscriptRun, isProvisioningRun, isUsageRunRecord } from "./runsStore";

describe("isProvisioningRun", () => {
  it("flags install rows from generate_skills.py's record_skill_run()", () => {
    expect(isProvisioningRun({ action: "install" })).toBe(true);
  });

  it("flags generate rows", () => {
    expect(isProvisioningRun({ action: "generate" })).toBe(true);
  });

  it("does not flag real skill_invoke rows", () => {
    expect(isProvisioningRun({ action: "skill_invoke" })).toBe(false);
  });

  it("does not flag missing/undefined action", () => {
    expect(isProvisioningRun({})).toBe(false);
  });
});

describe("isUsageRunRecord", () => {
  it("excludes install/generate provisioning rows", () => {
    expect(isUsageRunRecord({ action: "install" })).toBe(false);
    expect(isUsageRunRecord({ action: "generate" })).toBe(false);
  });

  it("excludes legacy attribution-collector transcript rows", () => {
    expect(
      isUsageRunRecord({ action: "transcript", metadata: { source: "attribution-collector" } })
    ).toBe(false);
  });

  it("includes real skill_invoke hook rows", () => {
    expect(isUsageRunRecord({ action: "skill_invoke", metadata: { source: "skill-invoke-hook-v2" } })).toBe(
      true
    );
  });

  it("does not confuse install rows with collector-transcript rows", () => {
    // Sanity check the two exclusions are independent — an install row should never
    // accidentally satisfy isCollectorTranscriptRun (which checks action === "transcript").
    expect(isCollectorTranscriptRun({ action: "install" })).toBe(false);
  });
});
