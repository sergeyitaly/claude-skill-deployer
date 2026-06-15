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

const EXTENSION_PATH = path.join(__dirname, "..");
const workspaces: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csd-hooks-"));
  workspaces.push(dir);
  return dir;
}

afterEach(() => {
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
          m.hooks.some((h) => h.command.includes("skill-invoke-watch.js"))
      )
    ).toBe(true);

    expect(
      claudeSettings.hooks?.PreToolUse?.some(
        (m) =>
          m.matcher.includes("Skill") &&
          m.hooks.some((h) => h.command.includes("skill-invoke-watch.js"))
      )
    ).toBe(true);

    const cursorHooks = JSON.parse(fs.readFileSync(path.join(target, ".cursor", "hooks.json"), "utf-8")) as {
      hooks?: { postToolUse?: { command?: string; matcher?: string }[] };
    };
    expect(cursorHooks.hooks?.postToolUse?.some((h) => h.matcher?.includes("Read"))).toBe(true);

    expect(fs.existsSync(path.join(target, ".kiro", "hooks", "claude-skills-skill-invoke.kiro.hook"))).toBe(true);
    expect(fs.existsSync(path.join(target, ".github", "hooks", "claude-skills-skill-invoke.json"))).toBe(true);
    expect(fs.existsSync(path.join(target, ".cursor", "hooks", "skill-invoke-watch.js"))).toBe(true);
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
    const claudeHooks = [
      "session-size-watch.js",
      "budget-watch.js",
      "context-focus-watch.js",
      "practical-focus-watch.js",
      "task-drift-watch.js",
    ];
    for (const hook of claudeHooks) {
      expect(commands.some((c) => c.includes(hook))).toBe(true);
    }

    const cursorHooks = JSON.parse(fs.readFileSync(path.join(target, ".cursor", "hooks.json"), "utf-8")) as {
      hooks?: { beforeSubmitPrompt?: { command?: string }[] };
    };
    const cursorEntries = cursorHooks.hooks?.beforeSubmitPrompt ?? [];
    for (const hook of claudeHooks) {
      expect(cursorEntries.some((h) => h.command?.includes(hook) && h.command?.includes(" cursor"))).toBe(
        true
      );
    }
    expect(fs.existsSync(path.join(target, ".cursor", "hooks", "hookPlatform.js"))).toBe(true);

    const kiroSpecs = [
      ["claude-skills-session-size.kiro.hook", "promptSubmit", "session-size-watch.js kiro"],
      ["claude-skills-budget.kiro.hook", "promptSubmit", "budget-watch.js kiro"],
      ["claude-skills-context-focus.kiro.hook", "promptSubmit", "context-focus-watch.js kiro"],
      ["claude-skills-practical-focus.kiro.hook", "promptSubmit", "practical-focus-watch.js kiro"],
      ["claude-skills-task-drift.kiro.hook", "promptSubmit", "task-drift-watch.js kiro"],
    ] as const;
    for (const [file, whenType, cmdPart] of kiroSpecs) {
      const kiroHook = JSON.parse(
        fs.readFileSync(path.join(target, ".kiro", "hooks", file), "utf-8")
      ) as { when?: { type?: string }; then?: { command?: string } };
      expect(kiroHook.when?.type).toBe(whenType);
      expect(kiroHook.then?.command).toContain(cmdPart);
    }

    const copilotFiles = [
      "claude-skills-session-size.json",
      "claude-skills-budget.json",
      "claude-skills-context-focus.json",
      "claude-skills-practical-focus.json",
      "claude-skills-task-drift.json",
    ];
    for (const file of copilotFiles) {
      expect(fs.existsSync(path.join(target, ".github", "hooks", file))).toBe(true);
    }
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
        m.hooks.some((h) => h.command.includes("profile-init-watch.js"))
      )
    ).toBe(true);

    const cursorHooks = JSON.parse(fs.readFileSync(path.join(target, ".cursor", "hooks.json"), "utf-8")) as {
      hooks?: { sessionStart?: { command?: string }[] };
    };
    expect(cursorHooks.hooks?.sessionStart?.some((h) => h.command?.includes("profile-init-watch.js"))).toBe(true);

    const kiroHook = JSON.parse(
      fs.readFileSync(
        path.join(target, ".kiro", "hooks", "claude-skills-skill-invoke-profile-init.kiro.hook"),
        "utf-8"
      )
    ) as { when?: { type?: string }; then?: { command?: string } };
    expect(kiroHook.when?.type).toBe("sessionStart");
    expect(kiroHook.then?.command).toContain("profile-init-watch.js kiro");
    expect(fs.existsSync(path.join(target, ".claude", "hooks", "profile-init-watch.js"))).toBe(true);

    const copilotHook = JSON.parse(
      fs.readFileSync(
        path.join(target, ".github", "hooks", "claude-skills-skill-invoke-profile-init.json"),
        "utf-8"
      )
    ) as { hooks?: { SessionStart?: { bash?: string }[]; sessionStart?: { bash?: string }[] } };
    const sessionStart = copilotHook.hooks?.SessionStart ?? copilotHook.hooks?.sessionStart ?? [];
    expect(sessionStart.some((h) => h.bash?.includes("profile-init-watch.js copilot"))).toBe(true);
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
