import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearBudgetTrackingForSkill,
  disableHighTierSkills,
  isBudgetDisabled,
  restoreBudgetDisabledSkills,
} from "./budgetOps";

const workspaces: string[] = [];

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "budget-ops-"));
  workspaces.push(root);
  return root;
}

function settingsPath(target: string): string {
  return path.join(target, ".claude", "settings.local.json");
}

function writeSettings(target: string, settings: unknown): void {
  const file = settingsPath(target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

function readSettings(target: string): any {
  return JSON.parse(fs.readFileSync(settingsPath(target), "utf-8"));
}

afterEach(() => {
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

describe("disableHighTierSkills", () => {
  it("turns off the given skills and tracks them under disabledByBudget", () => {
    const target = makeWorkspace();
    const disabled = disableHighTierSkills(target, ["aidlc-doc-writer", "drawio-diagrams"], "economy");

    expect(disabled).toEqual(["aidlc-doc-writer", "drawio-diagrams"]);
    const settings = readSettings(target);
    expect(settings.skillOverrides).toEqual({ "aidlc-doc-writer": "off", "drawio-diagrams": "off" });
    expect(settings.claudeSkillsBudget).toEqual({
      disabledByBudget: ["aidlc-doc-writer", "drawio-diagrams"],
      disabledReason: "economy",
    });
  });

  it("does not re-disable skills the user manually turned off", () => {
    const target = makeWorkspace();
    writeSettings(target, { skillOverrides: { "manual-skill": "off" } });

    const disabled = disableHighTierSkills(target, ["manual-skill"], "economy");
    expect(disabled).toEqual([]);
    expect(readSettings(target).claudeSkillsBudget).toBeUndefined();
  });
});

describe("restoreBudgetDisabledSkills", () => {
  it("restores skills tracked under disabledByBudget", () => {
    const target = makeWorkspace();
    writeSettings(target, {
      skillOverrides: { "aidlc-doc-writer": "off" },
      claudeSkillsBudget: { disabledByBudget: ["aidlc-doc-writer"], disabledReason: "economy" },
    });

    const restored = restoreBudgetDisabledSkills(target);
    expect(restored).toEqual(["aidlc-doc-writer"]);
    const settings = readSettings(target);
    expect(settings.skillOverrides).toBeUndefined();
    expect(settings.claudeSkillsBudget).toBeUndefined();
  });

  it("also restores skills tracked under disabledByBudgetRestrict", () => {
    const target = makeWorkspace();
    writeSettings(target, {
      skillOverrides: { "aidlc-doc-writer": "off", "adx-schema-check": "off", "manual-skill": "off" },
      claudeSkillsBudget: {
        disabledByBudget: ["aidlc-doc-writer"],
        disabledByBudgetRestrict: ["adx-schema-check"],
        disabledReason: "budget-95pct-restrict",
      },
    });

    const restored = restoreBudgetDisabledSkills(target);
    expect(restored.sort()).toEqual(["adx-schema-check", "aidlc-doc-writer"]);
    const settings = readSettings(target);
    expect(settings.skillOverrides).toEqual({ "manual-skill": "off" });
    expect(settings.claudeSkillsBudget).toBeUndefined();
  });

  it("returns an empty array when nothing is tracked", () => {
    const target = makeWorkspace();
    expect(restoreBudgetDisabledSkills(target)).toEqual([]);
  });
});

describe("isBudgetDisabled", () => {
  it("is true for a skill tracked under disabledByBudgetRestrict and turned off", () => {
    const target = makeWorkspace();
    writeSettings(target, {
      skillOverrides: { "adx-schema-check": "off" },
      claudeSkillsBudget: { disabledByBudgetRestrict: ["adx-schema-check"] },
    });

    expect(isBudgetDisabled(target, "adx-schema-check")).toBe(true);
  });

  it("is false for a manually disabled skill that budget enforcement doesn't track", () => {
    const target = makeWorkspace();
    writeSettings(target, { skillOverrides: { "manual-skill": "off" } });

    expect(isBudgetDisabled(target, "manual-skill")).toBe(false);
  });

  it("is false once a tracked skill has been re-enabled", () => {
    const target = makeWorkspace();
    writeSettings(target, {
      skillOverrides: {},
      claudeSkillsBudget: { disabledByBudget: ["aidlc-doc-writer"] },
    });

    expect(isBudgetDisabled(target, "aidlc-doc-writer")).toBe(false);
  });
});

describe("clearBudgetTrackingForSkill", () => {
  it("removes a skill from disabledByBudgetRestrict without disturbing disabledByBudget", () => {
    const target = makeWorkspace();
    writeSettings(target, {
      skillOverrides: { "aidlc-doc-writer": "off", "adx-schema-check": "off" },
      claudeSkillsBudget: {
        disabledByBudget: ["aidlc-doc-writer"],
        disabledByBudgetRestrict: ["adx-schema-check"],
        disabledReason: "budget-95pct-restrict",
      },
    });

    clearBudgetTrackingForSkill(target, "adx-schema-check");

    const settings = readSettings(target);
    expect(settings.claudeSkillsBudget.disabledByBudgetRestrict).toBeUndefined();
    expect(settings.claudeSkillsBudget.disabledByBudget).toEqual(["aidlc-doc-writer"]);
    expect(settings.claudeSkillsBudget.disabledReason).toBe("budget-95pct-restrict");
  });

  it("drops disabledReason once both tracking lists are empty, but records the re-enable", () => {
    const target = makeWorkspace();
    writeSettings(target, {
      skillOverrides: { "adx-schema-check": "off" },
      claudeSkillsBudget: { disabledByBudgetRestrict: ["adx-schema-check"], disabledReason: "budget-95pct-restrict" },
    });

    clearBudgetTrackingForSkill(target, "adx-schema-check");

    const settings = readSettings(target);
    expect(settings.claudeSkillsBudget.disabledByBudgetRestrict).toBeUndefined();
    expect(settings.claudeSkillsBudget.disabledReason).toBeUndefined();
    // Recorded so disableHighTierSkills() won't silently re-disable it on its next pass.
    expect(settings.claudeSkillsBudget.userReenabledSkills).toEqual(["adx-schema-check"]);
  });

  it("leaves skillOverrides untouched when the skill isn't tracked, but still records the re-enable", () => {
    const target = makeWorkspace();
    writeSettings(target, { skillOverrides: { "manual-skill": "off" } });

    clearBudgetTrackingForSkill(target, "manual-skill");

    const settings = readSettings(target);
    expect(settings.skillOverrides).toEqual({ "manual-skill": "off" });
    expect(settings.claudeSkillsBudget.userReenabledSkills).toEqual(["manual-skill"]);
  });
});

describe("disableHighTierSkills — respects a user's manual re-enable", () => {
  it("skips a skill recorded in userReenabledSkills even though it's still in the input list", () => {
    // Reproduces the reported bug: a user re-enables a high-tier skill, but two independent,
    // uncoordinated callers (budgetTierGating.ts's refresh loop, hookHandlers.ts's
    // handleBudget) both keep recomputing the same "high-tier skills outside the active set"
    // list and calling disableHighTierSkills() with it again on their own next pass — with
    // no memory of the user's action, it silently wins the race and re-disables the skill.
    const target = makeWorkspace();
    writeSettings(target, {
      skillOverrides: {},
      claudeSkillsBudget: { userReenabledSkills: ["aidlc-doc-writer"] },
    });

    const disabled = disableHighTierSkills(target, ["aidlc-doc-writer", "drawio-diagrams"], "budget-warn");

    expect(disabled).toEqual(["drawio-diagrams"]);
    const settings = readSettings(target);
    expect(settings.skillOverrides).toEqual({ "drawio-diagrams": "off" });
    expect(settings.claudeSkillsBudget.userReenabledSkills).toEqual(["aidlc-doc-writer"]);
  });

  it("end-to-end: clearBudgetTrackingForSkill followed by disableHighTierSkills leaves the skill on", () => {
    const target = makeWorkspace();
    disableHighTierSkills(target, ["aidlc-doc-writer"], "budget-warn");
    expect(readSettings(target).skillOverrides).toEqual({ "aidlc-doc-writer": "off" });

    // User manually re-enables it (claudeSkills.enableSkillLocally command path).
    clearBudgetTrackingForSkill(target, "aidlc-doc-writer");
    const overrides = { ...readSettings(target).skillOverrides };
    delete overrides["aidlc-doc-writer"]; // setSkillOverride(target, name, undefined)
    writeSettings(target, { ...readSettings(target), skillOverrides: overrides });

    // Budget gating's next pass recomputes the same candidate list and tries again.
    const disabledAgain = disableHighTierSkills(target, ["aidlc-doc-writer"], "budget-warn");

    expect(disabledAgain).toEqual([]);
    expect(readSettings(target).skillOverrides ?? {}).not.toHaveProperty("aidlc-doc-writer");
  });
});
