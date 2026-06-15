import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { areAttributionHooksConfigured, costControlHooksActive, installCostControlHooks } from "./hookOps";
import { ensureAttributionHooksActive, flushDebouncedWorkspaceSkillSync, propagateWorkspaceSkillChange, resetWorkspaceSyncQueueForTests } from "./workspaceSkillSync";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: (section: string) => ({
      get: (key: string, defaultValue?: unknown) => {
        if (section === "claudeSkills.agents" && key === "autoInstallAttributionHooks") {
          return true;
        }
        if (section === "claudeSkills.agents" && key === "syncHooksOnSkillChange") {
          return true;
        }
        if (section === "claudeSkills.agents" && key === "enabled") {
          return ["claude", "cursor", "kiro", "copilot"];
        }
        if (section === "claudeSkills" && key === "officialSkillsCheckOnSession") {
          return false;
        }
        return defaultValue;
      },
    }),
  },
}));

const EXTENSION_PATH = path.join(__dirname, "..");
const workspaces: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csd-sync-"));
  workspaces.push(dir);
  return dir;
}

afterEach(() => {
  resetWorkspaceSyncQueueForTests();
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

describe("ensureAttributionHooksActive", () => {
  it("installs hooks with zero workspace skills", () => {
    const target = makeWorkspace();
    const logs: string[] = [];
    const status = ensureAttributionHooksActive(EXTENSION_PATH, target, (line) => logs.push(line));
    expect(status === "installed" || status === "updated").toBe(true);
    expect(areAttributionHooksConfigured(target, EXTENSION_PATH)).toBe(true);
    expect(logs.some((l) => l.includes("Attribution v2 hooks"))).toBe(true);
  });
});

describe("propagateWorkspaceSkillChange", () => {
  it("installs attribution hooks even when no skills are installed", () => {
    const target = makeWorkspace();
    propagateWorkspaceSkillChange(EXTENSION_PATH, target, path.join(__dirname, "..", "skills_library"), () => {}, {
      saveBranchProfile: false,
      forceAgentSync: true,
    });
    expect(areAttributionHooksConfigured(target, EXTENSION_PATH)).toBe(true);
  });

  it("does not install cost-control copilot hooks when only attribution is active", () => {
    const target = makeWorkspace();
    fs.mkdirSync(path.join(target, ".claude", "skills", "alpha-skill"), { recursive: true });
    fs.writeFileSync(path.join(target, ".claude", "skills", "alpha-skill", "SKILL.md"), "# Alpha\n", "utf-8");
    propagateWorkspaceSkillChange(EXTENSION_PATH, target, path.join(__dirname, "..", "skills_library"), () => {}, {
      saveBranchProfile: false,
      forceAgentSync: true,
    });
    expect(areAttributionHooksConfigured(target, EXTENSION_PATH)).toBe(true);
    expect(costControlHooksActive(target)).toBe(false);
    expect(fs.existsSync(path.join(target, ".github", "hooks", "claude-skills-budget.json"))).toBe(false);
  });

  it("refreshes cost-control hooks on all agents when cost control is active", () => {
    const target = makeWorkspace();
    fs.mkdirSync(path.join(target, ".claude", "skills", "alpha-skill"), { recursive: true });
    fs.writeFileSync(path.join(target, ".claude", "skills", "alpha-skill", "SKILL.md"), "# Alpha\n", "utf-8");
    installCostControlHooks(EXTENSION_PATH, target);
    propagateWorkspaceSkillChange(EXTENSION_PATH, target, path.join(__dirname, "..", "skills_library"), () => {}, {
      saveBranchProfile: false,
      forceAgentSync: true,
    });
    expect(costControlHooksActive(target)).toBe(true);
    expect(fs.existsSync(path.join(target, ".github", "hooks", "claude-skills-context-focus.json"))).toBe(true);
  });

  it("debounces repeated propagate calls into one run", () => {
    const target = makeWorkspace();
    let runs = 0;
    const log = () => {
      runs++;
    };
    propagateWorkspaceSkillChange(EXTENSION_PATH, target, path.join(__dirname, "..", "skills_library"), log, {
      saveBranchProfile: false,
    });
    propagateWorkspaceSkillChange(EXTENSION_PATH, target, path.join(__dirname, "..", "skills_library"), log, {
      saveBranchProfile: false,
    });
    expect(flushDebouncedWorkspaceSkillSync()).toBeDefined();
    expect(runs).toBeGreaterThan(0);
  });
});
