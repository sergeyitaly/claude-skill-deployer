import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./featureFlags", () => ({
  isFeatureEnabled: (key: string) => key !== "multiAgent",
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

  it("removes kiro and copilot mirrors but keeps cursor on host-only tier", () => {
    const target = makeWorkspace(libraryDir);
    expect(fs.existsSync(path.join(target, ".kiro", "skills", "alpha-skill", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(target, ".github", "instructions", "alpha-skill.instructions.md"))).toBe(true);

    const pruned = pruneExcessAgentMirrors(target, libraryDir);
    expect(pruned.some((p) => p.agent === "kiro")).toBe(true);
    expect(pruned.some((p) => p.agent === "copilot")).toBe(true);
    expect(pruned.some((p) => p.agent === "cursor")).toBe(false);

    expect(fs.existsSync(path.join(target, ".cursor", "skills", "alpha-skill", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(target, ".kiro", "skills"))).toBe(false);
    expect(fs.existsSync(path.join(target, ".github", "instructions"))).toBe(false);
  });
});
