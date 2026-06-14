import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const HOOK_SCRIPT = path.join(__dirname, "..", "resources", "hooks", "skill-invoke-watch.js");

function runHook(
  agent: string,
  payload: Record<string, unknown>,
  env: Record<string, string> = {}
): { runs: Record<string, unknown>[]; exitCode: number | null } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-hook-"));
  const learningDir = path.join(tmp, ".claude", "learning");
  fs.mkdirSync(learningDir, { recursive: true });

  const result = spawnSync(process.execPath, [HOOK_SCRIPT, agent], {
    input: JSON.stringify({ ...payload, cwd: tmp }),
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });

  const runsFile = path.join(learningDir, "runs.jsonl");
  const runs = fs.existsSync(runsFile)
    ? fs
        .readFileSync(runsFile, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures on Windows file locks
  }

  return { runs, exitCode: result.status };
}

describe("skill-invoke-watch.js", () => {
  it("logs Claude Skill tool invokes", () => {
    const { runs } = runHook("claude", {
      session_id: "sess-claude-001",
      tool_name: "Skill",
      tool_input: { skill_name: "ci-pipeline-debug" },
      tool_use_id: "toolu_abc",
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].skill).toBe("ci-pipeline-debug");
    expect(runs[0].agent).toBe("claude");
  });

  it("logs Copilot instruction reads", () => {
    const { runs } = runHook("copilot", {
      sessionId: "sess-copilot-001",
      toolName: "Read",
      toolInput: { path: "/proj/.github/instructions/self-learning.instructions.md" },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].skill).toBe("self-learning");
    expect(runs[0].agent).toBe("copilot");
  });

  it("logs Cursor Read of skills-cursor paths", () => {
    const { runs } = runHook("cursor", {
      conversation_id: "conv-cursor-001",
      tool_name: "Read",
      tool_input: {
        path: "C:/Users/me/.cursor/skills-cursor/create-skill/SKILL.md",
      },
      tool_use_id: "tu_cursor_1",
      cwd: undefined,
      workspace_roots: ["C:/proj/ws"],
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].skill).toBe("create-skill");
    expect(runs[0].agent).toBe("cursor");
  });

  it("logs Cursor Read with tool_use_id session fallback when conversation_id missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-hook-cursor-"));
    const skillPath = path.join(tmp, "skills_library", "ci-preflight", "SKILL.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, "# skill");

    const result = spawnSync(process.execPath, [HOOK_SCRIPT, "cursor"], {
      input: JSON.stringify({
        tool_name: "Read",
        tool_input: { path: skillPath },
        tool_use_id: "tu_fallback",
        cwd: tmp,
      }),
      encoding: "utf-8",
    });

    const runsFile = path.join(tmp, ".claude", "learning", "runs.jsonl");
    const runs = fs.existsSync(runsFile)
      ? fs
          .readFileSync(runsFile, "utf-8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];

    expect(result.status).toBe(0);
    expect(runs).toHaveLength(1);
    expect(runs[0].skill).toBe("ci-preflight");
    expect(runs[0].agent).toBe("cursor");

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("reads Kiro payload from USER_PROMPT when stdin is empty", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-hook-kiro-"));
    const learningDir = path.join(tmp, ".claude", "learning");
    fs.mkdirSync(learningDir, { recursive: true });

    const payload = JSON.stringify({
      sessionId: "sess-kiro-001",
      toolName: "read",
      toolArgs: { path: "/proj/.kiro/skills/adx-schema-check/SKILL.md" },
    });

    spawnSync(process.execPath, [HOOK_SCRIPT, "kiro"], {
      input: "",
      encoding: "utf-8",
      cwd: tmp,
      env: {
        ...process.env,
        USER_PROMPT: payload,
      },
    });

    const runsFile = path.join(learningDir, "runs.jsonl");
    const runs = fs
      .readFileSync(runsFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(runs).toHaveLength(1);
    expect(runs[0].skill).toBe("adx-schema-check");
    expect(runs[0].agent).toBe("kiro");

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("tags not_in_active_profile when skill is outside task-active set", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-hook-"));
    const learningDir = path.join(tmp, ".claude", "learning");
    fs.mkdirSync(learningDir, { recursive: true });
    fs.writeFileSync(
      path.join(learningDir, "task-active-skills.json"),
      JSON.stringify({ version: 1, activeSkills: ["self-learning"], ignoredSkills: [] }) + "\n",
      "utf-8"
    );

    spawnSync(process.execPath, [HOOK_SCRIPT, "claude"], {
      input: JSON.stringify({
        cwd: tmp,
        session_id: "sess-profile-001",
        tool_name: "Skill",
        tool_input: { skill_name: "terraform-plan-review" },
        tool_use_id: "toolu_profile",
      }),
      encoding: "utf-8",
    });

    const runsFile = path.join(learningDir, "runs.jsonl");
    const runs = fs
      .readFileSync(runsFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(runs).toHaveLength(1);
    const meta = runs[0].metadata as Record<string, unknown>;
    expect(meta.not_in_active_profile).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
