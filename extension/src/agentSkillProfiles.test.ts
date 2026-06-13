import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  env: { appName: "Cursor" },
  workspace: {
    getConfiguration: (section: string) => ({
      get: <T>(key: string, defaultValue: T): T => {
        if (section === "claudeSkills.agentProfiles") {
          if (key === "enabled") {
            return true as T;
          }
        }
        return defaultValue;
      },
    }),
  },
}));

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
  hostAgentLabel,
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
    expect(detectHostAgentId()).toBe("cursor");
    expect(hostAgentLabel("kiro")).toBe("Kiro IDE");
  });

  it("saveAgentSkillSet persists per agent on branch", () => {
    const target = makeWorkspace();
    const saved = saveAgentSkillSet(target, "cursor");
    expect(saved?.agent).toBe("cursor");
    expect(saved?.branch).toBe(branch);
    expect(saved?.skills).toContain("self-learning");

    const loaded = loadAgentSkillSet(target, branch, "cursor");
    expect(loaded?.skills).toEqual(saved?.skills);
  });
});
