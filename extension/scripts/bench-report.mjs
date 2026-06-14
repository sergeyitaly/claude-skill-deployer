/**
 * Builds a markdown comparison report from the JSON/diff output produced by
 * benchmark-skill-impact.sh for the "with-skills" and "without-skills" runs.
 *
 * Usage: node bench-report.mjs <results-dir>
 */
import * as fs from "node:fs";
import * as path from "node:path";

const resultsDir = process.argv[2];
if (!resultsDir) {
  console.error("Usage: node bench-report.mjs <results-dir>");
  process.exit(1);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf-8").trim();
  } catch {
    return "";
  }
}

/**
 * Sums token usage across `modelUsage` (per-model breakdown, always present
 * even when a run is cut off by --max-budget-usd), falling back to the
 * top-level `usage` block if `modelUsage` is absent.
 */
function tokenTotals(json) {
  const modelUsage = json?.modelUsage;
  if (modelUsage && Object.keys(modelUsage).length > 0) {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheRead = 0;
    let cacheCreate = 0;
    for (const m of Object.values(modelUsage)) {
      inputTokens += m.inputTokens ?? 0;
      outputTokens += m.outputTokens ?? 0;
      cacheRead += m.cacheReadInputTokens ?? 0;
      cacheCreate += m.cacheCreationInputTokens ?? 0;
    }
    return { inputTokens, outputTokens, cacheRead, cacheCreate };
  }
  const usage = json?.usage ?? {};
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheCreate: usage.cache_creation_input_tokens ?? 0,
  };
}

function summarize(label) {
  const json = readJson(path.join(resultsDir, `${label}.json`));
  const seconds = Number(readText(path.join(resultsDir, `${label}.seconds`)) || 0);
  const diffstat = readText(path.join(resultsDir, `${label}.diffstat`));
  const { inputTokens, outputTokens, cacheRead, cacheCreate } = tokenTotals(json);
  return {
    label,
    seconds,
    turns: json?.num_turns ?? null,
    cost: json?.total_cost_usd ?? null,
    inputTokens,
    outputTokens,
    cacheRead,
    cacheCreate,
    totalTokens: inputTokens + outputTokens + cacheRead + cacheCreate,
    result: json?.result ?? "",
    isError: json?.is_error ?? null,
    errors: Array.isArray(json?.errors) ? json.errors : [],
    diffstat,
  };
}

function fmtNum(n) {
  return n === null || n === undefined ? "—" : Number(n).toLocaleString();
}

function fmtCost(n) {
  return n === null || n === undefined ? "—" : `$${Number(n).toFixed(4)}`;
}

function fmtSec(n) {
  return `${Number(n).toFixed(1)}s`;
}

function delta(a, b) {
  if (typeof a !== "number" || typeof b !== "number" || a === 0) return "—";
  const pct = ((b - a) / a) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

const withSkills = summarize("with-skills");
const withoutSkills = summarize("without-skills");

const lines = [];
lines.push(`# Skill impact benchmark — ${path.basename(resultsDir)}`);
lines.push("");
lines.push("| Metric | With skills | Without skills (`--disable-slash-commands`) | Δ (without vs with) |");
lines.push("|---|---|---|---|");
lines.push(`| Wall time | ${fmtSec(withSkills.seconds)} | ${fmtSec(withoutSkills.seconds)} | ${delta(withSkills.seconds, withoutSkills.seconds)} |`);
lines.push(`| Turns | ${fmtNum(withSkills.turns)} | ${fmtNum(withoutSkills.turns)} | ${delta(withSkills.turns, withoutSkills.turns)} |`);
lines.push(`| Input tokens | ${fmtNum(withSkills.inputTokens)} | ${fmtNum(withoutSkills.inputTokens)} | ${delta(withSkills.inputTokens, withoutSkills.inputTokens)} |`);
lines.push(`| Output tokens | ${fmtNum(withSkills.outputTokens)} | ${fmtNum(withoutSkills.outputTokens)} | ${delta(withSkills.outputTokens, withoutSkills.outputTokens)} |`);
lines.push(`| Cache read tokens | ${fmtNum(withSkills.cacheRead)} | ${fmtNum(withoutSkills.cacheRead)} | ${delta(withSkills.cacheRead, withoutSkills.cacheRead)} |`);
lines.push(`| Cache creation tokens | ${fmtNum(withSkills.cacheCreate)} | ${fmtNum(withoutSkills.cacheCreate)} | ${delta(withSkills.cacheCreate, withoutSkills.cacheCreate)} |`);
lines.push(`| Total tokens | ${fmtNum(withSkills.totalTokens)} | ${fmtNum(withoutSkills.totalTokens)} | ${delta(withSkills.totalTokens, withoutSkills.totalTokens)} |`);
lines.push(`| Total cost (USD) | ${fmtCost(withSkills.cost)} | ${fmtCost(withoutSkills.cost)} | ${delta(withSkills.cost, withoutSkills.cost)} |`);
lines.push(`| Error | ${withSkills.isError ?? "—"} | ${withoutSkills.isError ?? "—"} | |`);
if (withSkills.errors.length || withoutSkills.errors.length) {
  lines.push(`| Error detail | ${withSkills.errors.join("; ") || "—"} | ${withoutSkills.errors.join("; ") || "—"} | |`);
}
lines.push("");
lines.push("## Diff produced");
lines.push("");
lines.push("### With skills");
lines.push("```");
lines.push(withSkills.diffstat || "(no changes)");
lines.push("```");
lines.push("");
lines.push("### Without skills");
lines.push("```");
lines.push(withoutSkills.diffstat || "(no changes)");
lines.push("```");
lines.push("");
lines.push("## Final agent response");
lines.push("");
lines.push("### With skills");
lines.push("");
lines.push(withSkills.result || "_(none)_");
lines.push("");
lines.push("### Without skills");
lines.push("");
lines.push(withoutSkills.result || "_(none)_");
lines.push("");
lines.push("Full diffs (if any): `with-skills.diff`, `without-skills.diff` in this directory.");
lines.push("Raw CLI output: `with-skills.json`, `without-skills.json`, `*.log`.");

const report = lines.join("\n") + "\n";
fs.writeFileSync(path.join(resultsDir, "report.md"), report, "utf-8");
console.log("");
console.log(report);
