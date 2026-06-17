#!/usr/bin/env node
/**
 * Adaptive CLI MCP Server
 * Executes allow-listed CLI commands (az, aws, git, kubectl, helm, terraform,
 * gcloud, docker, gh) and logs every invocation to the same mcp-usage.jsonl
 * used by the filesystem server, enabling unified session telemetry.
 *
 * Usage: node index.js --config /path/to/cli-config.json
 * Config format:
 *   {
 *     "allowedClis": ["az","aws","git"],
 *     "workspaceLogPath": "/abs/path/.claude/mcp-usage.jsonl",
 *     "timeout": 300000
 *   }
 *
 * Without --config, defaults to a built-in allow-list and 5-minute timeout.
 */
"use strict";

const { spawn } = require("node:child_process");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const configArgIdx = process.argv.indexOf("--config");
const configPath = configArgIdx !== -1 ? process.argv[configArgIdx + 1] : null;

const DEFAULT_ALLOWED_CLIS = [
  "az", "aws", "git", "kubectl", "helm", "terraform",
  "gcloud", "docker", "gh", "dotnet", "node", "npm",
];
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;  // 5 minutes
const MAX_TIMEOUT_MS = 30 * 60 * 1000;     // 30 minutes
const MAX_OUTPUT_BYTES = 512 * 1024;        // 512 KB per stream

function readConfig() {
  if (configPath) {
    try { return JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch { /* fall through */ }
  }
  return {};
}

function getAllowedClis() {
  const cfg = readConfig();
  const list = Array.isArray(cfg.allowedClis) && cfg.allowedClis.length > 0
    ? cfg.allowedClis
    : DEFAULT_ALLOWED_CLIS;
  // Normalise: lowercase, strip .cmd/.exe suffix for matching purposes
  return list.map((c) => c.toLowerCase().replace(/\.(cmd|exe)$/, ""));
}

function getDefaultTimeoutMs() {
  const cfg = readConfig();
  const t = typeof cfg.timeout === "number" ? cfg.timeout : DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(1000, t), MAX_TIMEOUT_MS);
}

function getWorkspaceLogPath() {
  const cfg = readConfig();
  const p = cfg.workspaceLogPath;
  return typeof p === "string" && p ? p : null;
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function respond(id, result) { send({ jsonrpc: "2.0", id, result }); }
function respondError(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

// ---------------------------------------------------------------------------
// Usage log — appended to the same mcp-usage.jsonl as the filesystem server
// so the extension's telemetry panel picks up CLI calls in the same view.
// ---------------------------------------------------------------------------

const MCP_USAGE_LOG = path.join(os.homedir(), ".claude", "learning", "mcp-usage.jsonl");
let SESSION_ID = "";

function appendUsageLog(entry) {
  if (process.env.MCP_DISABLE_USAGE_LOG) return;
  const line = JSON.stringify(entry) + "\n";
  try { fs.appendFileSync(MCP_USAGE_LOG, line, "utf-8"); } catch { /* non-fatal */ }
  const wsLog = getWorkspaceLogPath();
  if (wsLog && wsLog !== MCP_USAGE_LOG) {
    try {
      fs.mkdirSync(path.dirname(wsLog), { recursive: true });
      fs.appendFileSync(wsLog, line, "utf-8");
    } catch { /* non-fatal */ }
  }
}

// ---------------------------------------------------------------------------
// CLI availability detection — probed once per session and cached
// ---------------------------------------------------------------------------

/** @type {Map<string, boolean>} */
const cliAvailabilityCache = new Map();

function probeCli(cli) {
  if (cliAvailabilityCache.has(cli)) return cliAvailabilityCache.get(cli);
  const available = _probeCliUncached(cli);
  cliAvailabilityCache.set(cli, available);
  return available;
}

function _probeCliUncached(cli) {
  const checkCmd = process.platform === "win32" ? "where" : "which";
  // Try the plain name first, then with .cmd on Windows
  const candidates = process.platform === "win32"
    ? [cli, `${cli}.cmd`, `${cli}.exe`]
    : [cli];
  for (const candidate of candidates) {
    try {
      execFileSync(checkCmd, [candidate], { stdio: "ignore", timeout: 3000 });
      return true;
    } catch { /* try next */ }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Resolve the actual executable for spawn (handles Windows .cmd wrappers)
// ---------------------------------------------------------------------------

function resolveExecutable(cli) {
  if (process.platform !== "win32") return cli;
  // On Windows, many CLIs are .cmd batch files; spawn needs 'shell: true'
  // for those — we indicate this via a wrapper object.
  return cli;
}

// ---------------------------------------------------------------------------
// Tool: run_command
// ---------------------------------------------------------------------------

/**
 * @param {string} cli
 * @param {string[]} args
 * @param {{ timeout?: number, cwd?: string, env?: Record<string,string> }} opts
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number, timedOut: boolean }>}
 */
function runCommand(cli, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const timeout = typeof opts.timeout === "number"
      ? Math.min(Math.max(1000, opts.timeout), MAX_TIMEOUT_MS)
      : getDefaultTimeoutMs();

    const env = { ...process.env, ...(opts.env ?? {}) };
    const cwd = typeof opts.cwd === "string" && opts.cwd ? opts.cwd : process.cwd();

    // On Windows use shell:true so that .cmd/.bat files launch correctly.
    // Args are still an array here — Node passes them as separate quoted tokens
    // to cmd.exe, so there is no shell injection risk from the args array.
    const useShell = process.platform === "win32";

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;

    const proc = spawn(cli, args, { env, cwd, shell: useShell, windowsHide: true });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
    }, timeout);

    proc.stdout.on("data", (chunk) => {
      if (stdoutTruncated) return;
      const chunkStr = chunk.toString("utf-8");
      if (Buffer.byteLength(stdout + chunkStr, "utf-8") <= MAX_OUTPUT_BYTES) {
        stdout += chunkStr;
      } else {
        const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(stdout, "utf-8");
        stdout += chunk.slice(0, Math.max(0, remaining)).toString("utf-8");
        stdout += `\n[stdout truncated at ${MAX_OUTPUT_BYTES} bytes]`;
        stdoutTruncated = true;
      }
    });

    proc.stderr.on("data", (chunk) => {
      if (stderrTruncated) return;
      const chunkStr = chunk.toString("utf-8");
      if (Buffer.byteLength(stderr + chunkStr, "utf-8") <= MAX_OUTPUT_BYTES) {
        stderr += chunkStr;
      } else {
        const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(stderr, "utf-8");
        stderr += chunk.slice(0, Math.max(0, remaining)).toString("utf-8");
        stderr += `\n[stderr truncated at ${MAX_OUTPUT_BYTES} bytes]`;
        stderrTruncated = true;
      }
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1, timedOut });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

async function dispatchTool(id, toolName, args) {
  const start = Date.now();
  const logEntry = {
    ts: new Date().toISOString(),
    tool: toolName,
    server: "cli",
    ...(SESSION_ID && { sessionId: SESSION_ID }),
  };

  try {
    let result;

    switch (toolName) {
      case "run_command": {
        const rawCli = typeof args.cli === "string" ? args.cli.trim() : "";
        // Normalise for allow-list check (strip .cmd/.exe)
        const cliNorm = rawCli.toLowerCase().replace(/\.(cmd|exe)$/, "");
        const cmdArgs = Array.isArray(args.args) ? args.args.map(String) : [];
        const allowed = getAllowedClis();

        if (!rawCli) throw new Error("cli parameter is required");
        if (!allowed.includes(cliNorm)) {
          throw new Error(
            `CLI "${rawCli}" is not in the allow-list. ` +
            `Allowed: ${allowed.join(", ")}. ` +
            `Update cli-config.json allowedClis to add it.`
          );
        }

        const { stdout, stderr, exitCode, timedOut } = await runCommand(rawCli, cmdArgs, {
          timeout: typeof args.timeout === "number" ? args.timeout : undefined,
          cwd: typeof args.cwd === "string" ? args.cwd : undefined,
          env: args.env && typeof args.env === "object" && !Array.isArray(args.env)
            ? args.env
            : undefined,
        });

        // Log tool as "cli:<name>" so each CLI gets its own bucket in byTool
        // aggregation — otherwise all run_command calls collapse into one entry.
        logEntry.tool = `cli:${cliNorm}`;
        const resolvedCwd = typeof args.cwd === "string" && args.cwd ? args.cwd : process.cwd();
        Object.assign(logEntry, {
          cli: cliNorm,
          cwd: resolvedCwd,
          exitCode,
          stdoutBytes: Buffer.byteLength(stdout, "utf-8"),
          stderrBytes: Buffer.byteLength(stderr, "utf-8"),
          ...(timedOut && { timedOut: true }),
        });

        const parts = [];
        if (stdout) parts.push(`stdout:\n${stdout.trimEnd()}`);
        if (stderr) parts.push(`stderr:\n${stderr.trimEnd()}`);
        parts.push(`exitCode: ${exitCode}`);
        if (timedOut) parts.push(`timedOut: true`);
        result = {
          content: [{ type: "text", text: parts.join("\n") }],
          isError: exitCode !== 0,
        };
        break;
      }

      case "list_available_clis": {
        const clis = getAllowedClis().map((cli) => ({ cli, available: probeCli(cli) }));
        Object.assign(logEntry, { available: clis.filter((c) => c.available).length });
        const found   = clis.filter((c) =>  c.available).map((c) => `  ✓ ${c.cli}`);
        const missing = clis.filter((c) => !c.available).map((c) => `  ✗ ${c.cli}`);
        const text = [
          `Found (${found.length}):`,   ...found,
          `Missing (${missing.length}):`, ...missing,
        ].join("\n");
        result = { content: [{ type: "text", text }] };
        break;
      }

      default:
        respondError(id, -32601, `Tool not found: ${toolName}`);
        return;
    }

    logEntry.durationMs = Date.now() - start;
    appendUsageLog(logEntry);
    respond(id, result);
  } catch (e) {
    logEntry.durationMs = Date.now() - start;
    logEntry.error = e.message;
    appendUsageLog(logEntry);
    respond(id, {
      content: [{ type: "text", text: e.message }],
      isError: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Stdio line reader
// ---------------------------------------------------------------------------

// Track in-flight async tool calls so we don't exit before they respond.
let _pendingOps = 0;
let _stdinEnded = false;

function _tryExit() {
  if (_stdinEnded && _pendingOps === 0) process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  const { id, method, params } = msg;
  if (!method) return;

  try {
    switch (method) {
      case "initialize":
        SESSION_ID = crypto.randomUUID().slice(0, 12);
        respond(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "claude-skills-cli",
            version: "1.0",
            allowedClis: getAllowedClis(),
            platform: process.platform,
          },
        });
        break;

      case "notifications/initialized":
        break;

      case "tools/list":
        respond(id, {
          tools: [
            {
              name: "run_command",
              description:
                "Execute an allow-listed CLI command and capture stdout, stderr, and exit code. " +
                "Every call is logged for telemetry. Supported CLIs: az, aws, git, kubectl, helm, " +
                "terraform, gcloud, docker, gh (configurable via cli-config.json). " +
                "Args are passed as an array — no shell expansion occurs, so pass flags exactly as needed. " +
                "Use the env parameter to inject MSYS_NO_PATHCONV=1 for Azure resource IDs on Windows. " +
                "Increase timeout for long-running operations: AKS creation ~10 min, Azure Backup ~45 min.",
              inputSchema: {
                type: "object",
                properties: {
                  cli: {
                    type: "string",
                    description: "CLI executable name (e.g. 'az', 'aws', 'git', 'kubectl'). Must be in the allow-list.",
                  },
                  args: {
                    type: "array",
                    items: { type: "string" },
                    description: "Command arguments as an array (e.g. ['group', 'list', '--output', 'json']). Each element is a separate argument — do not join into a single string.",
                  },
                  timeout: {
                    type: "number",
                    description: "Timeout in milliseconds. Default: 300000 (5 min). Max: 1800000 (30 min). Set to 2700000 for Azure Backup job waits (capped at 30 min).",
                  },
                  cwd: {
                    type: "string",
                    description: "Working directory for the command. Optional — defaults to the server's working directory.",
                  },
                  env: {
                    type: "object",
                    description: "Extra environment variables merged into the process environment (e.g. { \"MSYS_NO_PATHCONV\": \"1\" } for Azure resource ID paths on Windows Git Bash).",
                    additionalProperties: { type: "string" },
                  },
                },
                required: ["cli", "args"],
              },
            },
            {
              name: "list_available_clis",
              description:
                "Probe which allow-listed CLIs are installed and available in PATH. " +
                "Returns availability status for each configured CLI. " +
                "Use before starting an infrastructure workflow to verify prerequisites.",
              inputSchema: {
                type: "object",
                properties: {},
                required: [],
              },
            },
          ],
        });
        break;

      case "tools/call":
        _pendingOps++;
        try {
          await dispatchTool(id, params?.name, params?.arguments || {});
        } finally {
          _pendingOps--;
          _tryExit();
        }
        break;

      case "ping":
        if (id != null) respond(id, {});
        break;

      default:
        if (id != null) respondError(id, -32601, `Method not supported: ${method}`);
    }
  } catch (e) {
    if (id != null) respondError(id, -32000, e.message);
  }
});

process.stdin.on("end", () => { _stdinEnded = true; _tryExit(); });
