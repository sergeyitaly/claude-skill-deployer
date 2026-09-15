import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  areAttributionHooksConfigured,
  getWorkspaceHookStatus,
  installAttributionHooks,
  installCostControlHooks,
  installProfileInitSessionHook,
  areProfileInitHooksConfigured,
  removeDeadHookScriptReferences,
  installMcpForceHook,
  installMcpGateHook,
  isMcpForceHookConfigured,
  isMcpGateHookConfigured,
  installDirCacheGuardHook,
  installOfficialSkillsSessionHook,
} from "./hookOps";

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

const mockedHookPort = { value: 4895 };
vi.mock("./hookServer", () => ({
  hookBaseUrl: () => `http://127.0.0.1:${mockedHookPort.value}`,
}));

const EXTENSION_PATH = path.join(__dirname, "..");
const workspaces: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csd-hooks-"));
  workspaces.push(dir);
  return dir;
}

afterEach(() => {
  mockedHookPort.value = 4895;
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

describe("installAttributionHooks", () => {
  it("registers hooks for Claude, Cursor, Kiro, and Copilot", () => {
    const target = makeWorkspace();
    const status = installAttributionHooks(EXTENSION_PATH, target);
    expect(status === "installed" || status === "updated").toBe(true);
    expect(areAttributionHooksConfigured(target, EXTENSION_PATH)).toBe(true);

    const claudeSettings = JSON.parse(
      fs.readFileSync(path.join(target, ".claude", "settings.json"), "utf-8")
    ) as { hooks?: { PostToolUse?: { matcher: string; hooks: { command: string }[] }[] } };
    expect(
      claudeSettings.hooks?.PostToolUse?.some(
        (m) =>
          m.matcher.includes("Skill") &&
          m.matcher.includes("Read") &&
          m.hooks.some((h) => h.command.includes("/hook/skill-invoke"))
      )
    ).toBe(true);

    expect(
      claudeSettings.hooks?.PreToolUse?.some(
        (m) =>
          m.matcher.includes("Skill") &&
          m.hooks.some((h) => h.command.includes("/hook/skill-invoke"))
      )
    ).toBe(true);

    const cursorHooks = JSON.parse(fs.readFileSync(path.join(target, ".cursor", "hooks.json"), "utf-8")) as {
      hooks?: { postToolUse?: { command?: string; matcher?: string }[] };
    };
    expect(cursorHooks.hooks?.postToolUse?.some((h) => h.matcher?.includes("Read"))).toBe(true);
    expect(
      cursorHooks.hooks?.postToolUse?.some((h) => h.command?.includes("/hook/skill-invoke"))
    ).toBe(true);

    expect(fs.existsSync(path.join(target, ".kiro", "hooks", "claude-skills-skill-invoke.kiro.hook"))).toBe(true);
    expect(fs.existsSync(path.join(target, ".github", "hooks", "claude-skills-skill-invoke.json"))).toBe(true);
    // No JS files are copied any more
    expect(fs.existsSync(path.join(target, ".claude", "hooks", "skill-invoke-watch.js"))).toBe(false);
    expect(fs.existsSync(path.join(target, ".cursor", "hooks", "skill-invoke-watch.js"))).toBe(false);
  });

  it("replaces stale-port skill-invoke hook (e.g. old 51710 → current 4895)", () => {
    const target = makeWorkspace();
    // Pre-populate settings.json with a PostToolUse hook pointing to the old port
    const settingsDir = path.join(target, ".claude");
    fs.mkdirSync(settingsDir, { recursive: true });
    const staleSettings = {
      hooks: {
        PostToolUse: [
          {
            matcher: "Skill|Read|read|fs_read|fileread",
            hooks: [
              {
                type: "command",
                command: `curl -sf -X POST -H "Content-Type: application/json" --data @- "http://127.0.0.1:51710/hook/skill-invoke?agent=claude&cwd=\${CLAUDE_PROJECT_DIR}" || true`,
                timeout: 8,
              },
            ],
          },
        ],
      },
    };
    fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify(staleSettings), "utf-8");

    installAttributionHooks(EXTENSION_PATH, target);

    const updated = JSON.parse(
      fs.readFileSync(path.join(settingsDir, "settings.json"), "utf-8")
    ) as { hooks?: { PostToolUse?: { hooks: { command: string }[] }[] } };
    const cmds = updated.hooks?.PostToolUse?.flatMap((m) => m.hooks.map((h) => h.command)) ?? [];
    // Stale port must be gone
    expect(cmds.some((c) => c.includes("51710"))).toBe(false);
    // Current port must be present
    expect(cmds.some((c) => c.includes("4895") && c.includes("/hook/skill-invoke"))).toBe(true);
  });

  it("regression: installing an unrelated PreToolUse hook (dir-cache-guard) must not delete the skill-invoke matcher", () => {
    // Confirmed live: ensurePreToolHookRegistered()/ensurePostToolHookRegistered() called
    // String.includes(legacyFilename) with legacyFilename === "" (installDirCacheGuardHook
    // has no legacy filename to migrate — it's a brand-new hook). "anything".includes("")
    // is always true in JS, so the filter step treated EVERY existing PreToolUse matcher
    // as "legacy" and deleted it, leaving only the dir-cache-guard entry behind. Since
    // installDirCacheGuardHook() is called unconditionally on every extension activation
    // (see extension.ts), and attribution hooks are only reinstalled when
    // areAttributionHooksConfigured() reports MISSING (a presence check that would say
    // "already there" right after this silent deletion), nothing was restoring what this
    // wiped — the skill-invoke PreToolUse hook was being destroyed on every single
    // activation of the extension, in every workspace.
    const target = makeWorkspace();
    installAttributionHooks(EXTENSION_PATH, target);

    const before = JSON.parse(
      fs.readFileSync(path.join(target, ".claude", "settings.json"), "utf-8")
    ) as { hooks?: { PreToolUse?: { hooks: { command: string }[] }[] } };
    expect(before.hooks?.PreToolUse?.some((m) => m.hooks.some((h) => h.command.includes("/hook/skill-invoke")))).toBe(true);

    installDirCacheGuardHook(target);

    const after = JSON.parse(
      fs.readFileSync(path.join(target, ".claude", "settings.json"), "utf-8")
    ) as { hooks?: { PreToolUse?: { hooks: { command: string }[] }[] } };
    expect(after.hooks?.PreToolUse?.some((m) => m.hooks.some((h) => h.command.includes("/hook/skill-invoke")))).toBe(true);
    expect(after.hooks?.PreToolUse?.some((m) => m.hooks.some((h) => h.command.includes("/hook/dir-cache-guard")))).toBe(true);
  });
});

describe("installCostControlHooks", () => {
  it("also installs multi-agent attribution hooks", () => {
    const target = makeWorkspace();
    installCostControlHooks(EXTENSION_PATH, target);
    expect(areAttributionHooksConfigured(target, EXTENSION_PATH)).toBe(true);
  });

  it("registers all cost-control hooks for Claude and every enabled agent", () => {
    const target = makeWorkspace();
    installCostControlHooks(EXTENSION_PATH, target);
    const settings = JSON.parse(
      fs.readFileSync(path.join(target, ".claude", "settings.json"), "utf-8")
    ) as { hooks?: { UserPromptSubmit?: { hooks: { command: string }[] }[] } };
    const commands = (settings.hooks?.UserPromptSubmit ?? []).flatMap((m) =>
      m.hooks.map((h) => h.command)
    );
    const hookNames = [
      "/hook/prompt-context",
      "/hook/budget",
      "/hook/task-drift",
    ];
    for (const hookName of hookNames) {
      expect(commands.some((c) => c.includes(hookName))).toBe(true);
    }

    const cursorHooks = JSON.parse(fs.readFileSync(path.join(target, ".cursor", "hooks.json"), "utf-8")) as {
      hooks?: { beforeSubmitPrompt?: { command?: string }[] };
    };
    const cursorEntries = cursorHooks.hooks?.beforeSubmitPrompt ?? [];
    for (const hookName of hookNames) {
      expect(cursorEntries.some((h) => h.command?.includes(hookName) && h.command?.includes("agent=cursor"))).toBe(
        true
      );
    }
    // No JS files are copied any more
    expect(fs.existsSync(path.join(target, ".claude", "hooks", "hookPlatform.js"))).toBe(false);
    expect(fs.existsSync(path.join(target, ".cursor", "hooks", "hookPlatform.js"))).toBe(false);

    const kiroSpecs = [
      ["claude-skills-prompt-context.kiro.hook", "promptSubmit", "/hook/prompt-context", "agent=kiro"],
      ["claude-skills-budget.kiro.hook", "promptSubmit", "/hook/budget", "agent=kiro"],
      ["claude-skills-task-drift.kiro.hook", "promptSubmit", "/hook/task-drift", "agent=kiro"],
    ] as const;
    for (const [file, whenType, cmdPart, agentPart] of kiroSpecs) {
      const kiroHook = JSON.parse(
        fs.readFileSync(path.join(target, ".kiro", "hooks", file), "utf-8")
      ) as { when?: { type?: string }; then?: { command?: string } };
      expect(kiroHook.when?.type).toBe(whenType);
      expect(kiroHook.then?.command).toContain(cmdPart);
      expect(kiroHook.then?.command).toContain(agentPart);
    }

    const copilotFiles = [
      "claude-skills-prompt-context.json",
      "claude-skills-budget.json",
      "claude-skills-task-drift.json",
    ];
    for (const file of copilotFiles) {
      const hookPath = path.join(target, ".github", "hooks", file);
      expect(fs.existsSync(hookPath)).toBe(true);
      const hook = JSON.parse(fs.readFileSync(hookPath, "utf-8")) as {
        hooks?: { UserPromptSubmit?: Array<{ powershell?: string; bash?: string }> };
      };
      expect(hook.hooks?.UserPromptSubmit?.some((h) => h.powershell?.includes("/hook/"))).toBe(true);
      expect(hook.hooks?.UserPromptSubmit?.every((h) => !("bash" in h))).toBe(true);
    }
  });

  it("registers the Stop hook (session-stop) — handleSessionStop's only trigger, previously never installed by any code path", () => {
    const target = makeWorkspace();
    installCostControlHooks(EXTENSION_PATH, target);
    const settings = JSON.parse(
      fs.readFileSync(path.join(target, ".claude", "settings.json"), "utf-8")
    ) as { hooks?: { Stop?: { hooks: { command: string }[] }[] } };
    const commands = (settings.hooks?.Stop ?? []).flatMap((m) => m.hooks.map((h) => h.command));
    expect(commands.some((c) => c.includes("/hook/session-stop"))).toBe(true);
  });

  it("migrates a partially-configured workspace: adds the missing Stop hook and consolidates legacy session-size/context-focus/practical-focus even though budget already existed", () => {
    // Reproduces a live-reported gap: a workspace whose UserPromptSubmit hooks predate the
    // prompt-context consolidation (still has separate session-size/context-focus/
    // practical-focus entries) and has no Stop hook at all — installCostControlHooks() must
    // still catch it up, not just no-op because "budget" already looked configured.
    const target = makeWorkspace();
    const settingsDir = path.join(target, ".claude");
    fs.mkdirSync(settingsDir, { recursive: true });
    const legacySettings = {
      hooks: {
        UserPromptSubmit: [
          {
            matcher: "",
            hooks: [{
              type: "command",
              command: `curl -sf -X POST --data @- "http://127.0.0.1:4895/hook/session-size?agent=claude&cwd=\${CLAUDE_PROJECT_DIR}" || true`,
              timeout: 8,
            }],
          },
          {
            matcher: "",
            hooks: [{
              type: "command",
              command: `curl -sf -X POST --data @- "http://127.0.0.1:4895/hook/budget?agent=claude&cwd=\${CLAUDE_PROJECT_DIR}" || true`,
              timeout: 8,
            }],
          },
        ],
      },
    };
    fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify(legacySettings), "utf-8");

    installCostControlHooks(EXTENSION_PATH, target);

    const settings = JSON.parse(fs.readFileSync(path.join(settingsDir, "settings.json"), "utf-8")) as {
      hooks?: { UserPromptSubmit?: { hooks: { command: string }[] }[]; Stop?: { hooks: { command: string }[] }[] };
    };
    const promptCommands = (settings.hooks?.UserPromptSubmit ?? []).flatMap((m) => m.hooks.map((h) => h.command));
    expect(promptCommands.some((c) => c.includes("/hook/session-size"))).toBe(false);
    expect(promptCommands.some((c) => c.includes("/hook/prompt-context"))).toBe(true);
    const stopCommands = (settings.hooks?.Stop ?? []).flatMap((m) => m.hooks.map((h) => h.command));
    expect(stopCommands.some((c) => c.includes("/hook/session-stop"))).toBe(true);
  });
});

describe("installProfileInitSessionHook", () => {
  it("registers profile-init hooks for Claude, Cursor, Kiro, and Copilot", () => {
    const target = makeWorkspace();
    fs.mkdirSync(path.join(target, ".claude", "learning"), { recursive: true });
    fs.writeFileSync(
      path.join(target, ".claude", "learning", "profile-init-request.json"),
      JSON.stringify({ version: 1, status: "pending", branch: "feature/test" }) + "\n",
      "utf-8"
    );

    const libraryDir = path.join(EXTENSION_PATH, "skills_library");
    const status = installProfileInitSessionHook(EXTENSION_PATH, target, libraryDir);
    expect(status === "installed" || status === "updated").toBe(true);
    expect(areProfileInitHooksConfigured(target, libraryDir)).toBe(true);

    const claudeSettings = JSON.parse(
      fs.readFileSync(path.join(target, ".claude", "settings.json"), "utf-8")
    ) as { hooks?: { SessionStart?: { hooks: { command: string }[] }[] } };
    expect(
      (claudeSettings.hooks?.SessionStart ?? []).some((m) =>
        m.hooks.some((h) => h.command.includes("/hook/profile-init"))
      )
    ).toBe(true);

    const cursorHooks = JSON.parse(fs.readFileSync(path.join(target, ".cursor", "hooks.json"), "utf-8")) as {
      hooks?: { sessionStart?: { command?: string }[] };
    };
    expect(cursorHooks.hooks?.sessionStart?.some((h) => h.command?.includes("/hook/profile-init"))).toBe(true);

    const kiroHook = JSON.parse(
      fs.readFileSync(
        path.join(target, ".kiro", "hooks", "claude-skills-skill-invoke-profile-init.kiro.hook"),
        "utf-8"
      )
    ) as { when?: { type?: string }; then?: { command?: string } };
    expect(kiroHook.when?.type).toBe("sessionStart");
    expect(kiroHook.then?.command).toContain("/hook/profile-init");
    expect(kiroHook.then?.command).toContain("agent=kiro");
    // No JS files are copied any more
    expect(fs.existsSync(path.join(target, ".claude", "hooks", "profile-init-watch.js"))).toBe(false);

    const copilotHook = JSON.parse(
      fs.readFileSync(
        path.join(target, ".github", "hooks", "claude-skills-skill-invoke-profile-init.json"),
        "utf-8"
      )
    ) as { hooks?: { SessionStart?: { powershell?: string; bash?: string }[]; sessionStart?: { powershell?: string; bash?: string }[] } };
    const sessionStart = copilotHook.hooks?.SessionStart ?? copilotHook.hooks?.sessionStart ?? [];
    expect(sessionStart.some((h) => h.powershell?.includes("/hook/profile-init"))).toBe(true);
    expect(sessionStart.every((h) => !("bash" in h))).toBe(true);
  });
});

describe("removeDeadHookScriptReferences", () => {
  it("removes a SessionStart hook left over from before skill-gap-detector.js was deleted", () => {
    // Reproduces a live-reported gap: a workspace set up before the "Dead hook removal" cleanup
    // (see CHANGELOG.md) kept a direct node-script SessionStart hook pointing at a file that no
    // longer ships with the extension — no installer's legacy-filename migration targets this
    // name, so it silently MODULE_NOT_FOUND's on every session start forever until removed.
    const target = makeWorkspace();
    const settingsDir = path.join(target, ".claude");
    fs.mkdirSync(settingsDir, { recursive: true });
    const staleSettings = {
      hooks: {
        SessionStart: [
          {
            matcher: "startup|resume|clear",
            hooks: [
              {
                type: "command",
                command: 'node "c:/old/extensions/serhiivoinolovych.claude-skill-deployer-1.0.79/resources/hooks/skill-gap-detector.js" claude',
                timeout: 20,
              },
            ],
          },
        ],
        Stop: [
          {
            matcher: "",
            hooks: [{ type: "command", command: "curl -sf http://127.0.0.1:4895/hook/session-stop || true", timeout: 10 }],
          },
        ],
      },
    };
    fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify(staleSettings), "utf-8");

    const changed = removeDeadHookScriptReferences(target);
    expect(changed).toBe(true);

    const updated = JSON.parse(fs.readFileSync(path.join(settingsDir, "settings.json"), "utf-8")) as {
      hooks?: { SessionStart?: unknown[]; Stop?: { hooks: { command: string }[] }[] };
    };
    expect(updated.hooks?.SessionStart ?? []).toHaveLength(0);
    // Unrelated hook categories are left untouched
    expect(updated.hooks?.Stop?.[0]?.hooks?.[0]?.command).toContain("/hook/session-stop");
  });

  it("is a no-op when no dead hook script is referenced", () => {
    const target = makeWorkspace();
    installCostControlHooks(EXTENSION_PATH, target);
    const before = fs.readFileSync(path.join(target, ".claude", "settings.json"), "utf-8");

    const changed = removeDeadHookScriptReferences(target);
    expect(changed).toBe(false);

    const after = fs.readFileSync(path.join(target, ".claude", "settings.json"), "utf-8");
    expect(after).toBe(before);
  });
});

describe("getWorkspaceHookStatus", () => {
  it("reports attribution and cost-control hook state", () => {
    const target = makeWorkspace();
    installAttributionHooks(EXTENSION_PATH, target);
    installCostControlHooks(EXTENSION_PATH, target);

    const libraryDir = path.join(EXTENSION_PATH, "skills_library");
    const status = getWorkspaceHookStatus(target, libraryDir);

    expect(status.attribution.allConfigured).toBe(true);
    expect(status.attribution.configuredCount).toBeGreaterThan(0);
    expect(status.costControl.sessionSize).toBe(true);
    expect(status.costControl.budget).toBe(true);
    expect(status.costControl.contextFocus).toBe(true);
    expect(status.costControl.practicalFocus).toBe(true);
    expect(status.costControl.configured).toBe(true);
  });

  it("reports missing hooks on empty workspace", () => {
    const target = makeWorkspace();
    const libraryDir = path.join(EXTENSION_PATH, "skills_library");
    const status = getWorkspaceHookStatus(target, libraryDir);

    expect(status.attribution.allConfigured).toBe(false);
    expect(status.costControl.sessionSize).toBe(false);
    expect(status.costControl.budget).toBe(false);
  });
});

describe("installMcpForceHook / installMcpGateHook — stale-port re-sync", () => {
  // Confirmed live: a real workspace had MCP-Force Mode already enabled, but its
  // mcp-force/mcp-gate hooks pointed at a stale port (50882) while the hook server was
  // actually listening on the current default (4895) — every other hook category
  // (skill-invoke, dir-cache-guard, cli-loop-guard, etc.) already self-heals a stale
  // port because extension.ts calls its install*Hook() function unconditionally on
  // every activation, not just once. mcp-force/mcp-gate were only ever installed from
  // the manual "Enable MCP-Force Mode" command and never re-synced afterward — so a
  // hook server port change (e.g. the default port was in use, so it fell back) left
  // them silently unreachable (curl ... || true swallows the failure) with zero
  // corresponding entry in hook-health.jsonl, indistinguishable from "hook never fires"
  // without reading settings.json directly.

  it("installs both hooks pointing at the current port", () => {
    const target = makeWorkspace();

    expect(isMcpForceHookConfigured(target)).toBe(false);
    expect(isMcpGateHookConfigured(target)).toBe(false);

    expect(installMcpForceHook(target)).toBe("installed");
    expect(installMcpGateHook(target)).toBe("installed");

    expect(isMcpForceHookConfigured(target)).toBe(true);
    expect(isMcpGateHookConfigured(target)).toBe(true);

    const settingsFile = path.join(target, ".claude", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8")) as {
      hooks?: {
        UserPromptSubmit?: { hooks: { command: string }[] }[];
        SessionStart?: { hooks: { command: string }[] }[];
      };
    };
    const forceCmds = (settings.hooks?.UserPromptSubmit ?? []).flatMap((m) => m.hooks.map((h) => h.command));
    const gateCmds = (settings.hooks?.SessionStart ?? []).flatMap((m) => m.hooks.map((h) => h.command));
    expect(forceCmds.some((c) => c.includes("/hook/mcp-force") && c.includes(":4895"))).toBe(true);
    expect(gateCmds.some((c) => c.includes("/hook/mcp-gate") && c.includes(":4895"))).toBe(true);
  });

  it("re-syncs a stale port on an already-configured workspace instead of silently leaving it stale", () => {
    const target = makeWorkspace();
    installMcpForceHook(target);
    installMcpGateHook(target);

    // Simulate the hook server falling back to a different port in a later session
    // (e.g. the default port was already in use) — same scenario proven live.
    mockedHookPort.value = 50882;

    // Reproduces the pre-fix bug: calling through with the OLD port baked in would leave
    // the hooks silently pointing at 4895 forever, since installMcpForceHook/
    // installMcpGateHook only ever ran once from the manual enable command.
    const forceStatus = installMcpForceHook(target);
    const gateStatus = installMcpGateHook(target);
    expect(forceStatus).toBe("updated");
    expect(gateStatus).toBe("updated");

    const settingsFile = path.join(target, ".claude", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8")) as {
      hooks?: {
        UserPromptSubmit?: { hooks: { command: string }[] }[];
        SessionStart?: { hooks: { command: string }[] }[];
      };
    };
    const forceCmds = (settings.hooks?.UserPromptSubmit ?? []).flatMap((m) => m.hooks.map((h) => h.command));
    const gateCmds = (settings.hooks?.SessionStart ?? []).flatMap((m) => m.hooks.map((h) => h.command));
    // The stale port must be gone, and the current port must be present — mirrors the
    // existing "replaces stale-port skill-invoke hook" assertion style for other hooks.
    expect(forceCmds.some((c) => c.includes("/hook/mcp-force") && c.includes(":4895"))).toBe(false);
    expect(forceCmds.some((c) => c.includes("/hook/mcp-force") && c.includes(":50882"))).toBe(true);
    expect(gateCmds.some((c) => c.includes("/hook/mcp-gate") && c.includes(":4895"))).toBe(false);
    expect(gateCmds.some((c) => c.includes("/hook/mcp-gate") && c.includes(":50882"))).toBe(true);
  });

  it("returns already-configured when the port hasn't changed", () => {
    const target = makeWorkspace();
    installMcpForceHook(target);
    installMcpGateHook(target);

    expect(installMcpForceHook(target)).toBe("already-configured");
    expect(installMcpGateHook(target)).toBe("already-configured");
  });

  it("regression: installing mcp-gate must not delete a pre-existing, unrelated official-skills SessionStart hook", () => {
    // Confirmed live: installMcpGateHook() calls ensureSessionStartHookRegistered() with
    // legacyFilename: "" (it has no legacy filename to migrate from). "anything".includes("")
    // is always true in JS, so the filter step treated the pre-existing official-skills
    // SessionStart matcher as "legacy" and deleted it entirely, leaving only mcp-gate
    // behind. This project's own settings.json only avoided losing official-skills because
    // it happened to be (re)installed after mcp-gate in its real history — installing in
    // the other order, or calling installMcpGateHook a second time (e.g. to re-sync a
    // stale port, per the fix above), would silently delete it.
    const target = makeWorkspace();
    installOfficialSkillsSessionHook(EXTENSION_PATH, target);

    const before = JSON.parse(
      fs.readFileSync(path.join(target, ".claude", "settings.json"), "utf-8")
    ) as { hooks?: { SessionStart?: { hooks: { command: string }[] }[] } };
    expect(before.hooks?.SessionStart?.some((m) => m.hooks.some((h) => h.command.includes("/hook/official-skills")))).toBe(true);

    installMcpGateHook(target);

    const after = JSON.parse(
      fs.readFileSync(path.join(target, ".claude", "settings.json"), "utf-8")
    ) as { hooks?: { SessionStart?: { hooks: { command: string }[] }[] } };
    expect(after.hooks?.SessionStart?.some((m) => m.hooks.some((h) => h.command.includes("/hook/official-skills")))).toBe(true);
    expect(after.hooks?.SessionStart?.some((m) => m.hooks.some((h) => h.command.includes("/hook/mcp-gate")))).toBe(true);
  });
});
