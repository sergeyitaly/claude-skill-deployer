import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { areAttributionHooksConfigured } from "./hookOps";
import { ensureAttributionHooksActive, propagateWorkspaceSkillChange } from "./workspaceSkillSync";

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
    });
    expect(areAttributionHooksConfigured(target, EXTENSION_PATH)).toBe(true);
  });
});
