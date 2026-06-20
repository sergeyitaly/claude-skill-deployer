import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./featureFlags", () => ({
  isFeatureEnabled: () => true,
}));

vi.mock("./agentSkillProfiles", () => ({
  detectHostAgentId: () => "cursor" as const,
}));

import { pruneExcessAgentMirrors } from "./agentOps";

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-prune-"));
  workspaces.push(root);
  const claudeDir = path.join(root, ".claude", "skills");
  fs.mkdirSync(claudeDir, { recursive: true });
  writeSkill(claudeDir, "alpha-skill");
  writeSkill(path.join(root, ".cursor", "skills"), "alpha-skill");
  writeSkill(path.join(root, ".kiro", "skills"), "alpha-skill");
  const copilotDir = path.join(root, ".github", "instructions");
  fs.mkdirSync(copilotDir, { recursive: true });
  fs.writeFileSync(path.join(copilotDir, "alpha-skill.instructions.md"), "# alpha-skill\n", "utf-8");
  return root;
}

afterEach(() => {
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

describe("pruneExcessAgentMirrors", () => {
  const libraryDir = path.join(__dirname, "..", "skills_library");

  it("retains all agent mirrors in full multi-agent mode", () => {
    const target = makeWorkspace(libraryDir);
    expect(fs.existsSync(path.join(target, ".kiro", "skills", "alpha-skill", "SKILL.md"))).toBe(true);

    const pruned = pruneExcessAgentMirrors(target, libraryDir);
    // All agents are in mirror set when multiAgent is always on — nothing pruned
    expect(pruned.some((p) => p.agent === "kiro")).toBe(false);
    expect(pruned.some((p) => p.agent === "copilot")).toBe(false);
    expect(fs.existsSync(path.join(target, ".cursor", "skills", "alpha-skill", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(target, ".kiro", "skills", "alpha-skill", "SKILL.md"))).toBe(true);
  });

  it("does not remove agent hooks when all agents are enabled", () => {
    const target = makeWorkspace(libraryDir);
    const kiroHooks = path.join(target, ".kiro", "hooks");
    const copilotHooks = path.join(target, ".github", "hooks");
    fs.mkdirSync(kiroHooks, { recursive: true });
    fs.mkdirSync(copilotHooks, { recursive: true });
    fs.writeFileSync(path.join(kiroHooks, "claude-skills-skill-invoke.kiro.hook"), "{}", "utf-8");
    fs.writeFileSync(path.join(copilotHooks, "claude-skills-skill-invoke.json"), "{}", "utf-8");

    const pruned = pruneExcessAgentMirrors(target, libraryDir);
    expect(pruned.some((p) => p.kind === "hook" && p.agent === "kiro")).toBe(false);
    expect(pruned.some((p) => p.kind === "hook" && p.agent === "copilot")).toBe(false);
    expect(fs.existsSync(path.join(kiroHooks, "claude-skills-skill-invoke.kiro.hook"))).toBe(true);
  });
});
