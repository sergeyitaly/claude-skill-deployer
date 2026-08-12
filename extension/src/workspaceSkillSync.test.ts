import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { areAttributionHooksConfigured, costControlHooksActive, installCostControlHooks } from "./hookOps";
import {
  ensureAttributionHooksActive,
  ensureCostControlHooksActive,
  flushDebouncedWorkspaceSkillSync,
  propagateWorkspaceSkillChange,
  resetWorkspaceSyncQueueForTests,
} from "./workspaceSkillSync";

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

describe("ensureCostControlHooksActive", () => {
  it("regression: catches up a workspace that already has one cost-control hook but is missing the Stop hook and still uses legacy session-size", () => {
    // Live-reported gap: the old gate skipped re-running installCostControlHooks() entirely
    // once ANY cost-control hook existed (e.g. just "budget"), so a workspace stuck on the
    // pre-consolidation session-size/context-focus/practical-focus hooks — and missing the
    // Stop hook, added later — never got migrated.
    const target = makeWorkspace();
    const settingsDir = path.join(target, ".claude");
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, "settings.json"),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              matcher: "",
              hooks: [{
                type: "command",
                command: `curl -sf -X POST --data @- "http://127.0.0.1:4895/hook/budget?agent=claude&cwd=\${CLAUDE_PROJECT_DIR}" || true`,
                timeout: 8,
              }],
            },
          ],
        },
      }),
      "utf-8"
    );
    expect(costControlHooksActive(target)).toBe(true); // already "active" per the old gate

    const logs: string[] = [];
    ensureCostControlHooksActive(EXTENSION_PATH, target, (line) => logs.push(line));

    const settings = JSON.parse(fs.readFileSync(path.join(settingsDir, "settings.json"), "utf-8")) as {
      hooks?: { UserPromptSubmit?: { hooks: { command: string }[] }[]; Stop?: { hooks: { command: string }[] }[] };
    };
    const promptCommands = (settings.hooks?.UserPromptSubmit ?? []).flatMap((m) => m.hooks.map((h) => h.command));
    expect(promptCommands.some((c) => c.includes("/hook/prompt-context"))).toBe(true);
    const stopCommands = (settings.hooks?.Stop ?? []).flatMap((m) => m.hooks.map((h) => h.command));
    expect(stopCommands.some((c) => c.includes("/hook/session-stop"))).toBe(true);
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

  it("auto-installs cost-control hooks during propagation (Phase 3 behaviour)", () => {
    const target = makeWorkspace();
    fs.mkdirSync(path.join(target, ".claude", "skills", "alpha-skill"), { recursive: true });
    fs.writeFileSync(path.join(target, ".claude", "skills", "alpha-skill", "SKILL.md"), "# Alpha\n", "utf-8");
    propagateWorkspaceSkillChange(EXTENSION_PATH, target, path.join(__dirname, "..", "skills_library"), () => {}, {
      saveBranchProfile: false,
      forceAgentSync: true,
    });
    expect(areAttributionHooksConfigured(target, EXTENSION_PATH)).toBe(true);
    // Cost control hooks are now auto-installed alongside attribution hooks.
    expect(costControlHooksActive(target)).toBe(true);
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
    expect(fs.existsSync(path.join(target, ".github", "hooks", "claude-skills-prompt-context.json"))).toBe(true);
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
