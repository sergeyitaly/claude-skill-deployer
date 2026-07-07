#!/usr/bin/env node
/**
 * Minimal Filesystem MCP Server
 * Bundled with Claude Skills extension for convenient local file operations.
 * Supports: read (with optional offset/limit pagination), write, edit, list,
 * search by filename, search within a file, recursive multi-file content
 * search, delete — scoped to configured allowed directories.
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

/** Maximum file size allowed for read_file (50 MB). Prevents OOM on large binaries. */
const MAX_READ_BYTES = 50 * 1024 * 1024;

/** Directory names skipped by default during recursive content search (search_in_files). */
const SEARCH_EXCLUDED_DIRS = new Set([
  "node_modules", ".git", "out", "dist", "build", "coverage",
  ".vscode-test", "__pycache__", ".venv", "venv",
]);

/** Files larger than this are skipped by search_in_files (avoids slow regex on huge files). */
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;

/** Binary-file magic byte signatures (first 4 bytes). */
const BINARY_SIGNATURES = [
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff],        // JPEG
  [0x47, 0x49, 0x46],        // GIF
  [0x25, 0x50, 0x44, 0x46], // PDF
  [0x50, 0x4b, 0x03, 0x04], // ZIP / DOCX / XLSX / JAR
  [0x7f, 0x45, 0x4c, 0x46], // ELF binary
  [0x4d, 0x5a],              // Windows PE / EXE / DLL
  [0x00, 0x61, 0x73, 0x6d], // WebAssembly (.wasm)
  [0x42, 0x4d],              // BMP image
  [0x53, 0x51, 0x4c, 0x69], // SQLite database
];

/** Returns true when the first bytes of a Buffer match a known binary signature. */
function looksLikeBinary(buf) {
  return BINARY_SIGNATURES.some(
    (sig) => sig.every((byte, i) => buf[i] === byte)
  );
}
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

// Cache resolved allowed-dirs so assertAllowed() does not re-read the config file
// on every tool call. Cache keys use stat metadata and are also invalidated by
// fs.watch so runtime config updates (e.g. the extension refreshing workspaceLogPath)
// still take effect without restarting.
let _allowedDirsCache = null;
let _allowedDirsCacheKey = null;
let _allowedDirsCacheWatcher = null;

function invalidateAllowedDirsCache() {
  _allowedDirsCache = null;
  _allowedDirsCacheKey = null;
}

function watchAllowedDirsConfig() {
  if (!configPath || _allowedDirsCacheWatcher) return;
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  try {
    _allowedDirsCacheWatcher = fs.watch(dir, (_event, filename) => {
      const name = filename instanceof Buffer ? filename.toString() : filename;
      if (name === base || name == null) invalidateAllowedDirsCache();
    });
    _allowedDirsCacheWatcher.unref();
  } catch { /* ignore watch errors — stale cache is safe */ }
}

function getAllowedDirs() {
  if (configPath) {
    let stat = null;
    try { stat = fs.statSync(configPath); } catch { /* config missing; fall through to default */ }
    const cacheKey = stat ? `${stat.mtimeMs}:${stat.size}` : null;
    if (_allowedDirsCache !== null && _allowedDirsCacheKey === cacheKey) return _allowedDirsCache;

    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (Array.isArray(cfg.allowedDirs) && cfg.allowedDirs.length > 0) {
        _allowedDirsCache = cfg.allowedDirs.map((d) => path.resolve(d));
        _allowedDirsCacheKey = cacheKey;
        watchAllowedDirsConfig();
        return _allowedDirsCache;
      }
    } catch {
      // fall through to default
    }
  }
  _allowedDirsCache = [path.resolve(os.homedir(), ".claude")];
  _allowedDirsCacheKey = null;
  return _allowedDirsCache;
}

function normalizeAllowedDirComparison(p) {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

function isInsideAllowedDir(p, dir) {
  const normalizedPath = normalizeAllowedDirComparison(p);
  const normalizedDir = normalizeAllowedDirComparison(dir);
  return normalizedPath === normalizedDir || normalizedPath.startsWith(normalizedDir + path.sep);
}

/**
 * Resolve requestedPath and verify it is inside one of the allowed dirs.
 * Throws with a clear message if not; returns the resolved absolute path if OK.
 *
 * Both the nominal path (path.resolve) and the real path (fs.realpathSync) are
 * checked so a symlink inside an allowed dir cannot escape to the filesystem.
 */
function assertAllowed(requestedPath) {
  const resolved = path.resolve(requestedPath);
  const allowed = getAllowedDirs();
  const isInside = (p) => allowed.some((dir) => isInsideAllowedDir(p, dir));

  if (!isInside(resolved)) {
    throw new Error(
      `Access denied: "${resolved}" is outside allowed directories. ` +
        `Allowed: ${allowed.join(", ")}`
    );
  }

  // Resolve symlinks and re-check — a symlink inside an allowed dir may point outside.
  // Falls back to `resolved` for new files (realpathSync throws ENOENT; no symlink risk).
  let real = resolved;
  try { real = fs.realpathSync(resolved); } catch { /* file doesn't exist yet */ }
  if (real !== resolved && !isInside(real)) {
    throw new Error(
      `Access denied: "${resolved}" is a symlink resolving to "${real}" which is outside allowed directories. ` +
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
/** Entries older than this are evicted from the read/dir caches (60 minutes). */
const SESSION_CACHE_TTL_MS = 60 * 60 * 1000;

const sessionReadCache = new Map();
const sessionDirCache  = new Map();
/** Epoch-ms when each session's cache entry was first created. Used for TTL eviction. */
const sessionCreatedAt = new Map();

/**
 * Prune caches for all sessions except the current one to bound memory use.
 * Also evicts any session whose cache is older than SESSION_CACHE_TTL_MS so
 * long-running sessions (>1 h) don't accumulate stale dir entries.
 * Called on each `initialize` handshake (new agent conversation).
 */
function pruneSessionCaches(keepSessionId) {
  const now = Date.now();
  for (const sid of [...sessionReadCache.keys()]) {
    const age = now - (sessionCreatedAt.get(sid) ?? 0);
    if (sid !== keepSessionId || age > SESSION_CACHE_TTL_MS) {
      sessionReadCache.delete(sid);
      sessionDirCache.delete(sid);
      sessionCreatedAt.delete(sid);
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
// Recursive multi-file content search (search_in_files) — the grep-across-a-
// directory-tree counterpart to search_in_file (single file) and search_files
// (filename-only). Skips binary files and common noise directories by default.
// ---------------------------------------------------------------------------

function searchInFiles(rootResolved, regex, opts) {
  const { fileGlob, maxFiles, maxMatches, contextLines } = opts;
  const MAX_DEPTH = 12;
  const deadline = Date.now() + 8_000;
  const fileResults = [];
  let totalMatches = 0;
  let filesScanned = 0;
  let filesMatched = 0;
  let timedOut = false;
  let depthReached = false;

  function scanFile(full) {
    if (totalMatches >= maxMatches || filesScanned >= maxFiles) return;
    let stat;
    try { stat = fs.statSync(full); } catch { return; }
    if (stat.size === 0 || stat.size > MAX_SEARCH_FILE_BYTES) return;

    const header = Buffer.alloc(Math.min(4, stat.size));
    try {
      const fd = fs.openSync(full, "r");
      try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
    } catch { return; }
    if (looksLikeBinary(header)) return;

    filesScanned++;
    let content;
    try { content = fs.readFileSync(full, "utf-8"); } catch { return; }
    const lines = content.split("\n");
    const matches = [];
    for (let i = 0; i < lines.length && matches.length + totalMatches < maxMatches; i++) {
      if (i % 500 === 0 && Date.now() > deadline) { timedOut = true; break; }
      if (regex.test(lines[i])) {
        const start = Math.max(0, i - contextLines);
        const end = Math.min(lines.length - 1, i + contextLines);
        matches.push({
          lineNumber: i + 1,
          context: lines.slice(start, end + 1).map((l, idx) => ({
            lineNumber: start + idx + 1,
            text: l,
            isMatch: start + idx === i,
          })),
        });
      }
    }
    if (matches.length > 0) {
      filesMatched++;
      totalMatches += matches.length;
      fileResults.push({ file: full, matches });
    }
  }

  function scanDir(dir, depth) {
    if (timedOut || totalMatches >= maxMatches || filesScanned >= maxFiles) return;
    if (depth > MAX_DEPTH) { depthReached = true; return; }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (timedOut || totalMatches >= maxMatches || filesScanned >= maxFiles) return;
      if (e.isDirectory()) {
        if (SEARCH_EXCLUDED_DIRS.has(e.name)) continue;
        scanDir(path.join(dir, e.name), depth + 1);
      } else if (!fileGlob || e.name.includes(fileGlob)) {
        scanFile(path.join(dir, e.name));
      }
    }
  }

  scanDir(rootResolved, 0);
  return { fileResults, totalMatches, filesScanned, filesMatched, timedOut, depthReached };
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
        // Guard: reject files that are too large or binary before reading into memory.
        const stat = (() => { try { return fs.statSync(resolved); } catch { return null; } })();
        if (stat !== null) {
          if (stat.size > MAX_READ_BYTES) {
            throw new Error(
              `File too large to read (${(stat.size / 1_048_576).toFixed(1)} MB > ${MAX_READ_BYTES / 1_048_576} MB limit). ` +
              `Use search_in_file to locate specific content instead.`
            );
          }
          if (stat.size > 0) {
            const header = Buffer.alloc(Math.min(4, stat.size));
            const fd = fs.openSync(resolved, "r");
            try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
            if (looksLikeBinary(header)) {
              throw new Error(
                `Binary file detected at '${args.path}'. read_file only supports text files. ` +
                `Check the file extension or use a dedicated binary-aware tool.`
              );
            }
          }
        }
        // Session cache: skip re-read if file mtime is unchanged since last read.
        const mtime = stat ? stat.mtimeMs : -1;
        const sReads = sessionReadCache.get(SESSION_ID) ?? new Map();
        const cached = sReads.get(resolved);
        let content;
        if (cached && mtime !== -1 && cached.mtimeMs === mtime) {
          logExtra.skipped = true;
          content = cached.content;
        } else {
          content = fs.readFileSync(resolved, "utf-8");
          sReads.set(resolved, { content, mtimeMs: mtime });
          sessionReadCache.set(SESSION_ID, sReads);
        }
        logExtra.bytes = Buffer.byteLength(content, "utf-8");

        // Optional windowed read: offset (1-indexed start line) / limit (max lines).
        // Mirrors the built-in Read tool's pagination so large files no longer
        // force a fall-back to a different tool.
        const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : null;
        const limitLines = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : null;
        if (offset === null && limitLines === null) {
          result = { content: [{ type: "text", text: content }] };
          break;
        }
        const allLines = content.split("\n");
        const startIdx = offset !== null ? offset - 1 : 0;
        const endIdx = limitLines !== null ? startIdx + limitLines : allLines.length;
        const slice = allLines.slice(startIdx, endIdx);
        logExtra.entryCount = slice.length;
        const numbered = slice.map((l, i) => `${startIdx + i + 1}\t${l}`).join("\n");
        const shownEnd = Math.min(endIdx, allLines.length);
        const footer = endIdx < allLines.length
          ? `\n... (showing lines ${startIdx + 1}-${shownEnd} of ${allLines.length} total — pass offset:${shownEnd + 1} to continue)`
          : "";
        result = { content: [{ type: "text", text: numbered + footer }] };
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
        const rawContent = fs.readFileSync(resolved, "utf-8");
        logExtra.bytes = Buffer.byteLength(rawContent, "utf-8");
        // Normalize line endings for matching — files on Windows may use CRLF (\r\n)
        // while old_string always arrives with LF (\n) from JSON transport.
        const hasCRLF = rawContent.includes("\r\n");
        const content = hasCRLF ? rawContent.replace(/\r\n/g, "\n") : rawContent;
        const normalizedOld = oldStr.replace(/\r\n/g, "\n");
        const normalizedNew = newStr.replace(/\r\n/g, "\n");
        if (!content.includes(normalizedOld)) {
          throw new Error(`old_string not found in ${resolved}`);
        }
        const occurrences = content.split(normalizedOld).length - 1;
        if (occurrences > 1) {
          throw new Error(
            `old_string matches ${occurrences} locations in ${resolved} — make it more specific to uniquely identify the target`
          );
        }
        // Apply on LF-normalized content; restore original line endings before writing.
        const newContentLF = content.replace(normalizedOld, normalizedNew);
        const newContent = hasCRLF ? newContentLF.replace(/\n/g, "\r\n") : newContentLF;
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
        if (patternStr.length > 500) {
          throw new Error(`Regex pattern too long (${patternStr.length} chars > 500 max).`);
        }
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
        // Time-budget guard: catastrophic regex backtracking blocks the event loop.
        // Check every 200 lines so the overhead is negligible for typical files.
        const _searchDeadline = Date.now() + 5_000;
        for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
          if (i % 200 === 0 && Date.now() > _searchDeadline) {
            throw new Error("search_in_file: regex match timed out after 5s — simplify the pattern.");
          }
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
      case "search_in_files": {
        const resolved = assertAllowed(args.path);
        const patternStr = typeof args.pattern === "string" ? args.pattern : "";
        if (patternStr.length > 500) {
          throw new Error(`Regex pattern too long (${patternStr.length} chars > 500 max).`);
        }
        let regex;
        try {
          regex = new RegExp(patternStr);
        } catch {
          throw new Error(`Invalid regex pattern: ${patternStr}`);
        }
        const fileGlob = typeof args.file_glob === "string" ? args.file_glob : "";
        const maxFiles = typeof args.max_files === "number" ? Math.min(Math.max(1, args.max_files), 2000) : 500;
        const maxMatches = typeof args.max_matches === "number" ? Math.min(Math.max(1, args.max_matches), 500) : 200;
        const contextLines = typeof args.context_lines === "number" ? Math.min(Math.max(0, args.context_lines), 5) : 0;

        const { fileResults, totalMatches, filesScanned, filesMatched, timedOut, depthReached } =
          searchInFiles(resolved, regex, { fileGlob, maxFiles, maxMatches, contextLines });

        logExtra.entryCount = totalMatches;
        const outLines = [`Found ${totalMatches} match(es) in ${filesMatched} file(s) (scanned ${filesScanned} file(s)):`, ""];
        for (const fr of fileResults) {
          outLines.push(fr.file);
          for (const m of fr.matches) {
            for (const c of m.context) {
              outLines.push(`${c.isMatch ? ">" : " "} ${c.lineNumber}: ${c.text}`);
            }
          }
          outLines.push("");
        }
        if (timedOut) outLines.push("(search timed out after 8s — results may be incomplete; narrow file_glob or pattern)");
        if (depthReached) outLines.push("(directory depth limit reached — results may be incomplete)");
        result = { content: [{ type: "text", text: outLines.join("\n").trimEnd() || "(no matches)" }] };
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
        sessionCreatedAt.set(SESSION_ID, Date.now());
        // Prune caches from previous sessions (and any expired TTL entries).
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
                "Read contents of a file. Only paths inside the configured allowed directories are accessible. " +
                "For large files, pass offset/limit to read a specific line range instead of reading the whole file.",
              inputSchema: {
                type: "object",
                properties: {
                  path: { type: "string", description: "Absolute file path to read" },
                  offset: { type: "number", description: "1-indexed line number to start reading from (optional)" },
                  limit: { type: "number", description: "Maximum number of lines to return (optional)" },
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
            {
              name: "search_in_files",
              description:
                "Recursively search file contents for a regex pattern across a directory tree (like grep -r), " +
                "grouped by file. Skips binary files and common noise directories (node_modules, .git, dist, out, " +
                "build, coverage) by default. Use for 'which files reference X' questions across many files.",
              inputSchema: {
                type: "object",
                properties: {
                  path: { type: "string", description: "Absolute directory path to search in (root of the recursive walk)" },
                  pattern: { type: "string", description: "Regex pattern matched against each line" },
                  file_glob: { type: "string", description: "Only scan files whose name includes this substring (e.g. '.ts')" },
                  max_files: { type: "number", description: "Maximum files to scan (default 500, max 2000)" },
                  max_matches: { type: "number", description: "Maximum total matches across all files (default 200, max 500)" },
                  context_lines: { type: "number", description: "Lines of context around each match (default 0, max 5)" },
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
