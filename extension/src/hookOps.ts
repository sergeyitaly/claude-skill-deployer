import * as fs from "node:fs";
import * as path from "node:path";
import { AgentId, enabledAgents, loadAgentsManifest, workspaceMirrorAgentIds } from "./agentOps";
import { assessClaudeVscodeAttributionGap, ClaudeVscodeAttributionGap } from "./claudeVscodeAttributionGap";
import { ensureLearningDir } from "./usageStats";
import { hookBaseUrl } from "./hookServer";

// Legacy filenames — used only to detect and remove old JS-based hook commands during migration
const LEGACY_SESSION_HOOK = "session-size-watch.js";
const LEGACY_BUDGET_HOOK = "budget-watch.js";
const LEGACY_CONTEXT_FOCUS_HOOK = "context-focus-watch.js";
const LEGACY_PRACTICAL_FOCUS_HOOK = "practical-focus-watch.js";
const LEGACY_TASK_DRIFT_HOOK = "task-drift-watch.js";
const LEGACY_SKILL_INVOKE_HOOK = "skill-invoke-watch.js";
const LEGACY_OFFICIAL_SKILLS_HOOK = "official-skills-watch.js";
const LEGACY_PROFILE_INIT_HOOK = "profile-init-watch.js";

const ATTRIBUTION_HOOK_MARKER = "claude-skills-skill-invoke";
const KIRO_ATTRIBUTION_HOOK_FILE = `${ATTRIBUTION_HOOK_MARKER}.kiro.hook`;
const KIRO_PROFILE_INIT_HOOK_FILE = `${ATTRIBUTION_HOOK_MARKER}-profile-init.kiro.hook`;
const KIRO_TASK_DRIFT_HOOK_FILE = "claude-skills-task-drift.kiro.hook";
const KIRO_BUDGET_HOOK_FILE = "claude-skills-budget.kiro.hook";
/** Kiro `.kiro.hook` schema: when.type must be promptSubmit (not userPromptSubmit). */
const KIRO_WHEN_PROMPT_SUBMIT = "promptSubmit";
/** Kiro session-start hooks use sessionStart (not agentSpawn). */
const KIRO_WHEN_SESSION_START = "sessionStart";
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
const COPILOT_PROFILE_INIT_HOOK_FILE = `${ATTRIBUTION_HOOK_MARKER}-profile-init.json`;

const OFFICIAL_SKILLS_SESSION_MATCHER = "startup|resume|clear";
const ATTRIBUTION_HOOK_MATCHER = "Skill|Read|read|fs_read|fileread";

// Hook name → URL path segments used to detect and generate curl commands
const HOOK_SKILL_INVOKE = "skill-invoke";
const HOOK_SESSION_SIZE = "session-size";
const HOOK_BUDGET = "budget";
const HOOK_CONTEXT_FOCUS = "context-focus";
const HOOK_PRACTICAL_FOCUS = "practical-focus";
const HOOK_TASK_DRIFT = "task-drift";
const HOOK_OFFICIAL_SKILLS = "official-skills";
const HOOK_PROFILE_INIT = "profile-init";

/** curl command for Claude Code hooks (uses ${CLAUDE_PROJECT_DIR} shell variable). */
function claudeHookCmd(hookName: string): string {
  const base = hookBaseUrl();
  return `curl -sf -X POST -H "Content-Type: application/json" --data @- "${base}/hook/${hookName}?agent=claude&cwd=\${CLAUDE_PROJECT_DIR}" || true`;
}

/** curl command for Cursor/Kiro/Copilot hooks (workspace path baked in). */
function agentHookCmd(agent: string, hookName: string, target: string): string {
  const base = hookBaseUrl();
  const cwd = encodeURIComponent(target);
  return `curl -sf -X POST -H "Content-Type: application/json" --data @- "${base}/hook/${hookName}?agent=${agent}&cwd=${cwd}" || true`;
}

function powershellHookCommand(curlCommand: string): string {
  const matches = curlCommand.match(/"([^"]+)"/g) ?? [];
  const rawUri = matches.length > 0 ? matches[matches.length - 1].replace(/^"|"$/g, "") : curlCommand;
  const uri = rawUri.replace(/'/g, "''");
  return `$body = [Console]::In.ReadToEnd(); try { Invoke-WebRequest -UseBasicParsing -Uri '${uri}' -Method POST -Headers @{ 'Content-Type' = 'application/json' } -Body $body | Out-Null } catch { }`;
}

function copilotPowerShellCommand(curlCommand: string) {
  return {
    type: "command" as const,
    powershell: powershellHookCommand(curlCommand),
  };
}

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

// ── Detection helpers ────────────────────────────────────────────────────────

function hasHook(settings: Settings, hookName: string): boolean {
  const matchers = settings.hooks?.UserPromptSubmit ?? [];
  return matchers.some((m) => m.hooks.some((h) => h.command.includes(`/hook/${hookName}`)));
}

function hasPostToolHook(settings: Settings, hookName: string): boolean {
  const matchers = settings.hooks?.PostToolUse ?? [];
  return matchers.some((m) => m.hooks.some((h) => h.command.includes(`/hook/${hookName}`)));
}

function hasPreToolHook(settings: Settings, hookName: string): boolean {
  const matchers = settings.hooks?.PreToolUse ?? [];
  return matchers.some((m) => m.hooks.some((h) => h.command.includes(`/hook/${hookName}`)));
}

function hasSessionStartHook(settings: Settings, hookName: string): boolean {
  const matchers = settings.hooks?.SessionStart ?? [];
  return matchers.some((m) => m.hooks.some((h) => h.command.includes(`/hook/${hookName}`)));
}

export function isTaskDriftHookConfigured(target: string): boolean {
  try {
    const settings = readSettings(path.join(target, ".claude", "settings.json"));
    return hasHook(settings, HOOK_TASK_DRIFT);
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
    return hasHook(settings, HOOK_SESSION_SIZE);
  } catch {
    return false;
  }
}

export function isBudgetHookConfigured(target: string): boolean {
  try {
    const settings = readSettings(path.join(target, ".claude", "settings.json"));
    return hasHook(settings, HOOK_BUDGET);
  } catch {
    return false;
  }
}

export function isContextFocusHookConfigured(target: string): boolean {
  try {
    const settings = readSettings(path.join(target, ".claude", "settings.json"));
    return hasHook(settings, HOOK_CONTEXT_FOCUS);
  } catch {
    return false;
  }
}

export function isPracticalFocusHookConfigured(target: string): boolean {
  try {
    const settings = readSettings(path.join(target, ".claude", "settings.json"));
    return hasHook(settings, HOOK_PRACTICAL_FOCUS);
  } catch {
    return false;
  }
}

// ── Prompt hook spec ─────────────────────────────────────────────────────────

interface CostControlPromptHookSpec {
  hookName: string;       // URL path segment, e.g. "session-size"
  legacyFilename: string; // Old JS filename for migration cleanup
  marker: string;         // Description marker in Kiro/Copilot JSON files
  displayName: string;
  kiroHookFile: string;
  copilotHookFile: string;
}

const COST_CONTROL_PROMPT_HOOK_SPECS: CostControlPromptHookSpec[] = [
  {
    hookName: HOOK_SESSION_SIZE,
    legacyFilename: LEGACY_SESSION_HOOK,
    marker: SESSION_SIZE_HOOK_MARKER,
    displayName: "session size watch",
    kiroHookFile: KIRO_SESSION_SIZE_HOOK_FILE,
    copilotHookFile: COPILOT_SESSION_SIZE_HOOK_FILE,
  },
  {
    hookName: HOOK_BUDGET,
    legacyFilename: LEGACY_BUDGET_HOOK,
    marker: BUDGET_HOOK_MARKER,
    displayName: "budget watch",
    kiroHookFile: KIRO_BUDGET_HOOK_FILE,
    copilotHookFile: COPILOT_BUDGET_HOOK_FILE,
  },
  {
    hookName: HOOK_CONTEXT_FOCUS,
    legacyFilename: LEGACY_CONTEXT_FOCUS_HOOK,
    marker: CONTEXT_FOCUS_HOOK_MARKER,
    displayName: "context focus watch",
    kiroHookFile: KIRO_CONTEXT_FOCUS_HOOK_FILE,
    copilotHookFile: COPILOT_CONTEXT_FOCUS_HOOK_FILE,
  },
  {
    hookName: HOOK_PRACTICAL_FOCUS,
    legacyFilename: LEGACY_PRACTICAL_FOCUS_HOOK,
    marker: PRACTICAL_FOCUS_HOOK_MARKER,
    displayName: "practical focus watch",
    kiroHookFile: KIRO_PRACTICAL_FOCUS_HOOK_FILE,
    copilotHookFile: COPILOT_PRACTICAL_FOCUS_HOOK_FILE,
  },
  {
    hookName: HOOK_TASK_DRIFT,
    legacyFilename: LEGACY_TASK_DRIFT_HOOK,
    marker: TASK_DRIFT_HOOK_MARKER,
    displayName: "task drift re-proposal",
    kiroHookFile: KIRO_TASK_DRIFT_HOOK_FILE,
    copilotHookFile: COPILOT_TASK_DRIFT_HOOK_FILE,
  },
];

function agentPromptHookCommand(agent: "cursor" | "kiro" | "copilot", hookName: string, target: string): string {
  return agentHookCmd(agent, hookName, target);
}

// ── Cursor prompt hooks ──────────────────────────────────────────────────────

function isCursorPromptHookConfigured(target: string, hookName: string): boolean {
  const hooksFile = path.join(target, ".cursor", "hooks.json");
  const raw = readJsonFile<CursorHooksFile>(hooksFile);
  if (!raw?.hooks?.beforeSubmitPrompt) return false;
  return raw.hooks.beforeSubmitPrompt.some((entry) => (entry.command ?? "").includes(`/hook/${hookName}`));
}

function installCursorPromptHook(target: string, spec: CostControlPromptHookSpec): boolean {
  const hooksFile = path.join(target, ".cursor", "hooks.json");
  const existing = readJsonFile<CursorHooksFile>(hooksFile) ?? { version: 1, hooks: {} };
  existing.version = 1;
  existing.hooks = existing.hooks ?? {};
  const entries = (existing.hooks.beforeSubmitPrompt ?? []).filter(
    (e) => !(e.command ?? "").includes(spec.legacyFilename)
  );
  const desired = { command: agentPromptHookCommand("cursor", spec.hookName, target), timeout: 8 };
  const idx = entries.findIndex((e) => (e.command ?? "").includes(`/hook/${spec.hookName}`));
  if (idx >= 0) {
    const prev = entries[idx];
    if (prev.command === desired.command && prev.timeout === desired.timeout) {
      existing.hooks.beforeSubmitPrompt = entries;
      writeJsonFile(hooksFile, existing);
      return false;
    }
    entries[idx] = { ...prev, ...desired };
  } else {
    entries.push(desired);
  }
  existing.hooks.beforeSubmitPrompt = entries;
  writeJsonFile(hooksFile, existing);
  return true;
}

// ── Kiro prompt hooks ────────────────────────────────────────────────────────

function kiroPromptHookPayload(spec: CostControlPromptHookSpec, target: string): KiroHookFile {
  return {
    name: `Claude Skills — ${spec.displayName}`,
    description: `Managed by Claude Skills Manager (${spec.marker})`,
    version: "1",
    enabled: true,
    when: { type: KIRO_WHEN_PROMPT_SUBMIT },
    then: {
      type: "runCommand",
      command: agentPromptHookCommand("kiro", spec.hookName, target),
      timeout: 8,
    },
  };
}

function isKiroPromptHookConfigured(target: string, spec: CostControlPromptHookSpec): boolean {
  const hookPath = path.join(target, ".kiro", "hooks", spec.kiroHookFile);
  const existing = readJsonFile<KiroHookFile>(hookPath);
  return Boolean(existing?.description?.includes(spec.marker));
}

function installKiroPromptHook(target: string, spec: CostControlPromptHookSpec): boolean {
  const hookPath = path.join(target, ".kiro", "hooks", spec.kiroHookFile);
  const desired = kiroPromptHookPayload(spec, target);
  const existing = readJsonFile<KiroHookFile>(hookPath);
  if (existing?.description?.includes(spec.marker) && JSON.stringify(existing) === JSON.stringify(desired)) {
    return false;
  }
  writeJsonFile(hookPath, desired);
  return true;
}

// ── Copilot prompt hooks ─────────────────────────────────────────────────────

function copilotPromptHookPayload(spec: CostControlPromptHookSpec, target: string): CopilotHooksFile {
  const cmd = agentPromptHookCommand("copilot", spec.hookName, target);
  const command = {
    ...copilotPowerShellCommand(cmd),
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
  return Boolean(
    existing?.hooks?.UserPromptSubmit?.some((h) => (h.powershell ?? "").includes(`/hook/${spec.hookName}`))
  );
}

function installCopilotPromptHook(target: string, spec: CostControlPromptHookSpec): boolean {
  const hookPath = path.join(target, ".github", "hooks", spec.copilotHookFile);
  const desired = copilotPromptHookPayload(spec, target);
  const existing = readJsonFile<CopilotHooksFile>(hookPath);
  if (existing && JSON.stringify(existing) === JSON.stringify(desired)) return false;
  writeJsonFile(hookPath, desired);
  return true;
}

// ── Agent prompt hook orchestration ─────────────────────────────────────────

function workspaceHookTargetAgents(libraryDir: string): AgentId[] {
  return workspaceMirrorAgentIds(libraryDir);
}

function agentPromptHookConfigured(target: string, libraryDir: string, hookName: string): boolean {
  const spec = COST_CONTROL_PROMPT_HOOK_SPECS.find((s) => s.hookName === hookName);
  if (!spec) return true;
  const agents = workspaceHookTargetAgents(libraryDir);
  const cursorOk = !agents.includes("cursor") || isCursorPromptHookConfigured(target, hookName);
  const kiroOk = !agents.includes("kiro") || isKiroPromptHookConfigured(target, spec);
  const copilotOk = !agents.includes("copilot") || isCopilotPromptHookConfigured(target, spec);
  return cursorOk && kiroOk && copilotOk;
}

/** Cost-control prompt hooks for Cursor, Kiro, and Copilot (Claude uses UserPromptSubmit in settings.json). */
function installAgentCostControlPromptHooks(target: string, libraryDir: string): boolean {
  const agents = workspaceHookTargetAgents(libraryDir);
  let changed = false;
  for (const spec of COST_CONTROL_PROMPT_HOOK_SPECS) {
    if (agents.includes("cursor")) {
      changed = installCursorPromptHook(target, spec) || changed;
    }
    if (agents.includes("kiro")) {
      changed = installKiroPromptHook(target, spec) || changed;
    }
    if (agents.includes("copilot")) {
      changed = installCopilotPromptHook(target, spec) || changed;
    }
  }
  return changed;
}

function agentCostControlPromptHooksConfigured(target: string, libraryDir: string): boolean {
  return COST_CONTROL_PROMPT_HOOK_SPECS.every((spec) =>
    agentPromptHookConfigured(target, libraryDir, spec.hookName)
  );
}

// ── Profile-init hooks ───────────────────────────────────────────────────────

function isCursorProfileInitHookConfigured(target: string): boolean {
  const hooksFile = path.join(target, ".cursor", "hooks.json");
  const raw = readJsonFile<CursorHooksFile>(hooksFile);
  if (!raw?.hooks?.sessionStart) return false;
  return raw.hooks.sessionStart.some((entry) => (entry.command ?? "").includes(`/hook/${HOOK_PROFILE_INIT}`));
}

function installCursorProfileInitHook(target: string): boolean {
  const hooksFile = path.join(target, ".cursor", "hooks.json");
  const existing = readJsonFile<CursorHooksFile>(hooksFile) ?? { version: 1, hooks: {} };
  existing.version = 1;
  existing.hooks = existing.hooks ?? {};
  const entries = (existing.hooks.sessionStart ?? []).filter(
    (e) => !(e.command ?? "").includes(LEGACY_PROFILE_INIT_HOOK)
  );
  const desired = { command: agentHookCmd("cursor", HOOK_PROFILE_INIT, target), timeout: 20 };
  const idx = entries.findIndex((e) => (e.command ?? "").includes(`/hook/${HOOK_PROFILE_INIT}`));
  if (idx >= 0) {
    const prev = entries[idx];
    if (prev.command === desired.command && prev.timeout === desired.timeout) {
      existing.hooks.sessionStart = entries;
      writeJsonFile(hooksFile, existing);
      return false;
    }
    entries[idx] = { ...prev, ...desired };
  } else {
    entries.push(desired);
  }
  existing.hooks.sessionStart = entries;
  writeJsonFile(hooksFile, existing);
  return true;
}

function isKiroProfileInitHookConfigured(target: string): boolean {
  const hookPath = path.join(target, ".kiro", "hooks", KIRO_PROFILE_INIT_HOOK_FILE);
  const existing = readJsonFile<KiroHookFile>(hookPath);
  return Boolean(existing?.description?.includes(PROFILE_INIT_HOOK_MARKER));
}

function kiroProfileInitHookPayload(target: string): KiroHookFile {
  return {
    name: "Claude Skills — profile init & session skill adaptation",
    description: `Managed by Claude Skills Manager (${PROFILE_INIT_HOOK_MARKER})`,
    version: "1",
    enabled: true,
    when: { type: KIRO_WHEN_SESSION_START },
    then: {
      type: "runCommand",
      command: agentHookCmd("kiro", HOOK_PROFILE_INIT, target),
      timeout: 20,
    },
  };
}

function installKiroProfileInitHook(target: string): boolean {
  const hookPath = path.join(target, ".kiro", "hooks", KIRO_PROFILE_INIT_HOOK_FILE);
  const desired = kiroProfileInitHookPayload(target);
  const existing = readJsonFile<KiroHookFile>(hookPath);
  if (existing?.description?.includes(PROFILE_INIT_HOOK_MARKER)) {
    if (JSON.stringify(existing) === JSON.stringify(desired)) return false;
  }
  writeJsonFile(hookPath, desired);
  return true;
}

function copilotProfileInitHookPayload(target: string): CopilotHooksFile {
  const cmd = agentHookCmd("copilot", HOOK_PROFILE_INIT, target);
  const command = {
    ...copilotPowerShellCommand(cmd),
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

function isCopilotProfileInitHookConfigured(target: string): boolean {
  const hookPath = path.join(target, ".github", "hooks", COPILOT_PROFILE_INIT_HOOK_FILE);
  if (!fs.existsSync(hookPath)) return false;
  const raw = readJsonFile<CopilotHooksFile>(hookPath);
  const entries = raw?.hooks?.SessionStart ?? raw?.hooks?.sessionStart ?? [];
  return entries.some((entry) => (entry.powershell ?? "").includes(`/hook/${HOOK_PROFILE_INIT}`));
}

function installCopilotProfileInitHook(target: string): boolean {
  const hookPath = path.join(target, ".github", "hooks", COPILOT_PROFILE_INIT_HOOK_FILE);
  const desired = copilotProfileInitHookPayload(target);
  const existing = readJsonFile<CopilotHooksFile>(hookPath);
  if (existing && JSON.stringify(existing) === JSON.stringify(desired)) return false;
  writeJsonFile(hookPath, desired);
  return true;
}

// ── Claude settings.json hook registration ───────────────────────────────────

function migrateAttributionPreToolMatcher(settings: Settings): boolean {
  let changed = false;
  for (const matcher of settings.hooks?.PreToolUse ?? []) {
    const usesHook = matcher.hooks.some((h) => h.command.includes(`/hook/${HOOK_SKILL_INVOKE}`));
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
    const usesHook = matcher.hooks.some((h) => h.command.includes(`/hook/${HOOK_SKILL_INVOKE}`));
    if (usesHook && matcher.matcher !== ATTRIBUTION_HOOK_MATCHER) {
      matcher.matcher = ATTRIBUTION_HOOK_MATCHER;
      changed = true;
    }
  }
  return changed;
}

function ensureHookRegistered(settings: Settings, legacyFilename: string, hookName: string, command: string): boolean {
  settings.hooks = settings.hooks ?? {};
  settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit ?? [];

  let removedLegacy = false;
  settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit.filter((m) => {
    const hasLegacy = m.hooks.some((h) => h.command.includes(legacyFilename));
    if (hasLegacy) { removedLegacy = true; return false; }
    return true;
  });

  if (hasHook(settings, hookName)) return removedLegacy;

  settings.hooks.UserPromptSubmit.push({
    matcher: "",
    hooks: [{ type: "command", command, timeout: 8 }],
  });
  return true;
}

function ensurePostToolHookRegistered(
  settings: Settings,
  matcher: string,
  legacyFilename: string,
  hookName: string,
  command: string
): boolean {
  settings.hooks = settings.hooks ?? {};
  settings.hooks.PostToolUse = settings.hooks.PostToolUse ?? [];

  let removedLegacy = false;
  settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter((m) => {
    const hasLegacy = m.hooks.some((h) => h.command.includes(legacyFilename));
    if (hasLegacy) { removedLegacy = true; return false; }
    return true;
  });

  if (hasPostToolHook(settings, hookName)) {
    return removedLegacy || migrateAttributionHookMatcher(settings);
  }

  settings.hooks.PostToolUse.push({
    matcher,
    hooks: [{ type: "command", command, timeout: 8 }],
  });
  return true;
}

function ensurePreToolHookRegistered(
  settings: Settings,
  matcher: string,
  legacyFilename: string,
  hookName: string,
  command: string
): boolean {
  settings.hooks = settings.hooks ?? {};
  settings.hooks.PreToolUse = settings.hooks.PreToolUse ?? [];

  let removedLegacy = false;
  settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((m) => {
    const hasLegacy = m.hooks.some((h) => h.command.includes(legacyFilename));
    if (hasLegacy) { removedLegacy = true; return false; }
    return true;
  });

  if (hasPreToolHook(settings, hookName)) {
    return removedLegacy || migrateAttributionPreToolMatcher(settings);
  }

  settings.hooks.PreToolUse.push({
    matcher,
    hooks: [{ type: "command", command, timeout: 8 }],
  });
  return true;
}

function ensureSessionStartHookRegistered(
  settings: Settings,
  matcher: string,
  legacyFilename: string,
  hookName: string,
  command: string
): boolean {
  settings.hooks = settings.hooks ?? {};
  settings.hooks.SessionStart = settings.hooks.SessionStart ?? [];

  let removedLegacy = false;
  settings.hooks.SessionStart = settings.hooks.SessionStart.filter((m) => {
    const hasLegacy = m.hooks.some((h) => h.command.includes(legacyFilename));
    if (hasLegacy) { removedLegacy = true; return false; }
    return true;
  });

  for (const entry of settings.hooks.SessionStart) {
    if (entry.hooks.some((h) => h.command.includes(`/hook/${hookName}`))) {
      if (entry.matcher !== matcher) {
        entry.matcher = matcher;
        return true;
      }
      return removedLegacy;
    }
  }

  settings.hooks.SessionStart.push({
    matcher,
    hooks: [{ type: "command", command, timeout: 20 }],
  });
  return true;
}

// ── Attribution hook detection ───────────────────────────────────────────────

function isClaudeAttributionHookConfigured(target: string): boolean {
  try {
    const settings = readSettings(path.join(target, ".claude", "settings.json"));
    return hasPostToolHook(settings, HOOK_SKILL_INVOKE);
  } catch {
    return false;
  }
}

function isCursorAttributionHookConfigured(target: string): boolean {
  const hooksFile = path.join(target, ".cursor", "hooks.json");
  const raw = readJsonFile<CursorHooksFile>(hooksFile);
  if (!raw?.hooks?.postToolUse) return false;
  return raw.hooks.postToolUse.some((entry) => (entry.command ?? "").includes(`/hook/${HOOK_SKILL_INVOKE}`));
}

function isKiroAttributionHookConfigured(target: string): boolean {
  return fs.existsSync(path.join(target, ".kiro", "hooks", KIRO_ATTRIBUTION_HOOK_FILE));
}

function isCopilotAttributionHookConfigured(target: string): boolean {
  const hookPath = path.join(target, ".github", "hooks", COPILOT_ATTRIBUTION_HOOK_FILE);
  const existing = readJsonFile<CopilotHooksFile>(hookPath);
  return Boolean(
    existing?.hooks?.postToolUse?.some((h) => (h.powershell ?? "").includes(`/hook/${HOOK_SKILL_INVOKE}`))
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
    if (!agentSupportsAttribution(agent)) continue;
    if (agentId === "claude" && !isClaudeAttributionHookConfigured(target)) return false;
    if (agentId === "cursor" && !isCursorAttributionHookConfigured(target)) return false;
    if (agentId === "kiro" && !isKiroAttributionHookConfigured(target)) return false;
    if (agentId === "copilot" && !isCopilotAttributionHookConfigured(target)) return false;
  }
  return true;
}

// ── Attribution hook install ─────────────────────────────────────────────────

function installClaudeAttributionHook(target: string): boolean {
  const settingsFile = path.join(target, ".claude", "settings.json");
  const settings = readSettings(settingsFile);
  const cmd = claudeHookCmd(HOOK_SKILL_INVOKE);
  const addedPost = ensurePostToolHookRegistered(
    settings,
    ATTRIBUTION_HOOK_MATCHER,
    LEGACY_SKILL_INVOKE_HOOK,
    HOOK_SKILL_INVOKE,
    cmd
  );
  const addedPre = ensurePreToolHookRegistered(
    settings,
    ATTRIBUTION_HOOK_MATCHER,
    LEGACY_SKILL_INVOKE_HOOK,
    HOOK_SKILL_INVOKE,
    cmd
  );
  const migratedPost = migrateAttributionHookMatcher(settings);
  const migratedPre = migrateAttributionPreToolMatcher(settings);
  if (addedPost || addedPre || migratedPost || migratedPre) {
    writeJsonFile(settingsFile, settings);
  }
  return addedPost || addedPre || migratedPost || migratedPre;
}

function installCursorAttributionHook(target: string): boolean {
  const hooksFile = path.join(target, ".cursor", "hooks.json");
  const existing = readJsonFile<CursorHooksFile>(hooksFile) ?? { version: 1, hooks: {} };
  existing.version = 1;
  existing.hooks = existing.hooks ?? {};
  const entries = (existing.hooks.postToolUse ?? []).filter(
    (e) => !(e.command ?? "").includes(LEGACY_SKILL_INVOKE_HOOK)
  );
  const desired = {
    command: agentHookCmd("cursor", HOOK_SKILL_INVOKE, target),
    matcher: ATTRIBUTION_HOOK_MATCHER,
    timeout: 8,
  };
  const idx = entries.findIndex((e) => (e.command ?? "").includes(`/hook/${HOOK_SKILL_INVOKE}`));
  if (idx >= 0) {
    const prev = entries[idx];
    if (prev.command === desired.command && prev.matcher === desired.matcher) {
      existing.hooks.postToolUse = entries;
      writeJsonFile(hooksFile, existing);
      return false;
    }
    entries[idx] = { ...prev, ...desired };
  } else {
    entries.push(desired);
  }
  existing.hooks.postToolUse = entries;
  writeJsonFile(hooksFile, existing);
  return true;
}

function kiroAttributionHookPayload(target: string): KiroHookFile {
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
      command: agentHookCmd("kiro", HOOK_SKILL_INVOKE, target),
      timeout: 8,
    },
  };
}

function installKiroAttributionHook(target: string): boolean {
  const hookPath = path.join(target, ".kiro", "hooks", KIRO_ATTRIBUTION_HOOK_FILE);
  const desired = kiroAttributionHookPayload(target);
  const existing = readJsonFile<KiroHookFile>(hookPath);
  if (existing && existing.description.includes(ATTRIBUTION_HOOK_MARKER)) {
    if (JSON.stringify(existing) === JSON.stringify(desired)) return false;
  }
  writeJsonFile(hookPath, desired);
  return true;
}

function copilotAttributionHookPayload(target: string): CopilotHooksFile {
  const cmd = agentHookCmd("copilot", HOOK_SKILL_INVOKE, target);
  return {
    version: 1,
    hooks: {
      postToolUse: [
        {
          ...copilotPowerShellCommand(cmd),
          matcher: ATTRIBUTION_HOOK_MATCHER,
        },
      ],
    },
  };
}

function installCopilotAttributionHook(target: string): boolean {
  const hookPath = path.join(target, ".github", "hooks", COPILOT_ATTRIBUTION_HOOK_FILE);
  const desired = copilotAttributionHookPayload(target);
  const existing = readJsonFile<CopilotHooksFile>(hookPath);
  if (existing && JSON.stringify(existing) === JSON.stringify(desired)) return false;
  writeJsonFile(hookPath, desired);
  return true;
}

function agentSupportsAttribution(agent: { supportsAttributionHooks?: boolean }): boolean {
  return agent.supportsAttributionHooks !== false;
}

// ── Public install functions ──────────────────────────────────────────────────

/** Registers session-size, budget, context-focus, practical-focus, and task-drift
 * UserPromptSubmit hooks in <target>/.claude/settings.json plus equivalent hooks
 * for Cursor, Kiro, and Copilot. Idempotent; migrates legacy JS entries. */
export function installCostControlHooks(extensionPath: string, target: string): HookInstallStatus {
  ensureLearningDir(target);
  const libraryDir = libraryDirFromExtension(extensionPath);
  const settingsFile = path.join(target, ".claude", "settings.json");
  const settings = readSettings(settingsFile);

  const addedSession = ensureHookRegistered(settings, LEGACY_SESSION_HOOK, HOOK_SESSION_SIZE, claudeHookCmd(HOOK_SESSION_SIZE));
  const addedBudget = ensureHookRegistered(settings, LEGACY_BUDGET_HOOK, HOOK_BUDGET, claudeHookCmd(HOOK_BUDGET));
  const addedContextFocus = ensureHookRegistered(settings, LEGACY_CONTEXT_FOCUS_HOOK, HOOK_CONTEXT_FOCUS, claudeHookCmd(HOOK_CONTEXT_FOCUS));
  const addedPracticalFocus = ensureHookRegistered(settings, LEGACY_PRACTICAL_FOCUS_HOOK, HOOK_PRACTICAL_FOCUS, claudeHookCmd(HOOK_PRACTICAL_FOCUS));
  const addedTaskDrift = ensureHookRegistered(settings, LEGACY_TASK_DRIFT_HOOK, HOOK_TASK_DRIFT, claudeHookCmd(HOOK_TASK_DRIFT));

  if (addedSession || addedBudget || addedContextFocus || addedPracticalFocus || addedTaskDrift) {
    writeJsonFile(settingsFile, settings);
  }

  installAgentCostControlPromptHooks(target, libraryDir);
  return installAttributionHooks(extensionPath, target);
}

/** @deprecated Use installCostControlHooks */
export function installSessionWatchHook(extensionPath: string, target: string): HookInstallStatus {
  return installCostControlHooks(extensionPath, target);
}

/** Install skill-invoke hooks for all enabled agents (PostToolUse + Claude PreToolUse workaround). Idempotent. */
export function installAttributionHooks(extensionPath: string, target: string): HookInstallStatus {
  ensureLearningDir(target);

  const libraryDir = libraryDirFromExtension(extensionPath);
  const manifest = loadAgentsManifest(libraryDir);
  const enabled = enabledAgents(libraryDir);
  const workspaceAgents = workspaceHookTargetAgents(libraryDir);

  let changed = false;
  let hadAny = false;

  if (enabled.includes("claude") && agentSupportsAttribution(manifest.agents.claude)) {
    hadAny = isClaudeAttributionHookConfigured(target) || hadAny;
    changed = installClaudeAttributionHook(target) || changed;
  }
  if (workspaceAgents.includes("cursor") && agentSupportsAttribution(manifest.agents.cursor)) {
    hadAny = isCursorAttributionHookConfigured(target) || hadAny;
    changed = installCursorAttributionHook(target) || changed;
  }
  if (workspaceAgents.includes("kiro") && agentSupportsAttribution(manifest.agents.kiro)) {
    hadAny = isKiroAttributionHookConfigured(target) || hadAny;
    changed = installKiroAttributionHook(target) || changed;
  }
  if (workspaceAgents.includes("copilot") && agentSupportsAttribution(manifest.agents.copilot)) {
    hadAny = isCopilotAttributionHookConfigured(target) || hadAny;
    changed = installCopilotAttributionHook(target) || changed;
  }

  if (changed) return hadAny ? "updated" : "installed";
  return hadAny ? "already-configured" : "updated";
}

export function areOfficialSkillsHooksConfigured(target: string): boolean {
  try {
    const settings = readSettings(path.join(target, ".claude", "settings.json"));
    return hasSessionStartHook(settings, HOOK_OFFICIAL_SKILLS);
  } catch {
    return false;
  }
}

/** SessionStart hook: check anthropics/skills and inject skill-official-updater context. */
export function installOfficialSkillsSessionHook(extensionPath: string, target: string): HookInstallStatus {
  ensureLearningDir(target);
  const settingsFile = path.join(target, ".claude", "settings.json");
  const settings = readSettings(settingsFile);
  const had = hasSessionStartHook(settings, HOOK_OFFICIAL_SKILLS);

  const added = ensureSessionStartHookRegistered(
    settings,
    OFFICIAL_SKILLS_SESSION_MATCHER,
    LEGACY_OFFICIAL_SKILLS_HOOK,
    HOOK_OFFICIAL_SKILLS,
    claudeHookCmd(HOOK_OFFICIAL_SKILLS)
  );

  if (added) {
    writeJsonFile(settingsFile, settings);
    return had ? "updated" : "installed";
  }
  return had ? "already-configured" : "updated";
}

// ── MCP-force hooks ──────────────────────────────────────────────────────────

const HOOK_MCP_FORCE = "mcp-force";
const HOOK_MCP_GATE = "mcp-gate";

// ── CLI loop-guard hook ───────────────────────────────────────────────────────

const HOOK_CLI_LOOP_GUARD = "cli-loop-guard";
const CLI_LOOP_GUARD_MATCHER = "mcp__claude-skills-cli__run_command";

export function isCliLoopGuardConfigured(target: string): boolean {
  try {
    const settings = readSettings(path.join(target, ".claude", "settings.json"));
    return hasPostToolHook(settings, HOOK_CLI_LOOP_GUARD);
  } catch {
    return false;
  }
}

export function installCliLoopGuardHook(target: string): HookInstallStatus {
  ensureLearningDir(target);
  const settingsFile = path.join(target, ".claude", "settings.json");
  const settings = readSettings(settingsFile);
  const had = hasPostToolHook(settings, HOOK_CLI_LOOP_GUARD);
  const added = ensurePostToolHookRegistered(
    settings,
    CLI_LOOP_GUARD_MATCHER,
    "",
    HOOK_CLI_LOOP_GUARD,
    claudeHookCmd(HOOK_CLI_LOOP_GUARD)
  );
  if (added) {
    writeJsonFile(settingsFile, settings);
    return had ? "updated" : "installed";
  }
  return "already-configured";
}

// ── Dir cache guard hook ──────────────────────────────────────────────────────

const HOOK_DIR_CACHE_GUARD = "dir-cache-guard";
const DIR_CACHE_GUARD_MATCHER = "mcp__filesystem__list_directory";

export function isDirCacheGuardConfigured(target: string): boolean {
  try {
    const settings = readSettings(path.join(target, ".claude", "settings.json"));
    return hasPreToolHook(settings, HOOK_DIR_CACHE_GUARD);
  } catch {
    return false;
  }
}

export function installDirCacheGuardHook(target: string): HookInstallStatus {
  ensureLearningDir(target);
  const settingsFile = path.join(target, ".claude", "settings.json");
  const settings = readSettings(settingsFile);
  const had = hasPreToolHook(settings, HOOK_DIR_CACHE_GUARD);
  const added = ensurePreToolHookRegistered(
    settings,
    DIR_CACHE_GUARD_MATCHER,
    "",
    HOOK_DIR_CACHE_GUARD,
    claudeHookCmd(HOOK_DIR_CACHE_GUARD)
  );
  if (added) {
    writeJsonFile(settingsFile, settings);
    return had ? "updated" : "installed";
  }
  return "already-configured";
}

// ── MCP error guard hook ──────────────────────────────────────────────────────

const HOOK_MCP_ERROR_GUARD = "mcp-error-guard";
const MCP_ERROR_GUARD_MATCHER = "mcp__filesystem__";

export function isMcpErrorGuardConfigured(target: string): boolean {
  try {
    const settings = readSettings(path.join(target, ".claude", "settings.json"));
    return hasPostToolHook(settings, HOOK_MCP_ERROR_GUARD);
  } catch {
    return false;
  }
}

export function installMcpErrorGuardHook(target: string): HookInstallStatus {
  ensureLearningDir(target);
  const settingsFile = path.join(target, ".claude", "settings.json");
  const settings = readSettings(settingsFile);
  const had = hasPostToolHook(settings, HOOK_MCP_ERROR_GUARD);
  const added = ensurePostToolHookRegistered(
    settings,
    MCP_ERROR_GUARD_MATCHER,
    "",
    HOOK_MCP_ERROR_GUARD,
    claudeHookCmd(HOOK_MCP_ERROR_GUARD)
  );
  if (added) {
    writeJsonFile(settingsFile, settings);
    return had ? "updated" : "installed";
  }
  return "already-configured";
}

export function removeMcpErrorGuardHook(target: string): boolean {
  const settingsFile = path.join(target, ".claude", "settings.json");
  const settings = readSettings(settingsFile);
  if (!settings.hooks?.PostToolUse) return false;
  const before = settings.hooks.PostToolUse.length;
  settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(
    (m) => !m.hooks.some((h) => h.command.includes(`/hook/${HOOK_MCP_ERROR_GUARD}`))
  );
  if (settings.hooks.PostToolUse.length !== before) {
    writeJsonFile(settingsFile, settings);
    return true;
  }
  return false;
}

export function removeDirCacheGuardHook(target: string): boolean {
  const settingsFile = path.join(target, ".claude", "settings.json");
  const settings = readSettings(settingsFile);
  if (!settings.hooks?.PreToolUse) return false;
  const before = settings.hooks.PreToolUse.length;
  settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
    (m) => !m.hooks.some((h) => h.command.includes(`/hook/${HOOK_DIR_CACHE_GUARD}`))
  );
  if (settings.hooks.PreToolUse.length !== before) {
    writeJsonFile(settingsFile, settings);
    return true;
  }
  return false;
}

export function removeCliLoopGuardHook(target: string): boolean {
  const settingsFile = path.join(target, ".claude", "settings.json");
  const settings = readSettings(settingsFile);
  if (!settings.hooks?.PostToolUse) return false;
  const before = settings.hooks.PostToolUse.length;
  settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(
    (m) => !m.hooks.some((h) => h.command.includes(`/hook/${HOOK_CLI_LOOP_GUARD}`))
  );
  if (settings.hooks.PostToolUse.length !== before) {
    writeJsonFile(settingsFile, settings);
    return true;
  }
  return false;
}

export function isMcpForceHookConfigured(target: string): boolean {
  try {
    const settings = readSettings(path.join(target, ".claude", "settings.json"));
    return hasHook(settings, HOOK_MCP_FORCE);
  } catch {
    return false;
  }
}

export function isMcpGateHookConfigured(target: string): boolean {
  try {
    const settings = readSettings(path.join(target, ".claude", "settings.json"));
    return hasSessionStartHook(settings, HOOK_MCP_GATE);
  } catch {
    return false;
  }
}

export function installMcpForceHook(target: string): HookInstallStatus {
  ensureLearningDir(target);
  const settingsFile = path.join(target, ".claude", "settings.json");
  const settings = readSettings(settingsFile);
  const had = hasHook(settings, HOOK_MCP_FORCE);
  const added = ensureHookRegistered(settings, "", HOOK_MCP_FORCE, claudeHookCmd(HOOK_MCP_FORCE));
  if (added) {
    writeJsonFile(settingsFile, settings);
    return had ? "updated" : "installed";
  }
  return "already-configured";
}

export function installMcpGateHook(target: string): HookInstallStatus {
  ensureLearningDir(target);
  const settingsFile = path.join(target, ".claude", "settings.json");
  const settings = readSettings(settingsFile);
  const had = hasSessionStartHook(settings, HOOK_MCP_GATE);
  const added = ensureSessionStartHookRegistered(
    settings,
    OFFICIAL_SKILLS_SESSION_MATCHER,
    "",
    HOOK_MCP_GATE,
    claudeHookCmd(HOOK_MCP_GATE)
  );
  if (added) {
    writeJsonFile(settingsFile, settings);
    return had ? "updated" : "installed";
  }
  return had ? "already-configured" : "updated";
}

export function removeMcpForceHooks(target: string): boolean {
  const settingsFile = path.join(target, ".claude", "settings.json");
  const settings = readSettings(settingsFile);
  let changed = false;

  if (settings.hooks?.UserPromptSubmit) {
    const before = settings.hooks.UserPromptSubmit.length;
    settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit.filter(
      (m) => !m.hooks.some((h) => h.command.includes(`/hook/${HOOK_MCP_FORCE}`))
    );
    changed = settings.hooks.UserPromptSubmit.length !== before || changed;
  }

  if (settings.hooks?.SessionStart) {
    const before = settings.hooks.SessionStart.length;
    settings.hooks.SessionStart = settings.hooks.SessionStart.filter(
      (m) => !m.hooks.some((h) => h.command.includes(`/hook/${HOOK_MCP_GATE}`))
    );
    changed = settings.hooks.SessionStart.length !== before || changed;
  }

  if (changed) {
    writeJsonFile(settingsFile, settings);
  }
  return changed;
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
    const claudeOk = !claudeEnabled || hasSessionStartHook(settings, HOOK_PROFILE_INIT);
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

  let changed = false;
  let hadAny = false;

  if (enabled.includes("claude")) {
    const settingsFile = path.join(target, ".claude", "settings.json");
    const settings = readSettings(settingsFile);
    const had = hasSessionStartHook(settings, HOOK_PROFILE_INIT);
    hadAny = hadAny || had;
    const added = ensureSessionStartHookRegistered(
      settings,
      OFFICIAL_SKILLS_SESSION_MATCHER,
      LEGACY_PROFILE_INIT_HOOK,
      HOOK_PROFILE_INIT,
      claudeHookCmd(HOOK_PROFILE_INIT)
    );
    if (added) {
      writeJsonFile(settingsFile, settings);
      changed = true;
    }
  }

  if (workspaceAgents.includes("cursor")) {
    const had = isCursorProfileInitHookConfigured(target);
    hadAny = hadAny || had;
    changed = installCursorProfileInitHook(target) || changed;
  }

  if (workspaceAgents.includes("kiro")) {
    const had = isKiroProfileInitHookConfigured(target);
    hadAny = hadAny || had;
    changed = installKiroProfileInitHook(target) || changed;
  }

  if (workspaceAgents.includes("copilot")) {
    const had = isCopilotProfileInitHookConfigured(target);
    hadAny = hadAny || had;
    changed = installCopilotProfileInitHook(target) || changed;
  }

  if (changed) return hadAny ? "updated" : "installed";
  return hadAny ? "already-configured" : "updated";
}

/** Re-apply curl commands for all cost-control hooks (idempotent). */
export function refreshCostControlHookScripts(
  extensionPath: string,
  target: string,
  libraryDir?: string
): void {
  const lib = libraryDir ?? libraryDirFromExtension(extensionPath);
  installAgentCostControlPromptHooks(target, lib);
}

/** No-op: attribution hooks are now curl-based and do not require file copying. */
export function refreshAttributionHookScripts(_extensionPath: string, _target: string): void {
  // intentionally empty
}

// ── Hook status reporting ─────────────────────────────────────────────────────

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
        agentPromptHookConfigured(target, libraryDir, HOOK_SESSION_SIZE),
      budget:
        isBudgetHookConfigured(target) &&
        agentPromptHookConfigured(target, libraryDir, HOOK_BUDGET),
      contextFocus:
        isContextFocusHookConfigured(target) &&
        agentPromptHookConfigured(target, libraryDir, HOOK_CONTEXT_FOCUS),
      practicalFocus:
        isPracticalFocusHookConfigured(target) &&
        agentPromptHookConfigured(target, libraryDir, HOOK_PRACTICAL_FOCUS),
      configured:
        claudeCostControlHooksFullyConfigured(target) &&
        agentCostControlPromptHooksConfigured(target, libraryDir),
    },
    claudeVscodeGap: assessClaudeVscodeAttributionGap(target),
  };
}
