import * as fs from "node:fs";
import * as path from "node:path";
import { Manifest } from "./skillOps";

export interface RunRecord {
  ts: string;
  skill: string;
  action: string;
  rc: number;
  duration?: number;
  error?: string;
  hint?: string;
  note?: string;
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
  rating: UsageRating;
  recommendation: string;
}

const RUNS_LOG_RELATIVE = path.join(".claude", "learning", "runs.jsonl");

/** Reads and parses .claude/learning/runs.jsonl (written by the self-learning
 * skill). Malformed lines are skipped. Returns [] if the file doesn't exist. */
export function readRunRecords(target: string): RunRecord[] {
  const file = path.join(target, RUNS_LOG_RELATIVE);
  if (!fs.existsSync(file)) {
    return [];
  }
  const lines = fs.readFileSync(file, "utf-8").split("\n");
  const records: RunRecord[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj.skill === "string" && typeof obj.ts === "string") {
        records.push(obj as RunRecord);
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

function rate(stat: Omit<SkillUsageStat, "rating" | "recommendation">): SkillUsageStat {
  let rating: UsageRating;
  let recommendation: string;

  if (stat.runs === 0) {
    rating = "unused";
    recommendation =
      "Installed but no recorded runs yet - keep if recently added, otherwise a removal candidate.";
  } else if (stat.runs >= 3 && (stat.successRate ?? 100) < 60) {
    rating = "needs-attention";
    recommendation = `Failing often (${Math.round(stat.successRate ?? 0)}% success over ${stat.runs} runs) - check .claude/learning/patterns.md for recurring errors before relying on this skill.`;
  } else if (stat.runs >= 2 && stat.daysSinceLastUse !== null && stat.daysSinceLastUse <= 30) {
    rating = "active";
    recommendation = "Actively used and reliable - keep.";
  } else {
    rating = "low-usage";
    recommendation = "Used rarely or not recently - keep if still relevant, otherwise a removal candidate.";
  }

  return { ...stat, rating, recommendation };
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

  const stats: SkillUsageStat[] = [];
  for (const name of names) {
    const recs = byName.get(name) ?? [];
    const runs = recs.length;
    const successCount = recs.filter((r) => r.rc === 0).length;
    const failureCount = runs - successCount;
    const successRate = runs > 0 ? (successCount / runs) * 100 : null;
    const durations = recs.map((r) => r.duration).filter((d): d is number => typeof d === "number");
    const avgDuration = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null;

    let lastUsed: string | null = null;
    let daysSinceLastUse: number | null = null;
    for (const r of recs) {
      if (!lastUsed || new Date(r.ts).getTime() > new Date(lastUsed).getTime()) {
        lastUsed = r.ts;
      }
    }
    if (lastUsed) {
      daysSinceLastUse = Math.floor((now - new Date(lastUsed).getTime()) / (1000 * 60 * 60 * 24));
    }

    stats.push(
      rate({ name, runs, successCount, failureCount, successRate, avgDuration, lastUsed, daysSinceLastUse })
    );
  }

  stats.sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));
  return stats;
}

const RATING_LABEL: Record<UsageRating, string> = {
  active: "Active",
  "needs-attention": "Needs attention",
  "low-usage": "Low usage",
  unused: "Unused",
};

export function formatUsageReport(stats: SkillUsageStat[], target: string): string {
  const lines: string[] = [];
  lines.push(
    "# Claude Skills Usage Report",
    "",
    `Workspace: \`${target}\``,
    "Source: `.claude/learning/runs.jsonl` (written by the self-learning skill)",
    ""
  );

  if (stats.length === 0) {
    lines.push(
      "No installed skills and no recorded skill runs found. Install some skills and use the " +
        "self-learning skill to start recording outcomes."
    );
    return lines.join("\n");
  }

  lines.push(
    "| Skill | Runs | Success % | Last used | Days since | Rating | Recommendation |",
    "|---|---|---|---|---|---|---|"
  );
  for (const s of stats) {
    const successPct = s.successRate === null ? "-" : `${Math.round(s.successRate)}%`;
    const lastUsed = s.lastUsed ?? "-";
    const days = s.daysSinceLastUse === null ? "-" : String(s.daysSinceLastUse);
    lines.push(
      `| ${s.name} | ${s.runs} | ${successPct} | ${lastUsed} | ${days} | ${RATING_LABEL[s.rating]} | ${s.recommendation} |`
    );
  }

  const counts: Record<UsageRating, number> = { active: 0, "needs-attention": 0, "low-usage": 0, unused: 0 };
  for (const s of stats) {
    counts[s.rating]++;
  }
  lines.push(
    "",
    `Summary: ${counts.active} active, ${counts["low-usage"]} low-usage, ${counts.unused} unused, ${counts["needs-attention"]} needing attention.`
  );
  if (counts.unused > 0 || counts["low-usage"] > 0) {
    lines.push(
      "",
      "Unused/low-usage skills are removal candidates - delete `.claude/skills/<name>/` if no longer needed, or ask the `skill-usage-insights` skill for a fuller analysis before deciding."
    );
  }
  if (counts["needs-attention"] > 0) {
    lines.push(
      "",
      "Investigate failing skills via the `self-learning` skill's `patterns.md` before deciding to fix or remove them."
    );
  }

  return lines.join("\n");
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

/** Renders the usage report as a styled HTML page for a webview panel. */
export function formatUsageReportHtml(stats: SkillUsageStat[], target: string): string {
  const counts: Record<UsageRating, number> = { active: 0, "needs-attention": 0, "low-usage": 0, unused: 0 };
  for (const s of stats) {
    counts[s.rating]++;
  }

  const cards = (
    [
      ["active", "Active"],
      ["low-usage", "Low usage"],
      ["unused", "Unused"],
      ["needs-attention", "Needs attention"],
    ] as [UsageRating, string][]
  )
    .map(([key, label]) => `<div class="card ${key}"><div class="count">${counts[key]}</div><div class="label">${label}</div></div>`)
    .join("\n");

  let body: string;
  if (stats.length === 0) {
    body =
      "<p>No installed skills and no recorded skill runs found. Install some skills and use the " +
      "self-learning skill to start recording outcomes.</p>";
  } else {
    const rows = stats
      .map((s) => {
        const successPct = s.successRate === null ? "-" : `${Math.round(s.successRate)}%`;
        const lastUsed = s.lastUsed ?? "-";
        const days = s.daysSinceLastUse === null ? "-" : `${s.daysSinceLastUse}d ago`;
        return `<tr>
          <td>${escapeHtml(s.name)}</td>
          <td class="num">${s.runs}</td>
          <td class="num">${successPct}</td>
          <td>${escapeHtml(lastUsed)}</td>
          <td>${escapeHtml(days)}</td>
          <td><span class="badge ${RATING_CLASS[s.rating]}">${RATING_LABEL[s.rating]}</span></td>
          <td>${escapeHtml(s.recommendation)}</td>
        </tr>`;
      })
      .join("\n");

    const notes: string[] = [];
    if (counts.unused > 0 || counts["low-usage"] > 0) {
      notes.push(
        "Unused/low-usage skills are removal candidates - delete <code>.claude/skills/&lt;name&gt;/</code> if no longer needed, or ask the <code>skill-usage-insights</code> skill for a fuller analysis before deciding."
      );
    }
    if (counts["needs-attention"] > 0) {
      notes.push(
        "Investigate failing skills via the <code>self-learning</code> skill's <code>patterns.md</code> before deciding to fix or remove them."
      );
    }

    const notesHtml = notes.map((n) => `<div class="note">${n}</div>`).join("\n");
    body = `<table>
      <thead><tr>
        <th>Skill</th><th>Runs</th><th>Success</th><th>Last used</th><th>Recency</th><th>Rating</th><th>Recommendation</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${notesHtml}`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px 20px; }
  h1 { font-size: 1.3em; margin-bottom: 4px; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-bottom: 18px; }
  .meta code { font-family: var(--vscode-editor-font-family); }
  .summary { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
  .card { border: 1px solid var(--vscode-panel-border); border-left-width: 4px; border-radius: 6px; padding: 8px 18px; min-width: 90px; text-align: center; }
  .card .count { font-size: 1.6em; font-weight: 600; }
  .card .label { font-size: 0.8em; color: var(--vscode-descriptionForeground); }
  .card.active { border-left-color: #3fb950; }
  .card.low-usage { border-left-color: #d29922; }
  .card.unused { border-left-color: #8b949e; }
  .card.needs-attention { border-left-color: #f85149; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  th { color: var(--vscode-descriptionForeground); font-weight: 600; }
  td.num { text-align: right; white-space: nowrap; }
  .badge { display: inline-block; padding: 2px 9px; border-radius: 10px; font-size: 0.8em; font-weight: 600; color: #fff; white-space: nowrap; }
  .badge.active { background: #3fb950; }
  .badge.low-usage { background: #d29922; }
  .badge.unused { background: #8b949e; }
  .badge.needs-attention { background: #f85149; }
  .note { margin-top: 16px; padding: 10px 14px; border-left: 3px solid var(--vscode-textLink-foreground); background: var(--vscode-textCodeBlock-background); font-size: 0.9em; }
  .note code { font-family: var(--vscode-editor-font-family); }
</style>
</head>
<body>
  <h1>Claude Skills Usage Report</h1>
  <div class="meta">Workspace: <code>${escapeHtml(target)}</code><br>Source: <code>.claude/learning/runs.jsonl</code> (written by the self-learning skill)</div>
  <div class="summary">
${cards}
  </div>
  ${body}
</body>
</html>`;
}
