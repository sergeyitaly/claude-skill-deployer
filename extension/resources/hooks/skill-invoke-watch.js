#!/usr/bin/env node
/**
 * PostToolUse hook (Attribution v2): log explicit skill invocations to runs.jsonl.
 * Matcher: Skill|Read — one row per invoked skill (no equal-split).
 */
const fs = require("fs");
const path = require("path");

const SOURCE = "skill-invoke-hook-v2";
const SKILL_PATH_RE = /[\\/]\.claude[\\/]skills[\\/]([a-z][a-z0-9-]*)(?:[\\/]SKILL\.md)?/i;
const BLENDED_USD_PER_M_TOKEN = 9;

function readStdin() {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function plausible(name) {
  return typeof name === "string" && /^[a-z][a-z0-9-]{2,}$/.test(name);
}

function extractSkillName(input) {
  const tool = input.tool_name || "";
  const ti = input.tool_input || {};

  if (tool === "Skill") {
    const candidates = [ti.skill, ti.skill_name, ti.name, ti.skillName];
    for (const c of candidates) {
      if (plausible(c)) {
        return c.toLowerCase();
      }
    }
  }

  if (tool === "Read") {
    const fp = ti.file_path || ti.path || ti.file || "";
    const m = String(fp).match(SKILL_PATH_RE);
    if (m && plausible(m[1])) {
      return m[1].toLowerCase();
    }
  }

  return null;
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

function extractTokens(input) {
  const tr = input.tool_response;
  if (typeof tr === "string") {
    try {
      const parsed = JSON.parse(tr);
      return sumUsage(parsed.usage || parsed.message?.usage);
    } catch {
      return 0;
    }
  }
  if (tr && typeof tr === "object") {
    return sumUsage(tr.usage || tr.message?.usage);
  }
  return sumUsage(input.message?.usage);
}

function dedupeKey(sessionId, skill, toolUseId) {
  return `${sessionId}|${skill}|${toolUseId || "na"}`;
}

function appendRun(cwd, record) {
  const runsFile = path.join(cwd, ".claude", "learning", "runs.jsonl");
  fs.mkdirSync(path.dirname(runsFile), { recursive: true });
  fs.appendFileSync(runsFile, JSON.stringify(record) + "\n", "utf-8");
}

function main() {
  let input;
  try {
    input = JSON.parse(readStdin());
  } catch {
    return;
  }

  const cwd = input.cwd;
  const sessionId = input.session_id;
  if (!cwd || !sessionId) {
    return;
  }

  const skill = extractSkillName(input);
  if (!skill) {
    return;
  }

  const toolUseId = input.tool_use_id || input.tool_use?.id || "";
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

  const tokens = extractTokens(input);
  const ts = new Date().toISOString();
  const record = {
    ts,
    timestamp: ts,
    skill,
    action: "skill_invoke",
    agent: "claude",
    tokens,
    cost: (tokens / 1_000_000) * BLENDED_USD_PER_M_TOKEN,
    rc: 0,
    success: true,
    session_id: sessionId,
    project: cwd,
    metadata: {
      source: SOURCE,
      invoked: true,
      tool_name: input.tool_name,
      tool_use_id: toolUseId || undefined,
    },
  };

  try {
    appendRun(cwd, record);
    state[key] = ts;
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", "utf-8");
  } catch {
    // non-fatal
  }
}

main();
