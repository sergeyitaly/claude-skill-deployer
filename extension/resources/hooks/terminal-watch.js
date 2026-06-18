#!/usr/bin/env node
/**
 * PostToolUse hook: log native Bash / PowerShell / run_in_terminal commands
 * into mcp-usage.jsonl alongside CLI MCP server entries.
 *
 * Bridges the telemetry gap: previously only commands routed through the CLI MCP
 * server (run_command) were tracked. Now ALL terminal execution — including native
 * Claude Code Bash and PowerShell tool calls — lands in mcp-usage.jsonl with
 * server:"bash" so computeCliKpi() and the efficiency dashboard can analyse them.
 *
 * Entry format:
 *   { ts, tool:"bash:<cli>", server:"bash", cli, command, exitCode,
 *     stdoutBytes, stderrBytes, stderrSnippet?, isRetry?, sessionId, durationMs }
 *
 * Register in ~/.claude/settings.json:
 *   "hooks": {
 *     "PostToolUse": [
 *       { "matcher": "Bash",            "hooks": [{ "type": "command", "command": "node /path/to/terminal-watch.js claude" }] },
 *       { "matcher": "PowerShell",      "hooks": [{ "type": "command", "command": "node /path/to/terminal-watch.js claude" }] },
 *       { "matcher": "run_in_terminal", "hooks": [{ "type": "command", "command": "node /path/to/terminal-watch.js claude" }] }
 *     ]
 *   }
 */
"use strict";

const fs   = require("node:fs");
const os   = require("node:os");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MCP_USAGE_LOG   = path.join(os.homedir(), ".claude", "learning", "mcp-usage.jsonl");
const BASH_TOOL_NAMES = new Set(["bash", "powershell", "run_in_terminal"]);
const MAX_CMD_LEN     = 512;
const MAX_STDERR_LEN  = 512;
const RETRY_WINDOW_MS = 60_000;
const STATE_MAX_KEYS  = 500;
const STATE_MAX_AGE_MS = 30 * 60 * 1000; // 30 min — terminal hooks are transient

// ---------------------------------------------------------------------------
// Stdin
// ---------------------------------------------------------------------------
function readStdin() {
  try { return fs.readFileSync(0, "utf-8"); } catch { return ""; }
}

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------
function extractCommand(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return null;
  return toolInput.command || toolInput.cmd || toolInput.input || null;
}

/**
 * Derive a normalised CLI name from the command string.
 * Skips leading "cd <path>;" or "Set-Location <path>;" prefixes that Claude Code
 * prepends to every PowerShell call so the actual executable name is captured.
 */
function inferCli(command) {
  if (!command || typeof command !== "string") return "unknown";
  let cmd = command.trim();
  // Strip leading "cd ..." or "Set-Location ..." before a semicolon
  cmd = cmd.replace(/^(?:cd|Set-Location)\s+(?:"[^"]*"|'[^']*'|\S+)\s*;\s*/i, "").trim();
  const first = cmd.split(/\s+/)[0].toLowerCase();
  return first.replace(/\.(cmd|exe|ps1|bat)$/i, "") || "unknown";
}

// ---------------------------------------------------------------------------
// Exit-code inference
// ---------------------------------------------------------------------------
function inferExitCode(toolResponse) {
  if (!toolResponse) return 0;

  if (toolResponse.interrupted === true) return 130;
  if (toolResponse.isError === true)     return 1;

  const combined = [
    typeof toolResponse === "string" ? toolResponse : "",
    toolResponse.output  || "",
    toolResponse.stdout  || "",
    toolResponse.stderr  || toolResponse.error || "",
  ].join("\n");

  // Explicit "Exit code: N" / "exit code N"
  const exitMatch = combined.match(/[Ee]xit[\s_]code[:\s]+(\d+)/);
  if (exitMatch) return Number(exitMatch[1]);

  // PowerShell error record markers
  if (/FullyQualifiedErrorId|TerminatingError|CategoryInfo/.test(combined)) return 1;

  // Non-empty error field without explicit code → assume failure
  const errText = (toolResponse.error || toolResponse.stderr || "").trim();
  if (errText.length > 0 && !combined.includes("exit code 0")) return 1;

  return 0;
}

// ---------------------------------------------------------------------------
// Output extraction
// ---------------------------------------------------------------------------
function extractStdout(toolResponse) {
  if (!toolResponse) return "";
  if (typeof toolResponse === "string") return toolResponse;
  return toolResponse.output || toolResponse.stdout || "";
}

function extractStderr(toolResponse) {
  if (!toolResponse || typeof toolResponse === "string") return "";
  return toolResponse.stderr || toolResponse.error || "";
}

// ---------------------------------------------------------------------------
// Retry detection via lightweight state file
// ---------------------------------------------------------------------------
function loadState(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, "utf-8")); } catch { return {}; }
}

function pruneState(state) {
  const now = Date.now();
  const entries = Object.entries(state)
    .filter(([, v]) => now - Date.parse(v.ts || "0") < STATE_MAX_AGE_MS)
    .sort((a, b) => Date.parse(b[1].ts || "0") - Date.parse(a[1].ts || "0"))
    .slice(0, STATE_MAX_KEYS);
  return Object.fromEntries(entries);
}

function saveState(stateFile, state) {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state) + "\n", "utf-8");
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Log append
// ---------------------------------------------------------------------------
function appendLog(logPath, entry) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const raw = readStdin().trim();
  if (!raw) return;

  let payload;
  try { payload = JSON.parse(raw); } catch { return; }

  const toolName = (payload.tool_name || payload.toolName || "").toLowerCase();
  if (!BASH_TOOL_NAMES.has(toolName)) return;

  const command = extractCommand(payload.tool_input);
  if (!command) return;

  const cwd       = payload.cwd || payload.workingDirectory || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const sessionId = payload.session_id || payload.sessionId || payload.conversation_id || "";
  const toolResponse = payload.tool_response ?? payload.toolResult ?? payload.tool_output;

  const cli      = inferCli(command);
  const exitCode = inferExitCode(toolResponse);
  const stderr   = extractStderr(toolResponse).trim().slice(0, MAX_STDERR_LEN);
  const stdout   = extractStdout(toolResponse);

  // Retry detection: previous call to same CLI in this session failed within RETRY_WINDOW_MS
  const stateFile = path.join(cwd, ".claude", "learning", "terminal-hook-state.json");
  const state     = loadState(stateFile);
  const retryKey  = `${sessionId}|${cli}`;
  const prev      = state[retryKey];
  const isRetry   = Boolean(
    prev &&
    prev.exitCode !== 0 &&
    Date.now() - Date.parse(prev.ts || "0") < RETRY_WINDOW_MS
  );

  state[retryKey] = { ts: new Date().toISOString(), exitCode };
  saveState(stateFile, pruneState(state));

  const entry = {
    ts:           new Date().toISOString(),
    tool:         `bash:${cli}`,
    server:       "bash",
    cli,
    command:      command.slice(0, MAX_CMD_LEN),
    sessionId:    sessionId || undefined,
    exitCode,
    stdoutBytes:  Buffer.byteLength(stdout, "utf-8"),
    stderrBytes:  Buffer.byteLength(stderr, "utf-8"),
    durationMs:   0, // PostToolUse doesn't carry wall time; pair with PreToolUse for exact duration
    ...(exitCode !== 0 && stderr ? { stderrSnippet: stderr } : {}),
    ...(isRetry ? { isRetry: true } : {}),
  };

  // Write to global log always; also write workspace-scoped log when available
  appendLog(MCP_USAGE_LOG, entry);
  const wsLog = path.join(cwd, ".claude", "mcp-usage.jsonl");
  if (wsLog !== MCP_USAGE_LOG) appendLog(wsLog, entry);
}

main();
