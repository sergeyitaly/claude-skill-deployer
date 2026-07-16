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
        if (section === "claudeSkills.agents" && key === "syncWorkspaceToAll") {
          return false;
        }
        return defaultValue;
      },
    }),
  },
}));

import { applyBranchProfile, BranchSkillProfile } from "./branchProfiles";
import { readSkillOverrides } from "./skillOps";

const workspaces: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csd-branchprofiles-"));
  workspaces.push(dir);
  return dir;
}

function profileWithOverrides(overrides: Record<string, string>): BranchSkillProfile {
  return {
    branch: "main",
    skills: [],
    skillOverrides: overrides,
    updatedAt: new Date().toISOString(),
    workspacePath: "",
  };
}

afterEach(() => {
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
  mockConfig["claudeSkills.taskFocus"] = { enabled: false };
});

describe("applyBranchProfile — profileOverrides reapplication respects claudeSkills.taskFocus.enabled", () => {
  it("does NOT reapply a saved 'off' override from automatic/background callers while task focus is disabled (bug reproduction)", () => {
    const target = makeWorkspace();
    const profile = profileWithOverrides({ "mcp-builder": "off" });

    // Automatic/background call site shape: no opts passed at all — this is exactly how
    // handleBranchSync (hookHandlers.ts), handleBranchChange (branchProfiles.ts), and
    // applyTeamBranchProfile (teamBranchProfiles.ts) call this function.
    const result = applyBranchProfile("unused-library-dir", target, profile);

    expect(readSkillOverrides(target)["mcp-builder"]).toBeUndefined();
    expect(result.overridesApplied).toBe(0);
  });

  it("still reapplies a saved 'off' override when task focus is enabled (unchanged legacy behavior)", () => {
    mockConfig["claudeSkills.taskFocus"] = { enabled: true };
    const target = makeWorkspace();
    const profile = profileWithOverrides({ "mcp-builder": "off" });

    const result = applyBranchProfile("unused-library-dir", target, profile);

    expect(readSkillOverrides(target)["mcp-builder"]).toBe("off");
    expect(result.overridesApplied).toBe(1);
  });

  it("an explicit disableUndesired: true caller (the 'Apply Branch Skill Profile' command) still restores 'off' even while task focus is disabled", () => {
    const target = makeWorkspace();
    const profile = profileWithOverrides({ "mcp-builder": "off" });

    const result = applyBranchProfile("unused-library-dir", target, profile, { disableUndesired: true });

    expect(readSkillOverrides(target)["mcp-builder"]).toBe("off");
    expect(result.overridesApplied).toBe(1);
  });

  it("an explicit disableUndesired: false caller suppresses reapplication regardless of the master switch", () => {
    mockConfig["claudeSkills.taskFocus"] = { enabled: true };
    const target = makeWorkspace();
    const profile = profileWithOverrides({ "mcp-builder": "off" });

    const result = applyBranchProfile("unused-library-dir", target, profile, { disableUndesired: false });

    expect(readSkillOverrides(target)["mcp-builder"]).toBeUndefined();
    expect(result.overridesApplied).toBe(0);
  });

  it("always reapplies a non-'off' saved override (e.g. re-enabling), even while task focus is disabled", () => {
    const target = makeWorkspace();
    // Workspace currently has the skill force-disabled locally; the saved profile says "on".
    fs.mkdirSync(path.join(target, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(target, ".claude", "settings.local.json"),
      JSON.stringify({ skillOverrides: { "mcp-builder": "off" } }, null, 2)
    );
    const profile = profileWithOverrides({ "mcp-builder": "on" });

    const result = applyBranchProfile("unused-library-dir", target, profile);

    expect(readSkillOverrides(target)["mcp-builder"]).toBe("on");
    expect(result.overridesApplied).toBe(1);
  });
});
