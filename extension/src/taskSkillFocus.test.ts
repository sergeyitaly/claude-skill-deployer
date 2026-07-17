import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { listEffectiveEnabledSkills, readSkillOverrides } from "./skillOps";
import {
  applyTaskSkillFocus,
  applyTaskSkillFocusFromProposals,
  readTaskActiveSkills,
  taskActiveSkillsPath,
} from "./taskSkillFocus";
import { writeTaskSkillProposals } from "./taskSkillProposals";
import { listInstalledSkills } from "./usageStats";

function installSkillDir(target: string, name: string): void {
  const skillDir = path.join(target, ".claude", "skills", name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf-8");
}

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-focus-"));
  for (const name of ["pdf", "mcp-builder"]) {
    installSkillDir(dir, name);
  }
  return dir;
}

describe("applyTaskSkillFocus", () => {
  it("sets skillOverrides off for skills outside the active task set", () => {
    const target = makeWorkspace();
    const focus = applyTaskSkillFocus(target, ["pdf"], "task-skill-proposals", "2026-06-14T00:00:00.000Z");

    expect(focus.activeSkills).toContain("pdf");
    expect(focus.ignoredSkills).toContain("mcp-builder");
    expect(readSkillOverrides(target)["mcp-builder"]).toBe("off");
    expect(readSkillOverrides(target).pdf).toBeUndefined();
    expect(listEffectiveEnabledSkills(target)).toContain("pdf");
    expect(listEffectiveEnabledSkills(target)).not.toContain("mcp-builder");

    const saved = readTaskActiveSkills(target);
    expect(saved?.activeSkills).toContain("pdf");
    expect(fs.existsSync(taskActiveSkillsPath(target))).toBe(true);
  });

  it("re-enables previously ignored skills when they join a new task set", () => {
    const target = makeWorkspace();
    applyTaskSkillFocus(target, ["pdf"], "task-skill-proposals");
    applyTaskSkillFocus(target, ["pdf", "mcp-builder"], "task-skill-proposals", "2026-06-14T01:00:00.000Z");

    expect(readSkillOverrides(target)["mcp-builder"]).toBeUndefined();
    expect(listEffectiveEnabledSkills(target)).toContain("mcp-builder");
  });
});

describe("applyTaskSkillFocusFromProposals (regression: installed-set drift with unchanged proposals)", () => {
  it("prunes a skill installed after the last sweep even when task-skill-proposals.json hasn't regenerated", () => {
    const target = makeWorkspace();
    const libraryDir = path.join(__dirname, "..", "skills_library");
    const generatedAt = "2026-07-17T00:00:00.000Z";

    writeTaskSkillProposals(target, {
      version: 1,
      generatedAt,
      taskSummary: "Workspace-detected skills",
      proposals: [{ name: "pdf", reason: "test", confidence: 90, installed: true }],
    });

    // First sweep: pdf active, mcp-builder ignored (off) — normal path, already covered above.
    const first = applyTaskSkillFocusFromProposals(libraryDir, target);
    expect(first.applied).toBe(true);
    expect(readSkillOverrides(target)["mcp-builder"]).toBe("off");

    // Simulate a skill landing on disk through a different path (e.g. "Install Relevant
    // Skills for Workspace", a manual copy) — same proposals file, so generatedAt is
    // unchanged, but the installed set now has a skill the last sweep never accounted for.
    installSkillDir(target, "webapp-testing");

    const second = applyTaskSkillFocusFromProposals(libraryDir, target);

    // Before the fix: this returned { applied: false } because proposalsGeneratedAt still
    // matched, so webapp-testing was left with no override — neither active nor ignored —
    // permanently un-pruned noise alongside the genuinely relevant skills.
    expect(second.applied).toBe(true);
    expect(readSkillOverrides(target)["webapp-testing"]).toBe("off");
  });

  it("stays a no-op when the installed set hasn't changed and proposals are unchanged", () => {
    const target = makeWorkspace();
    const libraryDir = path.join(__dirname, "..", "skills_library");

    writeTaskSkillProposals(target, {
      version: 1,
      generatedAt: "2026-07-17T00:00:00.000Z",
      taskSummary: "Workspace-detected skills",
      proposals: [{ name: "pdf", reason: "test", confidence: 90, installed: true }],
    });

    applyTaskSkillFocusFromProposals(libraryDir, target);
    const second = applyTaskSkillFocusFromProposals(libraryDir, target);

    expect(second.applied).toBe(false);
  });
});
