#!/usr/bin/env node
/**
 * PostToolUse hook (Attribution v2): log explicit Skill tool invocations to runs.jsonl.
 * Supports Claude Code, Cursor, Kiro (stdin + USER_PROMPT), and GitHub Copilot.
 *
 * Usage: node skill-invoke-watch.js [claude|cursor|kiro|copilot]
 */
const fs = require("fs");
const path = require("path");

const SOURCE = "skill-invoke-hook-v2";
const VALID_AGENTS = new Set(["claude", "cursor", "kiro", "copilot"]);
const DENYLIST = new Set(["claude", "cursor", "api", "claude-api", "unknown", "base", "context", "skill", "skills", "kiro", "copilot"]);
const SKILL_FILE_PATTERNS = [
  /[\\/](?:\.claude|\.cursor|\.kiro)[\\/]skills[\\/]([a-z][a-z0-9-]*)(?:[\\/]SKILL\.md)?/i,
  /[\\/]\.cursor[\\/]skills-cursor[\\/]([a-z][a-z0-9-]*)(?:[\\/]SKILL\.md)?/i,
  /[\\/]\.agents[\\/]skills[\\/]([a-z][a-z0-9-]*)(?:[\\/]SKILL\.md)?/i,
  /[\\/]skills_library[\\/]([a-z][a-z0-9-]*)(?:[\\/]SKILL\.md)?/i,
  /[\\/]\.github[\\/]instructions[\\/]([a-z][a-z0-9-]*)\.instructions\.md/i,
];

function readStdin() {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function resolveAgent() {
  const arg = (process.argv[2] || "").toLowerCase();
  if (VALID_AGENTS.has(arg)) {
    return arg;
  }
  return "claude";
}

function plausible(name) {
  return typeof name === "string" && /^[a-z][a-z0-9-]{2,}$/.test(name) && !DENYLIST.has(name);
}

function skillFromPath(filePath) {
  if (typeof filePath !== "string") {
    return null;
  }
  for (const pattern of SKILL_FILE_PATTERNS) {
    pattern.lastIndex = 0;
    const match = filePath.match(pattern);
    if (match && plausible(match[1].toLowerCase())) {
      return match[1].toLowerCase();
    }
  }
  return null;
}

function collectPaths(toolInput) {
  const paths = [];
  if (!toolInput || typeof toolInput !== "object") {
    return paths;
  }
  if (typeof toolInput.path === "string") {
    paths.push(toolInput.path);
  }
  if (typeof toolInput.file_path === "string") {
    paths.push(toolInput.file_path);
  }
  if (typeof toolInput.filePath === "string") {
    paths.push(toolInput.filePath);
  }
  if (typeof toolInput.target_file === "string") {
    paths.push(toolInput.target_file);
  }
  if (typeof toolInput.targetFile === "string") {
    paths.push(toolInput.targetFile);
  }
  if (Array.isArray(toolInput.operations)) {
    for (const op of toolInput.operations) {
      if (op && typeof op.path === "string") {
        paths.push(op.path);
      }
    }
  }
  return paths;
}

function extractSkillName(toolName, toolInput) {
  const tool = (toolName || "").trim();
  const normalized = tool.toLowerCase();

  if (normalized === "skill" || normalized === "useskill") {
    const ti = toolInput || {};
    const candidates = [ti.skill, ti.skill_name, ti.name, ti.skillName, ti.skill_id, ti.skillId];
    for (const c of candidates) {
      if (plausible(c)) {
        return c.toLowerCase();
      }
    }
  }

  if (
    normalized === "read" ||
    normalized === "fs_read" ||
    normalized === "fileread" ||
    normalized === "filereadtool" ||
    normalized === "readtool"
  ) {
    for (const p of collectPaths(toolInput)) {
      const skill = skillFromPath(p);
      if (skill) {
        return skill;
      }
    }
  }

  return null;
}

function pricingForModel(model) {
  const lower = (model || "claude-sonnet").toLowerCase();
  const tiers = [
    { match: "fable", pricing: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 } },
    { match: "mythos", pricing: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 } },
    { match: "opus", pricing: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } },
    { match: "haiku", pricing: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 } },
    { match: "sonnet", pricing: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } },
  ];
  for (const tier of tiers) {
    if (lower.includes(tier.match)) {
      return tier.pricing;
    }
  }
  return tiers[4].pricing;
}

function estimateUsageCostUsd(usage, model) {
  if (!usage || typeof usage !== "object") {
    return 0;
  }
  const p = pricingForModel(model);
  return (
    ((usage.input_tokens || 0) / 1_000_000) * p.input +
    ((usage.output_tokens || 0) / 1_000_000) * p.output +
    ((usage.cache_creation_input_tokens || 0) / 1_000_000) * p.cacheWrite +
    ((usage.cache_read_input_tokens || 0) / 1_000_000) * p.cacheRead
  );
}

function blendedCostUsd(tokens, model) {
  const p = pricingForModel(model);
  return (tokens / 1_000_000) * ((p.input + p.output) / 2);
}

function sumUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return 0;
  }
  if (typeof usage.total_tokens === "number") {
    return usage.total_tokens;
  }
  return (
    (usage.input_tokens || 0) +
    (usage.output_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0)
  );
}

function extractUsage(normalized) {
  const tr = normalized.toolResponse;
  if (typeof tr === "string") {
    try {
      const parsed = JSON.parse(tr);
      const usage = parsed.usage || parsed.message?.usage;
      if (usage && sumUsage(usage) > 0) {
        return usage;
      }
    } catch {
      return null;
    }
  }
  if (tr && typeof tr === "object") {
    const usage = tr.usage || tr.message?.usage;
    if (usage && sumUsage(usage) > 0) {
      return usage;
    }
  }
  const msgUsage = normalized.message?.usage;
  if (msgUsage && sumUsage(msgUsage) > 0) {
    return msgUsage;
  }
  return null;
}

function extractTokens(normalized) {
  const tr = normalized.toolResponse;
  if (typeof tr === "string") {
    try {
      const parsed = JSON.parse(tr);
      const fromUsage = sumUsage(parsed.usage || parsed.message?.usage);
      if (fromUsage > 0) {
        return fromUsage;
      }
      if (typeof parsed.text === "string" && parsed.text.length > 0) {
        return Math.max(1, Math.round(parsed.text.length / 4));
      }
    } catch {
      if (tr.length > 0) {
        return Math.max(1, Math.round(tr.length / 4));
      }
      return 0;
    }
  }
  if (tr && typeof tr === "object") {
    const usage = tr.usage || tr.message?.usage;
    if (usage) {
      return sumUsage(usage);
    }
    const text =
      tr.textResultForLlm ||
      tr.text_result_for_llm ||
      (Array.isArray(tr.result) ? tr.result.join("\n") : typeof tr.result === "string" ? tr.result : "");
    if (typeof text === "string" && text.length > 0) {
      return Math.max(1, Math.round(text.length / 4));
    }
  }
  return sumUsage(normalized.message?.usage);
}

function resolveCwd(raw) {
  if (raw.cwd) {
    return raw.cwd;
  }
  if (Array.isArray(raw.workspace_roots) && raw.workspace_roots[0]) {
    return raw.workspace_roots[0];
  }
  if (raw.workingDirectory || raw.working_directory) {
    return raw.workingDirectory || raw.working_directory;
  }
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function resolveSessionId(raw) {
  return (
    raw.session_id ||
    raw.sessionId ||
    raw.conversation_id ||
    raw.conversationId ||
    raw.sessionID ||
    raw.generation_id ||
    raw.generationId ||
    (raw.tool_use_id && raw.cwd ? `${raw.cwd}|${raw.tool_use_id}` : "") ||
    (raw.toolUseId && raw.cwd ? `${raw.cwd}|${raw.toolUseId}` : "") ||
    ""
  );
}

function normalizeInput(raw) {
  const cwd = resolveCwd(raw);
  const sessionId = resolveSessionId({ ...raw, cwd });
  return {
    cwd,
    sessionId,
    toolName: raw.tool_name || raw.toolName || "",
    toolInput: raw.tool_input || raw.toolArgs || raw.toolInput || {},
    toolUseId: raw.tool_use_id || raw.toolUseId || raw.tool_use?.id || "",
    toolResponse: raw.tool_response ?? raw.toolResult ?? raw.tool_result ?? raw.tool_output,
    message: raw.message,
    model: typeof raw.model === "string" ? raw.model : undefined,
  };
}

function parseKiroUserPrompt() {
  const raw = process.env.USER_PROMPT;
  if (!raw || !raw.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      cwd: process.cwd(),
      sessionId: parsed.sessionId || parsed.session_id || `kiro_${Date.now()}`,
      toolName: parsed.toolName || parsed.tool_name || "",
      toolInput: parsed.toolArgs || parsed.tool_input || parsed.toolInput || {},
      toolUseId: parsed.toolUseId || parsed.tool_use_id || "",
      toolResponse: parsed.toolResult ?? parsed.tool_response ?? parsed.tool_result,
      message: undefined,
    };
  } catch {
    return null;
  }
}

function parseHookPayload(agent) {
  const stdin = readStdin().trim();
  if (stdin) {
    try {
      return normalizeInput(JSON.parse(stdin));
    } catch {
      // fall through to Kiro env
    }
  }
  if (agent === "kiro") {
    const kiro = parseKiroUserPrompt();
    if (kiro) {
      return kiro;
    }
  }
  return null;
}

const MAX_STATE_KEYS = 3000;
const MAX_STATE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function dedupeKey(sessionId, skill, toolUseId) {
  return `${sessionId}|${skill}|${toolUseId || "na"}`;
}

function pruneState(state) {
  const now = Date.now();
  let entries = Object.entries(state).filter(([, ts]) => {
    const t = Date.parse(ts);
    return !Number.isNaN(t) && now - t < MAX_STATE_AGE_MS;
  });
  if (entries.length > MAX_STATE_KEYS) {
    entries.sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]));
    entries = entries.slice(0, MAX_STATE_KEYS);
  }
  return Object.fromEntries(entries);
}

function appendRun(cwd, record) {
  const runsFile = path.join(cwd, ".claude", "learning", "runs.jsonl");
  fs.mkdirSync(path.dirname(runsFile), { recursive: true });
  fs.appendFileSync(runsFile, JSON.stringify(record) + "\n", "utf-8");
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

/** Skills in the active task/profile set (installed minus overrides when no task file). */
function effectiveActiveSkills(cwd) {
  const task = readJsonSafe(path.join(cwd, ".claude", "learning", "task-active-skills.json"));
  if (task && Array.isArray(task.activeSkills) && task.activeSkills.length) {
    return new Set(task.activeSkills.map((s) => String(s).toLowerCase()));
  }
  const local = readJsonSafe(path.join(cwd, ".claude", "settings.local.json"));
  const overrides = (local && local.skillOverrides) || {};
  const skillsDir = path.join(cwd, ".claude", "skills");
  const installed = new Set();
  try {
    for (const ent of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (ent.isDirectory() && overrides[ent.name] !== "off") {
        installed.add(ent.name);
      }
    }
  } catch {
    // no skills dir
  }
  return installed;
}

function main() {
  const agent = resolveAgent();
  const input = parseHookPayload(agent);
  if (!input) {
    return;
  }

  const cwd = input.cwd;
  const sessionId = input.sessionId;
  if (!cwd || !sessionId) {
    return;
  }

  const skill = extractSkillName(input.toolName, input.toolInput);
  if (!skill) {
    return;
  }

  const toolUseId = input.toolUseId;
  const stateFile = path.join(cwd, ".claude", "learning", "skill-invoke-state.json");
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
  } catch {
    state = {};
  }

  const key = dedupeKey(sessionId, skill, toolUseId);
  if (state[key]) {
    return;
  }

  const usage = extractUsage(input);
  const tokens = usage ? sumUsage(usage) : extractTokens(input);
  const model = input.model;
  const cost = usage ? estimateUsageCostUsd(usage, model) : blendedCostUsd(tokens, model);
  const activeSet = effectiveActiveSkills(cwd);
  const notInActiveProfile = activeSet.size > 0 && !activeSet.has(skill);
  const ts = new Date().toISOString();
  const record = {
    ts,
    timestamp: ts,
    skill,
    action: "skill_invoke",
    agent,
    tokens,
    cost,
    rc: 0,
    success: true,
    session_id: sessionId,
    project: cwd,
    model: model,
    metadata: {
      source: SOURCE,
      invoked: true,
      tool_name: input.toolName,
      tool_use_id: toolUseId || undefined,
      hook_agent: agent,
      ...(notInActiveProfile ? { not_in_active_profile: true } : {}),
      ...(usage ? { usage, cost_method: "usage_breakdown" } : { cost_method: "model_blended" }),
    },
  };

  try {
    appendRun(cwd, record);
    state[key] = ts;
    state = pruneState(state);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", "utf-8");
  } catch {
    // non-fatal
  }
}

main();
