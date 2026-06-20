import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const HOOKS_DIR = path.join(__dirname, "..", "resources", "hooks");
const PROMPT_CONTEXT_HOOK = path.join(HOOKS_DIR, "prompt-context-watch.js");
const BUDGET_HOOK = path.join(HOOKS_DIR, "budget-watch.js");
const PROFILE_INIT_HOOK = path.join(HOOKS_DIR, "profile-init-watch.js");

const workspaces: string[] = [];
const configFiles: string[] = [];

function makeWorkspace(withTf = false): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "focus-hook-"));
  workspaces.push(dir);
  fs.mkdirSync(path.join(dir, ".claude", "learning"), { recursive: true });
  if (withTf) {
    fs.mkdirSync(path.join(dir, "infra"), { recursive: true });
    fs.writeFileSync(path.join(dir, "infra", "main.tf"), 'resource "azurerm_resource_group" "rg" {}\n', "utf-8");
  }
  return dir;
}

function writeConfig(name: "context" | "practical", data: Record<string, unknown>): string {
  const file = path.join(os.tmpdir(), `focus-config-${name}-${Date.now()}-${Math.random()}.json`);
  configFiles.push(file);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf-8");
  return file;
}

// Written once at module level, not registered for per-test cleanup
const DISABLED_PRACTICAL = (() => {
  const f = path.join(os.tmpdir(), "focus-disabled-practical.json");
  fs.writeFileSync(f, JSON.stringify({ enabled: false }, null, 2) + "\n", "utf-8");
  return f;
})();
const DISABLED_CONTEXT = (() => {
  const f = path.join(os.tmpdir(), "focus-disabled-context.json");
  fs.writeFileSync(f, JSON.stringify({ enabled: false }, null, 2) + "\n", "utf-8");
  return f;
})();

function runPromptContextHook(
  cwd: string,
  configEnv: Record<string, string>,
  payload: Record<string, unknown> = {}
): { stdout: string; status: number | null } {
  const result = spawnSync(process.execPath, [PROMPT_CONTEXT_HOOK], {
    input: JSON.stringify({
      cwd,
      session_id: "test-session-001",
      transcript_path: path.join(cwd, "transcript.jsonl"),
      ...payload,
    }),
    encoding: "utf-8",
    env: { ...process.env, ...configEnv },
  });
  return { stdout: result.stdout ?? "", status: result.status };
}

afterEach(() => {
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
  for (const f of configFiles) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      // ignore
    }
  }
  configFiles.length = 0;
});

describe("prompt-context-watch.js — context focus", () => {
  it("emits additionalContext when context focus enabled", () => {
    const cwd = makeWorkspace();
    const config = writeConfig("context", { enabled: true, level: "local-first", injectEveryPrompt: true });
    const { stdout } = runPromptContextHook(cwd, {
      CLAUDE_SKILLS_CONTEXT_FOCUS_CONFIG: config,
      CLAUDE_SKILLS_PRACTICAL_FOCUS_CONFIG: DISABLED_PRACTICAL,
    });
    expect(stdout.trim()).not.toBe("");
    const parsed = JSON.parse(stdout.trim()) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("LOCAL-FIRST");
  });

  it("outputs nothing when both focus hooks are disabled and session is small", () => {
    const cwd = makeWorkspace();
    const config = writeConfig("context", { enabled: false, level: "balanced" });
    const { stdout } = runPromptContextHook(cwd, {
      CLAUDE_SKILLS_CONTEXT_FOCUS_CONFIG: config,
      CLAUDE_SKILLS_PRACTICAL_FOCUS_CONFIG: DISABLED_PRACTICAL,
    });
    expect(stdout.trim()).toBe("");
  });

  it("escalates to strict-local on large transcript", () => {
    const cwd = makeWorkspace();
    const transcript = path.join(cwd, "transcript.jsonl");
    fs.writeFileSync(transcript, "x".repeat(11 * 1024 * 1024), "utf-8");
    const config = writeConfig("context", {
      enabled: true,
      level: "balanced",
      autoEscalateOnSessionSize: true,
      injectEveryPrompt: true,
    });
    const { stdout } = runPromptContextHook(
      cwd,
      {
        CLAUDE_SKILLS_CONTEXT_FOCUS_CONFIG: config,
        CLAUDE_SKILLS_PRACTICAL_FOCUS_CONFIG: DISABLED_PRACTICAL,
      },
      { transcript_path: transcript }
    );
    const parsed = JSON.parse(stdout.trim()) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("STRICT LOCAL");
  });
});

describe("budget-watch.js", () => {
  it("emits Cursor additional_context when workspace_roots is set", () => {
    const cwd = makeWorkspace();
    const budgetDir = path.join(os.homedir(), ".claude", "learning");
    fs.mkdirSync(budgetDir, { recursive: true });
    const budgetFile = path.join(budgetDir, "budget.json");
    const budgetStateFile = path.join(budgetDir, "budget-state.json");
    const prevBudget = fs.existsSync(budgetFile) ? fs.readFileSync(budgetFile, "utf-8") : null;
    const prevState = fs.existsSync(budgetStateFile) ? fs.readFileSync(budgetStateFile, "utf-8") : null;
    try {
      fs.writeFileSync(
        budgetFile,
        JSON.stringify({ mode: "economy", economyWarnUsd: 0, highTierSkills: ["expensive-skill"] }) + "\n",
        "utf-8"
      );
      fs.writeFileSync(path.join(cwd, ".claude", "settings.local.json"), "{}\n", "utf-8");
      const result = spawnSync(process.execPath, [BUDGET_HOOK, "cursor"], {
        input: JSON.stringify({ workspace_roots: [cwd], session_id: "cursor-budget-1" }),
        encoding: "utf-8",
        cwd,
      });
      expect(result.stdout.trim()).not.toBe("");
      const parsed = JSON.parse(result.stdout.trim()) as { additional_context?: string };
      expect(parsed.additional_context).toContain("Claude Skills");
    } finally {
      if (prevBudget === null) {
        try {
          fs.rmSync(budgetFile, { force: true });
        } catch {
          // ignore
        }
      } else {
        fs.writeFileSync(budgetFile, prevBudget, "utf-8");
      }
      if (prevState === null) {
        try {
          fs.rmSync(budgetStateFile, { force: true });
        } catch {
          // ignore
        }
      } else {
        fs.writeFileSync(budgetStateFile, prevState, "utf-8");
      }
    }
  });
});

describe("prompt-context-watch.js — practical focus", () => {
  it("emits deploy-ready guidance when enabled", () => {
    const cwd = makeWorkspace(true);
    const config = writeConfig("practical", { enabled: true, level: "deploy-ready", injectEveryPrompt: true });
    const { stdout } = runPromptContextHook(cwd, {
      CLAUDE_SKILLS_CONTEXT_FOCUS_CONFIG: DISABLED_CONTEXT,
      CLAUDE_SKILLS_PRACTICAL_FOCUS_CONFIG: config,
    });
    const parsed = JSON.parse(stdout.trim()) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    const text = parsed.hookSpecificOutput?.additionalContext ?? "";
    expect(text).toContain("DEPLOY-READY");
    expect(text).toContain("Terraform");
    expect(text).toContain("deployment-practical");
  });

  it("outputs nothing when disabled (with context focus also disabled)", () => {
    const cwd = makeWorkspace();
    const config = writeConfig("practical", { enabled: false, level: "architecture-first" });
    const { stdout } = runPromptContextHook(cwd, {
      CLAUDE_SKILLS_CONTEXT_FOCUS_CONFIG: DISABLED_CONTEXT,
      CLAUDE_SKILLS_PRACTICAL_FOCUS_CONFIG: config,
    });
    expect(stdout.trim()).toBe("");
  });

  it("registers only once per session when injectEveryPrompt is false", () => {
    const cwd = makeWorkspace();
    const config = writeConfig("practical", {
      enabled: true,
      level: "architecture-first",
      injectEveryPrompt: false,
    });
    const env = {
      CLAUDE_SKILLS_CONTEXT_FOCUS_CONFIG: DISABLED_CONTEXT,
      CLAUDE_SKILLS_PRACTICAL_FOCUS_CONFIG: config,
    };
    const first = runPromptContextHook(cwd, env);
    const second = runPromptContextHook(cwd, env);
    expect(first.stdout.trim()).not.toBe("");
    expect(second.stdout.trim()).toBe("");
  });
});

describe("profile-init-watch.js", () => {
  it("emits Claude SessionStart context when profile-init request is pending", () => {
    const cwd = makeWorkspace();
    fs.mkdirSync(path.join(cwd, ".claude", "learning"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".claude", "learning", "profile-init-request.json"),
      JSON.stringify(
        {
          version: 1,
          status: "pending",
          branch: "feature/test",
          position: { role: "qa", label: "QA" },
          catalogPath: ".claude/learning/skills-catalog.json",
          outputPath: ".claude/profile.local.json",
          agentInstructions: "Run profile-init now.",
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );

    const result = spawnSync(process.execPath, [PROFILE_INIT_HOOK], {
      input: JSON.stringify({ cwd, source: "startup" }),
      encoding: "utf-8",
    });
    expect(result.stdout.trim()).not.toBe("");
    const parsed = JSON.parse(result.stdout.trim()) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("PROFILE INIT REQUIRED");
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("feature/test");
  });

  it("emits Cursor sessionStart additional_context when profile-init request is pending", () => {
    const cwd = makeWorkspace();
    fs.mkdirSync(path.join(cwd, ".claude", "learning"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".claude", "learning", "profile-init-request.json"),
      JSON.stringify(
        {
          version: 1,
          status: "pending",
          branch: "feature/cursor",
          position: { role: "devops", label: "DevOps" },
          agentInstructions: "Run profile-init now.",
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );

    const result = spawnSync(process.execPath, [PROFILE_INIT_HOOK, "cursor"], {
      input: JSON.stringify({ session_id: "sess-1", is_background_agent: false, composer_mode: "agent" }),
      encoding: "utf-8",
      cwd,
    });
    expect(result.stdout.trim()).not.toBe("");
    const parsed = JSON.parse(result.stdout.trim()) as {
      additional_context?: string;
      hookSpecificOutput?: { additionalContext?: string };
    };
    expect(parsed.additional_context).toContain("PROFILE INIT REQUIRED");
    expect(parsed.additional_context).toContain("feature/cursor");
    expect(parsed.hookSpecificOutput).toBeUndefined();
  });

  it("emits NEW SESSION task-proposal context when profile is already applied", () => {
    const cwd = makeWorkspace();
    fs.mkdirSync(path.join(cwd, ".claude", "learning"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".claude", "learning", "profile-init-request.json"),
      JSON.stringify({ version: 1, status: "pending", branch: "main" }) + "\n",
      "utf-8"
    );
    fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".claude", "profile.local.json"),
      JSON.stringify({ version: 1, status: "applied", skills: ["self-learning"] }) + "\n",
      "utf-8"
    );

    const result = spawnSync(process.execPath, [PROFILE_INIT_HOOK], {
      input: JSON.stringify({ cwd, source: "startup" }),
      encoding: "utf-8",
    });
    expect(result.stdout.trim()).not.toBe("");
    const parsed = JSON.parse(result.stdout.trim()) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    const context = parsed.hookSpecificOutput?.additionalContext ?? "";
    expect(context).toContain("NEW SESSION");
    expect(context).toContain("skill-feedback-adaptation");
    const applyRequest = JSON.parse(
      fs.readFileSync(path.join(cwd, ".claude", "learning", "session-skill-apply-request.json"), "utf-8")
    );
    expect(applyRequest.skills).toContain("self-learning");
  });

  it("writes session apply request from task-skill-proposals on session start", () => {
    const cwd = makeWorkspace();
    fs.mkdirSync(path.join(cwd, ".claude", "learning"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".claude", "learning", "task-skill-proposals.json"),
      JSON.stringify(
        {
          version: 1,
          generatedAt: new Date().toISOString(),
          taskSummary: "Profile init for branch dev",
          proposals: [
            { name: "ci-pipeline-debug", reason: "CI", confidence: 90, installed: false },
            { name: "self-learning", reason: "platform", confidence: 95, installed: true },
          ],
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );

    const result = spawnSync(process.execPath, [PROFILE_INIT_HOOK, "cursor"], {
      input: JSON.stringify({ session_id: "sess-proposals", is_background_agent: false }),
      encoding: "utf-8",
      cwd,
    });
    expect(result.stdout.trim()).toContain("Session ready");
    const applyRequest = JSON.parse(
      fs.readFileSync(path.join(cwd, ".claude", "learning", "session-skill-apply-request.json"), "utf-8")
    );
    expect(applyRequest.sessionId).toBe("sess-proposals");
    expect(applyRequest.skills).toContain("ci-pipeline-debug");
    expect(applyRequest.skills).toContain("self-learning");
  });

  it("emits Kiro sessionStart additional_context when profile-init request is pending", () => {
    const cwd = makeWorkspace();
    fs.mkdirSync(path.join(cwd, ".claude", "learning"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".claude", "learning", "profile-init-request.json"),
      JSON.stringify(
        {
          version: 1,
          status: "pending",
          branch: "feature/kiro",
          position: { role: "devops", label: "DevOps" },
          agentInstructions: "Run profile-init now.",
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );

    const result = spawnSync(process.execPath, [PROFILE_INIT_HOOK, "kiro"], {
      input: JSON.stringify({ hook_event_name: "sessionStart", session_id: "kiro-sess-1" }),
      encoding: "utf-8",
      cwd,
    });
    expect(result.stdout.trim()).not.toBe("");
    const parsed = JSON.parse(result.stdout.trim()) as { additional_context?: string };
    expect(parsed.additional_context).toContain("PROFILE INIT REQUIRED");
    expect(parsed.additional_context).toContain("feature/kiro");
  });

  it("emits Copilot SessionStart hookSpecificOutput when profile-init request is pending", () => {
    const cwd = makeWorkspace();
    fs.mkdirSync(path.join(cwd, ".claude", "learning"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".claude", "learning", "profile-init-request.json"),
      JSON.stringify(
        {
          version: 1,
          status: "pending",
          branch: "feature/copilot",
          position: { role: "qa", label: "QA" },
          agentInstructions: "Run profile-init now.",
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );

    const result = spawnSync(process.execPath, [PROFILE_INIT_HOOK, "copilot"], {
      input: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "copilot-sess-1",
        cwd,
        source: "startup",
      }),
      encoding: "utf-8",
    });
    expect(result.stdout.trim()).not.toBe("");
    const parsed = JSON.parse(result.stdout.trim()) as {
      hookSpecificOutput?: { additionalContext?: string };
      additional_context?: string;
    };
    const context = parsed.hookSpecificOutput?.additionalContext ?? parsed.additional_context;
    expect(context).toContain("PROFILE INIT REQUIRED");
    expect(context).toContain("feature/copilot");
  });

  it("emits compact session context when proposals are fresh", () => {
    const cwd = makeWorkspace();
    fs.mkdirSync(path.join(cwd, ".claude", "learning"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".claude", "profile.local.json"),
      JSON.stringify({ version: 1, status: "applied", skills: ["self-learning"] }) + "\n",
      "utf-8"
    );
    fs.writeFileSync(
      path.join(cwd, ".claude", "learning", "task-skill-proposals.json"),
      JSON.stringify(
        {
          version: 1,
          generatedAt: new Date().toISOString(),
          taskSummary: "Current task",
          proposals: [{ name: "ci-pipeline-debug", reason: "CI", confidence: 90, installed: true }],
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );
    fs.writeFileSync(
      path.join(cwd, ".claude", "learning", "cli-config.json"),
      JSON.stringify({ version: 1, features: { deterministicTaskProposals: true } }, null, 2) + "\n",
      "utf-8"
    );

    const result = spawnSync(process.execPath, [PROFILE_INIT_HOOK, "cursor"], {
      input: JSON.stringify({ session_id: "cursor-fresh-proposals", is_background_agent: false }),
      encoding: "utf-8",
      cwd,
    });
    const parsed = JSON.parse(result.stdout.trim()) as { additional_context?: string };
    expect(parsed.additional_context).toContain("Session ready");
    expect(parsed.additional_context).toContain("ci-pipeline-debug");
    expect(parsed.additional_context).not.toContain("overwrite .claude/learning/task-skill-proposals.json");
  });

  it("emits NEW SESSION context on Cursor sessionStart when profile is applied", () => {
    const cwd = makeWorkspace();
    fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".claude", "profile.local.json"),
      JSON.stringify({ version: 1, status: "applied", skills: ["self-learning"] }) + "\n",
      "utf-8"
    );

    const result = spawnSync(process.execPath, [PROFILE_INIT_HOOK, "cursor"], {
      input: JSON.stringify({ session_id: "cursor-new-session", is_background_agent: false }),
      encoding: "utf-8",
      cwd,
    });
    expect(result.stdout.trim()).not.toBe("");
    const parsed = JSON.parse(result.stdout.trim()) as { additional_context?: string };
    expect(parsed.additional_context).toContain("NEW SESSION");
    expect(parsed.additional_context).toContain("task-skill-proposals.json");
  });

  it("emits NEW SESSION context on Kiro sessionStart when profile is applied", () => {
    const cwd = makeWorkspace();
    fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".claude", "profile.local.json"),
      JSON.stringify({ version: 1, status: "applied", skills: ["self-learning"] }) + "\n",
      "utf-8"
    );

    const result = spawnSync(process.execPath, [PROFILE_INIT_HOOK, "kiro"], {
      input: JSON.stringify({ hook_event_name: "sessionStart", session_id: "kiro-new-session" }),
      encoding: "utf-8",
      cwd,
    });
    expect(result.stdout.trim()).not.toBe("");
    const parsed = JSON.parse(result.stdout.trim()) as { additional_context?: string };
    expect(parsed.additional_context).toContain("NEW SESSION");
  });

  it("emits NEW SESSION context on Copilot SessionStart when profile is applied", () => {
    const cwd = makeWorkspace();
    fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".claude", "profile.local.json"),
      JSON.stringify({ version: 1, status: "applied", skills: ["self-learning"] }) + "\n",
      "utf-8"
    );

    const result = spawnSync(process.execPath, [PROFILE_INIT_HOOK, "copilot"], {
      input: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "copilot-new-session",
        cwd,
        source: "startup",
      }),
      encoding: "utf-8",
    });
    expect(result.stdout.trim()).not.toBe("");
    const parsed = JSON.parse(result.stdout.trim()) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("NEW SESSION");
  });
});
