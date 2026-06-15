import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapWorkspaceForHostAgent,
  ensureCanonicalWorkspaceLayout,
  importHostSkillsToCanonical,
} from "./hostAgentBootstrap";

vi.mock("vscode", () => ({
  env: { appName: "Cursor" },
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, defaultValue?: T): T | undefined => {
        if (key === "hostAgentOverride") {
          return undefined;
        }
        if (key === "vscodeAgent") {
          return "copilot" as T;
        }
        return defaultValue;
      },
    }),
  },
}));

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "host-boot-"));
}

function writeSkill(dir: string, name: string): void {
  const root = path.join(dir, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "SKILL.md"), `---\nname: ${name}\ndescription: test\n---\n`);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hostAgentBootstrap", () => {
  const libraryDir = path.join(__dirname, "..", "skills_library");

  it("creates canonical .claude layout on any host", () => {
    const target = makeWorkspace();
    ensureCanonicalWorkspaceLayout(target);
    expect(fs.existsSync(path.join(target, ".claude", "learning"))).toBe(true);
    expect(fs.existsSync(path.join(target, ".claude", "skills"))).toBe(true);
    expect(fs.existsSync(path.join(target, ".claude", "hooks"))).toBe(true);
  });

  it("imports skills from Cursor mirror when canonical is empty", () => {
    const target = makeWorkspace();
    writeSkill(path.join(target, ".cursor", "skills"), "self-learning");
    const imported = importHostSkillsToCanonical(libraryDir, target, "cursor");
    expect(imported).toContain("self-learning");
    expect(fs.existsSync(path.join(target, ".claude", "skills", "self-learning", "SKILL.md"))).toBe(true);
  });

  it("bootstrapWorkspaceForHostAgent reports cursor host", () => {
    const target = makeWorkspace();
    writeSkill(path.join(target, ".cursor", "skills"), "file-style-conventions");
    const result = bootstrapWorkspaceForHostAgent(libraryDir, target);
    expect(result.host).toBe("cursor");
    expect(result.importedSkills.length).toBeGreaterThan(0);
  });
});
