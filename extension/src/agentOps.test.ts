import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentMirrorsNeedSync,
  missingAgentMirrorSkills,
  syncWorkspaceSkillsToAllAgents,
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-"));
  workspaces.push(root);
  const claudeDir = path.join(root, ".claude", "skills");
  fs.mkdirSync(claudeDir, { recursive: true });
  writeSkill(claudeDir, "alpha-skill");
  writeSkill(claudeDir, "beta-skill");
  fs.copyFileSync(path.join(libraryDir, "manifest.json"), path.join(root, "manifest-copy.json"));
  return root;
}

afterEach(() => {
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

describe("agent mirror sync", () => {
  const libraryDir = path.join(__dirname, "..", "skills_library");

  it("detects missing cursor and kiro mirrors", () => {
    const target = makeWorkspace(libraryDir);
    const gaps = missingAgentMirrorSkills(target, libraryDir);
    expect(gaps.some((g) => g.agent === "cursor" && g.missing.includes("alpha-skill"))).toBe(true);
    expect(gaps.some((g) => g.agent === "kiro")).toBe(true);
    expect(agentMirrorsNeedSync(target, libraryDir)).toBe(true);
  });

  it("syncs all effective skills to cursor, kiro, and copilot", () => {
    const target = makeWorkspace(libraryDir);
    const results = syncWorkspaceSkillsToAllAgents(libraryDir, target, { force: true });
    expect(results.length).toBeGreaterThan(0);

    expect(fs.existsSync(path.join(target, ".cursor", "skills", "alpha-skill", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(target, ".kiro", "skills", "beta-skill", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(target, ".github", "instructions", "alpha-skill.instructions.md"))).toBe(true);
    expect(agentMirrorsNeedSync(target, libraryDir)).toBe(false);
  });

  it("skips repeat sync when workspace fingerprint is unchanged", () => {
    const target = makeWorkspace(libraryDir);
    syncWorkspaceSkillsToAllAgents(libraryDir, target, { force: true });
    const second = syncWorkspaceSkillsToAllAgents(libraryDir, target);
    expect(second).toEqual([]);
  });
});
