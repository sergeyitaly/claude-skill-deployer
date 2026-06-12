import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { cursorParser } from "./transcriptParsers";
import { buildCostAttribution } from "./costAttribution";
import { readRunRecords } from "./usageStats";

const HOOK_SCRIPT = path.join(__dirname, "..", "resources", "hooks", "skill-invoke-watch.js");
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

  it("records cursor hook runs and surfaces them in attribution", () => {
    const target = makeWorkspace();
    const skillPath = path.join(target, ".claude", "skills", "file-style-conventions", "SKILL.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, "# skill", "utf-8");

    spawnSync(process.execPath, [HOOK_SCRIPT, "cursor"], {
      input: JSON.stringify({
        conversation_id: "conv-dashboard-test",
        tool_name: "Read",
        tool_input: { path: skillPath },
        tool_use_id: "tu_dashboard",
        cwd: target,
        tool_output: JSON.stringify({ text: "# file-style-conventions\n\ncontent" }),
      }),
      encoding: "utf-8",
    });

    const runs = readRunRecords(target);
    expect(runs.some((r) => r.agent === "cursor" && r.skill === "file-style-conventions")).toBe(true);

    const attr = buildCostAttribution(target, libraryDir);
    expect(attr.skills["file-style-conventions"]?.cursor?.sessions).toBeGreaterThan(0);
  });
});
