import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./featureFlags", () => ({
  isFeatureEnabled: () => true,
}));

vi.mock("./agentSkillProfiles", () => ({
  detectHostAgentId: () => "cursor" as const,
}));

import {
  missingAgentMirrorSkills,
  installSkillToAllWorkspaceAgents,
  syncWorkspaceSkillsToAllAgents,
  workspaceInstallAgentIds,
  workspaceMirrorAgentIds,
} from "./agentOps";

const workspaces: string[] = [];

function writeSkill(root: string, name: string): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill ${name}.\n---\n\n# ${name}\n`,
    "utf-8"
  );
}

function makeWorkspace(libraryDir: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-solo-"));
  workspaces.push(root);
  const claudeDir = path.join(root, ".claude", "skills");
  fs.mkdirSync(claudeDir, { recursive: true });
  writeSkill(claudeDir, "alpha-skill");
  writeSkill(claudeDir, "beta-skill");
  fs.copyFileSync(path.join(libraryDir, "manifest.json"), path.join(root, "manifest-copy.json"));
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

describe("solo-dev host-only mirror", () => {
  const libraryDir = path.join(__dirname, "..", "skills_library");

  it("targets all enabled agents when multiAgent is always on", () => {
    const ids = workspaceMirrorAgentIds(libraryDir);
    expect(ids).toContain("cursor");
    expect(workspaceInstallAgentIds(libraryDir)).toContain("claude");
    expect(workspaceInstallAgentIds(libraryDir)).toContain("cursor");
  });

  it("installSkillToAllWorkspaceAgents syncs to cursor and other enabled agents", () => {
    const target = makeWorkspace(libraryDir);
    installSkillToAllWorkspaceAgents(libraryDir, target, "alpha-skill", path.join(target, ".claude", "skills"), true, false);
    expect(fs.existsSync(path.join(target, ".cursor", "skills", "alpha-skill", "SKILL.md"))).toBe(true);
  });

  it("syncs workspace skills to all enabled agents", () => {
    const target = makeWorkspace(libraryDir);
    const gaps = missingAgentMirrorSkills(target, libraryDir);
    expect(gaps.some((g) => g.agent === "cursor")).toBe(true);

    syncWorkspaceSkillsToAllAgents(libraryDir, target, { force: true });
    expect(fs.existsSync(path.join(target, ".cursor", "skills", "alpha-skill", "SKILL.md"))).toBe(true);
  });
});
