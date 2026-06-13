import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => ({
  env: { appName: "Cursor" },
  workspace: {
    getConfiguration: (section: string) => ({
      get: <T>(key: string, defaultValue: T): T => {
        if (section === "claudeSkills.agentProfiles") {
          if (key === "enabled") {
            return true as T;
          }
          if (key === "vscodeAgent") {
            return "copilot" as T;
          }
        }
        return defaultValue;
      },
    }),
  },
}));

vi.mock("vscode", () => vscodeMock);

vi.mock("./featureFlags", () => ({
  isFeatureEnabled: () => true,
}));

const branch = "feature/x";
const repoKey = "repo-key-asp";

vi.mock("./branchProfiles", () => ({
  getCurrentBranch: () => branch,
  repoKeyFor: () => repoKey,
  getGitRepository: () => ({
    state: { HEAD: { name: branch, commit: "abc" }, remotes: [] },
  }),
  applyBranchProfile: vi.fn(() => ({
    installed: [],
    removed: [],
    overridesApplied: 0,
    skipped: [],
  })),
}));

import {
  AGENT_SKILL_PROFILES_PATH,
  detectHostAgentId,
  formatHostSkillSetActiveMessage,
  hostAgentLabel,
  hostAgentMirrorDir,
  loadAgentSkillSet,
  saveAgentSkillSet,
} from "./agentSkillProfiles";

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "asp-ws-"));
  fs.mkdirSync(path.join(root, ".claude", "skills", "self-learning"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".claude", "skills", "self-learning", "SKILL.md"),
    "---\nname: self-learning\n---\n",
    "utf-8"
  );
  return root;
}

describe("agentSkillProfiles", () => {
  let backupPath: string | undefined;

  beforeEach(() => {
    vscodeMock.env.appName = "Cursor";
    if (fs.existsSync(AGENT_SKILL_PROFILES_PATH)) {
      backupPath = `${AGENT_SKILL_PROFILES_PATH}.bak-${Date.now()}`;
      fs.copyFileSync(AGENT_SKILL_PROFILES_PATH, backupPath);
      fs.rmSync(AGENT_SKILL_PROFILES_PATH, { force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(AGENT_SKILL_PROFILES_PATH)) {
      fs.rmSync(AGENT_SKILL_PROFILES_PATH, { force: true });
    }
    if (backupPath && fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, AGENT_SKILL_PROFILES_PATH);
      fs.rmSync(backupPath, { force: true });
      backupPath = undefined;
    }
  });

  it("detectHostAgentId maps Cursor app name", () => {
    vscodeMock.env.appName = "Cursor";
    expect(detectHostAgentId()).toBe("cursor");
  });

  it("detectHostAgentId maps Kiro app name", () => {
    vscodeMock.env.appName = "Kiro";
    expect(detectHostAgentId()).toBe("kiro");
  });

  it("detectHostAgentId maps VS Code to copilot by default", () => {
    vscodeMock.env.appName = "Visual Studio Code";
    expect(detectHostAgentId()).toBe("copilot");
  });

  it("hostAgentMirrorDir returns per-IDE mirror paths", () => {
    expect(hostAgentMirrorDir("cursor")).toBe(".cursor/skills/");
    expect(hostAgentMirrorDir("kiro")).toBe(".kiro/skills/");
    expect(hostAgentMirrorDir("copilot")).toBe(".github/instructions/");
    expect(hostAgentMirrorDir("claude")).toBe(".claude/skills/");
  });

  it("formatHostSkillSetActiveMessage names the host mirror", () => {
    const msg = formatHostSkillSetActiveMessage("kiro", "main", 12);
    expect(msg).toContain("Kiro IDE");
    expect(msg).toContain(".kiro/skills/");
  });

  it("saveAgentSkillSet persists per agent on branch", () => {
    const target = makeWorkspace();
    const saved = saveAgentSkillSet(target, "cursor");
    expect(saved?.agent).toBe("cursor");
    expect(saved?.branch).toBe(branch);
    expect(saved?.skills).toContain("self-learning");

    const loaded = loadAgentSkillSet(target, branch, "cursor");
    expect(loaded?.skills).toEqual(saved?.skills);

    const kiroSaved = saveAgentSkillSet(target, "kiro");
    expect(kiroSaved?.agent).toBe("kiro");
    expect(loadAgentSkillSet(target, branch, "kiro")?.agent).toBe("kiro");

    const copilotSaved = saveAgentSkillSet(target, "copilot");
    expect(copilotSaved?.agent).toBe("copilot");
    expect(hostAgentLabel("copilot")).toBe("VS Code (Copilot)");
  });
});
