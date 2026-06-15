import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTaskSkillFocus, readTaskActiveSkills } from "./taskSkillFocus";
import { writeTaskSkillProposals } from "./taskSkillProposals";
import { maybePromoteIgnoredSkillsOnUnderuse } from "./taskSkillUnderuse";
import { encodeWorkspacePath } from "./workspaceTranscripts";

vi.mock("./hostAgentBootstrap", () => ({
  bootstrapWorkspaceForHostAgent: vi.fn(),
}));

vi.mock("./agentMirrorSync", () => ({
  propagateCostDisciplineToAgents: vi.fn(),
}));

vi.mock("vscode", () => ({
  window: {
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
  },
  workspace: {
    getConfiguration: (section: string) => ({
      get: (key: string, defaultValue?: unknown) => {
        if (section === "claudeSkills.skillFeedback") {
          if (key === "taskSkillUnderusePromote") {
            return true;
          }
          if (key === "taskSkillUnderuseNotifyUser") {
            return false;
          }
        }
        if (section === "claudeSkills.agents" && key === "enabled") {
          return ["claude"];
        }
        return defaultValue;
      },
    }),
  },
}));

vi.mock("./featureFlags", () => ({
  isFeatureEnabled: (key: string) => key === "taskSkillFocus",
}));

const workspaces: string[] = [];
const LIBRARY = path.join(__dirname, "..", "..", "skills_library");

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csd-underuse-"));
  workspaces.push(dir);
  fs.mkdirSync(path.join(dir, ".claude", "skills", "alpha-skill"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude", "skills", "beta-skill"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "skills", "alpha-skill", "SKILL.md"), "# a");
  fs.writeFileSync(path.join(dir, ".claude", "skills", "beta-skill", "SKILL.md"), "# b");
  return dir;
}

afterEach(() => {
  for (const ws of workspaces) {
    try {
      fs.rmSync(ws, { recursive: true, force: true });
    } catch {
      // ignore transcript cleanup on Windows locks
    }
  }
  workspaces.length = 0;
});

describe("maybePromoteIgnoredSkillsOnUnderuse", () => {
  it("promotes high-confidence ignored skills when active set unused after tool activity", () => {
    const target = makeWorkspace();
    applyTaskSkillFocus(target, ["alpha-skill"], "task-skill-proposals");

    writeTaskSkillProposals(target, {
      version: 1,
      generatedAt: new Date().toISOString(),
      taskSummary: "test",
      proposals: [
        { name: "alpha-skill", reason: "active", confidence: 95, installed: true },
        { name: "beta-skill", reason: "shell work", confidence: 88, installed: true },
      ],
    });

    const transcriptsRoot = path.join(os.homedir(), ".claude", "projects");
    const encoded = encodeWorkspacePath(target);
    const sessionDir = path.join(transcriptsRoot, encoded);
    fs.mkdirSync(sessionDir, { recursive: true });
    const transcript = path.join(sessionDir, `underuse-${Date.now()}.jsonl`);
    const toolLines = Array.from({ length: 6 }, () =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } })
    );
    fs.writeFileSync(transcript, toolLines.join("\n") + "\n", "utf-8");
    fs.utimesSync(transcript, new Date(), new Date());

    const result = maybePromoteIgnoredSkillsOnUnderuse(target, LIBRARY);
    expect(result.promoted).toBe(true);
    expect(result.promotedSkills).toContain("beta-skill");

    const focus = readTaskActiveSkills(target);
    expect(focus?.activeSkills).toContain("beta-skill");
    expect(focus?.ignoredSkills).not.toContain("beta-skill");
  });
});
