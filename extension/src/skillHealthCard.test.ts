/**
 * Unit tests for formatSkillHealthCard / computeSkillHealthSnapshot (Task 1)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { computeSkillHealthSnapshot, formatSkillHealthCard } from "./adoptionIntelligence";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skill-health-"));
}

function installSkill(target: string, name: string): void {
  const d = path.join(target, ".claude", "skills", name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "SKILL.md"), `# ${name}\n## Description\nTest skill.\n`, "utf-8");
}

function seedDormantOutcomes(target: string, skill: string, n: number): void {
  const ld = path.join(target, ".claude", "learning");
  fs.mkdirSync(ld, { recursive: true });
  const file = path.join(ld, "proposalOutcome.jsonl");
  for (let i = 0; i < n; i++) {
    fs.appendFileSync(file, JSON.stringify({
      ts: new Date().toISOString(),
      session_id: `s${i}`,
      event: "session_end",
      proposed: [skill],
      invoked: [],
      not_invoked: [skill],
      acceptance_rate: 0,
      skills_proposed_count: 1,
      skills_invoked_count: 0,
    }) + "\n", "utf-8");
  }
}

describe("computeSkillHealthSnapshot", () => {
  it("empty workspace → all zeros, no prompt data", () => {
    const target = tmpDir();
    const snap = computeSkillHealthSnapshot(target);
    expect(snap.activeCount).toBe(0);
    expect(snap.dormantCount).toBe(0);
    expect(snap.avgPromptQuality).toBe(0);
    expect(snap.hasPromptData).toBe(false);
  });

  it("3 installed skills, none dormant → activeCount=3, dormantCount=0", () => {
    const target = tmpDir();
    installSkill(target, "vitest-extension-testing");
    installSkill(target, "self-learning");
    installSkill(target, "skill-creator");

    const snap = computeSkillHealthSnapshot(target);
    expect(snap.activeCount).toBe(3);
    expect(snap.dormantCount).toBe(0);
  });

  it("1 of 3 skills dormant (5+ proposals, 0 invocations) → activeCount=2, dormantCount=1", () => {
    const target = tmpDir();
    installSkill(target, "vitest-extension-testing");
    installSkill(target, "github-actions-ci");
    installSkill(target, "self-learning");

    // Make github-actions-ci dormant
    seedDormantOutcomes(target, "github-actions-ci", 6);

    const snap = computeSkillHealthSnapshot(target);
    expect(snap.activeCount).toBe(2);
    expect(snap.dormantCount).toBe(1);
  });

  it("all installed skills dormant → activeCount=0", () => {
    const target = tmpDir();
    installSkill(target, "deployment-practical");
    seedDormantOutcomes(target, "deployment-practical", 5);

    const snap = computeSkillHealthSnapshot(target);
    expect(snap.activeCount).toBe(0);
    expect(snap.dormantCount).toBe(1);
  });

  it("4 proposals (< threshold) → skill is active, not dormant", () => {
    const target = tmpDir();
    installSkill(target, "github-actions-ci");
    seedDormantOutcomes(target, "github-actions-ci", 4);

    const snap = computeSkillHealthSnapshot(target);
    expect(snap.activeCount).toBe(1);
    expect(snap.dormantCount).toBe(0);
  });

  it("skills dir missing → graceful (no throw)", () => {
    const target = tmpDir();
    // No .claude/skills dir at all
    expect(() => computeSkillHealthSnapshot(target)).not.toThrow();
    const snap = computeSkillHealthSnapshot(target);
    expect(snap.activeCount).toBe(0);
  });
});

describe("formatSkillHealthCard", () => {
  it("returns HTML string containing the three stat-pill labels", () => {
    const target = tmpDir();
    const html = formatSkillHealthCard(target);
    expect(html).toContain("Active Skills");
    expect(html).toContain("Dormant Skills");
    expect(html).toContain("Avg Prompt Quality");
  });

  it("shows 0 active and 0 dormant for empty workspace", () => {
    const target = tmpDir();
    const html = formatSkillHealthCard(target);
    // Both counts shown as 0 in the pill values
    const matches = [...html.matchAll(/<span class="val[^"]*">(\d+)<\/span>/g)].map(m => parseInt(m[1]));
    // Should contain at least two 0s (active count and dormant count)
    expect(matches.filter(v => v === 0).length).toBeGreaterThanOrEqual(2);
  });

  it("shows '—' for avg prompt quality when no data", () => {
    const target = tmpDir();
    const html = formatSkillHealthCard(target);
    expect(html).toContain("—");
  });

  it("shows dormant warning note when dormantCount > 0", () => {
    const target = tmpDir();
    installSkill(target, "github-actions-ci");
    seedDormantOutcomes(target, "github-actions-ci", 6);

    const html = formatSkillHealthCard(target);
    expect(html).toContain("dormant and suppressed");
  });

  it("no dormant warning when no dormant skills", () => {
    const target = tmpDir();
    installSkill(target, "vitest-extension-testing");

    const html = formatSkillHealthCard(target);
    expect(html).not.toContain("dormant and suppressed");
  });

  it("uses roi-low class for dormant count > 0", () => {
    const target = tmpDir();
    installSkill(target, "deployment-practical");
    seedDormantOutcomes(target, "deployment-practical", 5);

    const html = formatSkillHealthCard(target);
    // The dormant pill should have roi-low
    expect(html).toMatch(/roi-low/);
  });

  it("uses roi-high class for active count when no dormant skills", () => {
    const target = tmpDir();
    installSkill(target, "self-learning");

    const html = formatSkillHealthCard(target);
    // Active skills pill should use roi-high (no dormant skills → green)
    expect(html).toMatch(/roi-high/);
  });
});
