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

module.exports = {
  sumTranscriptUsage,
  formatTokenCount,
  formatUsd,
  totalTokens,
  computeTodayUsageAcrossProjects,
};
