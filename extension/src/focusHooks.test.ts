import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const HOOKS_DIR = path.join(__dirname, "..", "resources", "hooks");
const CONTEXT_HOOK = path.join(HOOKS_DIR, "context-focus-watch.js");
const PRACTICAL_HOOK = path.join(HOOKS_DIR, "practical-focus-watch.js");

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

function runFocusHook(
  script: string,
  cwd: string,
  configEnv: Record<string, string>,
  payload: Record<string, unknown> = {}
): { stdout: string; status: number | null } {
  const result = spawnSync(process.execPath, [script], {
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

describe("context-focus-watch.js", () => {
  it("emits additionalContext when enabled", () => {
    const cwd = makeWorkspace();
    const config = writeConfig("context", { enabled: true, level: "local-first", injectEveryPrompt: true });
    const { stdout } = runFocusHook(CONTEXT_HOOK, cwd, {
      CLAUDE_SKILLS_CONTEXT_FOCUS_CONFIG: config,
    });
    expect(stdout.trim()).not.toBe("");
    const parsed = JSON.parse(stdout.trim()) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("LOCAL-FIRST");
  });

  it("outputs nothing when disabled", () => {
    const cwd = makeWorkspace();
    const config = writeConfig("context", { enabled: false, level: "balanced" });
    const { stdout } = runFocusHook(CONTEXT_HOOK, cwd, {
      CLAUDE_SKILLS_CONTEXT_FOCUS_CONFIG: config,
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
    const { stdout } = runFocusHook(
      CONTEXT_HOOK,
      cwd,
      { CLAUDE_SKILLS_CONTEXT_FOCUS_CONFIG: config },
      { transcript_path: transcript }
    );
    const parsed = JSON.parse(stdout.trim()) as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("STRICT LOCAL");
  });
});

describe("practical-focus-watch.js", () => {
  it("emits deploy-ready guidance when enabled", () => {
    const cwd = makeWorkspace(true);
    const config = writeConfig("practical", { enabled: true, level: "deploy-ready", injectEveryPrompt: true });
    const { stdout } = runFocusHook(PRACTICAL_HOOK, cwd, {
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

  it("outputs nothing when disabled", () => {
    const cwd = makeWorkspace();
    const config = writeConfig("practical", { enabled: false, level: "architecture-first" });
    const { stdout } = runFocusHook(PRACTICAL_HOOK, cwd, {
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
    const env = { CLAUDE_SKILLS_PRACTICAL_FOCUS_CONFIG: config };
    const first = runFocusHook(PRACTICAL_HOOK, cwd, env);
    const second = runFocusHook(PRACTICAL_HOOK, cwd, env);
    expect(first.stdout.trim()).not.toBe("");
    expect(second.stdout.trim()).toBe("");
  });
});
