import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncWorkspaceSkillsToAllAgents, wouldSkipAgentMirrorSync } from "./agentOps";
import { setSkillOverride } from "./skillOps";
import {
  markPreToggleFingerprint,
  rapidToggleWouldBeNoOp,
  resetSyncPredictForTests,
} from "./syncPredict";

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "predict-"));
  workspaces.push(root);
  const claudeDir = path.join(root, ".claude", "skills");
  fs.mkdirSync(claudeDir, { recursive: true });
  writeSkill(claudeDir, "alpha-skill");
  fs.copyFileSync(path.join(libraryDir, "manifest.json"), path.join(root, "manifest-copy.json"));
  return root;
}

afterEach(() => {
  resetSyncPredictForTests();
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

describe("syncPredict", () => {
  const libraryDir = path.join(__dirname, "..", "skills_library");

  it("does not no-op after a real toggle change", () => {
    const target = makeWorkspace(libraryDir);
    syncWorkspaceSkillsToAllAgents(libraryDir, target, { force: true });
    markPreToggleFingerprint(target);
    setSkillOverride(target, "alpha-skill", "off");
    expect(rapidToggleWouldBeNoOp(target)).toBe(false);
  });

  it("detects rapid on-off before sync as no-op", () => {
    const target = makeWorkspace(libraryDir);
    syncWorkspaceSkillsToAllAgents(libraryDir, target, { force: true });
    markPreToggleFingerprint(target);
    setSkillOverride(target, "alpha-skill", "off");
    setSkillOverride(target, "alpha-skill", undefined);
    expect(rapidToggleWouldBeNoOp(target)).toBe(true);
  });

  it("wouldSkipAgentMirrorSync after successful sync", () => {
    const target = makeWorkspace(libraryDir);
    syncWorkspaceSkillsToAllAgents(libraryDir, target, { force: true });
    expect(wouldSkipAgentMirrorSync(libraryDir, target)).toBe(true);
  });
});
