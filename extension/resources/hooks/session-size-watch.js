#!/usr/bin/env node
// Nudges toward /compact or /clear when the session transcript grows large.
// Claude/Cursor: needs transcript_path + session_id (no-op on Kiro/Copilot without transcripts).

const fs = require("fs");
const path = require("path");
const { sumTranscriptUsage, formatTokenCount, formatUsd } = require("./usageParse");
const { readStdin, parsePlatform, resolveCwd, resolveSessionId, writePromptOutput } = require("./hookPlatform");

const WARN_BYTES = 4 * 1024 * 1024;
const CRITICAL_BYTES = 10 * 1024 * 1024;
const PROJECTED_TOKEN_CEILING = 200_000;
const BLENDED_USD_PER_TOKEN = 0.000009;

const LEVEL_RANK = { ok: 0, warn: 1, critical: 2 };

function levelFor(bytes) {
  if (bytes >= CRITICAL_BYTES) {
    return "critical";
  }
  if (bytes >= WARN_BYTES) {
    return "warn";
  }
  return "ok";
}

function tokenAndCost(transcriptPath) {
  const usage = sumTranscriptUsage(transcriptPath);
  if (usage.totalTokens > 0) {
    return { tokens: usage.totalTokens, cost: usage.totalCostUsd };
  }
  let size;
  try {
    size = fs.statSync(transcriptPath).size;
  } catch {
    return { tokens: 0, cost: 0 };
  }
  const tokens = Math.round(size / 4);
  return { tokens, cost: tokens * BLENDED_USD_PER_TOKEN };
}

function savingsHint(tokens, cost) {
  const projectedCost = PROJECTED_TOKEN_CEILING * BLENDED_USD_PER_TOKEN;
  const saveUsd = Math.max(0, projectedCost - cost);
  if (saveUsd < 0.01) {
    return " /compact frees context; /clear resets completely.";
  }
  return ` /compact now may save ~${formatUsd(saveUsd)} vs letting the session grow; /clear resets completely.`;
}

function costSuffix(transcriptPath) {
  const { tokens, cost } = tokenAndCost(transcriptPath);
  if (tokens === 0) {
    return "";
  }
  return ` Session at ${formatTokenCount(tokens)} tokens (~${formatUsd(cost)} est.).${savingsHint(tokens, cost)}`;
}

const MESSAGES = {
  warn: (transcriptPath) =>
    `[Claude Skills] This session's transcript is getting large.${costSuffix(transcriptPath)}`,
  critical: (transcriptPath) =>
    `[Claude Skills] This session's transcript is very large.${costSuffix(transcriptPath)}`,
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
  if (!transcriptPath || !sessionId || !cwd) {
    return;
  }

  let size;
  try {
    size = fs.statSync(transcriptPath).size;
  } catch {
    return;
  }

  const level = levelFor(size);
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
    writePromptOutput(MESSAGES[level](transcriptPath), platform, "systemMessage");
  }
}

main();
