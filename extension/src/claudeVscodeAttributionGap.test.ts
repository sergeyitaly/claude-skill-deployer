import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assessClaudeVscodeAttributionGap } from "./claudeVscodeAttributionGap";
import { encodeWorkspacePath } from "./workspaceTranscripts";

const workspaces: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csd-gap-"));
  workspaces.push(dir);
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  return dir;
}

afterEach(() => {
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

describe("assessClaudeVscodeAttributionGap", () => {
  it("detects gap when VS Code session has tool uses but no PostToolUse fires", () => {
    const target = makeWorkspace();
    const transcriptsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csd-tr-"));
    workspaces.push(transcriptsRoot);

    const encoded = encodeWorkspacePath(target);
    const projectsDir = path.join(transcriptsRoot, "projects");
    const sessionDir = path.join(projectsDir, encoded);
    fs.mkdirSync(sessionDir, { recursive: true });
    const transcript = path.join(sessionDir, "sess-gap.jsonl");
    const lines = [
      '{"sessionId":"sess-gap","entrypoint":"claude-vscode"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}',
    ];
    fs.writeFileSync(transcript, lines.join("\n") + "\n", "utf-8");
    fs.utimesSync(transcript, new Date(), new Date());

    fs.writeFileSync(
      path.join(target, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: "Skill|Read",
              hooks: [{ type: "command", command: "node .claude/hooks/skill-invoke-watch.js claude" }],
            },
          ],
        },
      }),
      "utf-8"
    );

    const gap = assessClaudeVscodeAttributionGap(target, 14, { claudeTranscriptsRoot: projectsDir });
    expect(gap.detected).toBe(true);
    expect(gap.toolUseCount).toBeGreaterThanOrEqual(6);
    expect(gap.postToolUseHookFires).toBe(0);
    expect(gap.recommendation).toContain("PreToolUse");
  });

  it("reports mitigated when PreToolUse installed and v2 runs exist", () => {
    const target = makeWorkspace();
    fs.mkdirSync(path.join(target, ".claude", "learning"), { recursive: true });
    fs.writeFileSync(
      path.join(target, ".claude", "learning", "runs.jsonl"),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        skill: "self-learning",
        action: "skill_invoke",
        agent: "claude",
        tokens: 10,
        metadata: { source: "skill-invoke-hook-v2", invoked: true },
        session_id: "s1",
      })}\n`,
      "utf-8"
    );
    fs.writeFileSync(
      path.join(target, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: "Read", hooks: [{ command: "skill-invoke-watch.js" }] }],
          PreToolUse: [{ matcher: "Read", hooks: [{ command: "skill-invoke-watch.js" }] }],
        },
      }),
      "utf-8"
    );

    const gap = assessClaudeVscodeAttributionGap(target);
    expect(gap.mitigated).toBe(true);
    expect(gap.detected).toBe(false);
  });
});
