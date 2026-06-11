import * as fs from "node:fs";
import * as path from "node:path";
import { ensureLearningDir } from "./usageStats";

const HOOK_FILENAME = "session-size-watch.js";
const HOOK_COMMAND = `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/${HOOK_FILENAME}"`;

export type HookInstallStatus = "installed" | "already-configured";

interface HookEntry {
  type: string;
  command: string;
  timeout?: number;
}

interface HookMatcher {
  matcher: string;
  hooks: HookEntry[];
}

interface Settings {
  hooks?: Record<string, HookMatcher[]>;
  [key: string]: unknown;
}

function readSettings(file: string): Settings {
  if (!fs.existsSync(file)) {
    return {};
  }
  const raw = fs.readFileSync(file, "utf-8");
  if (raw.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(raw) as Settings;
  } catch (err) {
    throw new Error(`Could not parse ${file}: ${(err as Error).message}`);
  }
}

function hasSessionWatchHook(settings: Settings): boolean {
  const matchers = settings.hooks?.UserPromptSubmit ?? [];
  return matchers.some((m) => m.hooks.some((h) => h.command.includes(HOOK_FILENAME)));
}

/** Copies the session-size-watch hook script into <target>/.claude/hooks and
 * registers it as a UserPromptSubmit hook in <target>/.claude/settings.json.
 * Idempotent: returns "already-configured" if already registered. */
export function installSessionWatchHook(extensionPath: string, target: string): HookInstallStatus {
  ensureLearningDir(target);

  const settingsFile = path.join(target, ".claude", "settings.json");
  const settings = readSettings(settingsFile);

  if (hasSessionWatchHook(settings)) {
    return "already-configured";
  }

  const hooksDir = path.join(target, ".claude", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.copyFileSync(path.join(extensionPath, "resources", "hooks", HOOK_FILENAME), path.join(hooksDir, HOOK_FILENAME));

  settings.hooks = settings.hooks ?? {};
  settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit ?? [];
  settings.hooks.UserPromptSubmit.push({
    matcher: "",
    hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 5 }],
  });

  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf-8");

  return "installed";
}
