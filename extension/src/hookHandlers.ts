/**
 * HTTP hook handlers — TypeScript port of the JS hook scripts in resources/hooks/.
 * Called by hookServer.ts; no Node.js scripts are copied to agent directories.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendSkillRun, appendToolUse, RunAgent, readCachedEnrichedRuns } from "./runsStore";
import { readContextFocusConfig, effectiveContextFocusLevel, ContextFocusLevel } from "./contextFocusConfig";
import { readPracticalFocusConfig, PracticalFocusLevel } from "./practicalFocusConfig";
import { readBudgetConfig, readBudgetState, writeBudgetState, BudgetDayNotifications } from "./budgetConfig";
import { readCoachConfig } from "./coachConfig";
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
import { appendHookHealth } from "./hookHealth";
import { recordSessionProposalOutcome, recordSessionRejectionFeedback } from "./proposalOutcome";
import { computeEfficiencyMetrics } from "./efficiencyMetrics";
import { shouldSurfaceProposals } from "./adoptionIntelligence";
import { readTaskSkillProposals } from "./taskSkillProposals";
import { analyzePrompt, appendPromptRecord } from "./promptIntelligence";
import { getSessionCoachHints } from "./haceCoaching";
import { recordAdviceShown, shouldShowAdvice, evaluateAdviceOutcome } from "./coachingLearning";
import { isDormantSkill } from "./adoptionIntelligence";

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

function learnedPatternsPath(): string {
  return path.join(os.homedir(), ".claude", "learning", "cli-guard-patterns.json");
}

function mcpPatternsPath(): string {
  return path.join(os.homedir(), ".claude", "learning", "mcp-guard-patterns.json");
}

function analyzeCliFailures(): { needsReview: number } {
  return { needsReview: 0 };
}

function analyzeMcpErrors(): { needsReview: number } {
  return { needsReview: 0 };
}

function loadLearnedPatternsForHook(): Array<{
  needsReview: boolean;
  clis: string[];
  exitCode: number | null;
  stderrSubstring?: string;
  hint: string;
}> {
  return [];
}

function loadMcpPatternsForHook(): Array<{
  needsReview: boolean;
  clis: string[];
  stderrSubstring?: string;
  hint: string;
}> {
  return [];
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
  // Common filenames falsely detected as skill names via the skills_library path pattern
  "manifest", "package", "readme", "changelog", "license",
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
  if (
    ["read", "fs_read", "fileread", "filereadtool", "readtool",
     "mcp__filesystem__read_file", "mcp__filesystem__search_in_file", "mcp__filesystem__search_files"].includes(tool)
  ) {
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
  
  // Log non-skill tools (native IDE tools like run_task, run_in_terminal, etc.)
  if (!skill) {
    appendToolUse(cwd, {
      tool: String(toolName).toLowerCase() || "unknown",
      agent: req.agent as RunAgent,
      sessionId,
      metadata: {
        source: "skill-invoke-hook-v2",
        tool_name: String(toolName),
        tool_use_id: toolUseId || undefined,
        hook_agent: req.agent,
        model: typeof body.model === "string" ? body.model : undefined,
      },
    });
    return {};
  }

  const stateFile = path.join(cwd, ".claude", "learning", "skill-invoke-state.json");
  const MAX_STATE_KEYS = 3000;
  const MAX_STATE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

  // Dedup strategy:
  // - When toolUseId is present (PostToolUse with specific call ID): use it — exact match.
  // - When toolUseId is absent (PreToolUse / VS Code workaround): bucket by 10-second window.
  //   This prevents Pre+Post double-writes for the same tool call while allowing the SAME
  //   skill to be recorded again after the bucket expires (i.e., genuine re-invocations
  //   within the same session are captured, not permanently collapsed to one record).
  const hasResponse = !!(body.tool_response ?? body.toolResult ?? body.tool_result);
  const dedupeId = toolUseId
    ? toolUseId
    : hasResponse
      ? `post-${Math.floor(Date.now() / 10_000)}` // PostToolUse without ID: 10s bucket
      : `pre-${Math.floor(Date.now() / 10_000)}`;  // PreToolUse without ID: 10s bucket

  // Prefer recording on PostToolUse (completion known). Skip PreToolUse when PostToolUse
  // will fire for the same call — identified by a matching 10-second bucket key.
  // Exception: if there is no tool_response and no toolUseId (Claude VS Code workaround),
  // allow the PreToolUse record through so attribution is never silently dropped.
  if (!hasResponse && toolUseId) return {}; // Pre with ID: skip — Post will write

  const key = `${sessionId}|${skill}|${dedupeId}`;
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

  // Check if this skill was in the current proposal set (GAP 1: recommendation success chain)
  let proposedFlag = false;
  let proposalConfidence = 0;
  try {
    const pf = path.join(cwd, ".claude", "learning", "task-skill-proposals.json");
    const pfData = JSON.parse(fs.readFileSync(pf, "utf-8")) as { proposals?: Array<{ name: string; confidence: number }> };
    const prop = pfData.proposals?.find(p => p.name === skill);
    if (prop) { proposedFlag = true; proposalConfidence = prop.confidence; }
  } catch { /* non-fatal — proposals file may not exist */ }

  let wroteRuns = false;
  try {
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
        proposed: proposedFlag,
        proposal_confidence: proposalConfidence > 0 ? proposalConfidence : undefined,
        tool_name: String(toolName),
        tool_use_id: toolUseId || undefined,
        hook_agent: req.agent,
        model,
        ...(notInActiveProfile ? { not_in_active_profile: true } : {}),
      },
    });
    wroteRuns = true;
  } catch { /* non-fatal */ }

  // GAP 2: record hook health for learning loop diagnostics
  appendHookHealth(cwd, { event: "hook_fired", skill, wrote_runs: wroteRuns, agent: req.agent, session_id: sessionId });

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

  // Run the CLI guard learner once per session to promote repeated failures into
  // learned patterns. Non-fatal — a crash here must not block session start.
  let cliLearnerNote = "";
  try {
    const learnerResult = analyzeCliFailures();
    if (learnerResult.needsReview > 0) {
      cliLearnerNote =
        `[Claude Skills] ${learnerResult.needsReview} learned CLI guard pattern(s) need a corrective hint. ` +
        `Review and fill in the hint field in: ${learnedPatternsPath()}`;
    }
  } catch { /* non-fatal */ }

  let mcpLearnerNote = "";
  try {
    const mcpResult = analyzeMcpErrors();
    if (mcpResult.needsReview > 0) {
      mcpLearnerNote =
        `[Claude Skills] ${mcpResult.needsReview} learned MCP filesystem guard pattern(s) need a corrective hint. ` +
        `Review and fill in the hint field in: ${mcpPatternsPath()}`;
    }
  } catch { /* non-fatal */ }

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

    const sessionSkillAdaptation = true;
    const base = sessionSkillAdaptation
      ? deterministicEnabled && proposalsFresh
        ? formatFreshSessionContext(cwd)
        : formatNewSessionTaskContext()
      : "";

    const lowTrust = formatLowTrustPrompt(cwd);
    const drift = formatTaskDriftPromptText(cwd);
    return [base, lowTrust, drift, cliLearnerNote, mcpLearnerNote].filter(Boolean).join("\n\n");
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
  const lastSession = buildLastSessionSummary();
  const combined = [
    initPrompt,
    formatLowTrustPrompt(cwd),
    formatTaskDriftPromptText(cwd),
    cliLearnerNote,
    mcpLearnerNote,
    lastSession ? `## Last session\n${lastSession}` : "",
  ].filter(Boolean).join("\n\n");
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
// Rationale: the filesystem MCP server provides path-scoped access control —
// Claude cannot access paths outside the configured allow-list. Direct tools
// (Read/Write/Edit/Bash cat/grep) bypass this sandbox. MCP-only mode ensures
// all file operations are auditable and scoped to the workspace root.
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
    "ðŸš« Native file tools are disabled (MCP-force mode).",
    "âœ… Use MCP filesystem tools instead:",
    "",
  ];

  if (redirect && toolName) {
    const input = body.tool_input ?? body.toolInput ?? {};
    const examplePath =
      typeof input === "object" && input !== null
        ? (input as Record<string, unknown>).path ?? (input as Record<string, unknown>).file_path ?? "..."
        : "...";
    lines.push(`  ${toolName}("${String(examplePath)}")`);
    lines.push(`  â†’ \`${redirect}({ "path": "${String(examplePath)}" })\``);
  } else {
    lines.push("  Read(f)  â†’ mcp__filesystem__read_file({ \"path\": f })");
    lines.push("  Write(f) â†’ mcp__filesystem__write_file({ \"path\": f, \"content\": c })");
    lines.push("  Glob(p)  â†’ mcp__filesystem__list_directory({ \"path\": dir })");
    lines.push("  Grep(p)  â†’ mcp__filesystem__search_files({ \"path\": \".\", \"pattern\": p })");
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

/**
 * Reads the last 60 entries of mcp-usage.jsonl and builds a one-paragraph
 * context block describing the most recent agent session — which project
 * directory it ran in, what files it wrote, and which CLIs it called.
 * Returns an empty string when no recent session (<24 h) is found.
 */
function buildLastSessionSummary(): string {
  if (!fs.existsSync(MCP_USAGE_LOG)) return "";
  try {
    const lines = fs.readFileSync(MCP_USAGE_LOG, "utf-8").split("\n").filter(Boolean);
    if (lines.length === 0) return "";

    const recent = lines.slice(-60).reduce<Record<string, unknown>[]>((acc, l) => {
      try { acc.push(JSON.parse(l) as Record<string, unknown>); } catch { /* skip */ }
      return acc;
    }, []);
    if (recent.length === 0) return "";

    const lastEntry = recent[recent.length - 1];
    const lastTs = typeof lastEntry.ts === "string" ? lastEntry.ts : undefined;
    if (!lastTs) return "";

    const msAgo = Date.now() - new Date(lastTs).getTime();
    if (msAgo > 24 * 60 * 60 * 1000) return ""; // only inject for sessions < 24 h old

    const sessionId = typeof lastEntry.sessionId === "string" ? lastEntry.sessionId : undefined;
    const sessionEntries = sessionId
      ? recent.filter((e) => e.sessionId === sessionId)
      : recent.slice(-20);

    // Project directory from CLI cwd or common prefix of written file paths
    const cwds = sessionEntries.map((e) => e.cwd).filter((c): c is string => typeof c === "string");
    const projectCwd = cwds[0] ?? null;

    const writtenFiles = [...new Set(
      sessionEntries
        .filter((e) => e.tool === "write_file")
        .map((e) => e.path)
        .filter((p): p is string => typeof p === "string")
    )];

    const cliCalls = sessionEntries.reduce<Record<string, number>>((acc, e) => {
      if (e.server === "cli" && typeof e.cli === "string") {
        acc[e.cli] = (acc[e.cli] ?? 0) + 1;
      }
      return acc;
    }, {});

    const parts: string[] = [`Last session: ${formatActivityAge(lastTs)}`];
    if (projectCwd) parts.push(`  Project dir: ${projectCwd}`);
    if (writtenFiles.length > 0) {
      const names = writtenFiles.slice(0, 5).map((f) => path.basename(f)).join(", ");
      const extra = writtenFiles.length > 5 ? ` (+${writtenFiles.length - 5} more)` : "";
      parts.push(`  Files written: ${names}${extra}`);
    }
    const cliEntries = Object.entries(cliCalls).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (cliEntries.length > 0) {
      parts.push(`  CLI calls: ${cliEntries.map(([c, n]) => `${c}Ã—${n}`).join(", ")}`);
    }

    return parts.join("\n");
  } catch {
    return "";
  }
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
  const lastSession = buildLastSessionSummary();
  const parts = [statusLines.join("\n")];
  if (lastSession) parts.push("\n## Last session\n" + lastSession);
  if (hints) parts.push("\n" + hints);
  return parts.join("\n");
}

function handleMcpGate(req: HookRequest): HookResponse {
  const serverExists = fs.existsSync(MCP_SERVER_SCRIPT);
  if (!serverExists) {
    return sessionStartOutput(
      mcpGateMessage([
        "â›” MCP-Force Gate: MCP server script not found.",
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
        "âœ“ MCP-Force Gate: MCP server installed and ready (log empty — either first use or logs were recently cleared).",
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
    mcpGateMessage([`âœ“ MCP-Force Gate: MCP ready (last activity ${age}). Use mcp__filesystem__* for all file ops.`]),
    req.agent
  );
}

// ---------------------------------------------------------------------------
// Handler: dir-cache-guard (PreToolUse — mcp__filesystem__list_directory)
// Blocks redundant directory scans within a session using an in-memory cache.
// Cache miss â†’ allow + record. Cache hit â†’ block with decision:"block".
// ---------------------------------------------------------------------------

/** sessionId â†’ normalized directory paths already listed this session. */
const _dirListingCache = new Map<string, Set<string>>();
const DIR_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // evict per-session entry after 4 h

function getDirListingCache(sessionId: string): Set<string> {
  if (!_dirListingCache.has(sessionId)) {
    _dirListingCache.set(sessionId, new Set());
    setTimeout(() => _dirListingCache.delete(sessionId), DIR_CACHE_TTL_MS);
  }
  return _dirListingCache.get(sessionId)!;
}

function normalizeDirPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}

function handleDirCacheGuard(req: HookRequest): HookResponse {
  const body = req.body as Record<string, unknown>;
  const toolName = String(body.tool_name ?? body.toolName ?? "");
  if (!toolName.includes("list_directory")) return {};

  const toolInput = (body.tool_input ?? body.toolInput ?? {}) as Record<string, unknown>;
  const dirPath = String(toolInput.path ?? "").trim();
  if (!dirPath) return {};

  const sessionId = resolveSessionId(body, req.cwd);
  if (!sessionId) return {};

  const cache = getDirListingCache(sessionId);
  const key = normalizeDirPath(dirPath);

  if (cache.has(key)) {
    return {
      decision: "block",
      reason:
        `CACHE HIT: list_directory("${dirPath}") already ran this session. ` +
        `The directory contents are in your context — reuse them instead of re-scanning.`,
    };
  }

  cache.add(key);
  return {};
}

// ---------------------------------------------------------------------------
// Handler: cli-loop-guard (PostToolUse — mcp__claude-skills-cli__run_command)
// Injects a corrective hint when a CLI call exits non-zero, preventing the
// agent from blindly retrying without addressing the root cause.
// ---------------------------------------------------------------------------

interface CliGuardPattern {
  /** CLI names this pattern applies to (empty = all CLIs). */
  clis?: string[];
  exitCode: number | ((code: number) => boolean);
  stderrPattern?: RegExp;
  hint: string;
  skill?: string;
}

const CLI_GUARD_PATTERNS: CliGuardPattern[] = [
  // SSH key type — Azure rejects ed25519 at plan time
  {
    clis: ["terraform"],
    exitCode: 1,
    stderrPattern: /ed25519.*not supported|ssh-ed25519.*not supported/i,
    hint: "Azure rejected the ed25519 SSH key. Regenerate with RSA-4096:\n  ssh-keygen -t rsa -b 4096 -f <path> -N \"\"",
  },
  // Terraform: working dir not initialized
  {
    clis: ["terraform"],
    exitCode: 255,
    hint: "terraform exitCode=255 — working directory not initialized. Run: terraform init -input=false",
  },
  // Azure / any cloud — authorization failure
  {
    exitCode: (c) => c !== 0,
    stderrPattern: /AuthorizationFailed|403 Forbidden|does not have authorization/i,
    hint: "Authorization failed (403). The executing identity lacks the required role.\nâ†’ Invoke skill: azure-rbac-diagnostics",
    skill: "azure-rbac-diagnostics",
  },
  // kubectl / helm — connection refused or kubeconfig missing
  {
    clis: ["kubectl", "helm"],
    exitCode: (c) => c !== 0,
    stderrPattern: /connection refused|Unable to connect|kubeconfig/i,
    hint: "Kubernetes connection failed. Check kubeconfig is set and the cluster API server is reachable:\n  kubectl config current-context",
  },
  // git — merge conflict or lock file
  {
    clis: ["git"],
    exitCode: (c) => c !== 0,
    stderrPattern: /CONFLICT|lock file|index\.lock/i,
    hint: "git conflict or lock detected. Resolve conflicts manually or remove .git/index.lock if left by a crashed process.",
  },
  // gh CLI — auth required
  {
    clis: ["gh"],
    exitCode: (c) => c !== 0,
    stderrPattern: /not logged in|authentication required|gh auth login/i,
    hint: "GitHub CLI not authenticated. Run: gh auth login",
  },
  // Git Bash MSYS path mangling — leading slash converted to C:/Program Files/Git/
  {
    exitCode: (c) => c !== 0,
    stderrPattern: /C:\/Program Files\/Git\/subscriptions|segment at position 0 didn't match|parsing segment.*staticSubscriptions/i,
    hint:
      "Git Bash is mangling the leading slash in Azure resource IDs " +
      "(e.g. /subscriptions/... â†’ C:/Program Files/Git/subscriptions/...).\n" +
      "Fix: pass env: { MSYS_NO_PATHCONV: \"1\" } in the run_command call, " +
      "OR switch to PowerShell for this command.",
  },
  // Timed-out command
  {
    exitCode: (c) => c !== 0,
    stderrPattern: /timed out|timeout expired/i,
    hint: "Command timed out. Increase the timeout parameter (max 1800000ms = 30min) or break the operation into smaller steps.",
  },
];

function extractCliGuardFields(body: Record<string, unknown>): {
  cli: string; exitCode: number | null; stderr: string;
} {
  const toolInput = (body.tool_input ?? body.toolArgs ?? body.toolInput ?? {}) as Record<string, unknown>;
  const cli = String(toolInput.cli ?? "");
  const response = String(body.tool_response ?? body.toolResult ?? body.tool_result ?? "");
  const exitCodeMatch = response.match(/exitCode:\s*(-?\d+)/);
  const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : null;
  const stderrMatch = response.match(/stderr:\n([\s\S]*?)(?=\nexitCode:|$)/);
  const stderr = stderrMatch ? stderrMatch[1] : "";
  return { cli, exitCode, stderr };
}

function handleCliLoopGuard(req: HookRequest): HookResponse {
  const body = req.body as Record<string, unknown>;
  const toolName = String(body.tool_name ?? body.toolName ?? "");
  if (!toolName.includes("run_command")) return {};

  const { cli, exitCode, stderr } = extractCliGuardFields(body);
  if (exitCode === null || exitCode === 0) return {};

  for (const pattern of CLI_GUARD_PATTERNS) {
    if (pattern.clis && pattern.clis.length > 0 && !pattern.clis.includes(cli)) continue;
    const codeMatch = typeof pattern.exitCode === "function"
      ? pattern.exitCode(exitCode)
      : pattern.exitCode === exitCode;
    if (!codeMatch) continue;
    if (pattern.stderrPattern && !pattern.stderrPattern.test(stderr)) continue;

    const lines = [`⚠ CLI guard (\`${cli}\` exited ${exitCode}):`, pattern.hint];
    if (pattern.skill) lines.push(`â†’ Invoke skill: ${pattern.skill}`);
    return promptOutput(lines.join("\n"), req.agent);
  }

  // Check learned patterns from cli-guard-patterns.json (auto-generated by cliGuardLearner).
  // These use simple substring matching — safe for dynamically-written content.
  try {
    const learned = loadLearnedPatternsForHook();
    for (const p of learned) {
      if (p.needsReview) continue; // not yet actionable
      if (p.clis.length > 0 && !p.clis.includes(cli)) continue;
      if (p.exitCode !== null && p.exitCode !== exitCode) continue;
      if (p.stderrSubstring && !stderr.toLowerCase().includes(p.stderrSubstring.toLowerCase())) continue;
      return promptOutput(`⚠ CLI guard (learned, \`${cli}\` exited ${exitCode}):\n${p.hint}`, req.agent);
    }
  } catch { /* non-fatal — learned patterns are best-effort */ }

  return {};
}

// ---------------------------------------------------------------------------
// Handler: mcp-error-guard (PostToolUse — mcp__filesystem__*)
// Fires on failed filesystem MCP tool calls and injects a corrective hint.
// Static patterns cover the most common errors; learned patterns from
// mcp-guard-patterns.json cover repeated project-specific failures.
// ---------------------------------------------------------------------------

interface McpErrorPattern {
  tools?: string[];
  errorPattern: RegExp;
  hint: string;
}

const MCP_ERROR_PATTERNS: McpErrorPattern[] = [
  {
    errorPattern: /outside allowed directories/i,
    hint:
      "Path is outside the MCP server's allowed directories.\n" +
      "Pass an absolute path inside the workspace root, or add the directory to allowedDirs in the MCP filesystem config.",
  },
  {
    errorPattern: /ENOENT|no such file or directory/i,
    hint:
      "File or directory not found (ENOENT). Verify the path exists first.\n" +
      "Use search_files to locate it:\n" +
      "  mcp__filesystem__search_files({ path: \"<root>\", pattern: \"<filename>\" })",
  },
  {
    errorPattern: /EACCES|permission denied/i,
    hint: "Permission denied (EACCES). The MCP server process lacks access to this path.\nCheck file ownership and permissions.",
  },
  {
    errorPattern: /EISDIR/i,
    hint: "Path is a directory, not a file. Use list_directory instead of read_file for directories.",
  },
  {
    errorPattern: /ENOSPC/i,
    hint: "No space left on device (ENOSPC). Free up disk space before writing.",
  },
  {
    errorPattern: /EROFS/i,
    hint: "Read-only filesystem (EROFS). Cannot write — the filesystem is mounted read-only.",
  },
  {
    tools: ["search_in_file"],
    errorPattern: /Invalid regex/i,
    hint: String.raw`Invalid regex pattern for search_in_file. Escape special characters (., *, +, ?, (, ), [, ], {, }, ^, $, |, \\) with a backslash.`,
  },
  {
    errorPattern: /Access denied/i,
    hint:
      "MCP filesystem access denied. The requested path is not in the allowed directories list.\n" +
      "Use an absolute path inside the workspace root.",
  },
];

function handleMcpErrorGuard(req: HookRequest): HookResponse {
  const body = req.body as Record<string, unknown>;
  const toolName = String(body.tool_name ?? body.toolName ?? "");
  if (!toolName.includes("mcp__filesystem__")) return {};

  const isError = body.is_error === true || body.isError === true;
  if (!isError) return {};

  const errorMessage = String(body.tool_response ?? body.toolResult ?? body.tool_result ?? "");
  if (!errorMessage) return {};

  const shortTool = toolName.split("__").pop() ?? "";

  for (const pattern of MCP_ERROR_PATTERNS) {
    if (pattern.tools && !pattern.tools.includes(shortTool)) continue;
    if (pattern.errorPattern.test(errorMessage)) {
      return promptOutput(`⚠ MCP filesystem guard (\`${shortTool}\`):\n${pattern.hint}`, req.agent);
    }
  }

  try {
    const learned = loadMcpPatternsForHook();
    for (const p of learned) {
      if (p.needsReview) continue;
      if (p.clis.length > 0 && !p.clis.includes(shortTool)) continue;
      if (p.stderrSubstring && !errorMessage.toLowerCase().includes(p.stderrSubstring.toLowerCase())) continue;
      return promptOutput(`⚠ MCP filesystem guard (learned, \`${shortTool}\`):\n${p.hint}`, req.agent);
    }
  } catch { /* non-fatal — learned patterns are best-effort */ }

  return {};
}

// ---------------------------------------------------------------------------
// Handler: file-split-advisor (PostToolUse — mcp__filesystem__read_file)
// ---------------------------------------------------------------------------

const SPLIT_WARN_BYTES = 50 * 1024;   // 50 KB — gentle nudge
const SPLIT_CRIT_BYTES = 200 * 1024;  // 200 KB — strong push
const SPLIT_WARN_LINES = 500;
const SPLIT_CRIT_LINES = 1500;
const SPLIT_MAX_HINTS_PER_SESSION = 2;
const SPLIT_STATE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface SplitRecord {
  timesLarge: number;
  firstSeen: string;
  lastSeen: string;
  lastBytes: number;
  lastLines: number;
}

interface SessionReadEntry {
  count: number;
  ts: string;
}

interface FileSplitStore {
  files: Record<string, SplitRecord>;
  sessionReads: Record<string, SessionReadEntry>;
}

function inferSplitPoints(content: string): {
  types: string[]; utils: string[]; consts: string[]; rest: string[];
} {
  const lines = content.split("\n");
  const exports_: string[] = [];
  const patterns = [
    /^export\s+(?:default\s+)?(?:async\s+)?(?:function|class)\s+(\w+)/,
    /^export\s+(?:const|let|var)\s+(\w+)/,
    /^export\s+(?:interface|type|enum)\s+(\w+)/,
    /^(?:async\s+)?function\s+(\w+)/,
    /^class\s+(\w+)/,
    /^def\s+(\w+)/,
    /^class\s+(\w+):$/,
  ];
  for (const line of lines) {
    for (const re of patterns) {
      const m = line.match(re);
      if (m?.[1] && !exports_.includes(m[1])) {
        exports_.push(m[1]);
        if (exports_.length >= 8) break;
      }
    }
    if (exports_.length >= 8) break;
  }
  const types  = exports_.filter(n => /type|interface|enum|model|schema|dto/i.test(n));
  const utils  = exports_.filter(n => /util|helper|format|parse|convert|calc/i.test(n));
  const consts = exports_.filter(n => /const|config|setting|option|default/i.test(n));
  const rest   = exports_.filter(n => !types.includes(n) && !utils.includes(n) && !consts.includes(n));
  return { types, utils, consts, rest };
}

function buildSplitHint(filePath: string, bytes: number, lineCount: number, sessionReads: number, content: string): string {
  const ext  = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const dir  = path.dirname(filePath);
  const isHuge = bytes >= SPLIT_CRIT_BYTES || lineCount >= SPLIT_CRIT_LINES;
  const sizeLabel = bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
  const severity = isHuge ? "ðŸ”´ LARGE FILE" : "⚠ï¸  LARGE FILE";

  const { types, utils, consts, rest } = inferSplitPoints(content);
  const suggestedModules: string[] = [];
  if (types.length)  suggestedModules.push(`${base}.types${ext}     — ${types.slice(0, 3).join(", ")}`);
  if (consts.length) suggestedModules.push(`${base}.constants${ext} — ${consts.slice(0, 3).join(", ")}`);
  if (utils.length)  suggestedModules.push(`${base}.utils${ext}     — ${utils.slice(0, 3).join(", ")}`);
  if (rest.length)   suggestedModules.push(`${base}.core${ext}      — ${rest.slice(0, 4).join(", ")}`);
  if (!suggestedModules.length) {
    suggestedModules.push(
      `${base}.types${ext}     — interfaces, enums, type aliases`,
      `${base}.utils${ext}     — pure helper functions`,
      `${base}.constants${ext} — constants and configuration`,
    );
  }

  const escalation = sessionReads >= 2
    ? `\nâ™»ï¸  Read ${sessionReads}Ã— this session — every repeat read costs ~${Math.round(bytes / 4 / 1000)}k tokens. Split now to make future reads cheap.\n`
    : "";

  return [
    `${severity}: \`${path.basename(filePath)}\` is ${sizeLabel} / ${lineCount} lines.`,
    escalation,
    `**Recommended split layout in \`${dir}/\`:**`,
    ...suggestedModules.map(m => `  - \`${m}\``),
    `  - \`${base}${ext}\`          — main entry point (imports + re-exports only)`,
    ``,
    `**Steps (use MCP filesystem tools):**`,
    `1. Extract each group into its dedicated file with \`mcp__filesystem__write_file\``,
    `2. Update \`${base}${ext}\` to \`export * from "./${base}.types${ext.replace(".", "")}";\` etc.`,
    `3. Remove the extracted code from the original file`,
    ``,
    `Splitting reduces per-read token cost and prevents reasoning loops on large files.`,
  ].join("\n");
}

function extractReadFileContent(toolResponse: unknown): string | null {
  if (!toolResponse) return null;
  if (typeof toolResponse === "string") {
    try {
      const p = JSON.parse(toolResponse) as Record<string, unknown>;
      if (Array.isArray(p.content)) return (p.content as Array<{ text?: string }>).map(c => c.text ?? "").join("");
      if (typeof p.text === "string") return p.text;
      return toolResponse;
    } catch { return toolResponse; }
  }
  if (typeof toolResponse === "object") {
    const tr = toolResponse as Record<string, unknown>;
    if (Array.isArray(tr.content)) return (tr.content as Array<{ text?: string }>).map(c => c.text ?? "").join("");
    if (typeof tr.text === "string") return tr.text;
  }
  return null;
}

function handleFileSplitAdvisor(req: HookRequest): HookResponse {
  const body = req.body as Record<string, unknown>;
  const cwd = req.cwd;
  if (!cwd) return {};

  const toolName = String(body.tool_name ?? body.toolName ?? "").toLowerCase();
  if (!toolName.includes("read_file")) return {};

  const toolInput = (body.tool_input ?? body.toolInput ?? {}) as Record<string, unknown>;
  const filePath = typeof toolInput.path === "string" ? toolInput.path : undefined;
  if (!filePath) return {};

  const content = extractReadFileContent(body.tool_response ?? body.toolResult ?? body.tool_result);
  if (!content) return {};

  const bytes = Buffer.byteLength(content, "utf-8");
  const lineCount = content.split("\n").length;
  if (bytes < SPLIT_WARN_BYTES && lineCount < SPLIT_WARN_LINES) return {};

  const storeFile = path.join(cwd, ".claude", "learning", "file-split-advisor.json");
  const storeRaw = (() => { try { return JSON.parse(fs.readFileSync(storeFile, "utf-8")) as FileSplitStore; } catch { return null; } })();
  const store: FileSplitStore = {
    files: storeRaw?.files ?? {},
    sessionReads: storeRaw?.sessionReads ?? {},
  };

  const sid = resolveSessionId(body, cwd) || "unknown";
  const sessionKey = `${sid}|${filePath}`;

  // Count reads this session
  const prevEntry = store.sessionReads[sessionKey];
  const prevReads = prevEntry?.count ?? 0;
  store.sessionReads[sessionKey] = { count: prevReads + 1, ts: new Date().toISOString() };

  // Update learning record
  const rec: SplitRecord = store.files[filePath] ?? { timesLarge: 0, firstSeen: new Date().toISOString(), lastSeen: "", lastBytes: 0, lastLines: 0 };
  rec.timesLarge  = (rec.timesLarge ?? 0) + 1;
  rec.lastSeen    = new Date().toISOString();
  rec.lastBytes   = bytes;
  rec.lastLines   = lineCount;
  store.files[filePath] = rec;

  // Prune old entries
  const now = Date.now();
  for (const [k, v] of Object.entries(store.files)) {
    if (!v.lastSeen || now - new Date(v.lastSeen).getTime() > SPLIT_STATE_MAX_AGE_MS) {
      delete store.files[k];
    }
  }
  for (const [k, v] of Object.entries(store.sessionReads)) {
    if (now - new Date(v.ts).getTime() > 24 * 60 * 60 * 1000) {
      delete store.sessionReads[k];
    }
  }

  try {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.writeFileSync(storeFile, JSON.stringify(store, null, 2) + "\n", "utf-8");
  } catch { /* non-fatal */ }

  const currentReads = prevReads + 1;
  const hint = buildSplitHint(filePath, bytes, lineCount, currentReads, content);

  // First read: advisory suggestion — inform the agent, let it continue.
  if (prevReads === 0) {
    return promptOutput(hint, req.agent);
  }

  // Second+ read: escalate to a mandatory blocking task.
  // Return stopTask so Claude Code halts the current chain and forces the split
  // before the agent can continue. For other agents use a hard systemPrompt.
  const escalation = [
    `ðŸ›‘ MANDATORY SPLIT REQUIRED — do not continue with the current task until complete.`,
    ``,
    `\`${path.basename(filePath)}\` has been read ${currentReads}Ã— this session at ${Math.round(bytes / 1024)}KB each time.`,
    `Every re-read burns ~${Math.round(bytes / 4 / 1000)}k tokens. This is blocking efficient execution.`,
    ``,
    hint,
    ``,
    `Complete the split now using mcp__filesystem__write_file, then resume the original task.`,
  ].join("\n");

  if (req.agent === "claude") {
    // stopTask causes Claude Code to surface the message and halt the tool chain.
    return { stopTask: true, systemPrompt: escalation };
  }

  // Cursor / Kiro / Copilot: inject as additional_context with the strongest framing.
  return {
    additional_context: escalation,
    additionalContext: escalation,
    hookSpecificOutput: escalation,
  };
}

// ---------------------------------------------------------------------------
// Handler: file-split-read-guard (PreToolUse — mcp__filesystem__read_file)
// Blocks re-reads of files already flagged as large in the split-advisor store.
// On first read the file goes through normally (PostToolUse advisor fires after).
// On subsequent reads the agent is redirected to search_in_file instead.
// ---------------------------------------------------------------------------

function handleFileSplitReadGuard(req: HookRequest): HookResponse {
  const body = req.body as Record<string, unknown>;
  const cwd = req.cwd;
  if (!cwd) return {};

  const toolName = String(body.tool_name ?? body.toolName ?? "").toLowerCase();
  if (!toolName.includes("read_file")) return {};

  const toolInput = (body.tool_input ?? body.toolInput ?? {}) as Record<string, unknown>;
  const filePath = typeof toolInput.path === "string" ? toolInput.path : undefined;
  if (!filePath) return {};

  const storeFile = path.join(cwd, ".claude", "learning", "file-split-advisor.json");
  const store = (() => { try { return JSON.parse(fs.readFileSync(storeFile, "utf-8")) as FileSplitStore; } catch { return null; } })();
  if (!store) return {};

  const sid = resolveSessionId(body, cwd) || "unknown";
  const sessionKey = `${sid}|${filePath}`;
  const prevReads = store.sessionReads[sessionKey]?.count ?? 0;

  // Only block if already read at least once this session AND the file is known large.
  if (prevReads === 0 || !store.files[filePath]) return {};

  const rec = store.files[filePath];
  const kb = Math.round((rec.lastBytes ?? 0) / 1024);

  return {
    decision: "block",
    reason: [
      `LARGE FILE GUARD: \`${path.basename(filePath)}\` (${kb}KB) has already been read ${prevReads}Ã— this session.`,
      `Full re-reads are blocked to prevent token waste (~${Math.round((rec.lastBytes ?? 0) / 4 / 1000)}k tokens each).`,
      ``,
      `Instead, use targeted reads:`,
      `  â€¢ mcp__filesystem__search_in_file({ path: "${filePath}", pattern: "<what you need>" })`,
      `  â€¢ mcp__filesystem__read_file with start_line/end_line if the server supports it`,
      ``,
      `If you must split this file first, do that now with mcp__filesystem__write_file, then read the smaller result.`,
    ].join("\n"),
  };
}



// ---------------------------------------------------------------------------
// Handler: mcp-encoding-fix (PostToolUse -- write_file / edit_file)
// ---------------------------------------------------------------------------

const MOJIBAKE_FIXES: [RegExp, string][] = [
  [/Ã¢â‚¬“/g, "—"],   // U+2014 em dash
  [/Ã¢â‚¬”/g, "–"],   // U+2013 en dash
  [/Ã¢â‚¬â„¢/g, "’"], // right single quote
  [/Ã¢â‚¬Å“/g, "“"], // left double quote
  [/Ã¢â‚¬/g, "”"],  // right double quote
  [/Ã¢â‚¬Â¦/g, "…"],  // ellipsis
  [/Ã¢â€ ’/g, "â†’"],  // right arrow
  [/Ã¢â€ —/g, "â†—"],  // north east arrow
  [/Ã¢â€ /g, "â†"],   // left arrow
  [/Ã‚·/g, "·"],   // middle dot
  [/Ãƒ—/g, "Ã—"],   // multiplication sign
  [/Ã¢â€°Â¥/g, "â‰¥"],  // greater-than or equal
  [/Ã¢â€°Â¤/g, "â‰¤"],  // less-than or equal
  [/Ã¢Ë†’/g, "âˆ’"],  // minus sign
  [/Ã¢Å““/g, "âœ“"],  // check mark
  [/Ã¢Å“—/g, "âœ—"],  // ballot x
  [/Ã¢“â€š/g, "â”‚"],  // box drawings light vertical
  [/Ã¢“â‚¬/g, "â”€"],  // box drawings light horizontal
  [/Ã¢–Â¼/g, "â–¼"],  // black down-pointing triangle
  [/ï»¿/g, ""], // UTF-8 BOM
];

function hasMojibake(content: string): boolean {
  for (const [pattern] of MOJIBAKE_FIXES) {
    pattern.lastIndex = 0;
    if (pattern.exec(content) !== null) {
      pattern.lastIndex = 0;
      return true;
    }
  }
  return false;
}

function fixMojibake(content: string): string {
  let fixed = content;
  for (const [pattern, replacement] of MOJIBAKE_FIXES) {
    pattern.lastIndex = 0;
    fixed = fixed.replace(pattern, replacement);
  }
  return fixed;
}

const ENCODING_FIX_TOOL_NAMES = new Set([
  "write_file", "edit_file", "str_replace_based_edit_tool",
  "create_file", "overwrite_file", "replace_in_file",
]);
const ENCODING_FIX_TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".ts", ".js", ".json", ".yaml", ".yml",
  ".html", ".css", ".sh", ".ps1", ".py", ".toml",
]);

function handleMcpEncodingFix(req: HookRequest): HookResponse {
  const body = req.body as Record<string, unknown>;
  const toolName = String(body.tool_name ?? body.toolName ?? "");
  if (!ENCODING_FIX_TOOL_NAMES.has(toolName)) {
    return {};
  }
  const toolInput = (body.tool_input ?? body.toolInput ?? body.input ?? {}) as Record<string, unknown>;
  const filePath = String(toolInput.path ?? toolInput.file_path ?? toolInput.filepath ?? "");
  if (!filePath) {
    return {};
  }
  const ext = path.extname(filePath).toLowerCase();
  if (!ENCODING_FIX_TEXT_EXTENSIONS.has(ext)) {
    return {};
  }
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(req.cwd, filePath);
  try {
    const raw = fs.readFileSync(resolved, "utf-8");
    if (!hasMojibake(raw)) {
      return {};
    }
    const fixed = fixMojibake(raw);
    fs.writeFileSync(resolved, fixed, "utf-8");
    return { hookMessage: `[encoding-fix] Fixed Mojibake in ${path.basename(resolved)}` };
  } catch {
    return {};
  }
}

function extractPromptContent(resp: HookResponse, agent: string): string {
  if (agent === "cursor" || agent === "kiro") {
    const v = resp.additional_context ?? resp.additionalContext;
    return typeof v === "string" ? v : "";
  }
  return typeof resp.systemMessage === "string" ? resp.systemMessage : "";
}

// Per-session counter: how many times we surfaced skill proposals this session.
const _sessionProposalSurfaceCount = new Map<string, number>();
// Per-session set: names of skills surfaced via _detectOpportunity (OPPORTUNITY_SIGNALS path).
// Merged into proposalOutcome.jsonl at session-stop so dormancy counts them correctly.
const _sessionOpportunityProposals = new Map<string, Set<string>>();

// Keyword → installed-skill opportunity mapping (single source of truth for both prompt handlers)
const OPPORTUNITY_SIGNALS: ReadonlyArray<{ pattern: RegExp; skill: string; label: string }> = [
  { pattern: /kubectl|kubernetes|helm\b/i,                          skill: "k3s-kuberocketci",               label: "Kubernetes/kubectl" },
  { pattern: /terraform\b|\.tf\b/i,                                skill: "terraform-plan-review",           label: "Terraform" },
  { pattern: /github.actions|\.github\/workflows/i,                skill: "github-actions-ci",               label: "GitHub Actions" },
  { pattern: /gitlab.ci|\.gitlab-ci\.yml/i,                        skill: "gitlab-pipeline-ops",             label: "GitLab CI" },
  { pattern: /az\s+(webapp|aks|deploy)|bicep\b/i,                  skill: "azure-resource-ops",              label: "Azure deploy" },
  { pattern: /vitest\b|\.bench\.test\.|\.solo\.test\./i,           skill: "vitest-extension-testing",        label: "Vitest test" },
  { pattern: /vsce\b|vsix\b|vscode.*publish/i,                     skill: "vscode-extension-publishing",     label: "VS Code publish" },
  { pattern: /ovsx\b|open.vsx|cursor.*extension|kiro.*extension/i, skill: "cursor-kiro-extension-publishing",label: "Open VSX publish" },
  { pattern: /kusto\b|kql\b|adx\b/i,                              skill: "adx-schema-check",                label: "ADX/KQL" },
  { pattern: /generate.*pdf|extract.*pdf|\.pdf\b/i,               skill: "pdf",                              label: "PDF workflow" },
];

// ---------------------------------------------------------------------------
// Session Coach state — tracks hints shown per session to enforce the 3-per-session cap
// ---------------------------------------------------------------------------

/** Tracks { hintsShown, promptIndex } per session */
const _sessionCoachState = new Map<string, { hintsShown: number; promptIndex: number }>();

const SESSION_COACH_MAX_HINTS = 3;

/**
 * Analyzes the current prompt for quality, records the result, and returns a
 * coaching hint string when:
 *   1. The prompt quality is low enough to warrant advice
 *   2. The relevant metric's cooldown has not fired
 *   3. The per-session hint cap (3) has not been reached
 *   4. The hint has not already been shown this session for this metric
 *
 * Also: runs `analyzePrompt` and persists the record unconditionally (for dashboard).
 */
function handleSessionCoach(req: HookRequest, promptText: string): string {
  const cwd = req.cwd;
  if (!cwd || !promptText.trim()) return "";

  const body = req.body as Record<string, unknown>;
  const sessionId = resolveSessionId(body, cwd) || "unknown";

  const state = _sessionCoachState.get(sessionId) ?? { hintsShown: 0, promptIndex: 0 };
  state.promptIndex++;
  _sessionCoachState.set(sessionId, state);

  // Always record prompt quality for dashboard (no hint cap here)
  const analysis = analyzePrompt(promptText, sessionId, state.promptIndex);
  try { appendPromptRecord(cwd, analysis); } catch { /* non-fatal */ }

  const coachCfg = readCoachConfig();
  if (!coachCfg.enabled) return ""; // still recorded quality above; hints suppressed by user config

  // Evaluate whether prior coaching advice improved the score (wires the cooldown/decay loop).
  if (state.promptIndex > 2) {
    try { evaluateAdviceOutcome(cwd, "promptClarity", analysis.score); } catch { /* non-fatal */ }
  }

  // Don't coach on every prompt — skip the first prompt of a session (usually task setup)
  // and don't re-coach until the quality is actually below threshold
  if (state.promptIndex === 1 || state.hintsShown >= coachCfg.maxHintsPerSession) return "";

  // HIGH PRIORITY: multi-goal prompts cause the worst score collapse (0–28).
  // Surface before HACE hints and before the score≥65 gate so it always fires when present.
  const mgAP = analysis.antiPatterns.find(ap => ap.type === "multi_goal" && ap.severity === "high");
  if (mgAP) {
    const shown = recordAdviceShown(cwd, "promptClarity", analysis.score, mgAP.advice);
    if (shown) {
      state.hintsShown++;
      _sessionCoachState.set(sessionId, state);
      return `[Prompt Coach] ${mgAP.evidence} — ${mgAP.advice}`;
    }
  }

  if (analysis.score >= 65) return ""; // good enough — no coaching needed

  // Read current HACE scores from the last hace-session record for metric targeting
  let haceScores: Parameters<typeof getSessionCoachHints>[1] | null = null;
  try {
    const haceFile = path.join(cwd, ".claude", "learning", "hace-sessions.jsonl");
    const lines = fs.readFileSync(haceFile, "utf-8").split("\n").filter(Boolean);
    if (lines.length > 0) {
      const last = JSON.parse(lines[lines.length - 1]) as Record<string, number>;
      haceScores = {
        promptClarityScore:    last.promptClarityScore    ?? 50,
        taskVelocityScore:     last.taskVelocityScore     ?? 50,
        accuracyScore:         last.accuracyScore         ?? 50,
        resolutionVelocityScore: last.resolutionVelocityScore ?? 50,
        skillLeverageScore:    last.skillLeverageScore    ?? 50,
        cliEfficiencyScore:    last.cliEfficiencyScore    ?? 95,
      };
    }
  } catch { /* non-fatal — HACE data may not exist yet */ }

  if (!haceScores) return "";

  const hints = getSessionCoachHints(cwd, haceScores, promptText);

  for (const hint of hints) {
    if (!shouldShowAdvice(cwd, hint.metric)) continue; // in cooldown

    const shown = recordAdviceShown(cwd, hint.metric, haceScores[`${hint.metric}Score` as never] as number ?? 50, hint.message);
    if (!shown) continue; // cooldown says no

    state.hintsShown++;
    _sessionCoachState.set(sessionId, state);
    return `[HACE Coach] ${hint.message}`;
  }

  // Fall back: surface a prompt-quality-specific recommendation if no metric hint fired
  if (analysis.recommendations[0] && state.hintsShown < coachCfg.maxHintsPerSession) {
    state.hintsShown++;
    _sessionCoachState.set(sessionId, state);
    return `[Prompt Coach] Quality: ${analysis.score}/100 — ${analysis.recommendations[0]}`;
  }

  return "";
}

const NEGATION_WORDS = /\b(not|no|don'?t|doesn'?t|avoid|without|skip|never|instead|rather\s+than)\b/i;

/** Returns true when the matched signal keyword appears in a negated context ("don't use terraform"). */
export function signalIsNegated(text: string, signal: RegExp): boolean {
  const m = signal.exec(text);
  if (!m) return false;
  const sentenceStart = text.lastIndexOf(". ", m.index);
  const start = sentenceStart === -1 ? 0 : sentenceStart + 2;
  const end = text.indexOf(". ", m.index + m[0].length);
  const sentence = text.slice(start, end === -1 ? text.length : end);
  return NEGATION_WORDS.test(sentence);
}

function _detectOpportunity(
  cwd: string,
  promptText: string,
  sessionId: string | undefined,
  proposedCount: number,
): string {
  const { shouldPropose, reason } = shouldSurfaceProposals(promptText, proposedCount);
  if (!shouldPropose) return "";

  const installedSkills = new Set<string>();
  try {
    const skillsDir = path.join(cwd, ".claude", "skills");
    for (const d of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (d.isDirectory()) installedSkills.add(d.name);
    }
  } catch { /* non-fatal */ }

  const proposedSkills = new Set((readTaskSkillProposals(cwd)?.proposals ?? []).map(p => p.name));

  for (const { pattern, skill, label } of OPPORTUNITY_SIGNALS) {
    if (!pattern.test(promptText) || signalIsNegated(promptText, pattern)) continue;
    if (!installedSkills.has(skill)) continue;
    if (proposedSkills.has(skill)) continue;
    if (isDormantSkill(cwd, skill)) continue;

    if (sessionId) {
      _sessionProposalSurfaceCount.set(sessionId, proposedCount + 1);
      if (!_sessionOpportunityProposals.has(sessionId)) _sessionOpportunityProposals.set(sessionId, new Set());
      _sessionOpportunityProposals.get(sessionId)!.add(skill);
    }
    return `[Skill Opportunity] ${label} detected — invoke the \`${skill}\` skill to accelerate this task. (${reason})`;
  }
  return "";
}

/**
 * Skill Opportunity Detection — fires on UserPromptSubmit.
 * Reads the user's prompt from the transcript tail then delegates to _detectOpportunity.
 * Only fires for installed skills not yet proposed and not dormant.
 */
function handleSkillOpportunity(req: HookRequest): string {
  const body = req.body as Record<string, unknown>;
  const cwd = req.cwd;
  if (!cwd) return "";

  const sessionId = resolveSessionId(body, cwd);
  const proposedCount = sessionId ? (_sessionProposalSurfaceCount.get(sessionId) ?? 0) : 0;

  // Extract prompt text from transcript tail
  let promptText = "";
  const transcriptPath = typeof body.transcript_path === "string" ? body.transcript_path : undefined;
  if (transcriptPath) {
    try {
      const lines = fs.readFileSync(transcriptPath, "utf-8").split("\n").filter(Boolean).slice(-20);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]) as Record<string, unknown>;
          if (entry.type === "user") {
            const content = (entry.message as Record<string, unknown>)?.content;
            if (Array.isArray(content)) {
              const text = (content as Array<Record<string, unknown>>)
                .filter(c => c.type === "text")
                .map(c => String(c.text ?? "")).join(" ");
              if (text.trim()) { promptText = text; break; }
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* non-fatal */ }
  }

  if (!promptText) return "";
  return _detectOpportunity(cwd, promptText, sessionId, proposedCount);
}

function handlePromptContext(req: HookRequest): HookResponse {
  // Extract current prompt text once — shared by opportunity detection and session coach
  let promptText = "";
  const body = req.body as Record<string, unknown>;
  const transcriptPath = typeof body.transcript_path === "string" ? body.transcript_path : undefined;
  if (transcriptPath) {
    try {
      const lines = fs.readFileSync(transcriptPath, "utf-8").split("\n").filter(Boolean).slice(-20);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]) as Record<string, unknown>;
          if (entry.type === "user") {
            const content = (entry.message as Record<string, unknown>)?.content;
            if (Array.isArray(content)) {
              const text = (content as Array<Record<string, unknown>>)
                .filter(c => c.type === "text")
                .map(c => String(c.text ?? "")).join(" ");
              if (text.trim()) { promptText = text; break; }
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* non-fatal */ }
  }

  // Fallback: some Claude Code versions / environments include the prompt inline in the
  // hook body when transcript_path is absent or the JSONL extraction yields nothing.
  if (!promptText.trim()) {
    const b = req.body as Record<string, unknown>;
    const inline = b.message ?? b.prompt ?? b.content ?? b.input;
    if (typeof inline === "string") {
      promptText = inline;
    } else if (Array.isArray(inline)) {
      promptText = (inline as Array<Record<string, unknown>>)
        .filter(c => c.type === "text")
        .map(c => String(c.text ?? "")).join(" ");
    } else if (inline && typeof inline === "object") {
      const c = (inline as Record<string, unknown>).content;
      if (typeof c === "string") promptText = c;
      else if (Array.isArray(c)) {
        promptText = (c as Array<Record<string, unknown>>)
          .filter(x => x.type === "text")
          .map(x => String(x.text ?? "")).join(" ");
      }
    }
  }

  const coachHint   = handleSessionCoach(req, promptText);
  const opportunity = (() => {
    const cwd = req.cwd;
    if (!cwd) return "";
    const sessionId = resolveSessionId(req.body as Record<string, unknown>, cwd);
    const proposedCount = sessionId ? (_sessionProposalSurfaceCount.get(sessionId) ?? 0) : 0;
    if (promptText) return _detectOpportunity(cwd, promptText, sessionId, proposedCount);
    return handleSkillOpportunity(req); // fallback: re-extract prompt from transcript
  })();

  const parts = [
    coachHint,
    opportunity,
    extractPromptContent(handleSessionSize(req), req.agent),
    extractPromptContent(handleContextFocus(req), req.agent),
    extractPromptContent(handlePracticalFocus(req), req.agent),
  ].filter(Boolean);
  if (parts.length === 0) return {};
  return promptOutput(parts.join("\n\n"), req.agent);
}

export async function handleHookRequest(req: HookRequest): Promise<HookResponse> {
  switch (req.hookName) {
    case "skill-invoke": return handleSkillInvoke(req);
    case "prompt-context": return handlePromptContext(req);
    // Keep individual cases as fallbacks for existing installations not yet upgraded
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
    case "cli-loop-guard": return Promise.resolve(handleCliLoopGuard(req));
    case "dir-cache-guard": return Promise.resolve(handleDirCacheGuard(req));
    case "mcp-error-guard": return Promise.resolve(handleMcpErrorGuard(req));
    case "file-split-advisor": return Promise.resolve(handleFileSplitAdvisor(req));
    case "file-split-read-guard": return Promise.resolve(handleFileSplitReadGuard(req));
    case "mcp-encoding-fix": return Promise.resolve(handleMcpEncodingFix(req));
    case "session-stop": return Promise.resolve(handleSessionStop(req));
    default: return {};
  }
}

// ---------------------------------------------------------------------------
// Handler: session-stop (PreSessionStop / Stop)
// Writes a proposalOutcome record for every session — including zero-invocation
// sessions — so the learning loop can track non-use and decay confidence.
// ---------------------------------------------------------------------------

function handleSessionStop(req: HookRequest): HookResponse {
  const body = req.body as Record<string, unknown>;
  const cwd = req.cwd;
  if (!cwd) return {};

  const sessionId = resolveSessionId(body, cwd);
  if (!sessionId) return {};

  try {
    // Pass skills surfaced via OPPORTUNITY_SIGNALS so they're counted in dormancy tracking.
    const opportunityNames = [...(_sessionOpportunityProposals.get(sessionId) ?? [])];
    _sessionOpportunityProposals.delete(sessionId);
    recordSessionProposalOutcome(cwd, sessionId, opportunityNames);
  } catch { /* non-fatal */ }

  // Record per-skill rejection feedback for every not-invoked proposal
  try {
    const proposalsFile = path.join(cwd, ".claude", "learning", "task-skill-proposals.json");
    const proposalsData = JSON.parse(fs.readFileSync(proposalsFile, "utf-8")) as {
      proposals?: { name: string }[];
      generatedAt?: string;
    };
    // Mirror the 4-hour staleness gate used by recordSessionProposalOutcome so that
    // recommendation-feedback.jsonl only logs proposals that were actually fresh enough
    // to have been shown this session. Without this check, stale proposals from a prior
    // session would be written as "ignored", inflating ignore counts for FP suppression.
    const ageMs = proposalsData.generatedAt
      ? Date.now() - new Date(proposalsData.generatedAt).getTime()
      : Infinity;
    if (ageMs < 4 * 60 * 60 * 1000) {
      const proposedNames = proposalsData.proposals?.map((p) => p.name) ?? [];
      if (proposedNames.length > 0) {
        const invoked = readCachedEnrichedRuns(cwd)
          .filter(r => r.session_id === sessionId)
          .map(r => r.skill);
        recordSessionRejectionFeedback(cwd, sessionId, proposedNames, invoked);
      }
    }
  } catch { /* non-fatal */ }

  // Snapshot HACE metrics on every session stop so hace-sessions.jsonl accumulates
  // trend data without requiring the dashboard panel to be open.
  setImmediate(() => {
    try { computeEfficiencyMetrics(cwd, 14); } catch { /* non-fatal */ }
  });

  return {};
}
