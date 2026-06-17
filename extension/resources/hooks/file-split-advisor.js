#!/usr/bin/env node
/**
 * PostToolUse hook: file-split-advisor
 *
 * Fires after every mcp__filesystem__read_file call. When the file content
 * exceeds the size threshold the hook injects a structured split suggestion
 * as a systemPrompt so the agent acts on it before its next step.
 *
 * Self-learning  — persists flagged files + escalation counts in
 *   <workspace>/.claude/learning/file-split-advisor.json
 *   so repeated large reads escalate the hint across sessions.
 *
 * Self-correcting — on the second read of the same large file in a session
 *   the hint escalates from "consider splitting" to a concrete module layout
 *   derived from the file's actual top-level exports/functions.
 */
"use strict";

const fs   = require("fs");
const path = require("path");

// ── Thresholds ────────────────────────────────────────────────────────────────
const WARN_BYTES  = 50  * 1024;   // 50 KB  — gentle nudge
const CRIT_BYTES  = 200 * 1024;   // 200 KB — strong push
const WARN_LINES  = 500;
const CRIT_LINES  = 1500;
const MAX_HINTS_PER_SESSION = 2;   // stop repeating after 2 hints for same path
const LEARNING_REL = path.join(".claude", "learning", "file-split-advisor.json");
const STATE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── I/O helpers ───────────────────────────────────────────────────────────────
function readStdin() {
  try { return fs.readFileSync(0, "utf-8"); } catch { return ""; }
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

function writeJsonSafe(p, data) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf-8");
  } catch { /* non-fatal */ }
}

// ── Payload normalisation ─────────────────────────────────────────────────────
function resolveCwd(raw) {
  return raw.cwd
    || (Array.isArray(raw.workspace_roots) && raw.workspace_roots[0])
    || raw.workingDirectory || raw.working_directory
    || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function resolveSessionId(raw) {
  return raw.session_id || raw.sessionId || raw.conversation_id
    || raw.conversationId || raw.generation_id || "";
}

function extractContent(tr) {
  if (!tr) return null;
  if (typeof tr === "string") {
    try {
      const p = JSON.parse(tr);
      if (Array.isArray(p.content)) return p.content.map(c => c.text || "").join("");
      return typeof p.text === "string" ? p.text : tr;
    } catch { return tr; }
  }
  if (typeof tr === "object") {
    if (Array.isArray(tr.content)) return tr.content.map(c => c.text || "").join("");
    if (typeof tr.text === "string") return tr.text;
  }
  return null;
}

function parsePayload() {
  const raw = readStdin().trim();
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    return {
      cwd:          resolveCwd(obj),
      sessionId:    resolveSessionId(obj),
      toolName:     obj.tool_name || obj.toolName || "",
      toolInput:    obj.tool_input || obj.toolInput || {},
      toolResponse: obj.tool_response ?? obj.toolResult ?? obj.tool_result,
    };
  } catch { return null; }
}

// ── Content analysis — infer likely split points ──────────────────────────────
function inferSplitPoints(content, ext) {
  const lines = content.split("\n");
  const exports_ = [];
  const patterns = [
    /^export\s+(?:default\s+)?(?:async\s+)?(?:function|class)\s+(\w+)/,
    /^export\s+(?:const|let|var)\s+(\w+)/,
    /^export\s+(?:interface|type|enum)\s+(\w+)/,
    /^(?:async\s+)?function\s+(\w+)/,
    /^class\s+(\w+)/,
    /^def\s+(\w+)/,      // Python
    /^class\s+(\w+):$/,  // Python
  ];
  for (const line of lines) {
    for (const re of patterns) {
      const m = line.match(re);
      if (m && m[1] && !exports_.includes(m[1])) {
        exports_.push(m[1]);
        if (exports_.length >= 8) break;
      }
    }
    if (exports_.length >= 8) break;
  }

  // Guess semantic groups from names
  const types   = exports_.filter(n => /type|interface|enum|model|schema|dto/i.test(n));
  const utils   = exports_.filter(n => /util|helper|format|parse|convert|calc/i.test(n));
  const consts  = exports_.filter(n => /const|config|setting|option|default/i.test(n));
  const rest    = exports_.filter(n => !types.includes(n) && !utils.includes(n) && !consts.includes(n));

  return { types, utils, consts, rest, all: exports_ };
}

// ── Hint builder ──────────────────────────────────────────────────────────────
function buildHint(filePath, bytes, lines, sessionReads, content) {
  const ext    = path.extname(filePath);
  const base   = path.basename(filePath, ext);
  const dir    = path.dirname(filePath);
  const isHuge = bytes >= CRIT_BYTES || lines >= CRIT_LINES;
  const kb     = Math.round(bytes / 1024);
  const sizeLabel = bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${kb} KB`;
  const severity  = isHuge ? "🔴 LARGE FILE" : "⚠️  LARGE FILE";
  const { types, utils, consts, rest } = inferSplitPoints(content, ext);

  const suggestedModules = [];
  if (types.length)  suggestedModules.push(`${base}.types${ext}     — ${types.slice(0,3).join(", ")}`);
  if (consts.length) suggestedModules.push(`${base}.constants${ext} — ${consts.slice(0,3).join(", ")}`);
  if (utils.length)  suggestedModules.push(`${base}.utils${ext}     — ${utils.slice(0,3).join(", ")}`);
  if (rest.length)   suggestedModules.push(`${base}.core${ext}      — ${rest.slice(0,4).join(", ")}`);
  if (!suggestedModules.length) {
    suggestedModules.push(
      `${base}.types${ext}     — interfaces, enums, type aliases`,
      `${base}.utils${ext}     — pure helper functions`,
      `${base}.constants${ext} — constants and configuration`,
    );
  }

  const escalation = sessionReads >= 2
    ? `\n♻️  Read ${sessionReads}× this session — every repeat read costs ~${Math.round(bytes / 4 / 1000)}k tokens. Split now to make future reads cheap.\n`
    : "";

  return [
    `${severity}: \`${path.basename(filePath)}\` is ${sizeLabel} / ${lines} lines.`,
    escalation,
    `**Recommended split layout in \`${dir}/\`:**`,
    ...suggestedModules.map(m => `  - \`${m}\``),
    `  - \`${base}${ext}\`          — main entry point (imports + re-exports only)`,
    ``,
    `**Steps (use MCP filesystem tools):**`,
    `1. Extract each group into its dedicated file with \`mcp__filesystem__write_file\``,
    `2. Update \`${base}${ext}\` to \`export * from "./${base}.types${ext.replace(".", "")}";\` etc.`,
    `3. Remove the extracted code from the original file`,
    ``,
    `Splitting reduces per-read token cost and prevents reasoning loops on large files.`,
  ].join("\n");
}

// ── Learning store ────────────────────────────────────────────────────────────
function loadStore(cwd) {
  const file = path.join(cwd, LEARNING_REL);
  const data = readJsonSafe(file) || {};
  if (!data.files)        data.files = {};        // path → { timesLarge, lastBytes, lastLines, lastSeen }
  if (!data.sessionReads) data.sessionReads = {};  // "sessionId|path" → count
  return { file, data };
}

function pruneStore(data) {
  const cutoff = Date.now() - STATE_MAX_AGE_MS;
  for (const [k, v] of Object.entries(data.files)) {
    if (!v.lastSeen || new Date(v.lastSeen).getTime() < cutoff) delete data.files[k];
  }
  // session reads keys grow unboundedly — prune entries older than 24h
  const sessionCutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [k, v] of Object.entries(data.sessionReads)) {
    if (typeof v === "object" && v.ts && new Date(v.ts).getTime() < sessionCutoff) {
      delete data.sessionReads[k];
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  const payload = parsePayload();
  if (!payload) return;

  const toolName = (payload.toolName || "").toLowerCase();
  // Fire on any read_file tool (mcp__filesystem__read_file or similar)
  if (!toolName.includes("read_file")) return;

  const filePath = payload.toolInput?.path;
  if (!filePath) return;

  const content = extractContent(payload.toolResponse);
  if (!content) return;

  const bytes = Buffer.byteLength(content, "utf-8");
  const lines = content.split("\n").length;

  if (bytes < WARN_BYTES && lines < WARN_LINES) return;

  const { file: storeFile, data } = loadStore(payload.cwd);
  const sid = payload.sessionId || "unknown";
  const sessionKey = `${sid}|${filePath}`;

  // Count session reads for this file
  const prevEntry = data.sessionReads[sessionKey];
  const prevReads = typeof prevEntry === "object" ? prevEntry.count : (prevEntry || 0);
  data.sessionReads[sessionKey] = { count: prevReads + 1, ts: new Date().toISOString() };

  // Update learning record
  const rec = data.files[filePath] || { timesLarge: 0, firstSeen: new Date().toISOString() };
  rec.timesLarge   = (rec.timesLarge || 0) + 1;
  rec.lastSeen     = new Date().toISOString();
  rec.lastBytes    = bytes;
  rec.lastLines    = lines;
  data.files[filePath] = rec;

  pruneStore(data);
  writeJsonSafe(storeFile, data);

  // Don't spam — cap at MAX_HINTS_PER_SESSION per file per session
  if (prevReads >= MAX_HINTS_PER_SESSION) return;

  const hint = buildHint(filePath, bytes, lines, prevReads + 1, content);
  process.stdout.write(JSON.stringify({ systemPrompt: hint }) + "\n");
}

main();
