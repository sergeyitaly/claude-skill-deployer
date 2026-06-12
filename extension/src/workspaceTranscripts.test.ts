import { describe, expect, it } from "vitest";
import {
  encodeCursorWorkspacePath,
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

  it("matches Cursor project folder encoding (single dash after drive)", () => {
    const target = "C:\\Users\\SerhiiVoinolovich\\claude-skills-deployer";
    expect(encodeCursorWorkspacePath(target)).toBe("c-Users-SerhiiVoinolovich-claude-skills-deployer");
    const file =
      "C:/Users/SerhiiVoinolovich/.cursor/projects/c-Users-SerhiiVoinolovich-claude-skills-deployer/agent-transcripts/sess/chat.jsonl";
    expect(transcriptFileMatchesWorkspace(file, target)).toBe(true);
  });

  it("matches case-insensitively", () => {
    const target = "C:\\Users\\SerhiiVoinolovich\\claude-skills-deployer";
    const file =
      "C:/Users/SerhiiVoinolovich/.cursor/projects/C-Users-SerhiiVoinolovich-claude-skills-deployer/chat.jsonl";
    expect(transcriptFileMatchesWorkspace(file, target)).toBe(true);
  });

  it("rejects paths without a projects segment", () => {
    expect(transcriptFileMatchesWorkspace("/tmp/session.jsonl", "C:\\repo")).toBe(false);
  });
});

describe("workspaceFromTranscriptFile", () => {
  it("round-trips encode and decode when folder names have no hyphens", () => {
    const target = "/home/runner/work/myrepo";
    const encoded = encodeWorkspacePath(target);
    const file = `/home/runner/.claude/projects/${encoded}/session.jsonl`;
    expect(workspaceFromTranscriptFile(file)).toBe(target);
  });

  it("decodes Windows drive paths without path.resolve", () => {
    const target = "C:/Users/runner/myrepo";
    const encoded = encodeWorkspacePath(target);
    const file = `C:/Users/runner/.claude/projects/${encoded}/session.jsonl`;
    expect(workspaceFromTranscriptFile(file)).toBe("C:/Users/runner/myrepo");
  });

  it("decodes Cursor Windows project folders when segment names have no hyphens", () => {
    const target = "C:/Users/runner/myrepo";
    const encoded = encodeCursorWorkspacePath(target);
    const file = `C:/Users/runner/.cursor/projects/${encoded}/agent-transcripts/uuid/chat.jsonl`;
    expect(workspaceFromTranscriptFile(file)).toBe("C:/Users/runner/myrepo");
  });

  it("returns undefined for invalid paths", () => {
    expect(workspaceFromTranscriptFile("/tmp/session.jsonl")).toBeUndefined();
    expect(workspaceFromTranscriptFile("/.claude/projects/short/session.jsonl")).toBeUndefined();
  });
});
