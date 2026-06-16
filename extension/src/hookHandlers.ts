/**
 * HTTP hook handlers — TypeScript port of the JS hook scripts in resources/hooks/.
 * Called by hookServer.ts; no Node.js scripts are copied to agent directories.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendSkillRun, RunAgent } from "./runRecording";
import { readContextFocusConfig, effectiveContextFocusLevel, ContextFocusLevel } from "./contextFocusConfig";
import { readPracticalFocusConfig, PracticalFocusLevel } from "./practicalFocusConfig";
import { readBudgetConfig, readBudgetState, writeBudgetState, BudgetDayNotifications } from "./budgetConfig";
import { disableHighTierSkills } from "./budgetOps";
import { computeTodayCreditUsage } from "./usageCost";
import { formatTokenCount, readRunRecords } from "./usageStats";
import {
  checkOfficialSkillUpdates,
  workspaceUsesOfficialSkillUpdater,
  formatOfficialSkillsSessionContext,
  resolveSkillsLibraryDir,
} from "./officialSkillsSync";
import {
  processSessionSkillApplyRequest,
  resolveProposedSkillNamesWithSource,
  queueSessionSkillApplyRequest,
} from "./sessionSkillApply";
import { applyTaskSkillFocusFromProposals } from "./taskSkillFocus";
import { applyBranchProfile, getCurrentBranch, loadBranchProfile } from "./branchProfiles";
import { isFeatureEnabled } from "./featureFlags";

export interface HookRequest {
  hookName: string;
  agent: string;
  cwd: string;
  body: unknown;
}

type HookResponse = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Output formatting helpers
// ---------------------------------------------------------------------------

function formatUsd(n: number): string {
  if (n < 0.001) return "$0.00";
  if (n < 0.1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function promptOutput(content: string, agent: string): HookResponse {
  if (agent === "cursor" || agent === "kiro") {
    return { additional_context: content, additionalContext: content };
  }
  if (agent === "copilot") {
    return { hookSpecificOutput: content };
  }
  return { systemMessage: content };
}

function sessionStartOutput(content: string, agent: string): HookResponse {
  if (agent === "cursor" || agent === "kiro") {
    return { additional_context: content, additionalContext: content, continue: true };
  }
  if (agent === "copilot") {
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: content } };
  }
  return { systemMessage: content };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function readJsonSafe<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeJsonSafe(file: string, data: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf-8");
  } catch {
    /* non-fatal */
  }
}

function resolveSessionId(body: Record<string, unknown>, cwd: string): string {
  const raw =
    body.session_id ??
    body.sessionId ??
    body.conversation_id ??
    body.conversationId ??
    body.generation_id ??
    body.generationId;
  if (typeof raw === "string" && raw) return raw;
  const toolId = body.tool_use_id ?? body.toolUseId;
  if (typeof toolId === "string" && toolId) return `${cwd}|${toolId}`;
  return "";
}

// ---------------------------------------------------------------------------
// Handler: skill-invoke (PostToolUse / PreToolUse)
// ---------------------------------------------------------------------------

const SKILL_FILE_PATTERNS = [
  /[\\/](?:\.claude|\.cursor|\.kiro)[\\/]skills[\\/]([a-z][a-z0-9-]*)(?:[\\/]SKILL\.md)?/i,
  /[\\/]\.cursor[\\/]skills-cursor[\\/]([a-z][a-z0-9-]*)(?:[\\/]SKILL\.md)?/i,
  /[\\/]\.agents[\\/]skills[\\/]([a-z][a-z0-9-]*)(?:[\\/]SKILL\.md)?/i,
  /[\\/]skills_library[\\/]([a-z][a-z0-9-]*)(?:[\\/]SKILL\.md)?/i,
  /[\\/]\.github[\\/]instructions[\\/]([a-z][a-z0-9-]*)\.instructions\.md/i,
];

const SKILL_DENYLIST = new Set([
  "claude", "cursor", "api", "claude-api", "unknown", "base",
  "context", "skill", "skills", "kiro", "copilot",
]);

function plausibleSkillName(name: unknown): name is string {
  return typeof name === "string" && /^[a-z][a-z0-9-]{2,}$/.test(name) && !SKILL_DENYLIST.has(name);
}

function skillFromPath(filePath: string): string | null {
  for (const pattern of SKILL_FILE_PATTERNS) {
    const match = filePath.match(pattern);
    if (match && plausibleSkillName(match[1].toLowerCase())) return match[1].toLowerCase();
  }
  return null;
}

function collectToolPaths(toolInput: unknown): string[] {
  if (!toolInput || typeof toolInput !== "object") return [];
  const ti = toolInput as Record<string, unknown>;
  const paths: string[] = [];
  for (const k of ["path", "file_path", "filePath", "target_file", "targetFile"]) {
    if (typeof ti[k] === "string") paths.push(ti[k] as string);
  }
  if (Array.isArray(ti.operations)) {
    for (const op of ti.operations) {
      if (op && typeof op === "object" && typeof (op as Record<string, unknown>).path === "string") {
        paths.push((op as Record<string, unknown>).path as string);
      }
    }
  }
  return paths;
}

function extractSkillName(toolName: unknown, toolInput: unknown): string | null {
  const tool = String(toolName ?? "").trim().toLowerCase();
  if (tool === "skill" || tool === "useskill") {
    const ti = (toolInput && typeof toolInput === "object" ? toolInput : {}) as Record<string, unknown>;
    for (const k of ["skill", "skill_name", "name", "skillName", "skill_id", "skillId"]) {
      if (plausibleSkillName(ti[k])) return String(ti[k]).toLowerCase();
    }
  }
  if (["read", "fs_read", "fileread", "filereadtool", "readtool"].includes(tool)) {
    for (const p of collectToolPaths(toolInput)) {
      const skill = skillFromPath(p);
      if (skill) return skill;
    }
  }
  return null;
}

function estimateTokensFromBody(body: Record<string, unknown>): number {
  const usage = body.usage as Record<string, number> | null | undefined;
  if (usage && typeof usage === "object") {
    const total =
      (usage.input_tokens ?? 0) +
      (usage.output_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0);
    if (total > 0) return total;
  }
  const resp = body.tool_response ?? body.toolResult ?? body.tool_result;
  if (typeof resp === "string" && resp.length > 0) return Math.max(1, Math.round(resp.length / 4));
  return 0;
}

function handleSkillInvoke(req: HookRequest): HookResponse {
  const body = req.body as Record<string, unknown>;
  const cwd = req.cwd;
  const sessionId = resolveSessionId(body, cwd);
  if (!sessionId || !cwd) return {};

  const toolName = body.tool_name ?? body.toolName ?? "";
  const toolInput = body.tool_input ?? body.toolArgs ?? body.toolInput ?? {};
  const toolUseId = String(body.tool_use_id ?? body.toolUseId ?? "");

  const skill = extractSkillName(toolName, toolInput);
  if (!skill) return {};

  const stateFile = path.join(cwd, ".claude", "learning", "skill-invoke-state.json");
  const MAX_STATE_KEYS = 3000;
  const MAX_STATE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

  const key = `${sessionId}|${skill}|${toolUseId || "na"}`;
  let state: Record<string, string> = readJsonSafe<Record<string, string>>(stateFile) ?? {};
  if (state[key]) return {};

  const tokens = estimateTokensFromBody(body);
  const model = typeof body.model === "string" ? body.model : undefined;

  const activeSkillsFile = readJsonSafe<{ activeSkills?: unknown[] }>(
    path.join(cwd, ".claude", "learning", "task-active-skills.json")
  );
  const activeSet: Set<string> = activeSkillsFile?.activeSkills?.length
    ? new Set((activeSkillsFile.activeSkills as string[]).map((s) => String(s).toLowerCase()))
    : new Set();
  const notInActiveProfile = activeSet.size > 0 && !activeSet.has(skill);

  appendSkillRun(cwd, {
    skill,
    agent: req.agent as RunAgent,
    tokens,
    success: true,
    action: "skill_invoke",
    session_id: sessionId,
    metadata: {
      source: "skill-invoke-hook-v2",
      invoked: true,
      tool_name: String(toolName),
      tool_use_id: toolUseId || undefined,
      hook_agent: req.agent,
      model,
      ...(notInActiveProfile ? { not_in_active_profile: true } : {}),
    },
  });

  const now = new Date().toISOString();
  state[key] = now;
  const nowMs = Date.now();
  state = Object.fromEntries(
    Object.entries(state).filter(([, ts]) => {
      const t = Date.parse(ts);
      return !Number.isNaN(t) && nowMs - t < MAX_STATE_AGE_MS;
    })
  );
  if (Object.keys(state).length > MAX_STATE_KEYS) {
    const entries = Object.entries(state).sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]));
    state = Object.fromEntries(entries.slice(0, MAX_STATE_KEYS));
  }
  writeJsonSafe(stateFile, state);
  return {};
}

// ---------------------------------------------------------------------------
// Handler: session-size (UserPromptSubmit)
// ---------------------------------------------------------------------------

const WARN_BYTES = 4 * 1024 * 1024;
const CRITICAL_BYTES = 10 * 1024 * 1024;
const WARN_TOKENS = 100_000;
const CRITICAL_TOKENS = 200_000;
const PROJECTED_TOKEN_CEILING = 200_000;
const BLENDED_USD_PER_TOKEN = 0.000009;

type SizeLevel = "ok" | "warn" | "critical";
const LEVEL_RANK: Record<SizeLevel, number> = { ok: 0, warn: 1, critical: 2 };

function byteLevelFor(bytes: number): SizeLevel {
  if (bytes >= CRITICAL_BYTES) return "critical";
  if (bytes >= WARN_BYTES) return "warn";
  return "ok";
}

function tokenLevelFor(tokens: number): SizeLevel {
  if (tokens >= CRITICAL_TOKENS) return "critical";
  if (tokens >= WARN_TOKENS) return "warn";
  return "ok";
}

const MCP_OPTIMIZER_TIP =
  " For permanent context reduction across sessions: lazy-mcp (90%+ token cut via on-demand tool loading)," +
  " mcp-compressor from Atlassian Labs (70–97% schema compression for large MCP servers like GitHub/Jira)," +
  " or jmunch-mcp (efficient proxy for data-heavy MCP servers)." +
  ' Run "Claude Skills: Setup MCP Context Optimizer" in the VS Code command palette.';

function handleSessionSize(req: HookRequest): HookResponse {
  const body = req.body as Record<string, unknown>;
  const cwd = req.cwd;
  const sessionId = resolveSessionId(body, cwd);
  if (!sessionId || !cwd) return {};

  const transcriptPath = typeof body.transcript_path === "string" ? body.transcript_path : undefined;
  let usage: { tokens: number; cost: number; level: SizeLevel } | null = null;

  if (transcriptPath) {
    try {
      const stat = fs.statSync(transcriptPath);
      const tokens = Math.round(stat.size / 4);
      usage = { tokens, cost: tokens * BLENDED_USD_PER_TOKEN, level: byteLevelFor(stat.size) };
    } catch { /* fall through */ }
  }

  if (!usage) {
    const runs = readRunRecords(cwd);
    const sessionRuns = runs.filter(
      (r) => r.session_id === sessionId || (r as unknown as Record<string, unknown>).sessionId === sessionId
    );
    const totalTokens = sessionRuns.reduce((s, r) => s + (r.tokens ?? 0), 0);
    if (totalTokens > 0) {
      const totalCost = sessionRuns.reduce((s, r) => s + (r.cost ?? 0), 0);
      usage = { tokens: totalTokens, cost: totalCost, level: tokenLevelFor(totalTokens) };
    }
  }
  if (!usage) return {};

  const stateFile = path.join(cwd, ".claude", "learning", "session-watch.json");
  const state = readJsonSafe<Record<string, string>>(stateFile) ?? {};
  const previous = (state[sessionId] as SizeLevel | undefined) ?? "ok";
  state[sessionId] = usage.level;
  writeJsonSafe(stateFile, state);

  if (LEVEL_RANK[usage.level] <= LEVEL_RANK[previous]) return {};
  if (usage.level !== "warn" && usage.level !== "critical") return {};

  const projectedCost = PROJECTED_TOKEN_CEILING * BLENDED_USD_PER_TOKEN;
  const saveUsd = Math.max(0, projectedCost - usage.cost);
  const savingsHint =
    saveUsd < 0.01
      ? " /compact frees context; /clear resets completely."
      : ` /compact now may save ~${formatUsd(saveUsd)} vs letting the session grow; /clear resets completely.`;
  const costSuffix = ` Session at ${formatTokenCount(usage.tokens)} tokens (~${formatUsd(usage.cost)} est.).${savingsHint}`;

  const message =
    usage.level === "critical"
      ? `[Claude Skills] This session's transcript is very large.${costSuffix}${MCP_OPTIMIZER_TIP}`
      : `[Claude Skills] This session's transcript is getting large.${costSuffix}`;

  return promptOutput(message, req.agent);
}

// ---------------------------------------------------------------------------
// Handler: budget (UserPromptSubmit)
// ---------------------------------------------------------------------------

function handleBudget(req: HookRequest): HookResponse {
  const cwd = req.cwd;
  if (!cwd) return {};

  const config = readBudgetConfig();
  const { totalTokens, totalCost } = computeTodayCreditUsage();
  const today = new Date().toISOString().slice(0, 10);
  const state = readBudgetState();
  if (!state.notifications) state.notifications = {};
  if (!state.notifications[today]) state.notifications[today] = {};
  const notices: BudgetDayNotifications = state.notifications[today];
  const messages: string[] = [];

  if (config.mode === "economy") {
    if (config.highTierSkills.length > 0) {
      const disabled = disableHighTierSkills(cwd, config.highTierSkills, "economy");
      if (disabled.length > 0 && state.lastEconomyApplyDate !== today) {
        state.lastEconomyApplyDate = today;
        messages.push(
          `[Claude Skills] Economy mode: disabled ${disabled.length} high-tier skill(s) locally (${disabled.join(", ")}). Re-enable via Claude Skills Manager or switch to Normal mode.`
        );
      }
    }
    if (!notices.economyWarn && config.economyWarnUsd > 0 && totalCost >= config.economyWarnUsd) {
      notices.economyWarn = true;
      messages.push(
        `[Claude Skills] Economy mode: today's spend is ~${formatUsd(totalCost)} (${formatTokenCount(totalTokens)} tokens). Consider /compact to reduce context cost.`
      );
    }
  }

  if (config.mode === "unlimited") {
    if (!notices.unlimitedNotify && config.unlimitedNotifyUsd > 0 && totalCost >= config.unlimitedNotifyUsd) {
      notices.unlimitedNotify = true;
      messages.push(
        `[Claude Skills] Unlimited mode notice: today's spend reached ~${formatUsd(totalCost)} (${formatTokenCount(totalTokens)} tokens).`
      );
    }
  }

  if (config.dailyBudgetUsd > 0) {
    const pct = (totalCost / config.dailyBudgetUsd) * 100;
    const warnAt = config.warnThresholdPercent ?? 80;

    // Progressive threshold enforcement (mirrors JS fallback config)
    if (!notices.fallback95 && pct >= 95) {
      notices.fallback95 = true;
      const allSkills = [
        ...(config.highTierSkills ?? []),
        ...(config.mediumTierSkills ?? []),
      ];
      const blocked = disableHighTierSkills(cwd, allSkills, "budget-95pct-restrict");
      messages.push("[Claude Skills] Budget critical — only low-cost skills available.");
      if (blocked.length > 0) {
        messages.push(`[Claude Skills] Restricted ${blocked.length} skill(s) to low-tier only.`);
      }
    } else if (!notices.fallback90 && pct >= 90) {
      notices.fallback90 = true;
      const disabled = disableHighTierSkills(cwd, config.highTierSkills ?? [], "budget-90pct");
      messages.push("[Claude Skills] Budget critical - switching non-critical skills to Cursor (disable high-tier locally).");
      if (disabled.length > 0) {
        messages.push(`[Claude Skills] Disabled ${disabled.length} high-tier skill(s): ${disabled.join(", ")}.`);
        messages.push("[Claude Skills] Consider running medium/low-tier tasks in cursor to preserve Claude budget.");
      }
    } else if (!notices.fallback80 && pct >= 80 && pct < 90) {
      notices.fallback80 = true;
      messages.push("[Claude Skills] Budget at 80% - consider /compact.");
    }

    if (pct >= 100) {
      if (!notices.critical) {
        notices.critical = true;
        messages.push(
          `[Claude Skills] Daily budget exceeded: ~${formatUsd(totalCost)} of ${formatUsd(config.dailyBudgetUsd)} (${formatTokenCount(totalTokens)} tokens today). Raise the budget tier in Claude Skills Manager to continue without this warning.`
        );
      }
      if (config.autoDisableHighTierOnBudgetHit && (config.highTierSkills ?? []).length > 0) {
        const alreadyDone =
          state.lastAutoDisableDate === today &&
          JSON.stringify(state.lastAutoDisabledSkills ?? []) === JSON.stringify(config.highTierSkills);
        if (!alreadyDone) {
          const disabled = disableHighTierSkills(cwd, config.highTierSkills, "budget-exceeded");
          if (disabled.length > 0) {
            state.lastAutoDisableDate = today;
            state.lastAutoDisabledSkills = [...config.highTierSkills];
            messages.push(
              `[Claude Skills] Budget exceeded: auto-disabled ${disabled.length} high-tier skill(s) for this workspace (${disabled.join(", ")}). Restore via Claude Skills Manager when under budget.`
            );
          }
        }
      }
    } else if (!notices.warn && pct >= warnAt) {
      notices.warn = true;
      messages.push(
        `[Claude Skills] Daily budget warning: ~${formatUsd(totalCost)} of ${formatUsd(config.dailyBudgetUsd)} (${Math.round(pct)}%). Consider /compact or disabling unused skills.`
      );
    }
  }

  writeBudgetState(state);

  if (messages.length === 0) return {};
  return promptOutput(messages.join(" "), req.agent);
}

// ---------------------------------------------------------------------------
// Handler: context-focus (UserPromptSubmit)
// ---------------------------------------------------------------------------

const CONTEXT_FOCUS_INSTRUCTIONS: Record<ContextFocusLevel, string[]> = {
  knowledge: [
    "Context focus: KNOWLEDGE-FORWARD.",
    "Use broad technical knowledge for concepts and patterns.",
    "For this repository, read files when editing or when the user asks about specific code, paths, or behavior.",
  ],
  balanced: [
    "Context focus: BALANCED.",
    "Verify repo-specific claims (paths, APIs, config, behavior) by reading files before stating them.",
    "Use general knowledge for language/framework concepts, not for undocumented project behavior.",
    "In long sessions, re-read sources instead of relying on stale transcript context.",
  ],
  "local-first": [
    "Context focus: LOCAL-FIRST (reduce hallucination).",
    "Before explaining how this codebase works, read the relevant file(s) and cite paths.",
    "Do not invent file contents, env vars, CLI flags, or APIs for this project.",
    "Load and follow only skills clearly relevant to the current task; avoid broad skill dumps.",
  ],
  "strict-local": [
    "Context focus: STRICT LOCAL (minimal hallucination).",
    "Only assert facts from: (1) files read this session, (2) user messages, (3) explicit tool output.",
    "If unsure about this project, say so and read/search first — do not fill gaps from training data.",
    "Prefer a narrow, verified answer over a speculative comprehensive one.",
    "Use at most the few skills directly required for this task.",
  ],
};

function handleContextFocus(req: HookRequest): HookResponse {
  const body = req.body as Record<string, unknown>;
  const cwd = req.cwd;
  if (!cwd) return {};

  const config = readContextFocusConfig();
  if (!config.enabled) return {};

  const transcriptPath = typeof body.transcript_path === "string" ? body.transcript_path : undefined;
  const sessionId = resolveSessionId(body, cwd);

  let sizeLevel: SizeLevel = "ok";
  if (transcriptPath) {
    try { sizeLevel = byteLevelFor(fs.statSync(transcriptPath).size); } catch { /* ok */ }
  }

  let shouldInject = config.injectEveryPrompt;
  if (!shouldInject) {
    if (sizeLevel === "warn" || sizeLevel === "critical") {
      shouldInject = true;
    } else if (sessionId) {
      const stateFile = path.join(cwd, ".claude", "learning", "context-focus-state.json");
      const state = readJsonSafe<Record<string, boolean>>(stateFile) ?? {};
      if (!state[sessionId]) {
        state[sessionId] = true;
        writeJsonSafe(stateFile, state);
        shouldInject = true;
      }
    } else {
      shouldInject = true;
    }
  }
  if (!shouldInject) return {};

  const level = effectiveContextFocusLevel(config, sizeLevel);
  const lines = [...(CONTEXT_FOCUS_INSTRUCTIONS[level] ?? CONTEXT_FOCUS_INSTRUCTIONS.balanced)];

  if (config.limitSkillCatalogHints && (level === "local-first" || level === "strict-local")) {
    const skillsDir = path.join(cwd, ".claude", "skills");
    let skillCount = 0;
    try { skillCount = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).length; } catch { /* ok */ }
    if (skillCount >= (config.manySkillsThreshold ?? 12)) {
      lines.push(
        `This workspace has ${skillCount} installed skills — context is bounded. Do not assume all skill instructions are loaded; pick only what this task needs.`
      );
    }
  }
  if (sizeLevel === "warn" || sizeLevel === "critical") {
    lines.push("Session transcript is large — prioritize verified local sources over memory of earlier turns.");
  }

  return promptOutput(lines.join("\n"), req.agent);
}

// ---------------------------------------------------------------------------
// Handler: practical-focus (UserPromptSubmit)
// ---------------------------------------------------------------------------

const PRACTICAL_FOCUS_INSTRUCTIONS: Record<PracticalFocusLevel, string[]> = {
  exploratory: [
    "Practical focus: EXPLORATORY.",
    "Trade-offs, options, and high-level theory are appropriate.",
    "Still note major deployment risks if the user mentions production or deploy.",
  ],
  balanced: [
    "Practical focus: BALANCED.",
    "Pair explanations with concrete next steps tied to this repository.",
    "Read existing infra/CI files before suggesting a new pattern.",
  ],
  "architecture-first": [
    "Practical focus: ARCHITECTURE-FIRST (not hand-wavy theory).",
    "Before advising, read this repo's IaC, CI/CD, and deployment docs (terraform/, .gitlab-ci.yml, azure.yaml, Dockerfile, etc.).",
    "Propose concrete architecture: resource names, modules, pipelines, and how they connect — aligned with patterns already in the repo.",
    "Avoid generic 'you could use X or Y' without picking the default for THIS project and stating why.",
    "Prefer provisioned infrastructure (Terraform/Bicep/ARM/pipelines) over prose-only recommendations.",
    "Call out first-deploy blockers: RBAC, quotas, region availability, secrets, backend state, and identity wiring.",
  ],
  "deploy-ready": [
    "Practical focus: DEPLOY-READY (must work on first attempt).",
    "Every recommendation must be executable: exact CLI/API commands, file paths, and prerequisite checks.",
    "Run or specify validation before claiming success: terraform fmt/validate/plan, npm test, docker build, az deployment group validate, CI preflight, etc.",
    "Include rollback or safe undo steps for destructive changes.",
    "Do not skip permission/identity setup — surface the exact role assignment or az command an admin must run.",
    "If something was tried before and failed, check .claude/learning/ and project docs for known fixes before retrying.",
    "Prefer proven project patterns over novel greenfield designs unless the user explicitly asks to redesign.",
  ],
};

function fileExists(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function dirHasFiles(dir: string): boolean {
  try { return fs.readdirSync(dir).length > 0; } catch { return false; }
}

function walkForPattern(dir: string, matchFn: (p: string) => boolean, maxDepth = 4): boolean {
  if (maxDepth <= 0) return false;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && matchFn(e.name)) return true;
    if (e.isDirectory() && !e.name.startsWith(".") && walkForPattern(full, matchFn, maxDepth - 1)) return true;
  }
  return false;
}

function detectInfraSignals(cwd: string): string[] {
  const signals: string[] = [];
  const checks: [string, () => boolean][] = [
    ["Terraform", () => walkForPattern(cwd, (p) => p.endsWith(".tf"))],
    ["Bicep", () => walkForPattern(cwd, (p) => p.endsWith(".bicep"))],
    ["Azure Dev", () => fileExists(path.join(cwd, "azure.yaml")) || fileExists(path.join(cwd, "azure.yml"))],
    ["Docker", () => fileExists(path.join(cwd, "Dockerfile")) || walkForPattern(cwd, (p) => p.startsWith("Dockerfile."), 1)],
    ["GitLab CI", () => fileExists(path.join(cwd, ".gitlab-ci.yml"))],
    ["GitHub Actions", () => dirHasFiles(path.join(cwd, ".github", "workflows"))],
    ["Kubernetes", () => walkForPattern(cwd, (p) => p.includes("k8s") || (p.endsWith(".yaml") && p.includes("deployment")))],
  ];
  for (const [label, fn] of checks) {
    try { if (fn()) signals.push(label); } catch { /* ignore */ }
  }
  return signals;
}

function handlePracticalFocus(req: HookRequest): HookResponse {
  const body = req.body as Record<string, unknown>;
  const cwd = req.cwd;
  if (!cwd) return {};

  const config = readPracticalFocusConfig();
  if (!config.enabled) return {};

  const sessionId = resolveSessionId(body, cwd);
  if (!config.injectEveryPrompt && sessionId) {
    const stateFile = path.join(cwd, ".claude", "learning", "practical-focus-state.json");
    const state = readJsonSafe<Record<string, boolean>>(stateFile) ?? {};
    if (state[sessionId]) return {};
    state[sessionId] = true;
    writeJsonSafe(stateFile, state);
  }

  const level = config.level;
  const lines = [...(PRACTICAL_FOCUS_INSTRUCTIONS[level] ?? PRACTICAL_FOCUS_INSTRUCTIONS.balanced)];

  if (config.recommendDeploymentSkill) {
    const signals = detectInfraSignals(cwd);
    if (signals.length > 0) {
      lines.push(`Detected infra signals in this repo: ${signals.join(", ")}. Prefer deployment-skill actions aligned with these tools.`);
    }
  }

  return promptOutput(lines.join("\n"), req.agent);
}

// ---------------------------------------------------------------------------
// Handler: task-drift (UserPromptSubmit)
// ---------------------------------------------------------------------------

interface TaskDriftPrompt {
  shouldInject?: boolean;
  message?: string;
  deliveredAt?: string;
}

function handleTaskDrift(req: HookRequest): HookResponse {
  const cwd = req.cwd;
  if (!cwd) return {};

  const cliCfg = readJsonSafe<{ features?: { taskDriftReproposal?: boolean } }>(
    path.join(cwd, ".claude", "learning", "cli-config.json")
  );
  if (cliCfg?.features?.taskDriftReproposal === false) return {};

  const promptFile = path.join(cwd, ".claude", "learning", "task-drift-prompt.json");
  const prompt = readJsonSafe<TaskDriftPrompt>(promptFile);
  if (!prompt?.shouldInject || !prompt.message) return {};

  writeJsonSafe(promptFile, { ...prompt, shouldInject: false, deliveredAt: new Date().toISOString() });
  return promptOutput(prompt.message, req.agent);
}

// ---------------------------------------------------------------------------
// Handler: official-skills (SessionStart)
// ---------------------------------------------------------------------------

const SESSION_SOURCES = new Set(["startup", "resume", "clear"]);

async function handleOfficialSkills(req: HookRequest): Promise<HookResponse> {
  const body = req.body as Record<string, unknown>;
  const cwd = req.cwd;
  if (!cwd) return {};

  if (req.agent === "claude" || req.agent === "copilot") {
    const source = String(body.source ?? "startup");
    if (!SESSION_SOURCES.has(source)) return {};
  }

  if (!workspaceUsesOfficialSkillUpdater(cwd)) return {};

  const libraryDir = resolveSkillsLibraryDir(cwd);
  if (!libraryDir) return {};

  try {
    const result = await checkOfficialSkillUpdates(libraryDir);
    const context = formatOfficialSkillsSessionContext(result);
    if (!context) return {};
    return sessionStartOutput(context, req.agent);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Handler: profile-init (SessionStart)
// ---------------------------------------------------------------------------

const PROFILE_INIT_SESSION_SOURCES = new Set(["startup", "resume", "clear", "new"]);
const DEFAULT_REQUIRED_SKILLS = [
  "self-learning",
  "file-style-conventions",
  "skill-creator",
  "skill-usage-insights",
  "skill-feedback-adaptation",
  "skill-official-updater",
];

function profileInitComplete(cwd: string): boolean {
  const profile = readJsonSafe<{ status?: string; skills?: unknown[] }>(
    path.join(cwd, ".claude", "profile.local.json")
  );
  return profile?.status === "applied" && Array.isArray(profile.skills) && profile.skills.length > 0;
}

function readRequiredSkills(cwd: string): string[] {
  const request = readJsonSafe<{ requiredSkillNames?: unknown[] }>(
    path.join(cwd, ".claude", "learning", "profile-init-request.json")
  );
  if (request && Array.isArray(request.requiredSkillNames) && request.requiredSkillNames.length) {
    return request.requiredSkillNames.filter((s): s is string => typeof s === "string");
  }
  return DEFAULT_REQUIRED_SKILLS;
}

function formatLowTrustPrompt(cwd: string): string {
  const trust = readJsonSafe<{ enabled?: boolean; shouldInject?: boolean; scorePct?: number; thresholdPct?: number; summary?: string }>(
    path.join(cwd, ".claude", "learning", "attribution-trust.json")
  );
  if (!trust?.enabled || !trust.shouldInject) return "";
  const score = typeof trust.scorePct === "number" ? trust.scorePct : null;
  const threshold = typeof trust.thresholdPct === "number" ? trust.thresholdPct : 50;
  if (score === null || score >= threshold) return "";
  return [
    `[Claude Skills] Cost attribution trust is ${score}% (below your ${threshold}% threshold).`,
    "Dashboard per-skill costs and ROI are unreliable until Attribution v2 hooks log more invocations.",
    "Do not optimize skill choices from cost rankings alone — read SKILL.md for task-relevant skills.",
    trust.summary ? `Status: ${trust.summary}` : "",
  ].filter(Boolean).join(" ");
}

function formatTaskDriftPromptText(cwd: string): string {
  const cliCfg = readJsonSafe<{ features?: { taskDriftReproposal?: boolean } }>(
    path.join(cwd, ".claude", "learning", "cli-config.json")
  );
  if (cliCfg?.features?.taskDriftReproposal === false) return "";
  const prompt = readJsonSafe<{ shouldInject?: boolean; message?: string }>(
    path.join(cwd, ".claude", "learning", "task-drift-prompt.json")
  );
  if (!prompt?.shouldInject || !prompt.message) return "";
  writeJsonSafe(path.join(cwd, ".claude", "learning", "task-drift-prompt.json"), {
    ...prompt, shouldInject: false, deliveredAt: new Date().toISOString(),
  });
  return prompt.message;
}

function formatFreshSessionContext(cwd: string): string {
  const active = readJsonSafe<{ activeSkills?: unknown[]; ignoredSkills?: unknown[] }>(
    path.join(cwd, ".claude", "learning", "task-active-skills.json")
  );
  if (active && Array.isArray(active.activeSkills) && active.activeSkills.length) {
    const list = (active.activeSkills as string[]).slice(0, 12).join(", ");
    const ignored =
      Array.isArray(active.ignoredSkills) && active.ignoredSkills.length
        ? ` Ignored for this task (${active.ignoredSkills.length}): ${(active.ignoredSkills as string[]).slice(0, 8).join(", ")}${active.ignoredSkills.length > 8 ? ", ..." : ""}.`
        : "";
    return [
      "[Claude Skills] Task skill focus ON — use only the active skill set below; other installed skills are on your ignore list (skillOverrides off).",
      `Active skills: ${list}.`,
      ignored,
      "Do not load or read SKILL.md for ignored skills unless the user explicitly asks.",
    ].filter(Boolean).join(" ");
  }

  const proposals = readJsonSafe<{ proposals?: Array<{ name: string; confidence?: number }> }>(
    path.join(cwd, ".claude", "learning", "task-skill-proposals.json")
  );
  const top = ((proposals?.proposals ?? []) as Array<{ name: string; confidence?: number }>)
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .slice(0, 8)
    .map((p) => `${p.name} (${p.confidence ?? "?"}%)`)
    .join(", ");

  return [
    "[Claude Skills] Session ready — task skills set by the extension (auto-apply on).",
    top ? `Enabled proposals: ${top}.` : "",
    "Skip skill-feedback-adaptation section 3 unless the user starts a clearly new task.",
    "Do not read SKILL.md files unless the task needs a skill you have not used before.",
  ].filter(Boolean).join(" ");
}

function formatNewSessionTaskContext(): string {
  return [
    "[Claude Skills] NEW SESSION — update task skills before other work.",
    "Read and follow skill-feedback-adaptation section 3 (Propose skills for a new task) immediately — do not wait for the user to ask.",
    "Use the user's first message (or latest task scope) to overwrite .claude/learning/task-skill-proposals.json.",
    "Existing proposals may be a stale profile-init seed — replace them when the user starts a new task.",
    "Propose only skills that match this task (typically 3–8, not the whole library). Read and apply the top proposed skills, then answer the user.",
  ].join(" ");
}

function formatProfileInitContext(request: {
  branch?: string; position?: { label?: string; role?: string };
  catalogPath?: string; outputPath?: string;
  relevantSkillNames?: string[]; agentInstructions?: string;
}): string {
  const lines = [
    "[Claude Skills] PROFILE INIT REQUIRED — run before any other task.",
    `Branch: ${request.branch ?? "unknown"}`,
    `Position: ${request.position?.label ?? request.position?.role ?? "unknown"}`,
    `Catalog: ${request.catalogPath ?? ".claude/learning/skills-catalog.json"}`,
    `Output: ${request.outputPath ?? ".claude/profile.local.json"}`,
    "Learning: refine .claude/learning/task-skill-proposals.json if the extension seed is present.",
    "Proposed skills from the profile seed are being enabled locally for this session.",
  ];
  if (Array.isArray(request.relevantSkillNames) && request.relevantSkillNames.length) {
    lines.push(`Workspace-relevant skills: ${request.relevantSkillNames.join(", ")}.`);
  }
  lines.push(
    request.agentInstructions ??
    "Read and follow the profile-init skill now: pick skills from the catalog for this branch and position, write profile.local.json with status pending, then confirm apply."
  );
  return lines.join(" ");
}

function shouldRunProfileInit(body: Record<string, unknown>, agent: string): boolean {
  if (agent === "claude" || agent === "copilot") {
    const source = String(body.source ?? "startup");
    return PROFILE_INIT_SESSION_SOURCES.has(source);
  }
  return true;
}

async function handleProfileInit(req: HookRequest): Promise<HookResponse> {
  const body = req.body as Record<string, unknown>;
  const cwd = req.cwd;
  if (!cwd || !shouldRunProfileInit(body, req.agent)) return {};

  const libraryDir = resolveSkillsLibraryDir(cwd) ?? path.join(cwd, "skills_library");
  const { skills, source } = resolveProposedSkillNamesWithSource(cwd);

  const sessionId =
    String(body.session_id ?? body.sessionId ?? body.conversation_id ?? body.conversationId ?? "") ||
    `${req.agent}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (skills.length > 0) {
    queueSessionSkillApplyRequest(cwd, skills, source, sessionId);
    processSessionSkillApplyRequest(libraryDir, cwd);
    applyTaskSkillFocusFromProposals(libraryDir, cwd);
  }

  const buildContext = (): string => {
    const deterministicEnabled = (() => {
      const cfg = readJsonSafe<{ features?: { deterministicTaskProposals?: boolean } }>(
        path.join(cwd, ".claude", "learning", "cli-config.json")
      );
      return cfg?.features?.deterministicTaskProposals !== false;
    })();

    const proposals = readJsonSafe<{ generatedAt?: string; proposals?: unknown[] }>(
      path.join(cwd, ".claude", "learning", "task-skill-proposals.json")
    );
    const proposalsFresh = (() => {
      if (!proposals?.generatedAt || !Array.isArray(proposals?.proposals) || !proposals.proposals.length) return false;
      const ageMs = Date.now() - new Date(proposals.generatedAt).getTime();
      return ageMs >= 0 && ageMs < 24 * 60 * 60 * 1000;
    })();

    const sessionSkillAdaptation = isFeatureEnabled("sessionSkillAdaptation");
    const base = sessionSkillAdaptation
      ? deterministicEnabled && proposalsFresh
        ? formatFreshSessionContext(cwd)
        : formatNewSessionTaskContext()
      : "";

    const lowTrust = formatLowTrustPrompt(cwd);
    const drift = formatTaskDriftPromptText(cwd);
    return [base, lowTrust, drift].filter(Boolean).join("\n\n");
  };

  if (profileInitComplete(cwd)) {
    const context = buildContext();
    if (!context) return {};
    return sessionStartOutput(context, req.agent);
  }

  const requestFile = path.join(cwd, ".claude", "learning", "profile-init-request.json");
  const profileRequest = readJsonSafe<{
    status?: string; branch?: string; position?: { label?: string; role?: string };
    catalogPath?: string; outputPath?: string; relevantSkillNames?: string[]; agentInstructions?: string;
  }>(requestFile);

  if (!profileRequest || profileRequest.status === "completed") {
    const context = buildContext();
    if (!context) return {};
    return sessionStartOutput(context, req.agent);
  }

  const context = buildContext();
  const initPrompt = formatProfileInitContext(profileRequest);
  const combined = [initPrompt, formatLowTrustPrompt(cwd), formatTaskDriftPromptText(cwd)]
    .filter(Boolean).join("\n\n");
  return sessionStartOutput(combined || context, req.agent);
}

// ---------------------------------------------------------------------------
// Handler: branch-sync (git post-checkout)
// ---------------------------------------------------------------------------

function handleBranchSync(req: HookRequest): HookResponse {
  const cwd = req.cwd;
  if (!cwd) return {};

  const cliCfg = readJsonSafe<{ features?: { branchProfiles?: boolean } }>(
    path.join(cwd, ".claude", "learning", "cli-config.json")
  );
  if (cliCfg?.features?.branchProfiles === false) return {};

  try {
    const branch = getCurrentBranch(cwd);
    if (!branch || branch === "HEAD") return {};
    const profile = loadBranchProfile(cwd, branch);
    if (!profile) return {};
    const libraryDir = resolveSkillsLibraryDir(cwd) ?? path.join(cwd, "skills_library");
    applyBranchProfile(libraryDir, cwd, profile);
  } catch { /* non-fatal */ }

  return {};
}

// ---------------------------------------------------------------------------
// Handler: mcp-force (UserPromptSubmit — structured redirect message)
// ---------------------------------------------------------------------------

const MCP_FORCE_REDIRECT: Record<string, string> = {
  Read:  "mcp__filesystem__read_file",
  Write: "mcp__filesystem__write_file",
  Edit:  "mcp__filesystem__write_file",
  Glob:  "mcp__filesystem__list_directory / search_files",
  Grep:  "mcp__filesystem__search_files",
};

function handleMcpForce(req: HookRequest): HookResponse {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const toolName = String(body.tool_name ?? body.toolName ?? "");
  const redirect = MCP_FORCE_REDIRECT[toolName];

  const lines: string[] = [
    "🚫 Native file tools are disabled (MCP-force mode).",
    "✅ Use MCP filesystem tools instead:",
    "",
  ];

  if (redirect && toolName) {
    const input = body.tool_input ?? body.toolInput ?? {};
    const examplePath =
      typeof input === "object" && input !== null
        ? (input as Record<string, unknown>).path ?? (input as Record<string, unknown>).file_path ?? "..."
        : "...";
    lines.push(`  ${toolName}("${String(examplePath)}")`);
    lines.push(`  → \`${redirect}({ "path": "${String(examplePath)}" })\``);
  } else {
    lines.push("  Read(f)  → mcp__filesystem__read_file({ \"path\": f })");
    lines.push("  Write(f) → mcp__filesystem__write_file({ \"path\": f, \"content\": c })");
    lines.push("  Glob(p)  → mcp__filesystem__list_directory({ \"path\": dir })");
    lines.push("  Grep(p)  → mcp__filesystem__search_files({ \"path\": \".\", \"pattern\": p })");
  }

  return promptOutput(lines.join("\n"), req.agent);
}

// ---------------------------------------------------------------------------
// Handler: mcp-gate (SessionStart — health check with last activity timestamp)
// ---------------------------------------------------------------------------

const MCP_SERVER_SCRIPT = path.join(os.homedir(), ".claude", "mcp-servers", "filesystem", "index.js");
const MCP_USAGE_LOG = path.join(os.homedir(), ".claude", "learning", "mcp-usage.jsonl");
const MCP_HINTS_PATH = path.join(os.homedir(), ".claude", "learning", "mcp-agent-hints.md");

function readMcpHints(): string {
  try {
    if (fs.existsSync(MCP_HINTS_PATH)) {
      const content = fs.readFileSync(MCP_HINTS_PATH, "utf-8").trim();
      return content.length > 0 ? content : "";
    }
  } catch { /* non-fatal */ }
  return "";
}

function lastMcpActivityTimestamp(): string | undefined {
  if (!fs.existsSync(MCP_USAGE_LOG)) return undefined;
  try {
    const lines = fs.readFileSync(MCP_USAGE_LOG, "utf-8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = JSON.parse(lines[i]) as { ts?: string };
      if (entry.ts) return entry.ts;
    }
  } catch {
    // non-fatal
  }
  return undefined;
}

function formatActivityAge(ts: string): string {
  const ms = Date.now() - new Date(ts).getTime();
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}min ago`;
  const hours = Math.round(ms / 3_600_000);
  return `${hours}h ago`;
}

function mcpGateMessage(statusLines: string[]): string {
  const hints = readMcpHints();
  return hints
    ? statusLines.join("\n") + "\n\n" + hints
    : statusLines.join("\n");
}

function handleMcpGate(req: HookRequest): HookResponse {
  const serverExists = fs.existsSync(MCP_SERVER_SCRIPT);
  if (!serverExists) {
    return sessionStartOutput(
      mcpGateMessage([
        "⛔ MCP-Force Gate: MCP server script not found.",
        "   All native file tools (Read, Write, Edit, Glob, Grep) are blocked.",
        "   Run \"Claude Skills: Enable MCP Server\" in VS Code to restore file access.",
      ]),
      req.agent
    );
  }

  const lastTs = lastMcpActivityTimestamp();
  if (!lastTs) {
    return sessionStartOutput(
      mcpGateMessage([
        "✓ MCP-Force Gate: MCP server installed, no activity logged yet.",
        "  Use mcp__filesystem__* tools — native file tools are blocked.",
      ]),
      req.agent
    );
  }

  const age = formatActivityAge(lastTs);
  const msInactive = Date.now() - new Date(lastTs).getTime();
  const inactiveTooLong = msInactive > 10 * 60_000; // 10 min

  if (inactiveTooLong) {
    return sessionStartOutput(
      mcpGateMessage([
        `⚠ MCP-Force Gate: MCP server installed but inactive for ${age}.`,
        "  Verify the MCP server is connected before starting file work.",
        "  Use mcp__filesystem__* tools — native file tools are blocked.",
      ]),
      req.agent
    );
  }

  return sessionStartOutput(
    mcpGateMessage([`✓ MCP-Force Gate: MCP ready (last activity ${age}). Use mcp__filesystem__* for all file ops.`]),
    req.agent
  );
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function handleHookRequest(req: HookRequest): Promise<HookResponse> {
  switch (req.hookName) {
    case "skill-invoke": return handleSkillInvoke(req);
    case "session-size": return handleSessionSize(req);
    case "budget": return handleBudget(req);
    case "context-focus": return handleContextFocus(req);
    case "practical-focus": return handlePracticalFocus(req);
    case "task-drift": return handleTaskDrift(req);
    case "official-skills": return handleOfficialSkills(req);
    case "profile-init": return handleProfileInit(req);
    case "branch-sync": return Promise.resolve(handleBranchSync(req));
    case "mcp-force": return Promise.resolve(handleMcpForce(req));
    case "mcp-gate": return Promise.resolve(handleMcpGate(req));
    default: return {};
  }
}
