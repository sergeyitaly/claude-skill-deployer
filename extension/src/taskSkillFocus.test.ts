import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { listEffectiveEnabledSkills, readSkillOverrides } from "./skillOps";
import {
  applyTaskSkillFocus,
  applyTaskSkillFocusFromProposals,
  clearTaskFocusTrackingForSkill,
  readTaskActiveSkills,
  taskActiveSkillsPath,
} from "./taskSkillFocus";
import { setSkillOverride } from "./skillOps";
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

  it("regression: a manually re-enabled skill stays on across the next re-sweep, even though it's still outside the active set", () => {
    // Reported bug: a user re-enables a skill task-focus had disabled, but
    // applyTaskSkillFocus() recomputes its full sweep from scratch on every call with no
    // memory of the manual action — the very next re-apply (proposals regenerating, or the
    // installed set drifting) silently disables it again, sometimes within seconds since
    // re-applies are driven by ordinary tool-call activity.
    const target = makeWorkspace();
    // Pass 1: mcp-builder is outside the active set — task-focus disables it.
    applyTaskSkillFocus(target, ["pdf"], "task-skill-proposals", "2026-06-14T00:00:00.000Z");
    expect(readSkillOverrides(target)["mcp-builder"]).toBe("off");

    // User re-enables it locally — exactly what claudeSkills.enableSkillLocally does.
    setSkillOverride(target, "mcp-builder", undefined);
    clearTaskFocusTrackingForSkill(target, "mcp-builder");

    // Pass 2: task set is unchanged (mcp-builder is still outside it) — must NOT be swept
    // back off.
    const second = applyTaskSkillFocus(target, ["pdf"], "task-skill-proposals", "2026-06-14T01:00:00.000Z");

    expect(second.ignoredSkills).not.toContain("mcp-builder");
    expect(readSkillOverrides(target)["mcp-builder"]).toBeUndefined();
    expect(listEffectiveEnabledSkills(target)).toContain("mcp-builder");
  });

  it("implicit reclaim: a direct settings.local.json edit (no clearTaskFocusTrackingForSkill call) is respected too", () => {
    // Live-reported gap: userReenabledSkills only got populated via the command path. An
    // agent directly editing settings.local.json to remove the override — a common pattern
    // in agentic workflows — never calls clearTaskFocusTrackingForSkill, so the very next
    // re-sweep silently disabled the skill again despite the 1.0.143 fix.
    const target = makeWorkspace();
    applyTaskSkillFocus(target, ["pdf"], "task-skill-proposals", "2026-06-14T00:00:00.000Z");
    expect(readSkillOverrides(target)["mcp-builder"]).toBe("off");

    // Direct file edit — no clearTaskFocusTrackingForSkill call at all.
    setSkillOverride(target, "mcp-builder", undefined);

    const second = applyTaskSkillFocus(target, ["pdf"], "task-skill-proposals", "2026-06-14T01:00:00.000Z");

    expect(second.ignoredSkills).not.toContain("mcp-builder");
    expect(readSkillOverrides(target)["mcp-builder"]).toBeUndefined();

    // Promoted to the durable ledger so it stays protected on every future sweep too.
    const third = applyTaskSkillFocus(target, ["pdf"], "task-skill-proposals", "2026-06-14T02:00:00.000Z");
    expect(third.ignoredSkills).not.toContain("mcp-builder");
    expect(readSkillOverrides(target)["mcp-builder"]).toBeUndefined();
  });

  it("regression: prunes skillOverrides entries left behind by a skill that's no longer installed (live-reported: 39 override entries against 33 installed skills)", () => {
    const target = makeWorkspace();
    applyTaskSkillFocus(target, ["pdf"], "task-skill-proposals", "2026-06-14T00:00:00.000Z");
    expect(readSkillOverrides(target)["mcp-builder"]).toBe("off");

    // The skill is removed entirely (uninstall, cleanup, whatever) — the override entry
    // for it has no way to ever mean anything again.
    fs.rmSync(path.join(target, ".claude", "skills", "mcp-builder"), { recursive: true, force: true });

    const result = applyTaskSkillFocus(target, ["pdf"], "task-skill-proposals", "2026-06-14T01:00:00.000Z");

    expect(readSkillOverrides(target)).not.toHaveProperty("mcp-builder");
    expect(result.overridesApplied).toBeGreaterThan(0);
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
