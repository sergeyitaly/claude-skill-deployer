#!/usr/bin/env node
// Claude Code UserPromptSubmit hook: nudges the user toward /compact or
// /clear once the session transcript grows large, with estimated token/cost.
// Installed by the Claude Skills Manager extension's "Enable Session Size
// Notifications" command.

const fs = require("fs");
const path = require("path");
const { sumTranscriptUsage, formatTokenCount, formatUsd } = require("./usageParse");

const WARN_BYTES = 4 * 1024 * 1024; // ~4MB
const CRITICAL_BYTES = 10 * 1024 * 1024; // ~10MB

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

function costSuffix(transcriptPath) {
  const { totalTokens, totalCostUsd } = sumTranscriptUsage(transcriptPath);
  if (totalTokens > 0) {
    return ` Session at ${formatTokenCount(totalTokens)} tokens (~${formatUsd(totalCostUsd)} est.).`;
  }
  let size;
  try {
    size = fs.statSync(transcriptPath).size;
  } catch {
    return "";
  }
  const approxTokens = Math.round(size / 4);
  const approxCost = (approxTokens / 1_000_000) * 9;
  return ` Transcript ~${formatTokenCount(approxTokens)} tokens (~${formatUsd(approxCost)} est.).`;
}

const MESSAGES = {
  warn: (transcriptPath) =>
    `[Claude Skills] This session's transcript is getting large.${costSuffix(transcriptPath)} Consider running /compact to summarize and free up context.`,
  critical: (transcriptPath) =>
    `[Claude Skills] This session's transcript is very large.${costSuffix(transcriptPath)} Consider running /clear (or /compact) soon to keep things responsive.`,
};

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function main() {
  let input;
  try {
    input = JSON.parse(readStdin());
  } catch {
    return;
  }

  const transcriptPath = input.transcript_path;
  const sessionId = input.session_id;
  const cwd = input.cwd;
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
    // non-fatal: still emit the notification if escalating
  }

  const escalated = LEVEL_RANK[level] > LEVEL_RANK[previous];
  if (escalated && (level === "warn" || level === "critical")) {
    process.stdout.write(JSON.stringify({ systemMessage: MESSAGES[level](transcriptPath) }));
  }
}

main();
