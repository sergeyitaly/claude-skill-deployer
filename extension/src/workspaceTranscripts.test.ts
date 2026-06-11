import { describe, expect, it } from "vitest";
import { encodeWorkspacePath, transcriptFileMatchesWorkspace } from "./workspaceTranscripts";

describe("transcriptFileMatchesWorkspace", () => {
  it("encodes Windows workspace paths for Claude project folders", () => {
    expect(encodeWorkspacePath("C:\\Users\\SerhiiVoinolovich\\claude-skills-deployer")).toBe(
      "c--Users-SerhiiVoinolovich-claude-skills-deployer"
    );
  });

  it("matches encoded Claude project path", () => {
    const file =
      "C:/Users/SerhiiVoinolovich/.claude/projects/c--Users-SerhiiVoinolovich-claude-skills-deployer/session.jsonl";
    expect(transcriptFileMatchesWorkspace(file, "C:\\Users\\SerhiiVoinolovich\\claude-skills-deployer")).toBe(true);
  });

  it("rejects other projects", () => {
    const file = "C:/Users/SerhiiVoinolovich/.claude/projects/c--Users-SerhiiVoinolovich-other-repo/session.jsonl";
    expect(transcriptFileMatchesWorkspace(file, "C:\\Users\\SerhiiVoinolovich\\claude-skills-deployer")).toBe(false);
  });
});
