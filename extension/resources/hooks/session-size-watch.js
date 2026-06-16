#!/usr/bin/env node
// Nudges toward /compact or /clear when the session grows large.
// Claude/Cursor: byte-size of transcript_path. Kiro/Copilot (and any agent without
// transcript_path): falls back to this session's usage totals in runs.jsonl.

const fs = require("fs");
const path = require("path");
const { sumTranscriptUsageCached, sumSessionRunsUsage, formatTokenCount, formatUsd } = require("./usageParse");
const { readStdin, parsePlatform, resolveCwd, resolveSessionId, writePromptOutput } = require("./hookPlatform");

const WARN_BYTES = 4 * 1024 * 1024;
const CRITICAL_BYTES = 10 * 1024 * 1024;
const WARN_TOKENS = 100_000;
const CRITICAL_TOKENS = 200_000;
const PROJECTED_TOKEN_CEILING = 200_000;
const BLENDED_USD_PER_TOKEN = 0.000009;

const LEVEL_RANK = { ok: 0, warn: 1, critical: 2 };

function levelForBytes(bytes) {
  if (bytes >= CRITICAL_BYTES) {
    return "critical";
  }
  if (bytes >= WARN_BYTES) {
    return "warn";
  }
  return "ok";
}

function levelForTokens(tokens) {
  if (tokens >= CRITICAL_TOKENS) {
    return "critical";
  }
  if (tokens >= WARN_TOKENS) {
    return "warn";
  }
  return "ok";
}

/** Token/cost/level from the session transcript, or null if no transcript is available. */
function usageFromTranscript(transcriptPath, cacheFile) {
  let size;
  try {
    size = fs.statSync(transcriptPath).size;
  } catch {
    return null;
  }
  const usage = sumTranscriptUsageCached(transcriptPath, cacheFile);
  if (usage.totalTokens > 0) {
    return { tokens: usage.totalTokens, cost: usage.totalCostUsd, level: levelForBytes(size) };
  }
  const tokens = Math.round(size / 4);
  return { tokens, cost: tokens * BLENDED_USD_PER_TOKEN, level: levelForBytes(size) };
}

/** Token/cost/level from this session's runs.jsonl totals (Kiro/Copilot — no transcript). */
function usageFromRuns(cwd, sessionId) {
  const { totalTokens, totalCostUsd } = sumSessionRunsUsage(cwd, sessionId);
  if (totalTokens === 0) {
    return null;
  }
  return { tokens: totalTokens, cost: totalCostUsd, level: levelForTokens(totalTokens) };
}

function savingsHint(tokens, cost) {
  const projectedCost = PROJECTED_TOKEN_CEILING * BLENDED_USD_PER_TOKEN;
  const saveUsd = Math.max(0, projectedCost - cost);
  if (saveUsd < 0.01) {
    return " /compact frees context; /clear resets completely.";
  }
  return ` /compact now may save ~${formatUsd(saveUsd)} vs letting the session grow; /clear resets completely.`;
}

function costSuffix(usage) {
  if (!usage || usage.tokens === 0) {
    return "";
  }
  return ` Session at ${formatTokenCount(usage.tokens)} tokens (~${formatUsd(usage.cost)} est.).${savingsHint(usage.tokens, usage.cost)}`;
}

const MCP_OPTIMIZER_TIP =
  " For permanent context reduction across sessions: lazy-mcp (90%+ token cut via on-demand tool loading)," +
  " mcp-compressor from Atlassian Labs (70–97% schema compression for large MCP servers like GitHub/Jira)," +
  " or jmunch-mcp (efficient proxy for data-heavy MCP servers). Run \"Claude Skills: Setup MCP Context Optimizer\" in the VS Code command palette.";

const MESSAGES = {
  warn: (usage) => `[Claude Skills] This session's transcript is getting large.${costSuffix(usage)}`,
  critical: (usage) => `[Claude Skills] This session's transcript is very large.${costSuffix(usage)}${MCP_OPTIMIZER_TIP}`,
};

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
}

function main() {
  const platform = parsePlatform(process.argv);
  let input;
  try {
    input = JSON.parse(readStdin());
  } catch {
    input = {};
  }

  const transcriptPath = input.transcript_path;
  const sessionId = resolveSessionId(input);
  const cwd = resolveCwd(input, platform);
  if (!sessionId || !cwd) {
    return;
  }

  const sizeWatchCacheFile = path.join(cwd, ".claude", "learning", "session-watch-size.json");
  const usage = (transcriptPath && usageFromTranscript(transcriptPath, sizeWatchCacheFile)) || usageFromRuns(cwd, sessionId);
  if (!usage) {
    return;
  }

  const level = usage.level;
  const stateFile = path.join(cwd, ".claude", "learning", "session-watch.json");
  const state = readJsonSafe(stateFile);
  const previous = state[sessionId] || "ok";

  state[sessionId] = level;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", "utf-8");
  } catch {
    // non-fatal
  }

  const escalated = LEVEL_RANK[level] > LEVEL_RANK[previous];
  if (escalated && (level === "warn" || level === "critical")) {
    writePromptOutput(MESSAGES[level](usage), platform, "systemMessage");
  }
}

main();
