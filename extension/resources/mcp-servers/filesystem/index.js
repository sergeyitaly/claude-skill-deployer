#!/usr/bin/env node
/**
 * Minimal Filesystem MCP Server
 * Bundled with Claude Skills extension for convenient local file operations.
 * Supports: read, write, edit, list, search, delete — scoped to configured allowed directories.
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

// ---------------------------------------------------------------------------
// Session-level caches — silently skip redundant reads and directory scans.
//
// sessionReadCache: Map<sessionId, Map<resolvedPath, {content, mtimeMs}>>
//   Stores file content keyed by mtime; invalidated on write/edit.
//
// sessionDirCache: Map<sessionId, Map<resolvedPath, listingText>>
//   Stores directory listings; invalidated when a file is written inside the dir.
// ---------------------------------------------------------------------------
const sessionReadCache = new Map();
const sessionDirCache  = new Map();

/**
 * Prune caches for all sessions except the current one to bound memory use.
 * Called on each `initialize` handshake (new agent conversation).
 */
function pruneSessionCaches(keepSessionId) {
  for (const sid of [...sessionReadCache.keys()]) {
    if (sid !== keepSessionId) {
      sessionReadCache.delete(sid);
      sessionDirCache.delete(sid);
    }
  }
}

/** Workspace-scoped log path resolved once at startup from allowed-dirs.json config, or null. */
const WORKSPACE_LOG_PATH = (() => {
  if (!configPath) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const p = cfg.workspaceLogPath;
    return typeof p === "string" && p ? p : null;
  } catch {
    return null;
  }
})();

// ---------------------------------------------------------------------------
// Async write queue for MCP usage log.
// Batches rapid successive tool-call entries into a single I/O operation via
// setImmediate so the log flush never blocks the event loop during tool dispatch.
// ---------------------------------------------------------------------------

/** Map<filePath, lines[]> of pending log lines awaiting the next flush. */
const _logQueue = new Map();
let _logFlushScheduled = false;

function _flushLogQueue() {
  _logFlushScheduled = false;
  for (const [filePath, lines] of _logQueue) {
    _logQueue.delete(filePath);
    const data = lines.join("");
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, data, "utf-8");
    } catch {
      // non-fatal — never crash the server over logging
    }
  }
}

function appendMcpUsageLog(entry) {
  if (process.env.MCP_DISABLE_USAGE_LOG) return;
  const line = JSON.stringify(entry) + "\n";

  const enqueue = (filePath) => {
    const existing = _logQueue.get(filePath);
    if (existing) { existing.push(line); } else { _logQueue.set(filePath, [line]); }
  };

  enqueue(MCP_USAGE_LOG);
  const wsLog = WORKSPACE_LOG_PATH;
  if (wsLog && wsLog !== MCP_USAGE_LOG) enqueue(wsLog);

  if (!_logFlushScheduled) {
    _logFlushScheduled = true;
    setImmediate(_flushLogQueue);
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
        // Session cache: skip re-read if file mtime is unchanged since last read.
        const mtime = (() => { try { return fs.statSync(resolved).mtimeMs; } catch { return -1; } })();
        const sReads = sessionReadCache.get(SESSION_ID) ?? new Map();
        const cached = sReads.get(resolved);
        if (cached && mtime !== -1 && cached.mtimeMs === mtime) {
          logExtra.bytes = Buffer.byteLength(cached.content, "utf-8");
          logExtra.skipped = true;
          result = { content: [{ type: "text", text: cached.content }] };
          break;
        }
        const content = fs.readFileSync(resolved, "utf-8");
        logExtra.bytes = Buffer.byteLength(content, "utf-8");
        sReads.set(resolved, { content, mtimeMs: mtime });
        sessionReadCache.set(SESSION_ID, sReads);
        result = { content: [{ type: "text", text: content }] };
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
          result = { content: [{ type: "text", text: `Skipped: content unchanged (${resolved})` }] };
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
          // Update read cache with new content; invalidate parent dir listing.
          const sReads = sessionReadCache.get(SESSION_ID) ?? new Map();
          const newMtime = (() => { try { return fs.statSync(resolved).mtimeMs; } catch { return -1; } })();
          sReads.set(resolved, { content: newContent, mtimeMs: newMtime });
          sessionReadCache.set(SESSION_ID, sReads);
          const sDirs = sessionDirCache.get(SESSION_ID);
          if (sDirs) sDirs.delete(path.dirname(resolved));
          result = { content: [{ type: "text", text: `Written: ${resolved}` }] };
        }
        break;
      }
      case "edit_file": {
        const resolved = assertAllowed(args.path);
        const oldStr = typeof args.old_string === "string" ? args.old_string : "";
        const newStr = typeof args.new_string === "string" ? args.new_string : "";
        if (!oldStr) throw new Error("old_string must not be empty");
        const content = fs.readFileSync(resolved, "utf-8");
        logExtra.bytes = Buffer.byteLength(content, "utf-8");
        if (!content.includes(oldStr)) {
          throw new Error(`old_string not found in ${resolved}`);
        }
        const occurrences = content.split(oldStr).length - 1;
        if (occurrences > 1) {
          throw new Error(
            `old_string matches ${occurrences} locations in ${resolved} — make it more specific to uniquely identify the target`
          );
        }
        const newContent = content.replace(oldStr, newStr);
        const tmpPath = `${resolved}.${process.pid}.tmp`;
        try {
          fs.writeFileSync(tmpPath, newContent, "utf-8");
          fs.renameSync(tmpPath, resolved);
        } catch (e) {
          try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
          throw e;
        }
        // Update read cache with edited content; invalidate parent dir listing.
        const newMtime = (() => { try { return fs.statSync(resolved).mtimeMs; } catch { return -1; } })();
        const sReadsE = sessionReadCache.get(SESSION_ID) ?? new Map();
        sReadsE.set(resolved, { content: newContent, mtimeMs: newMtime });
        sessionReadCache.set(SESSION_ID, sReadsE);
        const sDirsE = sessionDirCache.get(SESSION_ID);
        if (sDirsE) sDirsE.delete(path.dirname(resolved));
        result = { content: [{ type: "text", text: `Edited: ${resolved}` }] };
        break;
      }
      case "list_directory": {
        const resolved = assertAllowed(args.path);
        // Session cache: return cached listing for this directory if available.
        const sDirs = sessionDirCache.get(SESSION_ID) ?? new Map();
        if (sDirs.has(resolved)) {
          logExtra.skipped = true;
          const cachedListing = sDirs.get(resolved);
          logExtra.entryCount = cachedListing ? cachedListing.split("\n").length : 0;
          result = { content: [{ type: "text", text: cachedListing }] };
          break;
        }
        const entries = fs.readdirSync(resolved, { withFileTypes: true });
        logExtra.entryCount = entries.length;
        const entryLines = entries.map((e) =>
          `${e.isDirectory() ? "[dir] " : "[file]"} ${e.name}`
        );
        const listingText = entryLines.join("\n") || "(empty directory)";
        sDirs.set(resolved, listingText);
        sessionDirCache.set(SESSION_ID, sDirs);
        result = { content: [{ type: "text", text: listingText }] };
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
        const resultLines = results.map((r) =>
          `${r.type === "directory" ? "[dir] " : "[file]"} ${r.path}`
        );
        if (depthReached) resultLines.push("(depth limit reached — results may be incomplete)");
        result = { content: [{ type: "text", text: resultLines.join("\n") || "(no matches)" }] };
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
        const matchLines = [`Found ${matches.length} match(es) in ${lines.length} lines:`];
        for (const m of matches) {
          for (const c of m.context) {
            matchLines.push(`${c.isMatch ? ">" : " "} ${c.lineNumber}: ${c.text}`);
          }
          matchLines.push("");
        }
        result = { content: [{ type: "text", text: matchLines.join("\n").trimEnd() || "(no matches)" }] };
        break;
      }
      case "delete_file": {
        const resolved = assertAllowed(args.path);
        fs.unlinkSync(resolved);
        // Invalidate caches for the deleted file and its parent dir.
        const sReads = sessionReadCache.get(SESSION_ID);
        if (sReads) sReads.delete(resolved);
        const sDirs = sessionDirCache.get(SESSION_ID);
        if (sDirs) sDirs.delete(path.dirname(resolved));
        result = { content: [{ type: "text", text: `Deleted: ${resolved}` }] };
        break;
      }
      default:
        respondError(id, -32601, `Tool not found: ${toolName}`);
        return;
    }
    appendMcpUsageLog({ ts: new Date().toISOString(), tool: toolName, path: args.path ?? "", durationMs: Date.now() - start, ...logExtra, ...(SESSION_ID && { sessionId: SESSION_ID }) });
    respond(id, result);
  } catch (e) {
    appendMcpUsageLog({ ts: new Date().toISOString(), tool: toolName, path: args.path ?? "", durationMs: Date.now() - start, error: e.message, errorSnippet: e.message.slice(0, 256), ...(SESSION_ID && { sessionId: SESSION_ID }) });
    // Return as tool-content error (not a JSON-RPC protocol error) so
    // PostToolUse hooks receive the message and can inject corrective hints.
    respond(id, { content: [{ type: "text", text: e.message }], isError: true });
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
        // Prune caches from previous sessions to keep memory bounded.
        pruneSessionCaches(SESSION_ID);
        respond(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "claude-skills-filesystem",
            version: "1.2",
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
              name: "edit_file",
              description:
                "Edit a file by replacing an exact string with a new string. old_string must match exactly once in the file — use enough context to make it unique. Prefer this over write_file for targeted edits.",
              inputSchema: {
                type: "object",
                properties: {
                  path: { type: "string", description: "Absolute file path to edit" },
                  old_string: { type: "string", description: "Exact string to find (must appear exactly once)" },
                  new_string: { type: "string", description: "Replacement string" },
                },
                required: ["path", "old_string", "new_string"],
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
