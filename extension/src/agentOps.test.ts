import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentMirrorsNeedSync,
  buildWorkspaceSyncFingerprint,
  missingAgentMirrorSkills,
  syncCopilotBootstrap,
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

  it("stable fingerprint ignores skill list order", () => {
    const target = makeWorkspace(libraryDir);
    syncWorkspaceSkillsToAllAgents(libraryDir, target, { force: true });
    const fp1 = buildWorkspaceSyncFingerprint(target);
    const fp2 = buildWorkspaceSyncFingerprint(target);
    expect(fp1).toBe(fp2);
    expect(fp1.length).toBeGreaterThan(0);
  });

  it("partial sync touches only the requested skill mirror", () => {
    const target = makeWorkspace(libraryDir);
    syncWorkspaceSkillsToAllAgents(libraryDir, target, { force: true });
    fs.rmSync(path.join(target, ".cursor", "skills", "beta-skill"), { recursive: true, force: true });
    expect(agentMirrorsNeedSync(target, libraryDir)).toBe(true);
    const partial = syncWorkspaceSkillsToAllAgents(libraryDir, target, { skillNames: ["beta-skill"] });
    expect(partial.some((r) => r.skill === "beta-skill" && r.agent === "cursor")).toBe(true);
    expect(fs.existsSync(path.join(target, ".cursor", "skills", "beta-skill", "SKILL.md"))).toBe(true);
  });
});

describe("syncCopilotBootstrap — catches up a stale copilot-instructions.md", () => {
  const libraryDir = path.join(__dirname, "..", "skills_library");

  it("regression: reflects a skill installed after the bootstrap file was last written, even without a task-focus re-apply in between", () => {
    // Live-reported gap: syncCopilotBootstrap() previously only ran from inside
    // applyTaskSkillFocusFromProposals's conditional re-apply path — a workspace whose
    // task-focus proposals had already settled never got .github/copilot-instructions.md
    // refreshed again, so it could sit stuck on an old, smaller skill snapshot for months
    // even as more skills were installed. Calling syncCopilotBootstrap() directly (as the
    // now-unconditional refresh-loop call in extension.ts does) must catch it up regardless.
    const target = makeWorkspace(libraryDir);
    const first = syncCopilotBootstrap(target, libraryDir);
    expect(first).toBeDefined();
    let bootstrap = fs.readFileSync(path.join(target, ".github", "copilot-instructions.md"), "utf-8");
    expect(bootstrap).toContain("alpha-skill");
    expect(bootstrap).toContain("beta-skill");
    expect(bootstrap).not.toContain("gamma-skill");

    // A skill lands on disk through some other path (manual install, a different sync flow)
    // — copilot-instructions.md is not touched by that alone.
    writeSkill(path.join(target, ".claude", "skills"), "gamma-skill");

    syncCopilotBootstrap(target, libraryDir);
    bootstrap = fs.readFileSync(path.join(target, ".github", "copilot-instructions.md"), "utf-8");
    expect(bootstrap).toContain("gamma-skill");
    expect(fs.existsSync(path.join(target, ".github", "instructions", "gamma-skill.instructions.md"))).toBe(true);
  });
});
