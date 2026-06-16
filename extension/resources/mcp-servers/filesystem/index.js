#!/usr/bin/env node
/**
 * Minimal Filesystem MCP Server
 * Bundled with Claude Skills extension for convenient local file operations.
 * Supports: read, write, list, delete — scoped to configured allowed directories.
 *
 * Usage: node index.js --config /path/to/allowed-dirs.json
 * Config format: { "allowedDirs": ["/abs/path/one", "/abs/path/two"] }
 *
 * Without --config, defaults to ~/.claude only.
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

function sha1hex(content) {
  return crypto.createHash("sha1").update(content).digest("hex").slice(0, 8);
}

// ---------------------------------------------------------------------------
// Allowed-directory enforcement
// ---------------------------------------------------------------------------

const configArgIdx = process.argv.indexOf("--config");
const configPath = configArgIdx !== -1 ? process.argv[configArgIdx + 1] : null;

function getAllowedDirs() {
  if (configPath) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (Array.isArray(cfg.allowedDirs) && cfg.allowedDirs.length > 0) {
        return cfg.allowedDirs.map((d) => path.resolve(d));
      }
    } catch {
      // fall through to default
    }
  }
  return [path.resolve(os.homedir(), ".claude")];
}

/**
 * Resolve requestedPath and verify it is inside one of the allowed dirs.
 * Throws with a clear message if not; returns the resolved absolute path if OK.
 */
function assertAllowed(requestedPath) {
  const resolved = path.resolve(requestedPath);
  const allowed = getAllowedDirs();
  const denied = allowed.every(
    (dir) => resolved !== dir && !resolved.startsWith(dir + path.sep)
  );
  if (denied) {
    throw new Error(
      `Access denied: "${resolved}" is outside allowed directories. ` +
        `Allowed: ${allowed.join(", ")}`
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

// ---------------------------------------------------------------------------
// MCP usage log — appends one JSONL entry per tool call to
// ~/.claude/learning/mcp-usage.jsonl so the extension can surface
// file-access frequency and latency in the efficiency metrics panel.
// ---------------------------------------------------------------------------

const MCP_USAGE_LOG = path.join(os.homedir(), ".claude", "learning", "mcp-usage.jsonl");
// Rotates on each initialize handshake so every agent session gets a distinct ID.
// This works because each new agent conversation re-sends initialize even if the
// server process is kept alive across sessions.
let SESSION_ID = "";

/** Returns the workspace-scoped log path from allowed-dirs.json config, or null. */
function getWorkspaceLogPath() {
  if (!configPath) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const p = cfg.workspaceLogPath;
    return typeof p === "string" && p ? p : null;
  } catch {
    return null;
  }
}

function appendMcpUsageLog(entry) {
  if (process.env.MCP_DISABLE_USAGE_LOG) return;
  const line = JSON.stringify(entry) + "\n";
  // Always write to global log for cross-session intelligence.
  try {
    fs.appendFileSync(MCP_USAGE_LOG, line, "utf-8");
  } catch {
    // non-fatal — never crash the server over logging
  }
  // Also write to workspace-scoped log for per-project KPI attribution (hybrid mode).
  const wsLog = getWorkspaceLogPath();
  if (wsLog && wsLog !== MCP_USAGE_LOG) {
    try {
      fs.mkdirSync(path.dirname(wsLog), { recursive: true });
      fs.appendFileSync(wsLog, line, "utf-8");
    } catch {
      // non-fatal
    }
  }
}

// ---------------------------------------------------------------------------
// Tool dispatch (extracted to keep line-reader handler under complexity limit)
// ---------------------------------------------------------------------------

function dispatchTool(id, toolName, args) {
  const start = Date.now();
  /** Extra fields merged into the log entry (e.g. bytes for read/write). */
  const logExtra = {};
  try {
    let result;
    switch (toolName) {
      case "read_file": {
        const resolved = assertAllowed(args.path);
        const content = fs.readFileSync(resolved, "utf-8");
        logExtra.bytes = Buffer.byteLength(content, "utf-8");
        result = { content };
        break;
      }
      case "write_file": {
        const resolved = assertAllowed(args.path);
        const newContent = args.content ?? "";
        logExtra.bytes = Buffer.byteLength(newContent, "utf-8");
        logExtra.contentHash = sha1hex(newContent);
        // Single try/catch read collapses the existsSync+readFileSync two-step into one
        // syscall, eliminating the TOCTOU gap between existence check and content read.
        let currentContent;
        try { currentContent = fs.readFileSync(resolved, "utf-8"); } catch { /* file doesn't exist yet */ }
        if (currentContent === newContent) {
          logExtra.skipped = true;
          result = { success: true, path: resolved, skipped: true };
        } else {
          fs.mkdirSync(path.dirname(resolved), { recursive: true });
          // Atomic write via temp-file + rename: readers never see partial content,
          // and concurrent writers produce a clean last-writer-wins outcome.
          const tmpPath = `${resolved}.${process.pid}.tmp`;
          try {
            fs.writeFileSync(tmpPath, newContent, "utf-8");
            fs.renameSync(tmpPath, resolved);
          } catch (e) {
            try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
            throw e;
          }
          result = { success: true, path: resolved, skipped: false };
        }
        break;
      }
      case "list_directory": {
        const resolved = assertAllowed(args.path);
        const entries = fs.readdirSync(resolved, { withFileTypes: true });
        logExtra.entryCount = entries.length;
        result = {
          entries: entries.map((e) => ({
            name: e.name,
            type: e.isDirectory() ? "directory" : "file",
          })),
        };
        break;
      }
      case "search_files": {
        const resolved = assertAllowed(args.path);
        const pattern = typeof args.pattern === "string" ? args.pattern : "";
        const maxResults = typeof args.max_results === "number" ? Math.min(args.max_results, 200) : 100;
        const MAX_DEPTH = 10;
        const results = [];
        let depthReached = false;
        function searchDir(dir, depth) {
          if (results.length >= maxResults) return;
          if (depth > MAX_DEPTH) { depthReached = true; return; }
          let dirEntries;
          try { dirEntries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of dirEntries) {
            if (results.length >= maxResults) break;
            const full = path.join(dir, e.name);
            if (!pattern || e.name.includes(pattern)) {
              results.push({ name: e.name, path: full, type: e.isDirectory() ? "directory" : "file" });
            }
            if (e.isDirectory()) searchDir(full, depth + 1);
          }
        }
        searchDir(resolved, 0);
        logExtra.entryCount = results.length;
        if (depthReached) logExtra.depthReached = true;
        result = { results, depthReached };
        break;
      }
      case "search_in_file": {
        const resolved = assertAllowed(args.path);
        const patternStr = typeof args.pattern === "string" ? args.pattern : "";
        const contextLines = typeof args.context_lines === "number" ? Math.min(Math.max(0, args.context_lines), 10) : 2;
        const maxMatches = typeof args.max_matches === "number" ? Math.min(args.max_matches, 100) : 50;
        let regex;
        try {
          regex = new RegExp(patternStr);
        } catch {
          throw new Error(`Invalid regex pattern: ${patternStr}`);
        }
        const content = fs.readFileSync(resolved, "utf-8");
        logExtra.bytes = Buffer.byteLength(content, "utf-8");
        const lines = content.split("\n");
        const matches = [];
        for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
          if (regex.test(lines[i])) {
            const start = Math.max(0, i - contextLines);
            const end = Math.min(lines.length - 1, i + contextLines);
            matches.push({
              lineNumber: i + 1,
              line: lines[i],
              context: lines.slice(start, end + 1).map((l, idx) => ({
                lineNumber: start + idx + 1,
                text: l,
                isMatch: start + idx === i,
              })),
            });
          }
        }
        logExtra.entryCount = matches.length;
        result = { matches, totalLines: lines.length };
        break;
      }
      case "delete_file": {
        const resolved = assertAllowed(args.path);
        fs.unlinkSync(resolved);
        result = { success: true, path: resolved };
        break;
      }
      default:
        respondError(id, -32601, `Tool not found: ${toolName}`);
        return;
    }
    appendMcpUsageLog({ ts: new Date().toISOString(), tool: toolName, path: args.path ?? "", durationMs: Date.now() - start, ...logExtra, ...(SESSION_ID && { sessionId: SESSION_ID }) });
    respond(id, result);
  } catch (e) {
    appendMcpUsageLog({ ts: new Date().toISOString(), tool: toolName, path: args.path ?? "", durationMs: Date.now() - start, error: e.message, ...(SESSION_ID && { sessionId: SESSION_ID }) });
    respondError(id, -32000, e.message);
  }
}

// ---------------------------------------------------------------------------
// Stdio line reader
// ---------------------------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

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
            name: "claude-skills-filesystem",
            version: "1.1",
            allowedDirs: getAllowedDirs(),
          },
        });
        break;

      case "notifications/initialized":
        break;

      case "tools/list":
        respond(id, {
          tools: [
            {
              name: "read_file",
              description:
                "Read contents of a file. Only paths inside the configured allowed directories are accessible.",
              inputSchema: {
                type: "object",
                properties: {
                  path: { type: "string", description: "Absolute file path to read" },
                },
                required: ["path"],
              },
            },
            {
              name: "write_file",
              description:
                "Write or overwrite a file. Only paths inside the configured allowed directories are writable.",
              inputSchema: {
                type: "object",
                properties: {
                  path: { type: "string", description: "Absolute file path to write" },
                  content: { type: "string", description: "File content" },
                },
                required: ["path", "content"],
              },
            },
            {
              name: "list_directory",
              description:
                "List files and directories. Only paths inside the configured allowed directories are listable.",
              inputSchema: {
                type: "object",
                properties: {
                  path: { type: "string", description: "Absolute directory path to list" },
                },
                required: ["path"],
              },
            },
            {
              name: "delete_file",
              description:
                "Delete a file. Only paths inside the configured allowed directories are deletable.",
              inputSchema: {
                type: "object",
                properties: {
                  path: { type: "string", description: "Absolute file path to delete" },
                },
                required: ["path"],
              },
            },
            {
              name: "search_files",
              description:
                "Recursively search for files whose name contains the given pattern. Only searches inside configured allowed directories.",
              inputSchema: {
                type: "object",
                properties: {
                  path: { type: "string", description: "Absolute directory path to search in" },
                  pattern: { type: "string", description: "Filename substring to match (case-sensitive)" },
                  max_results: { type: "number", description: "Maximum results (default 100, max 200)" },
                },
                required: ["path", "pattern"],
              },
            },
            {
              name: "search_in_file",
              description:
                "Search for lines matching a regex pattern within a file. Returns matching lines with surrounding context. Use instead of read_file for large files when you only need specific sections.",
              inputSchema: {
                type: "object",
                properties: {
                  path: { type: "string", description: "Absolute file path to search" },
                  pattern: { type: "string", description: "Regex pattern matched against each line" },
                  context_lines: { type: "number", description: "Lines of context around each match (default 2, max 10)" },
                  max_matches: { type: "number", description: "Maximum matches to return (default 50, max 100)" },
                },
                required: ["path", "pattern"],
              },
            },
          ],
        });
        break;

      case "tools/call":
        dispatchTool(id, params?.name, params?.arguments || {});
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

process.stdin.on("end", () => process.exit(0));
