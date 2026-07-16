import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockConfig: Record<string, Record<string, unknown>> = {
  "claudeSkills.taskFocus": { enabled: false },
};

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: (section: string) => ({
      get: (key: string, defaultValue?: unknown) => {
        if (mockConfig[section] && key in mockConfig[section]) {
          return mockConfig[section][key];
        }
        if (section === "claudeSkills.agents" && key === "enabled") {
          return ["claude", "cursor", "kiro", "copilot"];
        }
        return defaultValue;
      },
    }),
  },
}));

let emergencyDisabled: string[] = [];
vi.mock("./emergencyCutoff", () => ({
  emergencyDisabledSkillNames: () => emergencyDisabled,
}));

import * as skillOps from "./skillOps";
import { readSkillOverrides, setSkillOverride } from "./skillOps";
import {
  applyTaskSkillFocus,
  clearTaskSkillFocus,
  reclaimOrphanedTaskFocusOverrides,
  recordTaskFocusDisabled,
  readTaskActiveSkills,
  writeTaskActiveSkills,
} from "./taskSkillFocus";
import { disableHighTierSkills } from "./budgetOps";

const workspaces: string[] = [];

function makeWorkspace(skillNames: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csd-taskfocus-cleanup-"));
  workspaces.push(dir);
  for (const name of skillNames) {
    const skillDir = path.join(dir, ".claude", "skills", name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf-8");
  }
  return dir;
}

function readRawSettingsLocal(target: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(target, ".claude", "settings.local.json"), "utf-8"));
}

afterEach(() => {
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
  mockConfig["claudeSkills.taskFocus"] = { enabled: false };
  emergencyDisabled = [];
  vi.restoreAllMocks();
});

describe("clearTaskSkillFocus — durable ledger survives task-active-skills.json going stale", () => {
  it("clears a ledger-tracked override even when ignoredSkills reads back empty (the reported bug)", () => {
    const target = makeWorkspace(["mcp-builder", "frontend-design"]);

    // applyTaskSkillFocus writes both ignoredSkills AND the ledger in the same call.
    applyTaskSkillFocus(target, [], "task-skill-proposals");
    expect(readSkillOverrides(target)["mcp-builder"]).toBe("off");
    expect(readSkillOverrides(target)["frontend-design"]).toBe("off");

    // Reproduce the exact bug: something external resets task-active-skills.json back to
    // empty arrays (a "manual" reset) WITHOUT touching settings.local.json — this is the
    // observed real-world state (ignoredSkills: [] while skillOverrides still say "off").
    const state = readTaskActiveSkills(target)!;
    writeTaskActiveSkills(target, { ...state, source: "manual", activeSkills: [], ignoredSkills: [] });
    expect(readTaskActiveSkills(target)!.ignoredSkills).toHaveLength(0);

    const cleared = clearTaskSkillFocus(target);

    expect(cleared).toBe(2);
    expect(readSkillOverrides(target)["mcp-builder"]).toBeUndefined();
    expect(readSkillOverrides(target)["frontend-design"]).toBeUndefined();
  });

  it("records disableUndesired-style sweeps into the ledger via recordTaskFocusDisabled, clearable even without ignoredSkills ever mentioning them", () => {
    const target = makeWorkspace(["github-actions-ci"]);
    setSkillOverride(target, "github-actions-ci", "off");
    recordTaskFocusDisabled(target, ["github-actions-ci"]);

    // No task-active-skills.json exists at all for this workspace (as if applyBranchProfile's
    // disableUndesired sweep ran standalone, never touching that file) — clearTaskSkillFocus
    // must still find it via the ledger alone.
    expect(readTaskActiveSkills(target)).toBeNull();

    const cleared = clearTaskSkillFocus(target);
    expect(cleared).toBe(1);
    expect(readSkillOverrides(target)["github-actions-ci"]).toBeUndefined();
  });
});

describe("reclaimOrphanedTaskFocusOverrides — one-time legacy migration", () => {
  it("reclaims an unattributed stale 'off' override (workspace created before the fix)", () => {
    const target = makeWorkspace(["vscode-extension-publishing"]);
    // Simulate a pre-fix workspace: override is off, no ledger entry exists anywhere.
    setSkillOverride(target, "vscode-extension-publishing", "off");

    const { reclaimed } = reclaimOrphanedTaskFocusOverrides(target);

    expect(reclaimed).toEqual(["vscode-extension-publishing"]);
    expect(readSkillOverrides(target)["vscode-extension-publishing"]).toBeUndefined();

    const log = fs.readFileSync(
      path.join(target, ".claude", "learning", "task-focus-migration.jsonl"),
      "utf-8"
    );
    expect(log).toContain("vscode-extension-publishing");
  });

  it("never touches an override protected by an active emergency cutoff", () => {
    const target = makeWorkspace(["mcp-builder"]);
    setSkillOverride(target, "mcp-builder", "off");
    emergencyDisabled = ["mcp-builder"];

    const { reclaimed } = reclaimOrphanedTaskFocusOverrides(target);

    expect(reclaimed).toEqual([]);
    expect(readSkillOverrides(target)["mcp-builder"]).toBe("off");
  });

  it("never touches an override protected by budget/economy tracking", () => {
    const target = makeWorkspace(["skill-creator"]);
    disableHighTierSkills(target, ["skill-creator"], "economy");
    expect(readSkillOverrides(target)["skill-creator"]).toBe("off");

    const { reclaimed } = reclaimOrphanedTaskFocusOverrides(target);

    expect(reclaimed).toEqual([]);
    expect(readSkillOverrides(target)["skill-creator"]).toBe("off");
  });

  it("runs only once — a manual disable added after the migration is never swept", () => {
    const target = makeWorkspace(["frontend-design", "docx"]);
    setSkillOverride(target, "frontend-design", "off");

    // First run: reclaims the legacy orphan and marks the migration done.
    expect(reclaimOrphanedTaskFocusOverrides(target).reclaimed).toEqual(["frontend-design"]);

    // A real user disables "docx" locally after the migration already ran once.
    setSkillOverride(target, "docx", "off");

    const second = reclaimOrphanedTaskFocusOverrides(target);
    expect(second.reclaimed).toEqual([]);
    expect(readSkillOverrides(target)["docx"]).toBe("off");
  });

  it("does not remove an override still tracked in the ledger (normal clearTaskSkillFocus path handles those)", () => {
    const target = makeWorkspace(["mcp-server-creation"]);
    applyTaskSkillFocus(target, [], "task-skill-proposals");
    expect(readSkillOverrides(target)["mcp-server-creation"]).toBe("off");

    const { reclaimed } = reclaimOrphanedTaskFocusOverrides(target);

    // Ledgered — untouched by the legacy sweep; still off (clearTaskSkillFocus is the
    // path responsible for these, and it already ran conceptually via applyTaskSkillFocus's
    // own bookkeeping in this test's setup).
    expect(reclaimed).toEqual([]);
    expect(readSkillOverrides(target)["mcp-server-creation"]).toBe("off");
  });
});

describe("no unrelated user-created overrides are removed", () => {
  it("a manual disable made before any ledger entry ever existed for that skill, on a workspace with an unrelated already-migrated skill, is left alone", () => {
    const target = makeWorkspace(["frontend-design", "pdf"]);
    setSkillOverride(target, "frontend-design", "off");

    // Migration runs once (legitimately reclaims the orphan above, since nothing marks
    // it as anything other than orphaned at this point).
    reclaimOrphanedTaskFocusOverrides(target);
    expect(readSkillOverrides(target)["frontend-design"]).toBeUndefined();

    // User now manually disables "pdf" for real, after the one-time window has closed.
    setSkillOverride(target, "pdf", "off");

    // Any subsequent taskFocus cleanup call must never touch it again.
    reclaimOrphanedTaskFocusOverrides(target);
    clearTaskSkillFocus(target);

    expect(readSkillOverrides(target)["pdf"]).toBe("off");
  });

  it("settings.local.json keeps only the skillOverrides + ledger keys — no unrelated permissions are disturbed", () => {
    const target = makeWorkspace(["mcp-builder"]);
    fs.writeFileSync(
      path.join(target, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Bash(git *)"] }, skillOverrides: { "mcp-builder": "off" } }, null, 2)
    );

    reclaimOrphanedTaskFocusOverrides(target);

    const raw = readRawSettingsLocal(target);
    expect(raw.permissions).toEqual({ allow: ["Bash(git *)"] });
    expect(readSkillOverrides(target)["mcp-builder"]).toBeUndefined();
  });
});

describe("reclaimOrphanedTaskFocusOverrides — verifies persistence before locking legacyMigrationDone", () => {
  it("reports success and locks legacyMigrationDone when the clear actually persists (happy path)", () => {
    const target = makeWorkspace(["mcp-builder"]);
    setSkillOverride(target, "mcp-builder", "off");

    const { reclaimed } = reclaimOrphanedTaskFocusOverrides(target);

    expect(reclaimed).toEqual(["mcp-builder"]);
    expect(readSkillOverrides(target)["mcp-builder"]).toBeUndefined();
    const raw = readRawSettingsLocal(target) as { claudeSkillsTaskFocus?: { legacyMigrationDone?: boolean } };
    expect(raw.claudeSkillsTaskFocus?.legacyMigrationDone).toBe(true);

    const log = fs.readFileSync(
      path.join(target, ".claude", "learning", "task-focus-migration.jsonl"),
      "utf-8"
    );
    expect(JSON.parse(log.trim().split("\n").pop()!)).toMatchObject({ reclaimed: ["mcp-builder"], persisted: true });
  });

  it("reproduces the real bug: a second writer puts the override back to 'off' before verification — legacyMigrationDone must NOT be locked, and the skill must be reported as still off, not reclaimed", () => {
    const target = makeWorkspace(["mcp-builder", "github-actions-ci"]);
    setSkillOverride(target, "mcp-builder", "off");
    setSkillOverride(target, "github-actions-ci", "off");

    // Simulate applyBranchProfile()'s (formerly unconditional) profile-override reapply
    // landing between this function's own clearing loop and its read-back verification —
    // exactly what happened live on 2026-07-15: the migration logged "reclaimed" for
    // mcp-builder, github-actions-ci, webapp-testing, frontend-design, mcp-server-creation,
    // then all five were still (or again) "off" in settings.local.json moments later.
    const realSetSkillOverride = skillOps.setSkillOverride;
    vi.spyOn(skillOps, "setSkillOverride").mockImplementation((t, name, value) => {
      realSetSkillOverride(t, name, value);
      if (value === undefined && name === "mcp-builder") {
        realSetSkillOverride(t, name, "off");
      }
    });

    const { reclaimed } = reclaimOrphanedTaskFocusOverrides(target);

    // github-actions-ci genuinely cleared; mcp-builder got clobbered back to "off" by the
    // simulated second writer before the verification read.
    expect(reclaimed).toEqual(["github-actions-ci"]);
    expect(readSkillOverrides(target)["mcp-builder"]).toBe("off");
    expect(readSkillOverrides(target)["github-actions-ci"]).toBeUndefined();

    // legacyMigrationDone must stay unset so a future SessionStart gets another chance at
    // mcp-builder — this is the actual state-machine bug: previously this was set to `true`
    // unconditionally right after the clearing loop, regardless of whether it persisted.
    const raw = readRawSettingsLocal(target) as { claudeSkillsTaskFocus?: { legacyMigrationDone?: boolean } };
    expect(raw.claudeSkillsTaskFocus?.legacyMigrationDone).toBeUndefined();

    const log = fs.readFileSync(
      path.join(target, ".claude", "learning", "task-focus-migration.jsonl"),
      "utf-8"
    );
    const lastEntry = JSON.parse(log.trim().split("\n").pop()!);
    expect(lastEntry.persisted).toBe(false);
    expect(lastEntry.stillOff).toEqual(["mcp-builder"]);

    // Because legacyMigrationDone never got locked, a later retry (once the clobbering
    // writer is fixed / stops racing) can still reclaim mcp-builder.
    vi.restoreAllMocks();
    const retry = reclaimOrphanedTaskFocusOverrides(target);
    expect(retry.reclaimed).toEqual(["mcp-builder"]);
    expect(readSkillOverrides(target)["mcp-builder"]).toBeUndefined();
  });
});
