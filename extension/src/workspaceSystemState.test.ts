import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildWorkspaceSystemState } from "./workspaceSystemState";

const repoLibraryDir = path.join(__dirname, "..", "..", "skills_library");
const extLibraryDir = path.join(__dirname, "..", "skills_library");
const libraryDir = fs.existsSync(path.join(repoLibraryDir, "agents.json"))
  ? repoLibraryDir
  : extLibraryDir;

const workspaces: string[] = [];

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sysstate-"));
}

afterEach(() => {
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

describe("workspaceSystemState", () => {
  it("reports idle profile and broken attribution on empty workspace", () => {
    const target = makeWorkspace();
    workspaces.push(target);
    fs.mkdirSync(path.join(target, ".claude", "learning"), { recursive: true });

    const state = buildWorkspaceSystemState(target, libraryDir);
    expect(state.profileInit).toBe("idle");
    expect(state.attribution.status).toBe("broken");
    expect(state.version).toBe(1);
  });

  it("reports applied profile when profile.local is applied", () => {
    const target = makeWorkspace();
    workspaces.push(target);
    fs.mkdirSync(path.join(target, ".claude", "learning"), { recursive: true });
    fs.writeFileSync(
      path.join(target, ".claude", "profile.local.json"),
      JSON.stringify({
        version: 1,
        branch: "main",
        role: "devops",
        roleLabel: "DevOps",
        skills: ["self-learning"],
        initBy: "agent",
        status: "applied",
        createdAt: new Date().toISOString(),
      }) + "\n",
      "utf-8"
    );

    const state = buildWorkspaceSystemState(target, libraryDir);
    expect(state.profileInit).toBe("applied");
  });

  it("detects agent capabilities from manifest", () => {
    const target = makeWorkspace();
    workspaces.push(target);
    fs.mkdirSync(path.join(target, ".claude", "learning"), { recursive: true });

    const state = buildWorkspaceSystemState(target, libraryDir);
    expect(state.capabilities.claude.supportsHooks).toBe(true);
    expect(state.capabilities.copilot.supportsTokens).toBe(false);
  });
});
