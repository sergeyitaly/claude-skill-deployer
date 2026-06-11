import * as fs from "node:fs";
import * as path from "node:path";
import { detectRelevantSkills, Manifest } from "./skillOps";
import { CreditUsageSummary } from "./usageCost";
import { EnrichedRunRecord, normalizeRunRecord, RunAgent } from "./runRecording";

export type { RunAgent };

export interface RunRecord {
  ts: string;
  timestamp?: string;
  skill: string;
  action: string;
  rc: number;
  duration?: number;
  error?: string;
  hint?: string;
  note?: string;
  tokens?: number;
  cost?: number;
  success?: boolean;
  session_id?: string;
  project?: string;
  branch?: string | null;
  metadata?: Record<string, unknown>;
  /** Optional — which agent ran this skill (defaults to claude in attribution). */
  agent?: RunAgent;
}

export type UsageRating = "active" | "needs-attention" | "low-usage" | "unused";

export interface SkillUsageStat {
  name: string;
  runs: number;
  successCount: number;
  failureCount: number;
  successRate: number | null;
  avgDuration: number | null;
  lastUsed: string | null;
  daysSinceLastUse: number | null;
  totalTokens: number | null;
  rating: UsageRating;
}

export interface SuggestedSkill {
  name: string;
  description: string;
  matchedGlobs: string[];
}

const LEARNING_DIR_RELATIVE = path.join(".claude", "learning");
const RUNS_LOG_RELATIVE = path.join(LEARNING_DIR_RELATIVE, "runs.jsonl");

/** Ensures <target>/.claude/learning exists so the self-learning skill has a
 * place to write run records. Returns true if the directory was created. */
export function ensureLearningDir(target: string): boolean {
  const dir = path.join(target, LEARNING_DIR_RELATIVE);
  if (fs.existsSync(dir)) {
    return false;
  }
  fs.mkdirSync(dir, { recursive: true });
  return true;
}

/** Reads and parses .claude/learning/runs.jsonl (written by the self-learning
 * skill). Malformed lines are skipped. Returns [] if the file doesn't exist. */
export function readRunRecords(target: string): RunRecord[] {
  return readEnrichedRuns(target).map((r) => ({
    ts: r.ts,
    timestamp: r.timestamp,
    skill: r.skill,
    action: r.action,
    rc: r.rc,
    duration: r.duration,
    error: r.error,
    hint: r.hint,
    note: r.note,
    tokens: r.tokens,
    cost: r.cost,
    success: r.success,
    session_id: r.session_id,
    project: r.project,
    branch: r.branch ?? undefined,
    metadata: r.metadata,
    agent: r.agent,
  }));
}

/** Normalized runs with attribution fields (agent, session_id, cost, etc.). */
export function readEnrichedRuns(target: string): EnrichedRunRecord[] {
  const file = path.join(target, RUNS_LOG_RELATIVE);
  if (!fs.existsSync(file)) {
    return [];
  }
  const lines = fs.readFileSync(file, "utf-8").split("\n");
  const records: EnrichedRunRecord[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const normalized = normalizeRunRecord(obj);
      if (normalized) {
        records.push(normalized);
      }
    } catch {
      // skip malformed lines
    }
  }
  return records;
}

/** Names of skills installed in <target>/.claude/skills/. */
export function listInstalledSkills(target: string): string[] {
  const dir = path.join(target, ".claude", "skills");
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
}

function rate(stat: Omit<SkillUsageStat, "rating">): SkillUsageStat {
  let rating: UsageRating;

  if (stat.runs === 0) {
    rating = "unused";
  } else if (stat.runs >= 3 && (stat.successRate ?? 100) < 60) {
    rating = "needs-attention";
  } else if (stat.runs >= 2 && stat.daysSinceLastUse !== null && stat.daysSinceLastUse <= 30) {
    rating = "active";
  } else {
    rating = "low-usage";
  }

  return { ...stat, rating };
}

function lastUsedInfo(recs: RunRecord[], now: number): { lastUsed: string | null; daysSinceLastUse: number | null } {
  let lastUsed: string | null = null;
  for (const r of recs) {
    if (!lastUsed || new Date(r.ts).getTime() > new Date(lastUsed).getTime()) {
      lastUsed = r.ts;
    }
  }
  const daysSinceLastUse = lastUsed ? Math.floor((now - new Date(lastUsed).getTime()) / (1000 * 60 * 60 * 24)) : null;
  return { lastUsed, daysSinceLastUse };
}

function statForSkill(name: string, recs: RunRecord[], now: number): SkillUsageStat {
  const runs = recs.length;
  const successCount = recs.filter((r) => r.rc === 0).length;
  const failureCount = runs - successCount;
  const successRate = runs > 0 ? (successCount / runs) * 100 : null;

  const durations = recs.map((r) => r.duration).filter((d): d is number => typeof d === "number");
  const avgDuration = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null;

  const tokenVals = recs.map((r) => r.tokens).filter((t): t is number => typeof t === "number");
  const totalTokens = tokenVals.length > 0 ? tokenVals.reduce((a, b) => a + b, 0) : null;

  const { lastUsed, daysSinceLastUse } = lastUsedInfo(recs, now);

  return rate({ name, runs, successCount, failureCount, successRate, avgDuration, lastUsed, daysSinceLastUse, totalTokens });
}

/** Aggregates .claude/learning/runs.jsonl entries per known skill (manifest
 * keys), plus any installed skill with zero matching records ("unused"). */
export function computeUsageStats(target: string, manifest: Manifest): SkillUsageStat[] {
  const records = readRunRecords(target);
  const installed = new Set(listInstalledSkills(target));
  const knownSkills = new Set(Object.keys(manifest.skills));

  const byName = new Map<string, RunRecord[]>();
  for (const rec of records) {
    if (!knownSkills.has(rec.skill)) {
      continue;
    }
    const list = byName.get(rec.skill) ?? [];
    list.push(rec);
    byName.set(rec.skill, list);
  }

  const names = new Set<string>([...installed, ...byName.keys()]);
  const now = Date.now();

  const stats = [...names].map((name) => statForSkill(name, byName.get(name) ?? [], now));
  stats.sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));
  return stats;
}

/** Skills relevant to this workspace (by manifest detect_globs) that aren't
 * installed in <target>/.claude/skills yet - candidates that could help. */
export function computeSuggestedSkills(target: string, manifest: Manifest): SuggestedSkill[] {
  const detected = detectRelevantSkills(target, manifest);
  const installed = new Set(listInstalledSkills(target));
  return Object.entries(detected)
    .filter(([name]) => !installed.has(name))
    .map(([name, matchedGlobs]) => ({
      name,
      description: manifest.skills[name].description,
      matchedGlobs,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function formatRecency(days: number | null): string {
  if (days === null) {
    return "-";
  }
  if (days === 0) {
    return "today";
  }
  return days === 1 ? "1d ago" : `${days}d ago`;
}

/** Compact token count, e.g. 1234 -> "1.2k", 1500000 -> "1.5M". */
export function formatTokenCount(n: number | null): string {
  if (n === null) {
    return "-";
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }
  return `${n}`;
}

function formatCost(usd: number): string {
  if (usd < 0.01 && usd > 0) {
    return "<$0.01";
  }
  return `$${usd.toFixed(2)}`;
}

const RATING_LABEL: Record<UsageRating, string> = {
  active: "Active",
  "needs-attention": "Needs attention",
  "low-usage": "Low usage",
  unused: "Unused",
};

function tallyRatings(stats: SkillUsageStat[]): Record<UsageRating, number> {
  const counts: Record<UsageRating, number> = { active: 0, "needs-attention": 0, "low-usage": 0, unused: 0 };
  for (const s of stats) {
    counts[s.rating]++;
  }
  return counts;
}

function summaryLine(stats: SkillUsageStat[], suggested: SuggestedSkill[], counts: Record<UsageRating, number>): string {
  const parts: string[] = [];
  if (stats.length > 0) {
    parts.push(
      `${stats.length} installed (${counts.active} active, ${counts["low-usage"]} low-usage, ${counts.unused} unused, ${counts["needs-attention"]} needs attention)`
    );
  }
  if (suggested.length > 0) {
    parts.push(`${suggested.length} suggested`);
  }
  return parts.join(" - ");
}

function misusedLines(stats: SkillUsageStat[]): string[] {
  const misused = stats.filter((s) => s.rating === "needs-attention");
  if (misused.length === 0) {
    return [];
  }
  const lines = ["## Misused (failing often)", ""];
  for (const s of misused) {
    lines.push(
      `- **${s.name}**: ${Math.round(s.successRate ?? 0)}% success over ${s.runs} runs - check \`.claude/learning/patterns.md\` for recurring errors.`
    );
  }
  lines.push("");
  return lines;
}

function suggestedLines(suggested: SuggestedSkill[]): string[] {
  if (suggested.length === 0) {
    return [];
  }
  const lines = ["## Could help with this workspace", ""];
  for (const s of suggested) {
    lines.push(`- **${s.name}** - ${s.description} (matches ${s.matchedGlobs.join(", ")})`);
  }
  lines.push("");
  return lines;
}

function removalLines(stats: SkillUsageStat[]): string[] {
  const removal = stats.filter((s) => s.rating === "unused" || s.rating === "low-usage");
  if (removal.length === 0) {
    return [];
  }
  const lines = ["## Removal candidates", ""];
  for (const s of removal) {
    const detail = s.runs === 0 ? "never used" : `${s.runs} run(s), last used ${formatRecency(s.daysSinceLastUse)}`;
    lines.push(`- ${s.name} - ${detail}`);
  }
  lines.push(
    "",
    "Delete `.claude/skills/<name>/` if no longer needed, or ask the `skill-usage-insights` skill for a fuller analysis.",
    ""
  );
  return lines;
}

function detailTableLines(stats: SkillUsageStat[]): string[] {
  if (stats.length === 0) {
    return [];
  }
  const lines = [
    "## Per-skill detail",
    "",
    "| Skill | Runs | Success | Tokens | Last used | Rating |",
    "|---|---|---|---|---|---|",
  ];
  for (const s of stats) {
    const successPct = s.successRate === null ? "-" : `${Math.round(s.successRate)}%`;
    lines.push(
      `| ${s.name} | ${s.runs} | ${successPct} | ${formatTokenCount(s.totalTokens)} | ${formatRecency(s.daysSinceLastUse)} | ${RATING_LABEL[s.rating]} |`
    );
  }
  return lines;
}

function tokenSum(usage: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number }): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
}

function creditUsageLines(creditUsage: CreditUsageSummary): string[] {
  const lines = [`## Claude Credits Usage (last ${creditUsage.daysBack} days, all projects)`, ""];

  if (creditUsage.totalTokens === 0) {
    lines.push("No recorded Claude Code activity in this window.", "");
    return lines;
  }

  lines.push(
    `${formatTokenCount(creditUsage.totalTokens)} tokens, ~${formatCost(creditUsage.totalCost)} estimated, across ${creditUsage.sessionCount} session(s).`,
    "",
    "| Model | Input | Output | Cache write | Cache read | Tokens | Est. cost |",
    "|---|---|---|---|---|---|---|"
  );
  for (const m of creditUsage.byModel) {
    lines.push(
      `| ${m.model} | ${formatTokenCount(m.inputTokens)} | ${formatTokenCount(m.outputTokens)} | ${formatTokenCount(m.cacheCreationTokens)} | ${formatTokenCount(m.cacheReadTokens)} | ${formatTokenCount(tokenSum(m))} | ${formatCost(m.cost)} |`
    );
  }

  lines.push("", "| Date | Tokens | Est. cost |", "|---|---|---|");
  for (const d of creditUsage.byDay) {
    lines.push(`| ${d.date} | ${formatTokenCount(tokenSum(d))} | ${formatCost(d.cost)} |`);
  }

  lines.push(
    "",
    "Estimated cost is based on published per-model API pricing for reference - it is not an actual bill (Pro/Max plans are flat-rate).",
    ""
  );
  return lines;
}

export function formatUsageReport(
  stats: SkillUsageStat[],
  suggested: SuggestedSkill[],
  target: string,
  creditUsage: CreditUsageSummary
): string {
  if (stats.length === 0 && suggested.length === 0) {
    return [
      "# Claude Skills Usage Report",
      "",
      `Workspace: \`${target}\``,
      "",
      ...creditUsageLines(creditUsage),
      "No installed skills, no recorded skill runs, and no relevant skills detected for this workspace.",
    ].join("\n");
  }

  const counts = tallyRatings(stats);
  return [
    "# Claude Skills Usage Report",
    "",
    `Workspace: \`${target}\``,
    "",
    summaryLine(stats, suggested, counts),
    "",
    ...creditUsageLines(creditUsage),
    ...misusedLines(stats),
    ...suggestedLines(suggested),
    ...removalLines(stats),
    ...detailTableLines(stats),
  ].join("\n");
}

const RATING_CLASS: Record<UsageRating, string> = {
  active: "active",
  "needs-attention": "needs-attention",
  "low-usage": "low-usage",
  unused: "unused",
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function htmlCards(counts: Record<UsageRating, number>, suggestedCount: number): string {
  const cards = (
    [
      ["active", "Active"],
      ["low-usage", "Low usage"],
      ["unused", "Unused"],
      ["needs-attention", "Needs attention"],
    ] as [UsageRating, string][]
  ).map(([key, label]) => `<div class="card ${key}"><div class="count">${counts[key]}</div><div class="label">${label}</div></div>`);

  if (suggestedCount > 0) {
    cards.push(`<div class="card suggested"><div class="count">${suggestedCount}</div><div class="label">Suggested</div></div>`);
  }
  return cards.join("\n");
}

function htmlMisusedSection(stats: SkillUsageStat[]): string {
  const misused = stats.filter((s) => s.rating === "needs-attention");
  if (misused.length === 0) {
    return "";
  }
  const items = misused
    .map(
      (s) =>
        `<li><b>${escapeHtml(s.name)}</b>: ${Math.round(s.successRate ?? 0)}% success over ${s.runs} runs - check <code>.claude/learning/patterns.md</code> for recurring errors.</li>`
    )
    .join("\n");
  return `<div class="section"><h2>Misused (failing often)</h2><ul>${items}</ul></div>`;
}

function htmlSuggestedSection(suggested: SuggestedSkill[]): string {
  if (suggested.length === 0) {
    return "";
  }
  const items = suggested
    .map(
      (s) =>
        `<li><b>${escapeHtml(s.name)}</b> - ${escapeHtml(s.description)} <span class="muted">(matches ${escapeHtml(s.matchedGlobs.join(", "))})</span></li>`
    )
    .join("\n");
  return `<div class="section"><h2>Could help with this workspace</h2><ul>${items}</ul></div>`;
}

function htmlRemovalSection(stats: SkillUsageStat[]): string {
  const removal = stats.filter((s) => s.rating === "unused" || s.rating === "low-usage");
  if (removal.length === 0) {
    return "";
  }
  const items = removal
    .map((s) => {
      const detail = s.runs === 0 ? "never used" : `${s.runs} run(s), last used ${formatRecency(s.daysSinceLastUse)}`;
      return `<li><b>${escapeHtml(s.name)}</b> - ${detail}</li>`;
    })
    .join("\n");
  return `<div class="section"><h2>Removal candidates</h2><ul>${items}</ul><div class="note">Delete <code>.claude/skills/&lt;name&gt;/</code> if no longer needed, or ask the <code>skill-usage-insights</code> skill for a fuller analysis.</div></div>`;
}

function htmlDetailTable(stats: SkillUsageStat[]): string {
  if (stats.length === 0) {
    return "";
  }
  const rows = stats
    .map((s) => {
      const successPct = s.successRate === null ? "-" : `${Math.round(s.successRate)}%`;
      return `<tr>
          <td>${escapeHtml(s.name)}</td>
          <td class="num">${s.runs}</td>
          <td class="num">${successPct}</td>
          <td class="num">${formatTokenCount(s.totalTokens)}</td>
          <td>${formatRecency(s.daysSinceLastUse)}</td>
          <td><span class="badge ${RATING_CLASS[s.rating]}">${RATING_LABEL[s.rating]}</span></td>
        </tr>`;
    })
    .join("\n");
  return `<table>
      <thead><tr><th>Skill</th><th>Runs</th><th>Success</th><th>Tokens</th><th>Last used</th><th>Rating</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function htmlCreditUsageSection(creditUsage: CreditUsageSummary): string {
  const title = `Claude Credits Usage (last ${creditUsage.daysBack} days, all projects)`;
  if (creditUsage.totalTokens === 0) {
    return `<div class="section"><h2>${title}</h2><p>No recorded Claude Code activity in this window.</p></div>`;
  }

  const modelRows = creditUsage.byModel
    .map(
      (m) => `<tr>
          <td>${escapeHtml(m.model)}</td>
          <td class="num">${formatTokenCount(m.inputTokens)}</td>
          <td class="num">${formatTokenCount(m.outputTokens)}</td>
          <td class="num">${formatTokenCount(m.cacheCreationTokens)}</td>
          <td class="num">${formatTokenCount(m.cacheReadTokens)}</td>
          <td class="num">${formatTokenCount(tokenSum(m))}</td>
          <td class="num">${formatCost(m.cost)}</td>
        </tr>`
    )
    .join("\n");

  const dayRows = creditUsage.byDay
    .map(
      (d) => `<tr>
          <td>${d.date}</td>
          <td class="num">${formatTokenCount(tokenSum(d))}</td>
          <td class="num">${formatCost(d.cost)}</td>
        </tr>`
    )
    .join("\n");

  return `<div class="section">
    <h2>${title}</h2>
    <p>${formatTokenCount(creditUsage.totalTokens)} tokens, ~${formatCost(creditUsage.totalCost)} estimated, across ${creditUsage.sessionCount} session(s).</p>
    <table>
      <thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cache write</th><th>Cache read</th><th>Tokens</th><th>Est. cost</th></tr></thead>
      <tbody>${modelRows}</tbody>
    </table>
    <table>
      <thead><tr><th>Date</th><th>Tokens</th><th>Est. cost</th></tr></thead>
      <tbody>${dayRows}</tbody>
    </table>
    <div class="note">Estimated cost is based on published per-model API pricing for reference - it is not an actual bill (Pro/Max plans are flat-rate).</div>
  </div>`;
}

/** Renders the usage report as a styled HTML page for a webview panel. */
export function formatUsageReportHtml(
  stats: SkillUsageStat[],
  suggested: SuggestedSkill[],
  target: string,
  creditUsage: CreditUsageSummary
): string {
  const counts = tallyRatings(stats);

  let body: string;
  if (stats.length === 0 && suggested.length === 0) {
    body = [
      htmlCreditUsageSection(creditUsage),
      "<p>No installed skills, no recorded skill runs, and no relevant skills detected for this workspace.</p>",
    ].join("\n");
  } else {
    body = [
      htmlCreditUsageSection(creditUsage),
      htmlMisusedSection(stats),
      htmlSuggestedSection(suggested),
      htmlRemovalSection(stats),
      htmlDetailTable(stats),
    ]
      .filter((s) => s.length > 0)
      .join("\n");
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px 20px; }
  h1 { font-size: 1.3em; margin-bottom: 4px; }
  h2 { font-size: 1em; margin: 0 0 6px; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-bottom: 18px; }
  .meta code { font-family: var(--vscode-editor-font-family); }
  .summary { display: flex; gap: 12px; margin-bottom: 18px; flex-wrap: wrap; }
  .card { border: 1px solid var(--vscode-panel-border); border-left-width: 4px; border-radius: 6px; padding: 8px 18px; min-width: 90px; text-align: center; }
  .card .count { font-size: 1.6em; font-weight: 600; }
  .card .label { font-size: 0.8em; color: var(--vscode-descriptionForeground); }
  .card.active { border-left-color: #3fb950; }
  .card.low-usage { border-left-color: #d29922; }
  .card.unused { border-left-color: #8b949e; }
  .card.needs-attention { border-left-color: #f85149; }
  .card.suggested { border-left-color: #58a6ff; }
  .section { margin-bottom: 16px; }
  .section ul { margin: 0; padding-left: 20px; font-size: 0.9em; }
  .section li { margin-bottom: 2px; }
  .muted { color: var(--vscode-descriptionForeground); }
  table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  th { color: var(--vscode-descriptionForeground); font-weight: 600; }
  td.num { text-align: right; white-space: nowrap; }
  .badge { display: inline-block; padding: 2px 9px; border-radius: 10px; font-size: 0.8em; font-weight: 600; color: #fff; white-space: nowrap; }
  .badge.active { background: #3fb950; }
  .badge.low-usage { background: #d29922; }
  .badge.unused { background: #8b949e; }
  .badge.needs-attention { background: #f85149; }
  .note { margin-top: 8px; padding: 10px 14px; border-left: 3px solid var(--vscode-textLink-foreground); background: var(--vscode-textCodeBlock-background); font-size: 0.9em; }
  .note code { font-family: var(--vscode-editor-font-family); }
</style>
</head>
<body>
  <h1>Claude Skills Usage Report</h1>
  <div class="meta">Workspace: <code>${escapeHtml(target)}</code></div>
  <div class="summary">
${htmlCards(counts, suggested.length)}
  </div>
  ${body}
</body>
</html>`;
}
