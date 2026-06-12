import * as fs from "node:fs";
import * as path from "node:path";
import { AgentId, enabledAgents, loadAgentsManifest } from "./agentOps";
import { ensureLearningDir } from "./usageStats";

const SESSION_HOOK_FILENAME = "session-size-watch.js";
const BUDGET_HOOK_FILENAME = "budget-watch.js";
const SKILL_INVOKE_HOOK_FILENAME = "skill-invoke-watch.js";
const OFFICIAL_SKILLS_HOOK_FILENAME = "official-skills-watch.js";
const HOOK_HELPER_FILENAME = "usageParse.js";

const ATTRIBUTION_HOOK_MARKER = "claude-skills-skill-invoke";
const KIRO_ATTRIBUTION_HOOK_FILE = `${ATTRIBUTION_HOOK_MARKER}.kiro.hook`;
const COPILOT_ATTRIBUTION_HOOK_FILE = `${ATTRIBUTION_HOOK_MARKER}.json`;

const SESSION_HOOK_COMMAND = `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/${SESSION_HOOK_FILENAME}"`;
const BUDGET_HOOK_COMMAND = `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/${BUDGET_HOOK_FILENAME}"`;
const CLAUDE_SKILL_INVOKE_COMMAND = `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/${SKILL_INVOKE_HOOK_FILENAME}" claude`;
const CURSOR_SKILL_INVOKE_COMMAND = `node .cursor/hooks/${SKILL_INVOKE_HOOK_FILENAME} cursor`;
const KIRO_SKILL_INVOKE_COMMAND = `node .claude/hooks/${SKILL_INVOKE_HOOK_FILENAME} kiro`;
const COPILOT_SKILL_INVOKE_COMMAND = `node .claude/hooks/${SKILL_INVOKE_HOOK_FILENAME} copilot`;
const OFFICIAL_SKILLS_HOOK_COMMAND = `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/${OFFICIAL_SKILLS_HOOK_FILENAME}"`;
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

function hasHook(settings: Settings, filename: string): boolean {
  const matchers = settings.hooks?.UserPromptSubmit ?? [];
  return matchers.some((m) => m.hooks.some((h) => h.command.includes(filename)));
}

const ALL_HOOK_FILES = [
  SESSION_HOOK_FILENAME,
  BUDGET_HOOK_FILENAME,
  SKILL_INVOKE_HOOK_FILENAME,
  OFFICIAL_SKILLS_HOOK_FILENAME,
  HOOK_HELPER_FILENAME,
];

function copyHookFiles(extensionPath: string, hooksDir: string): void {
  const hooksSource = path.join(extensionPath, "resources", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const name of ALL_HOOK_FILES) {
    fs.copyFileSync(path.join(hooksSource, name), path.join(hooksDir, name));
  }
}

function copyAttributionHookScript(extensionPath: string, hooksDir: string): void {
  const hooksSource = path.join(extensionPath, "resources", "hooks", SKILL_INVOKE_HOOK_FILENAME);
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.copyFileSync(hooksSource, path.join(hooksDir, SKILL_INVOKE_HOOK_FILENAME));
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

function agentSupportsAttribution(agent: { supportsAttributionHooks?: boolean }): boolean {
  return agent.supportsAttributionHooks !== false;
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
    writeJsonFile(settingsFile, settings);
    return installAttributionHooks(extensionPath, target);
  }

  if (hadSession && hadBudget) {
    return installAttributionHooks(extensionPath, target);
  }
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

/** Copy latest hook scripts into workspace agent hook directories. */
export function refreshCostControlHookScripts(extensionPath: string, target: string): void {
  copyHookFiles(extensionPath, path.join(target, ".claude", "hooks"));
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
      budget: isBudgetHookConfigured(target),
      configured: areCostControlHooksConfigured(target),
    },
  };
}
