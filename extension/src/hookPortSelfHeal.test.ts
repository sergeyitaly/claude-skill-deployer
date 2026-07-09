import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockHookBaseUrl = vi.fn(() => "http://127.0.0.1:4895");

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: (section: string) => ({
      get: (key: string, defaultValue?: unknown) => {
        if (section === "claudeSkills.agents" && key === "enabled") {
          return ["claude", "cursor", "kiro", "copilot"];
        }
        return defaultValue;
      },
    }),
  },
}));

vi.mock("./hookServer", () => ({
  hookBaseUrl: () => mockHookBaseUrl(),
}));

import {
  installAttributionHooks,
  installCostControlHooks,
  installProfileInitSessionHook,
} from "./hookOps";

const EXTENSION_PATH = path.join(__dirname, "..");
const LIBRARY_DIR = path.join(EXTENSION_PATH, "skills_library");
const workspaces: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csd-port-heal-"));
  workspaces.push(dir);
  return dir;
}

afterEach(() => {
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
  mockHookBaseUrl.mockReturnValue("http://127.0.0.1:4895");
});

/** Only the curl-based /hook/<name> commands carry an embedded port — e.g. the
 * PostToolUse terminal-watch.js entry runs a local script directly and never
 * references the hook server's port, so it's out of scope for port self-heal. */
function claudeHookCommands(target: string, category: "PreToolUse" | "PostToolUse" | "SessionStart" | "UserPromptSubmit"): string[] {
  const settings = JSON.parse(
    fs.readFileSync(path.join(target, ".claude", "settings.json"), "utf-8")
  ) as { hooks?: Record<string, { hooks: { command: string }[] }[]> };
  return (settings.hooks?.[category] ?? [])
    .flatMap((m) => m.hooks.map((h) => h.command))
    .filter((c) => c.includes("/hook/"));
}

describe("hook-server port change — all four categories self-heal", () => {
  it("rewrites PreToolUse, PostToolUse, SessionStart, and UserPromptSubmit hooks to the new port on reconciliation", () => {
    const target = makeWorkspace();
    fs.mkdirSync(path.join(target, ".claude", "learning"), { recursive: true });
    fs.writeFileSync(
      path.join(target, ".claude", "learning", "profile-init-request.json"),
      JSON.stringify({ version: 1, status: "pending", branch: "main" }) + "\n",
      "utf-8"
    );

    // Step 1: hook server bound to the default port — register all four hook categories.
    mockHookBaseUrl.mockReturnValue("http://127.0.0.1:4895");
    installAttributionHooks(EXTENSION_PATH, target); // PostToolUse + PreToolUse (skill-invoke)
    installCostControlHooks(EXTENSION_PATH, target); // UserPromptSubmit (prompt-context, budget, task-drift)
    installProfileInitSessionHook(EXTENSION_PATH, target, LIBRARY_DIR); // SessionStart (profile-init)

    for (const category of ["PostToolUse", "PreToolUse", "UserPromptSubmit", "SessionStart"] as const) {
      const cmds = claudeHookCommands(target, category);
      expect(cmds.length).toBeGreaterThan(0);
      expect(cmds.every((c) => c.includes("127.0.0.1:4895"))).toBe(true);
    }

    // Step 2: simulate the hook server restarting on a fallback port (default port was
    // already taken — mirrors hookServer.ts's tryBind(srv, 0) EADDRINUSE fallback).
    mockHookBaseUrl.mockReturnValue("http://127.0.0.1:55555");

    // Step 3: extension re-runs its hook reconciliation (same install calls it makes on
    // every activation / workspace-state refresh) — this must rewrite existing entries
    // in place rather than leaving them pointed at the dead old port.
    installAttributionHooks(EXTENSION_PATH, target);
    installCostControlHooks(EXTENSION_PATH, target);
    installProfileInitSessionHook(EXTENSION_PATH, target, LIBRARY_DIR);

    for (const category of ["PostToolUse", "PreToolUse", "UserPromptSubmit", "SessionStart"] as const) {
      const cmds = claudeHookCommands(target, category);
      expect(cmds.length).toBeGreaterThan(0);
      expect(cmds.some((c) => c.includes("127.0.0.1:4895"))).toBe(false); // old port must be gone
      expect(cmds.every((c) => c.includes("127.0.0.1:55555"))).toBe(true); // every entry on new port
    }
  });
});
