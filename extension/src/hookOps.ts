import * as fs from "node:fs";
import * as path from "node:path";
import { AgentId, enabledAgents, loadAgentsManifest, workspaceMirrorAgentIds } from "./agentOps";
import { assessClaudeVscodeAttributionGap, ClaudeVscodeAttributionGap } from "./claudeVscodeAttributionGap";
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
/** Kiro `.kiro.hook` schema: when.type must be promptSubmit (not userPromptSubmit). */
const KIRO_WHEN_PROMPT_SUBMIT = "promptSubmit";
/** Kiro session-start hooks use sessionStart (not agentSpawn). */
const KIRO_WHEN_SESSION_START = "sessionStart";
const HOOK_PLATFORM_FILENAME = "hookPlatform.js";
const SESSION_SIZE_HOOK_MARKER = "claude-skills-session-size";
const CONTEXT_FOCUS_HOOK_MARKER = "claude-skills-context-focus";
const PRACTICAL_FOCUS_HOOK_MARKER = "claude-skills-practical-focus";
const KIRO_SESSION_SIZE_HOOK_FILE = "claude-skills-session-size.kiro.hook";
const KIRO_CONTEXT_FOCUS_HOOK_FILE = "claude-skills-context-focus.kiro.hook";
const KIRO_PRACTICAL_FOCUS_HOOK_FILE = "claude-skills-practical-focus.kiro.hook";
const COPILOT_SESSION_SIZE_HOOK_FILE = "claude-skills-session-size.json";
const COPILOT_CONTEXT_FOCUS_HOOK_FILE = "claude-skills-context-focus.json";
const COPILOT_PRACTICAL_FOCUS_HOOK_FILE = "claude-skills-practical-focus.json";
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

export function isTaskDriftHookConfigured(target: string): boolean {
  try {
    const settings = readSettings(path.join(target, ".claude", "settings.json"));
    return hasHook(settings, TASK_DRIFT_HOOK_FILENAME);
  } catch {
    return false;
  }
}

function claudeCostControlHooksFullyConfigured(target: string): boolean {
  return (
    isSessionSizeHookConfigured(target) &&
    isBudgetHookConfigured(target) &&
    isContextFocusHookConfigured(target) &&
    isPracticalFocusHookConfigured(target) &&
    isTaskDriftHookConfigured(target)
  );
}

export function areCostControlHooksConfigured(target: string): boolean {
  return isSessionSizeHookConfigured(target) && isBudgetHookConfigured(target);
}

/** True when any Claude UserPromptSubmit cost-control hook is registered. */
export function costControlHooksActive(target: string): boolean {
  return (
    isSessionSizeHookConfigured(target) ||
    isBudgetHookConfigured(target) ||
    isContextFocusHookConfigured(target) ||
    isPracticalFocusHookConfigured(target) ||
    isTaskDriftHookConfigured(target)
  );
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
  HOOK_PLATFORM_FILENAME,
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

interface CostControlPromptHookSpec {
  scriptFile: string;
  marker: string;
  displayName: string;
  kiroHookFile: string;
  copilotHookFile: string;
  needsUsageParse: boolean;
}

const COST_CONTROL_PROMPT_HOOK_SPECS: CostControlPromptHookSpec[] = [
  {
    scriptFile: SESSION_HOOK_FILENAME,
    marker: SESSION_SIZE_HOOK_MARKER,
    displayName: "session size watch",
    kiroHookFile: KIRO_SESSION_SIZE_HOOK_FILE,
    copilotHookFile: COPILOT_SESSION_SIZE_HOOK_FILE,
    needsUsageParse: true,
  },
  {
    scriptFile: BUDGET_HOOK_FILENAME,
    marker: BUDGET_HOOK_MARKER,
    displayName: "budget watch",
    kiroHookFile: KIRO_BUDGET_HOOK_FILE,
    copilotHookFile: COPILOT_BUDGET_HOOK_FILE,
    needsUsageParse: true,
  },
  {
    scriptFile: CONTEXT_FOCUS_HOOK_FILENAME,
    marker: CONTEXT_FOCUS_HOOK_MARKER,
    displayName: "context focus watch",
    kiroHookFile: KIRO_CONTEXT_FOCUS_HOOK_FILE,
    copilotHookFile: COPILOT_CONTEXT_FOCUS_HOOK_FILE,
    needsUsageParse: false,
  },
  {
    scriptFile: PRACTICAL_FOCUS_HOOK_FILENAME,
    marker: PRACTICAL_FOCUS_HOOK_MARKER,
    displayName: "practical focus watch",
    kiroHookFile: KIRO_PRACTICAL_FOCUS_HOOK_FILE,
    copilotHookFile: COPILOT_PRACTICAL_FOCUS_HOOK_FILE,
    needsUsageParse: false,
  },
  {
    scriptFile: TASK_DRIFT_HOOK_FILENAME,
    marker: TASK_DRIFT_HOOK_MARKER,
    displayName: "task drift re-proposal",
    kiroHookFile: KIRO_TASK_DRIFT_HOOK_FILE,
    copilotHookFile: COPILOT_TASK_DRIFT_HOOK_FILE,
    needsUsageParse: false,
  },
];

function agentPromptHookCommand(agent: "cursor" | "kiro" | "copilot", scriptFile: string): string {
  if (agent === "cursor") {
    return `node .cursor/hooks/${scriptFile} cursor`;
  }
  return `node .claude/hooks/${scriptFile} ${agent}`;
}

function copyCostControlHookScripts(extensionPath: string, target: string, spec: CostControlPromptHookSpec): void {
  const hooksSource = path.join(extensionPath, "resources", "hooks");
  const extras = [HOOK_PLATFORM_FILENAME, ...(spec.needsUsageParse ? [HOOK_HELPER_FILENAME] : [])];
  for (const dir of [path.join(target, ".claude", "hooks"), path.join(target, ".cursor", "hooks")]) {
    fs.mkdirSync(dir, { recursive: true });
    copyFileWithRetry(path.join(hooksSource, spec.scriptFile), path.join(dir, spec.scriptFile));
    for (const extra of extras) {
      copyFileWithRetry(path.join(hooksSource, extra), path.join(dir, extra));
    }
  }
}

function isCursorPromptHookConfigured(target: string, scriptFile: string): boolean {
  const hooksFile = path.join(target, ".cursor", "hooks.json");
  const raw = readJsonFile<CursorHooksFile>(hooksFile);
  if (!raw?.hooks?.beforeSubmitPrompt) {
    return false;
  }
  return raw.hooks.beforeSubmitPrompt.some((entry) => (entry.command ?? "").includes(scriptFile));
}

function installCursorPromptHook(
  extensionPath: string,
  target: string,
  spec: CostControlPromptHookSpec
): boolean {
  copyCostControlHookScripts(extensionPath, target, spec);
  const hooksFile = path.join(target, ".cursor", "hooks.json");
  const existing = readJsonFile<CursorHooksFile>(hooksFile) ?? { version: 1, hooks: {} };
  existing.version = 1;
  existing.hooks = existing.hooks ?? {};
  const entries = existing.hooks.beforeSubmitPrompt ?? [];
  const desired = {
    command: agentPromptHookCommand("cursor", spec.scriptFile),
    timeout: 8,
  };
  const idx = entries.findIndex((e) => (e.command ?? "").includes(spec.scriptFile));
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

function kiroPromptHookPayload(spec: CostControlPromptHookSpec): KiroHookFile {
  return {
    name: `Claude Skills — ${spec.displayName}`,
    description: `Managed by Claude Skills Manager (${spec.marker})`,
    version: "1",
    enabled: true,
    when: { type: KIRO_WHEN_PROMPT_SUBMIT },
    then: {
      type: "runCommand",
      command: agentPromptHookCommand("kiro", spec.scriptFile),
      timeout: 8,
    },
  };
}

function isKiroPromptHookConfigured(target: string, spec: CostControlPromptHookSpec): boolean {
  const hookPath = path.join(target, ".kiro", "hooks", spec.kiroHookFile);
  const existing = readJsonFile<KiroHookFile>(hookPath);
  return Boolean(existing?.description?.includes(spec.marker));
}

function installKiroPromptHook(extensionPath: string, target: string, spec: CostControlPromptHookSpec): boolean {
  copyCostControlHookScripts(extensionPath, target, spec);
  const hookPath = path.join(target, ".kiro", "hooks", spec.kiroHookFile);
  const desired = kiroPromptHookPayload(spec);
  const existing = readJsonFile<KiroHookFile>(hookPath);
  if (existing?.description?.includes(spec.marker) && JSON.stringify(existing) === JSON.stringify(desired)) {
    return false;
  }
  writeJsonFile(hookPath, desired);
  return true;
}

function copilotPromptHookPayload(spec: CostControlPromptHookSpec): CopilotHooksFile {
  const cmd = agentPromptHookCommand("copilot", spec.scriptFile);
  const command = {
    type: "command" as const,
    bash: cmd,
    powershell: cmd,
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

function isCopilotPromptHookConfigured(target: string, spec: CostControlPromptHookSpec): boolean {
  const hookPath = path.join(target, ".github", "hooks", spec.copilotHookFile);
  const existing = readJsonFile<CopilotHooksFile>(hookPath);
  return Boolean(existing?.hooks?.UserPromptSubmit?.some((h) => (h.bash ?? "").includes(spec.scriptFile)));
}

function installCopilotPromptHook(extensionPath: string, target: string, spec: CostControlPromptHookSpec): boolean {
  copyCostControlHookScripts(extensionPath, target, spec);
  const hookPath = path.join(target, ".github", "hooks", spec.copilotHookFile);
  const desired = copilotPromptHookPayload(spec);
  const existing = readJsonFile<CopilotHooksFile>(hookPath);
  if (existing && JSON.stringify(existing) === JSON.stringify(desired)) {
    return false;
  }
  writeJsonFile(hookPath, desired);
  return true;
}

function workspaceHookTargetAgents(libraryDir: string): AgentId[] {
  return workspaceMirrorAgentIds(libraryDir);
}

function agentPromptHookConfigured(target: string, libraryDir: string, scriptFile: string): boolean {
  const spec = COST_CONTROL_PROMPT_HOOK_SPECS.find((s) => s.scriptFile === scriptFile);
  if (!spec) {
    return true;
  }
  const agents = workspaceHookTargetAgents(libraryDir);
  const cursorOk = !agents.includes("cursor") || isCursorPromptHookConfigured(target, scriptFile);
  const kiroOk = !agents.includes("kiro") || isKiroPromptHookConfigured(target, spec);
  const copilotOk = !agents.includes("copilot") || isCopilotPromptHookConfigured(target, spec);
  return cursorOk && kiroOk && copilotOk;
}

/** Cost-control prompt hooks for Cursor, Kiro, and Copilot (Claude uses UserPromptSubmit in settings.json). */
function installAgentCostControlPromptHooks(extensionPath: string, target: string, libraryDir: string): boolean {
  const agents = workspaceHookTargetAgents(libraryDir);
  let changed = false;
  for (const spec of COST_CONTROL_PROMPT_HOOK_SPECS) {
    if (agents.includes("cursor")) {
      changed = installCursorPromptHook(extensionPath, target, spec) || changed;
    }
    if (agents.includes("kiro")) {
      changed = installKiroPromptHook(extensionPath, target, spec) || changed;
    }
    if (agents.includes("copilot")) {
      changed = installCopilotPromptHook(extensionPath, target, spec) || changed;
    }
  }
  return changed;
}

function agentCostControlPromptHooksConfigured(target: string, libraryDir: string): boolean {
  return COST_CONTROL_PROMPT_HOOK_SPECS.every((spec) =>
    agentPromptHookConfigured(target, libraryDir, spec.scriptFile)
  );
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
    when: { type: KIRO_WHEN_SESSION_START },
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

function hasPreToolHook(settings: Settings, filename: string): boolean {
  const matchers = settings.hooks?.PreToolUse ?? [];
  return matchers.some((m) => m.hooks.some((h) => h.command.includes(filename)));
}

function ensurePreToolHookRegistered(settings: Settings, matcher: string, filename: string, command: string): boolean {
  settings.hooks = settings.hooks ?? {};
  settings.hooks.PreToolUse = settings.hooks.PreToolUse ?? [];

  if (hasPreToolHook(settings, filename)) {
    return migrateAttributionPreToolMatcher(settings);
  }

  settings.hooks.PreToolUse.push({
    matcher,
    hooks: [{ type: "command", command, timeout: 8 }],
  });
  return true;
}

function migrateAttributionPreToolMatcher(settings: Settings): boolean {
  let changed = false;
  for (const matcher of settings.hooks?.PreToolUse ?? []) {
    const usesHook = matcher.hooks.some((h) => h.command.includes(SKILL_INVOKE_HOOK_FILENAME));
    if (usesHook && matcher.matcher !== ATTRIBUTION_HOOK_MATCHER) {
      matcher.matcher = ATTRIBUTION_HOOK_MATCHER;
      changed = true;
    }
  }
  return changed;
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
  const addedPost = ensurePostToolHookRegistered(
    settings,
    ATTRIBUTION_HOOK_MATCHER,
    SKILL_INVOKE_HOOK_FILENAME,
    CLAUDE_SKILL_INVOKE_COMMAND
  );
  const addedPre = ensurePreToolHookRegistered(
    settings,
    ATTRIBUTION_HOOK_MATCHER,
    SKILL_INVOKE_HOOK_FILENAME,
    CLAUDE_SKILL_INVOKE_COMMAND
  );
  const migratedPost = migrateAttributionHookMatcher(settings);
  const migratedPre = migrateAttributionPreToolMatcher(settings);
  if (addedPost || addedPre || migratedPost || migratedPre) {
    writeJsonFile(settingsFile, settings);
  }
  return addedPost || addedPre || migratedPost || migratedPre;
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
    installAgentCostControlPromptHooks(extensionPath, target, libraryDir);
    return installAttributionHooks(extensionPath, target);
  }

  if (hadSession && hadBudget && hadContextFocus && hadPracticalFocus && hadTaskDrift) {
    installAgentCostControlPromptHooks(extensionPath, target, libraryDir);
    return installAttributionHooks(extensionPath, target);
  }
  installAgentCostControlPromptHooks(extensionPath, target, libraryDir);
  return installAttributionHooks(extensionPath, target);
}

/** @deprecated Use installCostControlHooks */
export function installSessionWatchHook(extensionPath: string, target: string): HookInstallStatus {
  return installCostControlHooks(extensionPath, target);
}

/** Install skill-invoke hooks for all enabled agents (PostToolUse + Claude PreToolUse workaround). Idempotent. */
export function installAttributionHooks(extensionPath: string, target: string): HookInstallStatus {
  ensureLearningDir(target);
  refreshAttributionHookScripts(extensionPath, target);

  const libraryDir = libraryDirFromExtension(extensionPath);
  const manifest = loadAgentsManifest(libraryDir);
  const enabled = enabledAgents(libraryDir);
  const workspaceAgents = workspaceHookTargetAgents(libraryDir);

  let changed = false;
  let hadAny = false;

  if (enabled.includes("claude") && agentSupportsAttribution(manifest.agents.claude)) {
    hadAny = isClaudeAttributionHookConfigured(target) || hadAny;
    changed = installClaudeAttributionHook(extensionPath, target) || changed;
  }
  if (workspaceAgents.includes("cursor") && agentSupportsAttribution(manifest.agents.cursor)) {
    hadAny = isCursorAttributionHookConfigured(target) || hadAny;
    changed = installCursorAttributionHook(extensionPath, target) || changed;
  }
  if (workspaceAgents.includes("kiro") && agentSupportsAttribution(manifest.agents.kiro)) {
    hadAny = isKiroAttributionHookConfigured(target) || hadAny;
    changed = installKiroAttributionHook(extensionPath, target) || changed;
  }
  if (workspaceAgents.includes("copilot") && agentSupportsAttribution(manifest.agents.copilot)) {
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
  const workspaceAgents = lib ? workspaceHookTargetAgents(lib) : (["cursor", "kiro", "copilot"] as AgentId[]);
  const cursorEnabled = workspaceAgents.includes("cursor");
  const kiroEnabled = workspaceAgents.includes("kiro");
  const copilotEnabled = workspaceAgents.includes("copilot");
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
  const enabled = enabledAgents(lib);
  const workspaceAgents = workspaceHookTargetAgents(lib);

  copyHookFiles(extensionPath, path.join(target, ".claude", "hooks"));

  let changed = false;
  let hadAny = false;

  if (enabled.includes("claude")) {
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

  if (workspaceAgents.includes("cursor")) {
    const had = isCursorProfileInitHookConfigured(target);
    hadAny = hadAny || had;
    changed = installCursorProfileInitHook(extensionPath, target) || changed;
  }

  if (workspaceAgents.includes("kiro")) {
    const had = isKiroProfileInitHookConfigured(target);
    hadAny = hadAny || had;
    changed = installKiroProfileInitHook(extensionPath, target) || changed;
  }

  if (workspaceAgents.includes("copilot")) {
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
  installAgentCostControlPromptHooks(extensionPath, target, lib);
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
  /** Claude VS Code PostToolUse gap + PreToolUse workaround state. */
  claudeVscodeGap?: ClaudeVscodeAttributionGap;
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
      sessionSize:
        isSessionSizeHookConfigured(target) &&
        agentPromptHookConfigured(target, libraryDir, SESSION_HOOK_FILENAME),
      budget:
        isBudgetHookConfigured(target) && agentPromptHookConfigured(target, libraryDir, BUDGET_HOOK_FILENAME),
      contextFocus:
        isContextFocusHookConfigured(target) &&
        agentPromptHookConfigured(target, libraryDir, CONTEXT_FOCUS_HOOK_FILENAME),
      practicalFocus:
        isPracticalFocusHookConfigured(target) &&
        agentPromptHookConfigured(target, libraryDir, PRACTICAL_FOCUS_HOOK_FILENAME),
      configured:
        claudeCostControlHooksFullyConfigured(target) &&
        agentCostControlPromptHooksConfigured(target, libraryDir),
    },
    claudeVscodeGap: assessClaudeVscodeAttributionGap(target),
  };
}
