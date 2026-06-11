import { describe, expect, it } from "vitest";
import {
  encodeWorkspacePath,
  transcriptFileMatchesWorkspace,
  workspaceFromTranscriptFile,
} from "./workspaceTranscripts";

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

  it("encodes POSIX workspace paths on Linux runners", () => {
    const target = "/home/runner/work/claude-skill-deployer/claude-skill-deployer";
    const encoded = encodeWorkspacePath(target);
    expect(encoded).toBe("home-runner-work-claude-skill-deployer-claude-skill-deployer");
    const file = `/home/runner/.claude/projects/${encoded}/session.jsonl`;
    expect(transcriptFileMatchesWorkspace(file, target)).toBe(true);
  });

  it("matches case-insensitively", () => {
    const target = "C:\\Users\\SerhiiVoinolovich\\claude-skills-deployer";
    const file =
      "C:/Users/SerhiiVoinolovich/.cursor/projects/C--USERS-SERHIIVOINOLOVICH-CLAUDE-SKILLS-DEPLOYER/chat.jsonl";
    expect(transcriptFileMatchesWorkspace(file, target)).toBe(true);
  });

  it("rejects paths without a projects segment", () => {
    expect(transcriptFileMatchesWorkspace("/tmp/session.jsonl", "C:\\repo")).toBe(false);
  });
});

describe("workspaceFromTranscriptFile", () => {
  it("decodes Windows drive letter from encoded project folders", () => {
    const file =
      "C:/Users/SerhiiVoinolovich/.claude/projects/c--Users-SerhiiVoinolovich-claude-skills-deployer/session.jsonl";
    const decoded = workspaceFromTranscriptFile(file);
    expect(decoded).toBeTruthy();
    expect(decoded!.replace(/\\/g, "/").toLowerCase()).toMatch(/^c:\/users\/serhiivoinolovich\//);
  });

  it("decodes POSIX encoded project folders on POSIX hosts", () => {
    if (process.platform === "win32") {
      return;
    }
    const encoded = "home-runner-work-claude-skill-deployer-claude-skill-deployer";
    const file = `/home/runner/.claude/projects/${encoded}/session.jsonl`;
    expect(workspaceFromTranscriptFile(file)).toBe(
      "/home/runner/work/claude-skill-deployer/claude-skill-deployer"
    );
  });

  it("returns undefined for invalid paths", () => {
    expect(workspaceFromTranscriptFile("/tmp/session.jsonl")).toBeUndefined();
    expect(workspaceFromTranscriptFile("/.claude/projects/short/session.jsonl")).toBeUndefined();
  });
});
