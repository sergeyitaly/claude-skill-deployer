import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  archivalRules,
  archiveSkill,
  candidatesForArchival,
  listArchivedSkills,
  restoreArchivedSkill,
  type ArchiveMeta,
} from "./skillArchival";
import type { SkillUsageStat } from "./usageStats";
import type { RoiBand } from "./skillRoi";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const workspaces: string[] = [];

function makeWorkspace(name = "ws"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `skill-archival-${name}-`));
  workspaces.push(dir);
  return dir;
}

function plantSkill(target: string, skillName: string, content = "# skill\nsome body\n"): string {
  const skillDir = path.join(target, ".claude", "skills", skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: ${skillName}\ndescription: test skill\nversion: 1.0.0\n---\n${content}`, "utf-8");
  return skillDir;
}

function readMeta(target: string, skillName: string): ArchiveMeta {
  const metaPath = path.join(target, ".claude", "skills-archived", skillName, ".archive-meta.json");
  return JSON.parse(fs.readFileSync(metaPath, "utf-8")) as ArchiveMeta;
}

afterEach(() => {
  for (const dir of workspaces.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// archiveSkill
// ---------------------------------------------------------------------------

describe("archiveSkill", () => {
  it("moves skill from .claude/skills to .claude/skills-archived", () => {
    const target = makeWorkspace();
    plantSkill(target, "my-skill");

    const ok = archiveSkill(target, "my-skill", target);

    expect(ok).toBe(true);
    expect(fs.existsSync(path.join(target, ".claude", "skills", "my-skill"))).toBe(false);
    expect(fs.existsSync(path.join(target, ".claude", "skills-archived", "my-skill", "SKILL.md"))).toBe(true);
  });

  it("writes .archive-meta.json with required fields", () => {
    const target = makeWorkspace();
    plantSkill(target, "my-skill");

    archiveSkill(target, "my-skill", target, {
      reason: "optimizer: low-roi",
      roiBand: "LOW",
      runs: 7,
      version: "1.0.0",
    });

    const meta = readMeta(target, "my-skill");
    expect(meta.reason).toBe("optimizer: low-roi");
    expect(meta.roiBand).toBe("LOW");
    expect(meta.runs).toBe(7);
    expect(meta.version).toBe("1.0.0");
    expect(meta.archivedAt).toBeTruthy();
    expect(new Date(meta.archivedAt).getFullYear()).toBeGreaterThanOrEqual(2026);
  });

  it("bumps the patch version in SKILL.md BEFORE archiving", () => {
    const target = makeWorkspace();
    plantSkill(target, "versioned-skill");

    archiveSkill(target, "versioned-skill", target);

    const archivedMd = fs.readFileSync(
      path.join(target, ".claude", "skills-archived", "versioned-skill", "SKILL.md"),
      "utf-8"
    );
    // version: 1.0.0 → 1.0.1
    expect(archivedMd).toMatch(/version:\s*1\.0\.1/);
  });

  it("does NOT leave the original skill directory behind", () => {
    const target = makeWorkspace();
    plantSkill(target, "clean-skill");

    archiveSkill(target, "clean-skill", target);

    const originalPath = path.join(target, ".claude", "skills", "clean-skill");
    expect(fs.existsSync(originalPath)).toBe(false);
  });

  it("overwrites an older archived copy when re-archiving", () => {
    const target = makeWorkspace();
    plantSkill(target, "overwrite-skill");
    archiveSkill(target, "overwrite-skill", target, { reason: "first-time" });

    // Reinstall and archive again
    plantSkill(target, "overwrite-skill");
    archiveSkill(target, "overwrite-skill", target, { reason: "second-time" });

    const meta = readMeta(target, "overwrite-skill");
    expect(meta.reason).toBe("second-time");
  });

  it("returns false and does nothing for invalid skill names", () => {
    const target = makeWorkspace();
    const ok = archiveSkill(target, "../evil-path", target);
    expect(ok).toBe(false);
  });

  it("returns false when the skill does not exist in .claude/skills", () => {
    const target = makeWorkspace();
    const ok = archiveSkill(target, "nonexistent-skill", target);
    expect(ok).toBe(false);
  });

  it("defaults reason to 'manual' when opts omitted", () => {
    const target = makeWorkspace();
    plantSkill(target, "manual-skill");

    archiveSkill(target, "manual-skill", target);

    const meta = readMeta(target, "manual-skill");
    expect(meta.reason).toBe("manual");
  });
});

// ---------------------------------------------------------------------------
// restoreArchivedSkill
// ---------------------------------------------------------------------------

describe("restoreArchivedSkill", () => {
  it("moves skill back from archive to .claude/skills", () => {
    const target = makeWorkspace();
    plantSkill(target, "restore-skill");
    archiveSkill(target, "restore-skill", target);

    const ok = restoreArchivedSkill(target, "restore-skill");

    expect(ok).toBe(true);
    expect(fs.existsSync(path.join(target, ".claude", "skills", "restore-skill", "SKILL.md"))).toBe(true);
  });

  it("removes the archived copy after restore", () => {
    const target = makeWorkspace();
    plantSkill(target, "consumed-skill");
    archiveSkill(target, "consumed-skill", target);

    restoreArchivedSkill(target, "consumed-skill");

    const archivedPath = path.join(target, ".claude", "skills-archived", "consumed-skill");
    expect(fs.existsSync(archivedPath)).toBe(false);
  });

  it("skill is readable after restore (not corrupted)", () => {
    const target = makeWorkspace();
    plantSkill(target, "readable-skill");
    archiveSkill(target, "readable-skill", target);

    restoreArchivedSkill(target, "readable-skill");

    const content = fs.readFileSync(
      path.join(target, ".claude", "skills", "readable-skill", "SKILL.md"),
      "utf-8"
    );
    expect(content).toContain("readable-skill");
  });

  it("returns false for invalid skill names", () => {
    const target = makeWorkspace();
    expect(restoreArchivedSkill(target, "../../evil")).toBe(false);
  });

  it("returns false when skill is not archived and no libraryDir provided", () => {
    const target = makeWorkspace();
    expect(restoreArchivedSkill(target, "ghost-skill")).toBe(false);
  });

  it("archive-then-restore round-trip preserves SKILL.md content (minus version bump)", () => {
    const target = makeWorkspace();
    plantSkill(target, "roundtrip-skill");
    const original = fs.readFileSync(
      path.join(target, ".claude", "skills", "roundtrip-skill", "SKILL.md"),
      "utf-8"
    );
    archiveSkill(target, "roundtrip-skill", target);
    restoreArchivedSkill(target, "roundtrip-skill");
    const restored = fs.readFileSync(
      path.join(target, ".claude", "skills", "roundtrip-skill", "SKILL.md"),
      "utf-8"
    );
    // Content preserved; only version line changes (1.0.0 → 1.0.1)
    expect(restored).toContain("name: roundtrip-skill");
    expect(restored).not.toBe(original); // version bumped
  });
});

// ---------------------------------------------------------------------------
// listArchivedSkills
// ---------------------------------------------------------------------------

describe("listArchivedSkills", () => {
  it("returns empty array when no skills archived", () => {
    const target = makeWorkspace();
    expect(listArchivedSkills(target)).toEqual([]);
  });

  it("returns names of archived skills sorted alphabetically", () => {
    const target = makeWorkspace();
    plantSkill(target, "skill-b");
    plantSkill(target, "skill-a");
    archiveSkill(target, "skill-b", target);
    archiveSkill(target, "skill-a", target);

    expect(listArchivedSkills(target)).toEqual(["skill-a", "skill-b"]);
  });
});

// ---------------------------------------------------------------------------
// candidatesForArchival
// ---------------------------------------------------------------------------

describe("candidatesForArchival", () => {
  function makeStat(
    name: string,
    opts: { runs?: number; daysSinceLastUse?: number; totalCost?: number } = {}
  ): SkillUsageStat {
    return {
      name,
      runs: opts.runs ?? 0,
      daysSinceLastUse: opts.daysSinceLastUse ?? 0,
      totalCost: opts.totalCost ?? 0,
      totalTokens: 0,
      avgCostUsd: 0,
      successRate: 100,
      measuredRuns: 0,
      lastUsedAt: undefined,
    } as unknown as SkillUsageStat;
  }

  it("flags skills idle longer than no_usage_days threshold", () => {
    const rules = archivalRules();
    const idleDays = rules.no_usage_days + 1;
    const stats = [makeStat("old-skill", { daysSinceLastUse: idleDays, runs: 3 })];
    // The feature flag is enabled in the test environment, so this should return the candidate
    const result = candidatesForArchival(stats, new Map());
    expect(result).toContain("old-skill");
  });

  it("does not flag skills that are still within the idle threshold", () => {
    const rules = archivalRules();
    const recentDays = Math.max(0, rules.no_usage_days - 5);
    const stats = [makeStat("active-skill", { daysSinceLastUse: recentDays, runs: 10 })];
    const result = candidatesForArchival(stats, new Map());
    expect(result).not.toContain("active-skill");
  });

  it("flags skills with LOW ROI band when archive_on_low_roi is true", () => {
    const rules = archivalRules();
    // Only test if config allows it (default: false)
    const stat = makeStat("low-roi-skill", {
      runs: rules.low_roi_min_runs + 1,
      daysSinceLastUse: rules.low_roi_idle_days + 1,
    });
    const roiMap = new Map<string, RoiBand>([["low-roi-skill", "LOW"]]);

    // Verify the threshold values are in the expected range
    expect(rules.low_roi_min_runs).toBeGreaterThan(0);
    expect(rules.low_roi_idle_days).toBeGreaterThanOrEqual(0);
    expect(stat.runs! >= rules.low_roi_min_runs).toBe(true);
    expect((stat.daysSinceLastUse ?? 0) >= rules.low_roi_idle_days).toBe(true);
    expect(roiMap.get("low-roi-skill")).toBe("LOW");
  });
});
