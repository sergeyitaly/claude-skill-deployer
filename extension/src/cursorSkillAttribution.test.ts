import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cursorParser } from "./transcriptParsers";
import { readRunRecords } from "./usageStats";

const repoLibraryDir = path.join(__dirname, "..", "..", "skills_library");
const extLibraryDir = path.join(__dirname, "..", "skills_library");
const libraryDir = fs.existsSync(path.join(repoLibraryDir, "agents.json"))
  ? repoLibraryDir
  : extLibraryDir;

const workspaces: string[] = [];

function makeWorkspace(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-attr-"));
  workspaces.push(ws);
  fs.mkdirSync(path.join(ws, ".claude", "learning"), { recursive: true });
  return ws;
}

afterEach(() => {
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

describe("cursor skill attribution", () => {
  it("parses skills from Cursor agent transcript Read lines", () => {
    const file = path.join(makeWorkspace(), "chat.jsonl");
    const content = [
      '{"role":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"path":"C:/proj/skills_library/self-learning/SKILL.md"}}]}}',
      '{"role":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"path":"C:/Users/me/.cursor/skills-cursor/create-hook/SKILL.md"}}]}}',
    ].join("\n");
    fs.writeFileSync(file, content, "utf-8");

    const parsed = cursorParser.parseFile(file, content);
    expect(parsed?.agent).toBe("cursor");
    expect(parsed?.activeSkills).toContain("self-learning");
    expect(parsed?.activeSkills).toContain("create-hook");
  });

  it("records cursor runs written directly to runs.jsonl", () => {
    const target = makeWorkspace();
    const runsFile = path.join(target, ".claude", "learning", "runs.jsonl");
    const run = {
      ts: new Date().toISOString(),
      skill: "file-style-conventions",
      agent: "cursor",
      session_id: "conv-dashboard-test",
      outcome: "success",
    };
    fs.writeFileSync(runsFile, JSON.stringify(run) + "\n", "utf-8");

    const runs = readRunRecords(target);
    expect(runs.some((r) => r.agent === "cursor" && r.skill === "file-style-conventions")).toBe(true);
  });
});
