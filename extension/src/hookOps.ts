import * as fs from "node:fs";
import * as path from "node:path";
import { AgentId, enabledAgents, loadAgentsManifest } from "./agentOps";
import { copyFileWithRetry } from "./fileWriteCoordination";
import { ensureLearningDir } from "./usageStats";

const SESSION_HOOK_FILENAME = "session-size-watch.js";
const BUDGET_HOOK_FILENAME = "budget-watch.js";
const CONTEXT_FOCUS_HOOK_FILENAME = "context-focus-watch.js";
const PRACTICAL_FOCUS_HOOK_FILENAME = "practical-focus-watch.js";
const TASK_DRIFT_HOOK_FILENAME = "task-drift-watch.js";
const SKILL_INVOKE_HOOK_FILENAME = "skill-invoke-watch.js";
const OFFICIAL_SKILLS_HOOK_FILENAME = "official-skills-watch.js";
const PROFILE_INIT_HOOK_FILENAME = "profile-init-watch.js";
const HOOK_HELPER_FILENAME = "usageParse.js";

const ATTRIBUTION_HOOK_MARKER = "claude-skills-skill-invoke";
const KIRO_ATTRIBUTION_HOOK_FILE = `${ATTRIBUTION_HOOK_MARKER}.kiro.hook`;
const KIRO_PROFILE_INIT_HOOK_FILE = `${ATTRIBUTION_HOOK_MARKER}-profile-init.kiro.hook`;
const KIRO_TASK_DRIFT_HOOK_FILE = "claude-skills-task-drift.kiro.hook";
const KIRO_BUDGET_HOOK_FILE = "claude-skills-budget.kiro.hook";
const TASK_DRIFT_HOOK_MARKER = "claude-skills-task-drift";
const BUDGET_HOOK_MARKER = "claude-skills-budget";
const PROFILE_INIT_HOOK_MARKER = `${ATTRIBUTION_HOOK_MARKER}-profile-init`;
const COPILOT_ATTRIBUTION_HOOK_FILE = `${ATTRIBUTION_HOOK_MARKER}.json`;
const COPILOT_TASK_DRIFT_HOOK_FILE = "claude-skills-task-drift.json";
const COPILOT_BUDGET_HOOK_FILE = "claude-skills-budget.json";

const SESSION_HOOK_COMMAND = `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/${SESSION_HOOK_FILENAME}"`;
const BUDGET_HOOK_COMMAND = `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/${BUDGET_HOOK_FILENAME}"`;
const CONTEXT_FOCUS_HOOK_COMMAND = `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/${CONTEXT_FOCUS_HOOK_FILENAME}"`;
const PRACTICAL_FOCUS_HOOK_COMMAND = `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/${PRACTICAL_FOCUS_HOOK_FILENAME}"`;
const TASK_DRIFT_HOOK_COMMAND = `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/${TASK_DRIFT_HOOK_FILENAME}"`;
const CLAUDE_SKILL_INVOKE_COMMAND = `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/${SKILL_INVOKE_HOOK_FILENAME}" claude`;
const CURSOR_SKILL_INVOKE_COMMAND = `node .cursor/hooks/${SKILL_INVOKE_HOOK_FILENAME} cursor`;
const KIRO_SKILL_INVOKE_COMMAND = `node .claude/hooks/${SKILL_INVOKE_HOOK_FILENAME} kiro`;
const COPILOT_SKILL_INVOKE_COMMAND = `node .claude/hooks/${SKILL_INVOKE_HOOK_FILENAME} copilot`;
const COPILOT_PROFILE_INIT_HOOK_FILE = `${ATTRIBUTION_HOOK_MARKER}-profile-init.json`;
const COPILOT_PROFILE_INIT_HOOK_COMMAND = `node .claude/hooks/${PROFILE_INIT_HOOK_FILENAME} copilot`;
const OFFICIAL_SKILLS_HOOK_COMMAND = `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/${OFFICIAL_SKILLS_HOOK_FILENAME}"`;
const PROFILE_INIT_HOOK_COMMAND = `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/${PROFILE_INIT_HOOK_FILENAME}"`;
const CURSOR_PROFILE_INIT_HOOK_COMMAND = `node .cursor/hooks/${PROFILE_INIT_HOOK_FILENAME} cursor`;
const CURSOR_TASK_DRIFT_HOOK_COMMAND = `node .cursor/hooks/${TASK_DRIFT_HOOK_FILENAME} cursor`;
const CURSOR_BUDGET_HOOK_COMMAND = `node .cursor/hooks/${BUDGET_HOOK_FILENAME}`;
const KIRO_TASK_DRIFT_HOOK_COMMAND = `node .claude/hooks/${TASK_DRIFT_HOOK_FILENAME} kiro`;
const KIRO_BUDGET_HOOK_COMMAND = `node .claude/hooks/${BUDGET_HOOK_FILENAME}`;
const COPILOT_TASK_DRIFT_HOOK_COMMAND = `node .claude/hooks/${TASK_DRIFT_HOOK_FILENAME} copilot`;
const COPILOT_BUDGET_HOOK_COMMAND = `node .claude/hooks/${BUDGET_HOOK_FILENAME}`;
const KIRO_PROFILE_INIT_HOOK_COMMAND = `node .claude/hooks/${PROFILE_INIT_HOOK_FILENAME} kiro`;
const OFFICIAL_SKILLS_SESSION_MATCHER = "startup|resume|clear";
const ATTRIBUTION_HOOK_MATCHER = "Skill|Read|read|fs_read|fileread";

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

interface CursorHooksFile {
  version: number;
  hooks?: Record<string, Array<{ command?: string; matcher?: string; type?: string; timeout?: number }>>;
}

interface CopilotHooksFile {
  version: number;
  hooks?: Record<
    string,
    Array<{
      type?: string;
      matcher?: string;
      bash?: string;
      powershell?: string;
      command?: string;
      timeoutSec?: number;
    }>
  >;
}

interface KiroHookFile {
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  when: { type: string; toolTypes?: string[] };
  then: { type: string; command: string; timeout?: number };
}

function libraryDirFromExtension(extensionPath: string): string {
  return path.join(extensionPath, "skills_library");
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

function readJsonFile<T>(file: string): T | null {
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function areCostControlHooksConfigured(target: string): boolean {
  return isSessionSizeHookConfigured(target) && isBudgetHookConfigured(target);
}

export function isSessionSizeHookConfigured(target: string): boolean {
  try {
    const settings = readSettings(path.join(target, ".claude", "settings.json"));
    return hasHook(settings, SESSION_HOOK_FILENAME);
  } catch {
    return false;
  }
}

export function isBudgetHookConfigured(target: string): boolean {
  try {
    const settings = readSettings(path.join(target, ".claude", "settings.json"));
    return hasHook(settings, BUDGET_HOOK_FILENAME);
  } catch {
    return false;
  }
}

export function isContextFocusHookConfigured(target: string): boolean {
  try {
    const settings = readSettings(path.join(target, ".claude", "settings.json"));
    return hasHook(settings, CONTEXT_FOCUS_HOOK_FILENAME);
  } catch {
    return false;
  }
}

export function isPracticalFocusHookConfigured(target: string): boolean {
  try {
    const settings = readSettings(path.join(target, ".claude", "settings.json"));
    return hasHook(settings, PRACTICAL_FOCUS_HOOK_FILENAME);
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
  CONTEXT_FOCUS_HOOK_FILENAME,
  PRACTICAL_FOCUS_HOOK_FILENAME,
  TASK_DRIFT_HOOK_FILENAME,
  SKILL_INVOKE_HOOK_FILENAME,
  OFFICIAL_SKILLS_HOOK_FILENAME,
  PROFILE_INIT_HOOK_FILENAME,
  HOOK_HELPER_FILENAME,
  "session-apply.js",
  "task-skill-focus.js",
  "branch-sync.js",
];

function copyHookFiles(extensionPath: string, hooksDir: string): void {
  const hooksSource = path.join(extensionPath, "resources", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const name of ALL_HOOK_FILES) {
    copyFileWithRetry(path.join(hooksSource, name), path.join(hooksDir, name));
  }
}

function installCursorTaskDriftHook(extensionPath: string, target: string): boolean {
  copyFileWithRetry(
    path.join(extensionPath, "resources", "hooks", TASK_DRIFT_HOOK_FILENAME),
    path.join(target, ".cursor", "hooks", TASK_DRIFT_HOOK_FILENAME)
  );
  const hooksFile = path.join(target, ".cursor", "hooks.json");
  const existing = readJsonFile<CursorHooksFile>(hooksFile) ?? { version: 1, hooks: {} };
  existing.version = 1;
  existing.hooks = existing.hooks ?? {};
  const entries = existing.hooks.beforeSubmitPrompt ?? [];
  const idx = entries.findIndex((e) => (e.command ?? "").includes(TASK_DRIFT_HOOK_FILENAME));
  const desired = {
    command: CURSOR_TASK_DRIFT_HOOK_COMMAND,
    timeout: 8,
  };
  if (idx >= 0) {
    const prev = entries[idx];
    if (prev.command === desired.command) {
      return false;
    }
    entries[idx] = { ...prev, ...desired };
    existing.hooks.beforeSubmitPrompt = entries;
    writeJsonFile(hooksFile, existing);
    return true;
  }
  existing.hooks.beforeSubmitPrompt = [...entries, desired];
  writeJsonFile(hooksFile, existing);
  return true;
}

function kiroTaskDriftHookPayload(): KiroHookFile {
  return {
    name: "Claude Skills — task drift re-proposal",
    description: `Managed by Claude Skills Manager (${TASK_DRIFT_HOOK_MARKER})`,
    version: "1",
    enabled: true,
    when: { type: "userPromptSubmit" },
    then: {
      type: "runCommand",
      command: KIRO_TASK_DRIFT_HOOK_COMMAND,
      timeout: 8,
    },
  };
}

function installKiroTaskDriftHook(extensionPath: string, target: string): boolean {
  copyFileWithRetry(
    path.join(extensionPath, "resources", "hooks", TASK_DRIFT_HOOK_FILENAME),
    path.join(target, ".claude", "hooks", TASK_DRIFT_HOOK_FILENAME)
  );
  const hookPath = path.join(target, ".kiro", "hooks", KIRO_TASK_DRIFT_HOOK_FILE);
  const desired = kiroTaskDriftHookPayload();
  const existing = readJsonFile<KiroHookFile>(hookPath);
  if (existing && existing.description.includes(TASK_DRIFT_HOOK_MARKER)) {
    const same = JSON.stringify(existing) === JSON.stringify(desired);
    if (same) {
      return false;
    }
  }
  writeJsonFile(hookPath, desired);
  return true;
}

function copilotTaskDriftHookPayload(): CopilotHooksFile {
  const command = {
    type: "command" as const,
    bash: COPILOT_TASK_DRIFT_HOOK_COMMAND,
    powershell: COPILOT_TASK_DRIFT_HOOK_COMMAND,
    timeoutSec: 8,
  };
  return {
    version: 1,
    hooks: {
      UserPromptSubmit: [command],
      userPromptSubmitted: [command],
    },
  };
}

function installCopilotTaskDriftHook(extensionPath: string, target: string): boolean {
  copyFileWithRetry(
    path.join(extensionPath, "resources", "hooks", TASK_DRIFT_HOOK_FILENAME),
    path.join(target, ".claude", "hooks", TASK_DRIFT_HOOK_FILENAME)
  );
  const hookPath = path.join(target, ".github", "hooks", COPILOT_TASK_DRIFT_HOOK_FILE);
  const desired = copilotTaskDriftHookPayload();
  const existing = readJsonFile<CopilotHooksFile>(hookPath);
  if (existing) {
    const same = JSON.stringify(existing) === JSON.stringify(desired);
    if (same) {
      return false;
    }
  }
  writeJsonFile(hookPath, desired);
  return true;
}

function isCursorBudgetHookConfigured(target: string): boolean {
  const hooksFile = path.join(target, ".cursor", "hooks.json");
  const raw = readJsonFile<CursorHooksFile>(hooksFile);
  if (!raw?.hooks?.beforeSubmitPrompt) {
    return false;
  }
  return raw.hooks.beforeSubmitPrompt.some((entry) => (entry.command ?? "").includes(BUDGET_HOOK_FILENAME));
}

function installCursorBudgetHook(extensionPath: string, target: string): boolean {
  copyFileWithRetry(
    path.join(extensionPath, "resources", "hooks", BUDGET_HOOK_FILENAME),
    path.join(target, ".cursor", "hooks", BUDGET_HOOK_FILENAME)
  );
  copyFileWithRetry(
    path.join(extensionPath, "resources", "hooks", HOOK_HELPER_FILENAME),
    path.join(target, ".cursor", "hooks", HOOK_HELPER_FILENAME)
  );
  const hooksFile = path.join(target, ".cursor", "hooks.json");
  const existing = readJsonFile<CursorHooksFile>(hooksFile) ?? { version: 1, hooks: {} };
  existing.version = 1;
  existing.hooks = existing.hooks ?? {};
  const entries = existing.hooks.beforeSubmitPrompt ?? [];
  const idx = entries.findIndex((e) => (e.command ?? "").includes(BUDGET_HOOK_FILENAME));
  const desired = {
    command: CURSOR_BUDGET_HOOK_COMMAND,
    timeout: 8,
  };
  if (idx >= 0) {
    const prev = entries[idx];
    if (prev.command === desired.command && prev.timeout === desired.timeout) {
      return false;
    }
    entries[idx] = { ...prev, ...desired };
    existing.hooks.beforeSubmitPrompt = entries;
    writeJsonFile(hooksFile, existing);
    return true;
  }
  existing.hooks.beforeSubmitPrompt = [...entries, desired];
  writeJsonFile(hooksFile, existing);
  return true;
}

function kiroBudgetHookPayload(): KiroHookFile {
  return {
    name: "Claude Skills — budget watch",
    description: `Managed by Claude Skills Manager (${BUDGET_HOOK_MARKER})`,
    version: "1",
    enabled: true,
    when: { type: "userPromptSubmit" },
    then: {
      type: "runCommand",
      command: KIRO_BUDGET_HOOK_COMMAND,
      timeout: 8,
    },
  };
}

function isKiroBudgetHookConfigured(target: string): boolean {
  const hookPath = path.join(target, ".kiro", "hooks", KIRO_BUDGET_HOOK_FILE);
  const existing = readJsonFile<KiroHookFile>(hookPath);
  return Boolean(existing?.description?.includes(BUDGET_HOOK_MARKER));
}

function installKiroBudgetHook(extensionPath: string, target: string): boolean {
  copyFileWithRetry(
    path.join(extensionPath, "resources", "hooks", BUDGET_HOOK_FILENAME),
    path.join(target, ".claude", "hooks", BUDGET_HOOK_FILENAME)
  );
  copyFileWithRetry(
    path.join(extensionPath, "resources", "hooks", HOOK_HELPER_FILENAME),
    path.join(target, ".claude", "hooks", HOOK_HELPER_FILENAME)
  );
  const hookPath = path.join(target, ".kiro", "hooks", KIRO_BUDGET_HOOK_FILE);
  const desired = kiroBudgetHookPayload();
  const existing = readJsonFile<KiroHookFile>(hookPath);
  if (existing && existing.description.includes(BUDGET_HOOK_MARKER)) {
    const same = JSON.stringify(existing) === JSON.stringify(desired);
    if (same) {
      return false;
    }
  }
  writeJsonFile(hookPath, desired);
  return true;
}

function copilotBudgetHookPayload(): CopilotHooksFile {
  const command = {
    type: "command" as const,
    bash: COPILOT_BUDGET_HOOK_COMMAND,
    powershell: COPILOT_BUDGET_HOOK_COMMAND,
    timeoutSec: 8,
  };
  return {
    version: 1,
    hooks: {
      UserPromptSubmit: [command],
      userPromptSubmitted: [command],
    },
  };
}

function isCopilotBudgetHookConfigured(target: string): boolean {
  const hookPath = path.join(target, ".github", "hooks", COPILOT_BUDGET_HOOK_FILE);
  const existing = readJsonFile<CopilotHooksFile>(hookPath);
  return Boolean(existing?.hooks?.UserPromptSubmit?.some((h) => (h.bash ?? "").includes(BUDGET_HOOK_FILENAME)));
}

function installCopilotBudgetHook(extensionPath: string, target: string): boolean {
  copyFileWithRetry(
    path.join(extensionPath, "resources", "hooks", BUDGET_HOOK_FILENAME),
    path.join(target, ".claude", "hooks", BUDGET_HOOK_FILENAME)
  );
  copyFileWithRetry(
    path.join(extensionPath, "resources", "hooks", HOOK_HELPER_FILENAME),
    path.join(target, ".claude", "hooks", HOOK_HELPER_FILENAME)
  );
  const hookPath = path.join(target, ".github", "hooks", COPILOT_BUDGET_HOOK_FILE);
  const desired = copilotBudgetHookPayload();
  const existing = readJsonFile<CopilotHooksFile>(hookPath);
  if (existing) {
    const same = JSON.stringify(existing) === JSON.stringify(desired);
    if (same) {
      return false;
    }
  }
  writeJsonFile(hookPath, desired);
  return true;
}

/** Budget hooks for Cursor, Kiro, and Copilot (Claude uses UserPromptSubmit in settings.json). */
function installAgentBudgetHooks(extensionPath: string, target: string, libraryDir: string): boolean {
  const agents = enabledAgents(libraryDir);
  let changed = false;
  if (agents.includes("cursor")) {
    changed = installCursorBudgetHook(extensionPath, target) || changed;
  }
  if (agents.includes("kiro")) {
    changed = installKiroBudgetHook(extensionPath, target) || changed;
  }
  if (agents.includes("copilot")) {
    changed = installCopilotBudgetHook(extensionPath, target) || changed;
  }
  return changed;
}

function agentBudgetHooksConfigured(target: string, libraryDir: string): boolean {
  const agents = enabledAgents(libraryDir);
  const cursorOk = !agents.includes("cursor") || isCursorBudgetHookConfigured(target);
  const kiroOk = !agents.includes("kiro") || isKiroBudgetHookConfigured(target);
  const copilotOk = !agents.includes("copilot") || isCopilotBudgetHookConfigured(target);
  return cursorOk && kiroOk && copilotOk;
}

/** Task-drift prompt hooks for Cursor, Kiro, and Copilot (Claude uses UserPromptSubmit in settings.json). */
function installAgentTaskDriftHooks(extensionPath: string, target: string, libraryDir: string): boolean {
  const agents = enabledAgents(libraryDir);
  let changed = false;
  if (agents.includes("cursor")) {
    changed = installCursorTaskDriftHook(extensionPath, target) || changed;
  }
  if (agents.includes("kiro")) {
    changed = installKiroTaskDriftHook(extensionPath, target) || changed;
  }
  if (agents.includes("copilot")) {
    changed = installCopilotTaskDriftHook(extensionPath, target) || changed;
  }
  return changed;
}

function copyAttributionHookScript(extensionPath: string, hooksDir: string): void {
  const hooksSource = path.join(extensionPath, "resources", "hooks", SKILL_INVOKE_HOOK_FILENAME);
  fs.mkdirSync(hooksDir, { recursive: true });
  copyFileWithRetry(hooksSource, path.join(hooksDir, SKILL_INVOKE_HOOK_FILENAME));
}

function copyProfileInitHookScript(extensionPath: string, hooksDir: string): void {
  const hooksSource = path.join(extensionPath, "resources", "hooks", PROFILE_INIT_HOOK_FILENAME);
  fs.mkdirSync(hooksDir, { recursive: true });
  copyFileWithRetry(hooksSource, path.join(hooksDir, PROFILE_INIT_HOOK_FILENAME));
}

function isCursorProfileInitHookConfigured(target: string): boolean {
  const hooksFile = path.join(target, ".cursor", "hooks.json");
  const raw = readJsonFile<CursorHooksFile>(hooksFile);
  if (!raw?.hooks?.sessionStart) {
    return false;
  }
  return raw.hooks.sessionStart.some((entry) => (entry.command ?? "").includes(PROFILE_INIT_HOOK_FILENAME));
}

function installCursorProfileInitHook(extensionPath: string, target: string): boolean {
  copyProfileInitHookScript(extensionPath, path.join(target, ".cursor", "hooks"));
  const hooksFile = path.join(target, ".cursor", "hooks.json");
  const existing = readJsonFile<CursorHooksFile>(hooksFile) ?? { version: 1, hooks: {} };
  existing.version = 1;
  existing.hooks = existing.hooks ?? {};
  const entries = existing.hooks.sessionStart ?? [];
  const idx = entries.findIndex((e) => (e.command ?? "").includes(PROFILE_INIT_HOOK_FILENAME));
  const desired = {
    command: CURSOR_PROFILE_INIT_HOOK_COMMAND,
    timeout: 20,
  };
  if (idx >= 0) {
    const prev = entries[idx];
    if (prev.command === desired.command && prev.timeout === desired.timeout) {
      return false;
    }
    entries[idx] = { ...prev, ...desired };
    existing.hooks.sessionStart = entries;
    writeJsonFile(hooksFile, existing);
    return true;
  }
  existing.hooks.sessionStart = [...entries, desired];
  writeJsonFile(hooksFile, existing);
  return true;
}

function isKiroProfileInitHookConfigured(target: string): boolean {
  const hookPath = path.join(target, ".kiro", "hooks", KIRO_PROFILE_INIT_HOOK_FILE);
  const existing = readJsonFile<KiroHookFile>(hookPath);
  return Boolean(existing?.description?.includes(PROFILE_INIT_HOOK_MARKER));
}

function kiroProfileInitHookPayload(): KiroHookFile {
  return {
    name: "Claude Skills — profile init & session skill adaptation",
    description: `Managed by Claude Skills Manager (${PROFILE_INIT_HOOK_MARKER})`,
    version: "1",
    enabled: true,
    when: { type: "agentSpawn" },
    then: {
      type: "runCommand",
      command: KIRO_PROFILE_INIT_HOOK_COMMAND,
      timeout: 20,
    },
  };
}

function installKiroProfileInitHook(extensionPath: string, target: string): boolean {
  copyProfileInitHookScript(extensionPath, path.join(target, ".claude", "hooks"));
  const hookPath = path.join(target, ".kiro", "hooks", KIRO_PROFILE_INIT_HOOK_FILE);
  const desired = kiroProfileInitHookPayload();
  const existing = readJsonFile<KiroHookFile>(hookPath);
  if (existing?.description?.includes(PROFILE_INIT_HOOK_MARKER)) {
    const same = JSON.stringify(existing) === JSON.stringify(desired);
    if (same) {
      return false;
    }
  }
  writeJsonFile(hookPath, desired);
  return true;
}

function hasPostToolHook(settings: Settings, filename: string): boolean {
  const matchers = settings.hooks?.PostToolUse ?? [];
  return matchers.some((m) => m.hooks.some((h) => h.command.includes(filename)));
}

function migrateAttributionHookMatcher(settings: Settings): boolean {
  let changed = false;
  for (const matcher of settings.hooks?.PostToolUse ?? []) {
    const usesHook = matcher.hooks.some((h) => h.command.includes(SKILL_INVOKE_HOOK_FILENAME));
    if (usesHook && matcher.matcher !== ATTRIBUTION_HOOK_MATCHER) {
      matcher.matcher = ATTRIBUTION_HOOK_MATCHER;
      changed = true;
    }
  }
  return changed;
}

function ensurePostToolHookRegistered(settings: Settings, matcher: string, filename: string, command: string): boolean {
  settings.hooks = settings.hooks ?? {};
  settings.hooks.PostToolUse = settings.hooks.PostToolUse ?? [];

  if (hasPostToolHook(settings, filename)) {
    return migrateAttributionHookMatcher(settings);
  }

  settings.hooks.PostToolUse.push({
    matcher,
    hooks: [{ type: "command", command, timeout: 8 }],
  });
  return true;
}

function isClaudeAttributionHookConfigured(target: string): boolean {
  try {
    const settings = readSettings(path.join(target, ".claude", "settings.json"));
    return hasPostToolHook(settings, SKILL_INVOKE_HOOK_FILENAME);
  } catch {
    return false;
  }
}

function isCursorAttributionHookConfigured(target: string): boolean {
  const hooksFile = path.join(target, ".cursor", "hooks.json");
  const raw = readJsonFile<CursorHooksFile>(hooksFile);
  if (!raw?.hooks?.postToolUse) {
    return false;
  }
  return raw.hooks.postToolUse.some((entry) => (entry.command ?? "").includes(SKILL_INVOKE_HOOK_FILENAME));
}

function isKiroAttributionHookConfigured(target: string): boolean {
  return fs.existsSync(path.join(target, ".kiro", "hooks", KIRO_ATTRIBUTION_HOOK_FILE));
}

function isCopilotAttributionHookConfigured(target: string): boolean {
  return fs.existsSync(path.join(target, ".github", "hooks", COPILOT_ATTRIBUTION_HOOK_FILE));
}

function isCopilotProfileInitHookConfigured(target: string): boolean {
  const hookPath = path.join(target, ".github", "hooks", COPILOT_PROFILE_INIT_HOOK_FILE);
  if (!fs.existsSync(hookPath)) {
    return false;
  }
  const raw = readJsonFile<CopilotHooksFile>(hookPath);
  const entries = raw?.hooks?.SessionStart ?? raw?.hooks?.sessionStart ?? [];
  return entries.some(
    (entry) =>
      (entry.bash ?? entry.powershell ?? entry.command ?? "").includes(PROFILE_INIT_HOOK_FILENAME)
  );
}

/** True when attribution hooks are installed for every enabled agent that supports them. */
export function areAttributionHooksConfigured(target: string, extensionPath?: string): boolean {
  const libraryDir = extensionPath ? libraryDirFromExtension(extensionPath) : undefined;
  if (!libraryDir) {
    return isClaudeAttributionHookConfigured(target);
  }
  const manifest = loadAgentsManifest(libraryDir);
  for (const agentId of enabledAgents(libraryDir)) {
    const agent = manifest.agents[agentId];
    if (!agentSupportsAttribution(agent)) {
      continue;
    }
    if (agentId === "claude" && !isClaudeAttributionHookConfigured(target)) {
      return false;
    }
    if (agentId === "cursor" && !isCursorAttributionHookConfigured(target)) {
      return false;
    }
    if (agentId === "kiro" && !isKiroAttributionHookConfigured(target)) {
      return false;
    }
    if (agentId === "copilot" && !isCopilotAttributionHookConfigured(target)) {
      return false;
    }
  }
  return true;
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

function installClaudeAttributionHook(extensionPath: string, target: string): boolean {
  const settingsFile = path.join(target, ".claude", "settings.json");
  const settings = readSettings(settingsFile);
  copyHookFiles(extensionPath, path.join(target, ".claude", "hooks"));
  const added = ensurePostToolHookRegistered(
    settings,
    ATTRIBUTION_HOOK_MATCHER,
    SKILL_INVOKE_HOOK_FILENAME,
    CLAUDE_SKILL_INVOKE_COMMAND
  );
  const migrated = migrateAttributionHookMatcher(settings);
  if (added || migrated) {
    writeJsonFile(settingsFile, settings);
  }
  return added || migrated;
}

function installCursorAttributionHook(extensionPath: string, target: string): boolean {
  copyAttributionHookScript(extensionPath, path.join(target, ".cursor", "hooks"));
  const hooksFile = path.join(target, ".cursor", "hooks.json");
  const existing = readJsonFile<CursorHooksFile>(hooksFile) ?? { version: 1, hooks: {} };
  existing.version = 1;
  existing.hooks = existing.hooks ?? {};
  const entries = existing.hooks.postToolUse ?? [];
  const idx = entries.findIndex((e) => (e.command ?? "").includes(SKILL_INVOKE_HOOK_FILENAME));
  const desired = {
    command: CURSOR_SKILL_INVOKE_COMMAND,
    matcher: ATTRIBUTION_HOOK_MATCHER,
    timeout: 8,
  };
  if (idx >= 0) {
    const prev = entries[idx];
    if (prev.command === desired.command && prev.matcher === desired.matcher) {
      return false;
    }
    entries[idx] = { ...prev, ...desired };
    existing.hooks.postToolUse = entries;
    writeJsonFile(hooksFile, existing);
    return true;
  }
  existing.hooks.postToolUse = [...entries, desired];
  writeJsonFile(hooksFile, existing);
  return true;
}

function kiroAttributionHookPayload(): KiroHookFile {
  return {
    name: "Claude Skills — skill invoke attribution",
    description: `Managed by Claude Skills Manager (${ATTRIBUTION_HOOK_MARKER})`,
    version: "1",
    enabled: true,
    when: {
      type: "postToolUse",
      toolTypes: ["Skill", "skill", "read", "fs_read", "fileread"],
    },
    then: {
      type: "runCommand",
      command: KIRO_SKILL_INVOKE_COMMAND,
      timeout: 8,
    },
  };
}

function installKiroAttributionHook(extensionPath: string, target: string): boolean {
  copyAttributionHookScript(extensionPath, path.join(target, ".claude", "hooks"));
  const hookPath = path.join(target, ".kiro", "hooks", KIRO_ATTRIBUTION_HOOK_FILE);
  const desired = kiroAttributionHookPayload();
  const existing = readJsonFile<KiroHookFile>(hookPath);
  if (existing && existing.description.includes(ATTRIBUTION_HOOK_MARKER)) {
    const same = JSON.stringify(existing) === JSON.stringify(desired);
    if (same) {
      return false;
    }
  }
  writeJsonFile(hookPath, desired);
  return true;
}

function copilotAttributionHookPayload(): CopilotHooksFile {
  return {
    version: 1,
    hooks: {
      postToolUse: [
        {
          type: "command",
          matcher: ATTRIBUTION_HOOK_MATCHER,
          bash: COPILOT_SKILL_INVOKE_COMMAND,
          powershell: COPILOT_SKILL_INVOKE_COMMAND,
        },
      ],
    },
  };
}

function installCopilotAttributionHook(extensionPath: string, target: string): boolean {
  copyAttributionHookScript(extensionPath, path.join(target, ".claude", "hooks"));
  const hookPath = path.join(target, ".github", "hooks", COPILOT_ATTRIBUTION_HOOK_FILE);
  const desired = copilotAttributionHookPayload();
  const existing = readJsonFile<CopilotHooksFile>(hookPath);
  if (existing) {
    const same = JSON.stringify(existing) === JSON.stringify(desired);
    if (same) {
      return false;
    }
  }
  writeJsonFile(hookPath, desired);
  return true;
}

function copilotProfileInitHookPayload(): CopilotHooksFile {
  const command = {
    type: "command" as const,
    bash: COPILOT_PROFILE_INIT_HOOK_COMMAND,
    powershell: COPILOT_PROFILE_INIT_HOOK_COMMAND,
    timeoutSec: 20,
  };
  return {
    version: 1,
    hooks: {
      SessionStart: [command],
      sessionStart: [command],
    },
  };
}

function installCopilotProfileInitHook(extensionPath: string, target: string): boolean {
  copyProfileInitHookScript(extensionPath, path.join(target, ".claude", "hooks"));
  const hookPath = path.join(target, ".github", "hooks", COPILOT_PROFILE_INIT_HOOK_FILE);
  const desired = copilotProfileInitHookPayload();
  const existing = readJsonFile<CopilotHooksFile>(hookPath);
  if (existing) {
    const same = JSON.stringify(existing) === JSON.stringify(desired);
    if (same) {
      return false;
    }
  }
  writeJsonFile(hookPath, desired);
  return true;
}

function agentSupportsAttribution(agent: { supportsAttributionHooks?: boolean }): boolean {
  return agent.supportsAttributionHooks !== false;
}

/** Copies cost-control hook scripts into <target>/.claude/hooks and registers
 * session-size, budget, context-focus, and practical-focus UserPromptSubmit hooks in
 * <target>/.claude/settings.json. Idempotent; refreshes hook file contents on each run. */
export function installCostControlHooks(extensionPath: string, target: string): HookInstallStatus {
  ensureLearningDir(target);
  const libraryDir = libraryDirFromExtension(extensionPath);

  const settingsFile = path.join(target, ".claude", "settings.json");
  const settings = readSettings(settingsFile);
  const hadSession = hasHook(settings, SESSION_HOOK_FILENAME);
  const hadBudget = hasHook(settings, BUDGET_HOOK_FILENAME);
  const hadContextFocus = hasHook(settings, CONTEXT_FOCUS_HOOK_FILENAME);
  const hadPracticalFocus = hasHook(settings, PRACTICAL_FOCUS_HOOK_FILENAME);
  const hadTaskDrift = hasHook(settings, TASK_DRIFT_HOOK_FILENAME);

  copyHookFiles(extensionPath, path.join(target, ".claude", "hooks"));

  const addedSession = ensureHookRegistered(settings, SESSION_HOOK_FILENAME, SESSION_HOOK_COMMAND);
  const addedBudget = ensureHookRegistered(settings, BUDGET_HOOK_FILENAME, BUDGET_HOOK_COMMAND);
  const addedContextFocus = ensureHookRegistered(
    settings,
    CONTEXT_FOCUS_HOOK_FILENAME,
    CONTEXT_FOCUS_HOOK_COMMAND
  );
  const addedPracticalFocus = ensureHookRegistered(
    settings,
    PRACTICAL_FOCUS_HOOK_FILENAME,
    PRACTICAL_FOCUS_HOOK_COMMAND
  );
  const addedTaskDrift = ensureHookRegistered(settings, TASK_DRIFT_HOOK_FILENAME, TASK_DRIFT_HOOK_COMMAND);

  if (addedSession || addedBudget || addedContextFocus || addedPracticalFocus || addedTaskDrift) {
    writeJsonFile(settingsFile, settings);
    installAgentTaskDriftHooks(extensionPath, target, libraryDir);
    installAgentBudgetHooks(extensionPath, target, libraryDir);
    return installAttributionHooks(extensionPath, target);
  }

  if (hadSession && hadBudget && hadContextFocus && hadPracticalFocus && hadTaskDrift) {
    installAgentTaskDriftHooks(extensionPath, target, libraryDir);
    installAgentBudgetHooks(extensionPath, target, libraryDir);
    return installAttributionHooks(extensionPath, target);
  }
  installAgentTaskDriftHooks(extensionPath, target, libraryDir);
  installAgentBudgetHooks(extensionPath, target, libraryDir);
  return installAttributionHooks(extensionPath, target);
}

/** @deprecated Use installCostControlHooks */
export function installSessionWatchHook(extensionPath: string, target: string): HookInstallStatus {
  return installCostControlHooks(extensionPath, target);
}

/** Install PostToolUse skill-invoke hooks for all enabled agents (Attribution v2). Idempotent. */
export function installAttributionHooks(extensionPath: string, target: string): HookInstallStatus {
  ensureLearningDir(target);
  refreshAttributionHookScripts(extensionPath, target);

  const libraryDir = libraryDirFromExtension(extensionPath);
  const manifest = loadAgentsManifest(libraryDir);
  const active = enabledAgents(libraryDir);

  let changed = false;
  let hadAny = false;

  if (active.includes("claude") && agentSupportsAttribution(manifest.agents.claude)) {
    hadAny = isClaudeAttributionHookConfigured(target) || hadAny;
    changed = installClaudeAttributionHook(extensionPath, target) || changed;
  }
  if (active.includes("cursor") && agentSupportsAttribution(manifest.agents.cursor)) {
    hadAny = isCursorAttributionHookConfigured(target) || hadAny;
    changed = installCursorAttributionHook(extensionPath, target) || changed;
  }
  if (active.includes("kiro") && agentSupportsAttribution(manifest.agents.kiro)) {
    hadAny = isKiroAttributionHookConfigured(target) || hadAny;
    changed = installKiroAttributionHook(extensionPath, target) || changed;
  }
  if (active.includes("copilot") && agentSupportsAttribution(manifest.agents.copilot)) {
    hadAny = isCopilotAttributionHookConfigured(target) || hadAny;
    changed = installCopilotAttributionHook(extensionPath, target) || changed;
  }

  if (changed) {
    return hadAny ? "updated" : "installed";
  }
  return hadAny ? "already-configured" : "updated";
}

function hasSessionStartHook(settings: Settings, filename: string): boolean {
  const matchers = settings.hooks?.SessionStart ?? [];
  return matchers.some((m) => m.hooks.some((h) => h.command.includes(filename)));
}

function ensureSessionStartHookRegistered(
  settings: Settings,
  matcher: string,
  filename: string,
  command: string
): boolean {
  settings.hooks = settings.hooks ?? {};
  settings.hooks.SessionStart = settings.hooks.SessionStart ?? [];

  for (const entry of settings.hooks.SessionStart) {
    if (entry.hooks.some((h) => h.command.includes(filename))) {
      if (entry.matcher !== matcher) {
        entry.matcher = matcher;
        return true;
      }
      return false;
    }
  }

  settings.hooks.SessionStart.push({
    matcher,
    hooks: [{ type: "command", command, timeout: 20 }],
  });
  return true;
}

export function areOfficialSkillsHooksConfigured(target: string): boolean {
  try {
    const settings = readSettings(path.join(target, ".claude", "settings.json"));
    return hasSessionStartHook(settings, OFFICIAL_SKILLS_HOOK_FILENAME);
  } catch {
    return false;
  }
}

/** SessionStart hook: check anthropics/skills and inject skill-official-updater context. */
export function installOfficialSkillsSessionHook(extensionPath: string, target: string): HookInstallStatus {
  ensureLearningDir(target);
  const settingsFile = path.join(target, ".claude", "settings.json");
  const settings = readSettings(settingsFile);
  const had = hasSessionStartHook(settings, OFFICIAL_SKILLS_HOOK_FILENAME);

  copyHookFiles(extensionPath, path.join(target, ".claude", "hooks"));
  const added = ensureSessionStartHookRegistered(
    settings,
    OFFICIAL_SKILLS_SESSION_MATCHER,
    OFFICIAL_SKILLS_HOOK_FILENAME,
    OFFICIAL_SKILLS_HOOK_COMMAND
  );

  if (added) {
    writeJsonFile(settingsFile, settings);
    return had ? "updated" : "installed";
  }
  return had ? "already-configured" : "updated";
}

export function areProfileInitHooksConfigured(target: string, libraryDir?: string): boolean {
  const lib = libraryDir ?? "";
  const cursorEnabled = lib ? enabledAgents(lib).includes("cursor") : isCursorProfileInitHookConfigured(target);
  const kiroEnabled = lib ? enabledAgents(lib).includes("kiro") : isKiroProfileInitHookConfigured(target);
  const copilotEnabled = lib ? enabledAgents(lib).includes("copilot") : isCopilotProfileInitHookConfigured(target);
  const cursorOk = !cursorEnabled || isCursorProfileInitHookConfigured(target);
  const kiroOk = !kiroEnabled || isKiroProfileInitHookConfigured(target);
  const copilotOk = !copilotEnabled || isCopilotProfileInitHookConfigured(target);
  try {
    const settings = readSettings(path.join(target, ".claude", "settings.json"));
    const claudeEnabled = !lib || enabledAgents(lib).includes("claude");
    const claudeOk = !claudeEnabled || hasSessionStartHook(settings, PROFILE_INIT_HOOK_FILENAME);
    return claudeOk && cursorOk && kiroOk && copilotOk;
  } catch {
    return cursorOk && kiroOk && copilotOk;
  }
}

/** SessionStart hook: inject profile-init when a branch profile request is pending. */
export function installProfileInitSessionHook(
  extensionPath: string,
  target: string,
  libraryDir?: string
): HookInstallStatus {
  ensureLearningDir(target);
  const lib = libraryDir ?? libraryDirFromExtension(extensionPath);
  const agents = enabledAgents(lib);

  copyHookFiles(extensionPath, path.join(target, ".claude", "hooks"));

  let changed = false;
  let hadAny = false;

  if (agents.includes("claude")) {
    const settingsFile = path.join(target, ".claude", "settings.json");
    const settings = readSettings(settingsFile);
    const had = hasSessionStartHook(settings, PROFILE_INIT_HOOK_FILENAME);
    hadAny = hadAny || had;
    const added = ensureSessionStartHookRegistered(
      settings,
      OFFICIAL_SKILLS_SESSION_MATCHER,
      PROFILE_INIT_HOOK_FILENAME,
      PROFILE_INIT_HOOK_COMMAND
    );
    if (added) {
      writeJsonFile(settingsFile, settings);
      changed = true;
    }
  }

  if (agents.includes("cursor")) {
    const had = isCursorProfileInitHookConfigured(target);
    hadAny = hadAny || had;
    changed = installCursorProfileInitHook(extensionPath, target) || changed;
  }

  if (agents.includes("kiro")) {
    const had = isKiroProfileInitHookConfigured(target);
    hadAny = hadAny || had;
    changed = installKiroProfileInitHook(extensionPath, target) || changed;
  }

  if (agents.includes("copilot")) {
    const had = isCopilotProfileInitHookConfigured(target);
    hadAny = hadAny || had;
    changed = installCopilotProfileInitHook(extensionPath, target) || changed;
  }

  if (changed) {
    return hadAny ? "updated" : "installed";
  }
  return hadAny ? "already-configured" : "updated";
}

/** Copy latest hook scripts into workspace agent hook directories. */
export function refreshCostControlHookScripts(
  extensionPath: string,
  target: string,
  libraryDir?: string
): void {
  const lib = libraryDir ?? libraryDirFromExtension(extensionPath);
  copyHookFiles(extensionPath, path.join(target, ".claude", "hooks"));
  installAgentBudgetHooks(extensionPath, target, lib);
  installAgentTaskDriftHooks(extensionPath, target, lib);
  refreshAttributionHookScripts(extensionPath, target);
}

export function refreshAttributionHookScripts(extensionPath: string, target: string): void {
  copyAttributionHookScript(extensionPath, path.join(target, ".claude", "hooks"));
  copyAttributionHookScript(extensionPath, path.join(target, ".cursor", "hooks"));
}

export interface AgentAttributionHookStatus {
  agent: AgentId;
  displayName: string;
  applicable: boolean;
  configured: boolean;
}

export interface WorkspaceHookStatus {
  attribution: {
    configuredCount: number;
    applicableCount: number;
    allConfigured: boolean;
    agents: AgentAttributionHookStatus[];
  };
  costControl: {
    sessionSize: boolean;
    budget: boolean;
    contextFocus: boolean;
    practicalFocus: boolean;
    configured: boolean;
  };
}

function attributionConfiguredForAgent(target: string, agentId: AgentId): boolean {
  switch (agentId) {
    case "claude":
      return isClaudeAttributionHookConfigured(target);
    case "cursor":
      return isCursorAttributionHookConfigured(target);
    case "kiro":
      return isKiroAttributionHookConfigured(target);
    case "copilot":
      return isCopilotAttributionHookConfigured(target);
    default:
      return false;
  }
}

/** Per-agent attribution hooks and Claude Code session/budget hook state for this workspace. */
export function getWorkspaceHookStatus(target: string, libraryDir: string): WorkspaceHookStatus {
  const manifest = loadAgentsManifest(libraryDir);
  const agents: AgentAttributionHookStatus[] = [];

  for (const agentId of enabledAgents(libraryDir)) {
    const def = manifest.agents[agentId];
    const applicable = agentSupportsAttribution(def);
    agents.push({
      agent: agentId,
      displayName: def.displayName,
      applicable,
      configured: applicable ? attributionConfiguredForAgent(target, agentId) : false,
    });
  }

  const applicableAgents = agents.filter((a) => a.applicable);
  const configuredCount = applicableAgents.filter((a) => a.configured).length;

  return {
    attribution: {
      configuredCount,
      applicableCount: applicableAgents.length,
      allConfigured: applicableAgents.length > 0 && configuredCount === applicableAgents.length,
      agents,
    },
    costControl: {
      sessionSize: isSessionSizeHookConfigured(target),
      budget:
        isBudgetHookConfigured(target) && agentBudgetHooksConfigured(target, libraryDir),
      contextFocus: isContextFocusHookConfigured(target),
      practicalFocus: isPracticalFocusHookConfigured(target),
      configured:
        areCostControlHooksConfigured(target) && agentBudgetHooksConfigured(target, libraryDir),
    },
  };
}
