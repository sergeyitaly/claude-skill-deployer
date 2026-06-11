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
