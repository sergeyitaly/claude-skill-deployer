#!/usr/bin/env node
// Claude Code UserPromptSubmit hook: nudges the user toward /compact or
// /clear once the session transcript grows large. Installed by the Claude
// Skills Manager extension's "Enable Session Size Notifications" command.

const fs = require("fs");
const path = require("path");

const WARN_BYTES = 4 * 1024 * 1024; // ~4MB
const CRITICAL_BYTES = 10 * 1024 * 1024; // ~10MB

const LEVEL_RANK = { ok: 0, warn: 1, critical: 2 };

const MESSAGES = {
  warn:
    "[Claude Skills] This session's transcript is getting large. Consider running /compact to summarize and free up context.",
  critical:
    "[Claude Skills] This session's transcript is very large. Consider running /clear (or /compact) soon to keep things responsive.",
};

function levelFor(bytes) {
  if (bytes >= CRITICAL_BYTES) {
    return "critical";
  }
  if (bytes >= WARN_BYTES) {
    return "warn";
  }
  return "ok";
}

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
    process.stdout.write(JSON.stringify({ systemMessage: MESSAGES[level] }));
  }
}

main();
