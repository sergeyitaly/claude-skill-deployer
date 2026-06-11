import * as fs from "node:fs";
import * as path from "node:path";
import { ensureLearningDir } from "./usageStats";

const SESSION_HOOK_FILENAME = "session-size-watch.js";
const BUDGET_HOOK_FILENAME = "budget-watch.js";
const SKILL_INVOKE_HOOK_FILENAME = "skill-invoke-watch.js";
const HOOK_HELPER_FILENAME = "usageParse.js";

const SESSION_HOOK_COMMAND = `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/${SESSION_HOOK_FILENAME}"`;
const BUDGET_HOOK_COMMAND = `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/${BUDGET_HOOK_FILENAME}"`;
const SKILL_INVOKE_HOOK_COMMAND = `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/${SKILL_INVOKE_HOOK_FILENAME}"`;

export type HookInstallStatus = "installed" | "already-configured" | "updated";

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

export function areCostControlHooksConfigured(target: string): boolean {
  try {
    const settings = readSettings(path.join(target, ".claude", "settings.json"));
    return hasHook(settings, SESSION_HOOK_FILENAME) && hasHook(settings, BUDGET_HOOK_FILENAME);
  } catch {
    return false;
  }
}

function hasHook(settings: Settings, filename: string): boolean {
  const matchers = settings.hooks?.UserPromptSubmit ?? [];
  return matchers.some((m) => m.hooks.some((h) => h.command.includes(filename)));
}

const ALL_HOOK_FILES = [
  SESSION_HOOK_FILENAME,
  BUDGET_HOOK_FILENAME,
  SKILL_INVOKE_HOOK_FILENAME,
  HOOK_HELPER_FILENAME,
];

function copyHookFiles(extensionPath: string, hooksDir: string): void {
  const hooksSource = path.join(extensionPath, "resources", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const name of ALL_HOOK_FILES) {
    fs.copyFileSync(path.join(hooksSource, name), path.join(hooksDir, name));
  }
}

function hasPostToolHook(settings: Settings, filename: string): boolean {
  const matchers = settings.hooks?.PostToolUse ?? [];
  return matchers.some((m) => m.hooks.some((h) => h.command.includes(filename)));
}

function ensurePostToolHookRegistered(settings: Settings, matcher: string, filename: string, command: string): boolean {
  settings.hooks = settings.hooks ?? {};
  settings.hooks.PostToolUse = settings.hooks.PostToolUse ?? [];

  if (hasPostToolHook(settings, filename)) {
    return false;
  }

  settings.hooks.PostToolUse.push({
    matcher,
    hooks: [{ type: "command", command, timeout: 8 }],
  });
  return true;
}

export function areAttributionHooksConfigured(target: string): boolean {
  try {
    const settings = readSettings(path.join(target, ".claude", "settings.json"));
    return hasPostToolHook(settings, SKILL_INVOKE_HOOK_FILENAME);
  } catch {
    return false;
  }
}

function ensureHookRegistered(settings: Settings, filename: string, command: string): boolean {
  settings.hooks = settings.hooks ?? {};
  settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit ?? [];

  if (hasHook(settings, filename)) {
    return false;
  }

  settings.hooks.UserPromptSubmit.push({
    matcher: "",
    hooks: [{ type: "command", command, timeout: 8 }],
  });
  return true;
}

/** Copies cost-control hook scripts into <target>/.claude/hooks and registers
 * session-size + budget UserPromptSubmit hooks in <target>/.claude/settings.json.
 * Idempotent; refreshes hook file contents on each run. */
export function installCostControlHooks(extensionPath: string, target: string): HookInstallStatus {
  ensureLearningDir(target);

  const settingsFile = path.join(target, ".claude", "settings.json");
  const settings = readSettings(settingsFile);
  const hadSession = hasHook(settings, SESSION_HOOK_FILENAME);
  const hadBudget = hasHook(settings, BUDGET_HOOK_FILENAME);

  copyHookFiles(extensionPath, path.join(target, ".claude", "hooks"));

  const addedSession = ensureHookRegistered(settings, SESSION_HOOK_FILENAME, SESSION_HOOK_COMMAND);
  const addedBudget = ensureHookRegistered(settings, BUDGET_HOOK_FILENAME, BUDGET_HOOK_COMMAND);

  if (addedSession || addedBudget) {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    return "installed";
  }

  if (hadSession && hadBudget) {
    return "already-configured";
  }
  return "updated";
}

/** @deprecated Use installCostControlHooks */
export function installSessionWatchHook(extensionPath: string, target: string): HookInstallStatus {
  return installCostControlHooks(extensionPath, target);
}

/** Install PostToolUse skill-invoke hook (Attribution v2). Idempotent. */
export function installAttributionHooks(extensionPath: string, target: string): HookInstallStatus {
  ensureLearningDir(target);
  const settingsFile = path.join(target, ".claude", "settings.json");
  const settings = readSettings(settingsFile);
  const had = hasPostToolHook(settings, SKILL_INVOKE_HOOK_FILENAME);

  copyHookFiles(extensionPath, path.join(target, ".claude", "hooks"));
  const added = ensurePostToolHookRegistered(settings, "Skill|Read", SKILL_INVOKE_HOOK_FILENAME, SKILL_INVOKE_HOOK_COMMAND);

  if (added) {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    return "installed";
  }
  return had ? "already-configured" : "updated";
}

/** Copy latest hook scripts into the workspace without changing settings.json. */
export function refreshCostControlHookScripts(extensionPath: string, target: string): void {
  copyHookFiles(extensionPath, path.join(target, ".claude", "hooks"));
}
