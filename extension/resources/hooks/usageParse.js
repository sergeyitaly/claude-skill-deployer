// Shared transcript token parsing and cost estimation for Claude Code hooks.
// Mirrors extension/src/usageCost.ts pricing (approximate API reference rates).

const PRICING_TIERS = [
  { match: "opus", pricing: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } },
  { match: "haiku", pricing: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 } },
];
const DEFAULT_PRICING = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };

function pricingForModel(model) {
  const lower = (model || "").toLowerCase();
  for (const tier of PRICING_TIERS) {
    if (lower.includes(tier.match)) {
      return tier.pricing;
    }
  }
  return DEFAULT_PRICING;
}

function totalTokens(usage) {
  return (
    (usage.inputTokens || 0) +
    (usage.outputTokens || 0) +
    (usage.cacheCreationTokens || 0) +
    (usage.cacheReadTokens || 0)
  );
}

function estimateCostUsd(model, usage) {
  const pricing = pricingForModel(model);
  return (
    ((usage.inputTokens || 0) / 1_000_000) * pricing.input +
    ((usage.outputTokens || 0) / 1_000_000) * pricing.output +
    ((usage.cacheCreationTokens || 0) / 1_000_000) * pricing.cacheWrite +
    ((usage.cacheReadTokens || 0) / 1_000_000) * pricing.cacheRead
  );
}

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

function addUsage(target, delta) {
  target.inputTokens += delta.inputTokens || 0;
  target.outputTokens += delta.outputTokens || 0;
  target.cacheCreationTokens += delta.cacheCreationTokens || 0;
  target.cacheReadTokens += delta.cacheReadTokens || 0;
}

/** Sum token usage from a Claude Code session transcript (.jsonl). */
function sumTranscriptUsage(transcriptPath) {
  const fs = require("fs");
  let content;
  try {
    content = fs.readFileSync(transcriptPath, "utf-8");
  } catch {
    return { totalTokens: 0, totalCostUsd: 0, byModel: new Map() };
  }

  const byModel = new Map();
  for (const line of content.split("\n")) {
    if (!line.includes('"usage"')) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = parsed.message?.usage;
    const model = parsed.message?.model;
    if (!usage || !model) {
      continue;
    }
    const delta = {
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cacheCreationTokens: usage.cache_creation_input_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
    };
    if (totalTokens(delta) === 0) {
      continue;
    }
    const bucket = byModel.get(model) || emptyUsage();
    addUsage(bucket, delta);
    byModel.set(model, bucket);
  }

  let totalTokenCount = 0;
  let totalCostUsd = 0;
  for (const [model, usage] of byModel) {
    totalTokenCount += totalTokens(usage);
    totalCostUsd += estimateCostUsd(model, usage);
  }

  return { totalTokens: totalTokenCount, totalCostUsd, byModel };
}

function formatTokenCount(n) {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }
  return `${n}`;
}

function formatUsd(usd) {
  if (usd < 0.01 && usd > 0) {
    return "<$0.01";
  }
  return `$${usd.toFixed(2)}`;
}

const fs = require("fs");
const path = require("path");
const os = require("os");

const BUCKET_KEY_SEP = "|";

function listTranscriptFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTranscriptFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(full);
    }
  }
  return files;
}

function recordLine(line, today, buckets) {
  if (!line.includes('"usage"')) {
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  const usage = parsed.message?.usage;
  const model = parsed.message?.model;
  const timestamp = parsed.timestamp;
  if (!usage || !model || !timestamp) {
    return;
  }
  const date = timestamp.slice(0, 10);
  if (date !== today) {
    return;
  }
  const delta = {
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    cacheCreationTokens: usage.cache_creation_input_tokens || 0,
    cacheReadTokens: usage.cache_read_input_tokens || 0,
  };
  if (totalTokens(delta) === 0) {
    return;
  }
  const key = `${date}${BUCKET_KEY_SEP}${model}`;
  const bucket = buckets.get(key) || emptyUsage();
  addUsage(bucket, delta);
  buckets.set(key, bucket);
}

function recordFile(file, today, buckets) {
  let content;
  try {
    content = fs.readFileSync(file, "utf-8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    recordLine(line, today, buckets);
  }
}

/** Sum today's token usage and estimated cost across all Claude Code projects. */
function computeTodayUsageAcrossProjects() {
  const today = new Date().toISOString().slice(0, 10);
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  const buckets = new Map();

  for (const file of listTranscriptFiles(projectsDir)) {
    recordFile(file, today, buckets);
  }

  let totalTokenCount = 0;
  let totalCostUsd = 0;
  for (const [key, usage] of buckets) {
    const model = key.split(BUCKET_KEY_SEP)[1];
    totalTokenCount += totalTokens(usage);
    totalCostUsd += estimateCostUsd(model, usage);
  }

  return { totalTokens: totalTokenCount, totalCostUsd, date: today };
}

// ---- Incremental scan cache (avoids re-reading full transcripts on every hook invocation) ----

// Per-day cache path — avoids a single ever-growing 40 KB blob for all-time history.
function todayCachePath() {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(os.homedir(), ".claude", "learning", `usage-today-cache.${today}.json`);
}

// Returns the sum of immediate project-subdir mtimes — cheap O(N subdirs) fingerprint.
function projectsDirFingerprint(projectsDir) {
  try {
    return fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .reduce((sum, e) => {
        try { return sum + fs.statSync(path.join(projectsDir, e.name)).mtimeMs; } catch { return sum; }
      }, 0)
      .toString();
  } catch { return ""; }
}

// Delete usage-today-cache files older than 7 days (runs only when a full rescan happens).
function cleanupStaleDayCaches() {
  const dir = path.join(os.homedir(), ".claude", "learning");
  const cutoffMs = Date.now() - 7 * 86400_000;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/^usage-today-cache\.\d{4}-\d{2}-\d{2}\.json$/.test(f)) {
        const fp = path.join(dir, f);
        try { if (fs.statSync(fp).mtimeMs < cutoffMs) fs.unlinkSync(fp); } catch {}
      }
    }
    // Remove old single-file cache left by previous versions
    const legacy = path.join(dir, "usage-today-cache.json");
    try { fs.unlinkSync(legacy); } catch {}
  } catch {}
}

function readCacheFile(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return null; }
}

function writeCacheFile(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data) + "\n", "utf-8");
  } catch {}
}

/** Parse usage lines from `content`, accumulating into a plain-object `byModel` map. */
function parseUsageLines(content, today, byModel) {
  const result = Object.assign({}, byModel);
  for (const line of content.split("\n")) {
    if (!line.includes('"usage"')) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    const usage = parsed.message?.usage;
    const model = parsed.message?.model;
    if (!usage || !model) continue;
    if (today) {
      const ts = parsed.timestamp;
      if (!ts || ts.slice(0, 10) !== today) continue;
    }
    const delta = {
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cacheCreationTokens: usage.cache_creation_input_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
    };
    if (totalTokens(delta) === 0) continue;
    const bucket = result[model] || emptyUsage();
    addUsage(bucket, delta);
    result[model] = bucket;
  }
  return result;
}

/** Read `file` starting at byte `offset` (pass 0 for a full read). */
function readFileFrom(file, offset) {
  if (offset === 0) {
    try { return fs.readFileSync(file, "utf-8"); } catch { return ""; }
  }
  try {
    const stat = fs.statSync(file);
    const newBytes = stat.size - offset;
    if (newBytes <= 0) return "";
    const fd = fs.openSync(file, "r");
    const buf = Buffer.allocUnsafe(newBytes);
    fs.readSync(fd, buf, 0, newBytes, offset);
    fs.closeSync(fd);
    return buf.toString("utf-8");
  } catch {
    return "";
  }
}

/**
 * Incrementally-cached version of computeTodayUsageAcrossProjects.
 * Uses a per-day cache file and a projectsDir mtime fingerprint to skip the
 * expensive recursive transcript walk on the vast majority of prompt-submit calls.
 */
function computeTodayUsageAcrossProjectsCached() {
  const today = new Date().toISOString().slice(0, 10);
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  const cacheFile = todayCachePath();

  let cache = readCacheFile(cacheFile) || {};
  if (cache.date !== today) cache = { date: today, files: {}, dirFingerprint: "" };
  const fileCache = cache.files || {};
  const updatedFiles = {};
  let dirty = false;

  const currentFingerprint = projectsDirFingerprint(projectsDir);
  const needsRescan = currentFingerprint !== (cache.dirFingerprint || "");

  if (!needsRescan && Object.keys(fileCache).length > 0) {
    // Fast path: no new project dirs detected — check only known files for size changes.
    for (const [file, cached] of Object.entries(fileCache)) {
      let currentSize;
      try { currentSize = fs.statSync(file).size; } catch { continue; }
      if (cached && cached.size === currentSize) { updatedFiles[file] = cached; continue; }
      const offset = (cached && currentSize > cached.size) ? cached.size : 0;
      const chunk = readFileFrom(file, offset);
      const existingByModel = offset > 0 ? (cached.byModel || {}) : {};
      const byModel = parseUsageLines(chunk, today, existingByModel);
      updatedFiles[file] = { size: currentSize, byModel };
      dirty = true;
    }
  } else {
    // Slow path: full rescan (first run or project dir structure changed).
    for (const file of listTranscriptFiles(projectsDir)) {
      let currentSize;
      try { currentSize = fs.statSync(file).size; } catch { continue; }
      const cached = fileCache[file];
      if (cached && cached.size === currentSize) { updatedFiles[file] = cached; continue; }
      const offset = (cached && currentSize > cached.size) ? cached.size : 0;
      const chunk = readFileFrom(file, offset);
      const existingByModel = offset > 0 ? (cached.byModel || {}) : {};
      const byModel = parseUsageLines(chunk, today, existingByModel);
      updatedFiles[file] = { size: currentSize, byModel };
      dirty = true;
    }
    dirty = true; // always persist updated fingerprint after rescan
    cleanupStaleDayCaches();
  }

  if (dirty || needsRescan) {
    writeCacheFile(cacheFile, { date: today, files: updatedFiles, dirFingerprint: currentFingerprint });
  }

  let totalTokenCount = 0;
  let totalCostUsd = 0;
  for (const fc of Object.values(updatedFiles)) {
    for (const [model, usage] of Object.entries(fc.byModel || {})) {
      totalTokenCount += totalTokens(usage);
      totalCostUsd += estimateCostUsd(model, usage);
    }
  }

  return { totalTokens: totalTokenCount, totalCostUsd, date: today };
}

/**
 * Cached version of sumTranscriptUsage — only re-parses bytes appended since the last call.
 * @param {string} cacheFile - per-workspace JSON file for persisting size/token state
 */
function sumTranscriptUsageCached(transcriptPath, cacheFile) {
  let currentSize;
  try { currentSize = fs.statSync(transcriptPath).size; } catch {
    return { totalTokens: 0, totalCostUsd: 0, byModel: new Map() };
  }

  const allCache = readCacheFile(cacheFile) || {};
  const cached = allCache[transcriptPath] || null;

  if (cached && cached.size === currentSize) {
    return {
      totalTokens: cached.tokens,
      totalCostUsd: cached.costUsd,
      byModel: new Map(Object.entries(cached.byModel || {})),
    };
  }

  const offset = (cached && currentSize > cached.size) ? cached.size : 0;
  const content = readFileFrom(transcriptPath, offset);
  const existingByModel = offset > 0 ? (cached.byModel || {}) : {};
  const byModel = parseUsageLines(content, null, existingByModel);

  let totalTokenCount = 0;
  let totalCostUsd = 0;
  for (const [model, usage] of Object.entries(byModel)) {
    totalTokenCount += totalTokens(usage);
    totalCostUsd += estimateCostUsd(model, usage);
  }

  allCache[transcriptPath] = { size: currentSize, byModel, tokens: totalTokenCount, costUsd: totalCostUsd };
  writeCacheFile(cacheFile, allCache);

  return { totalTokens: totalTokenCount, totalCostUsd, byModel: new Map(Object.entries(byModel)) };
}

/** Sum tokens/cost already recorded in this workspace's runs.jsonl for one session (Kiro/Copilot fallback — no transcript). */
function sumSessionRunsUsage(cwd, sessionId) {
  const runsFile = path.join(cwd, ".claude", "learning", "runs.jsonl");
  let content;
  try {
    content = fs.readFileSync(runsFile, "utf-8");
  } catch {
    return { totalTokens: 0, totalCostUsd: 0 };
  }

  let totalTokenCount = 0;
  let totalCostUsd = 0;
  for (const line of content.split("\n")) {
    if (!line.includes(sessionId)) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.session_id !== sessionId) {
      continue;
    }
    totalTokenCount += parsed.tokens || 0;
    totalCostUsd += parsed.cost || 0;
  }

  return { totalTokens: totalTokenCount, totalCostUsd };
}

module.exports = {
  sumTranscriptUsage,
  sumTranscriptUsageCached,
  sumSessionRunsUsage,
  formatTokenCount,
  formatUsd,
  totalTokens,
  computeTodayUsageAcrossProjects,
  computeTodayUsageAcrossProjectsCached,
};
