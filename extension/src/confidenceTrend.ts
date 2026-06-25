import * as fs from "node:fs";
import * as path from "node:path";

const HISTORY_REL = path.join(".claude", "learning", "confidence-history.jsonl");
// Keep max 90 days of history to prevent unbounded file growth
const MAX_HISTORY_DAYS = 90;
const MAX_SNAPSHOTS_PER_SKILL = 60;

export interface ConfidenceSnapshot {
  ts: string;
  skill: string;
  confidence: number;
}

export interface SkillTrend {
  skill: string;
  current: number;
  history: number[];   // oldest → newest, sampled at most once per day
  delta7d: number;     // change over last 7 snapshots (positive = improving)
  delta30d: number;    // change over last 30 snapshots
  direction: "rising" | "falling" | "stable";
}

export function confidenceHistoryPath(target: string): string {
  return path.join(target, HISTORY_REL);
}

/** Append one confidence snapshot per skill. Called from writeTaskSkillProposals. */
export function appendConfidenceSnapshots(
  target: string,
  proposals: Array<{ name: string; confidence: number }>
): void {
  if (proposals.length === 0) return;
  const file = confidenceHistoryPath(target);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const ts = new Date().toISOString();
    const lines = proposals
      .map(p => JSON.stringify({ ts, skill: p.name, confidence: p.confidence }))
      .join("\n");
    fs.appendFileSync(file, lines + "\n", "utf-8");
    pruneConfidenceHistory(target, file);
  } catch { /* non-fatal */ }
}

function pruneConfidenceHistory(target: string, file: string): void {
  try {
    const stat = fs.statSync(file);
    // Only prune if file exceeds 512 KB
    if (stat.size < 512 * 1024) return;
    const cutoff = Date.now() - MAX_HISTORY_DAYS * 86_400_000;
    const lines = fs.readFileSync(file, "utf-8").split("\n").filter(l => {
      if (!l.trim()) return false;
      try {
        const r = JSON.parse(l) as ConfidenceSnapshot;
        return new Date(r.ts).getTime() >= cutoff;
      } catch { return false; }
    });
    fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");
  } catch { /* non-fatal */ }
}

/** Read raw snapshot records from the history file. */
export function readConfidenceHistory(target: string): ConfidenceSnapshot[] {
  const file = confidenceHistoryPath(target);
  if (!fs.existsSync(file)) return [];
  const records: ConfidenceSnapshot[] = [];
  try {
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line) as ConfidenceSnapshot); } catch { /* skip */ }
    }
  } catch { /* non-fatal */ }
  return records;
}

/**
 * Compute per-skill confidence trends from history.
 * Groups snapshots by day (latest per day), then computes delta over 7d and 30d windows.
 */
export function computeConfidenceTrends(target: string): SkillTrend[] {
  const records = readConfidenceHistory(target);
  if (records.length === 0) return [];

  // Group by skill → date → latest confidence that day
  const bySkill = new Map<string, Map<string, number>>();
  for (const r of records) {
    const day = r.ts.slice(0, 10);
    let dayMap = bySkill.get(r.skill);
    if (!dayMap) { dayMap = new Map(); bySkill.set(r.skill, dayMap); }
    dayMap.set(day, r.confidence); // last write for this day wins
  }

  const trends: SkillTrend[] = [];
  for (const [skill, dayMap] of bySkill) {
    const sorted = [...dayMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-MAX_SNAPSHOTS_PER_SKILL);
    const history = sorted.map(([, v]) => v);
    if (history.length === 0) continue;

    const current = history[history.length - 1];
    const win7  = history.slice(-7);
    const win30 = history.slice(-30);
    const delta7d  = win7.length  >= 2 ? current - win7[0]  : 0;
    const delta30d = win30.length >= 2 ? current - win30[0] : 0;

    const direction: SkillTrend["direction"] =
      delta7d > 3 ? "rising" : delta7d < -3 ? "falling" : "stable";

    trends.push({ skill, current, history, delta7d, delta30d, direction });
  }

  return trends.sort((a, b) => b.current - a.current);
}

/**
 * Returns top N improving and declining skills for dashboard display.
 */
export function getTopConfidenceMovers(
  target: string,
  n = 5
): { improving: SkillTrend[]; declining: SkillTrend[] } {
  const all = computeConfidenceTrends(target);
  const improving = [...all].sort((a, b) => b.delta7d - a.delta7d).slice(0, n);
  const declining = [...all].sort((a, b) => a.delta7d - b.delta7d).slice(0, n);
  return { improving, declining };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sparkline(history: number[]): string {
  if (history.length < 2) return "";
  const bars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const min = Math.min(...history);
  const max = Math.max(...history);
  const range = max - min || 1;
  return history.map(v => bars[Math.round(((v - min) / range) * (bars.length - 1))]).join("");
}

function deltaLabel(d: number): string {
  if (d > 0) return `<span style="color:var(--vscode-charts-green,#4CAF50)">+${d}</span>`;
  if (d < 0) return `<span style="color:var(--vscode-charts-red,#F44336)">${d}</span>`;
  return `<span style="opacity:.6">±0</span>`;
}

export function formatConfidenceTrendHtml(target: string): string {
  const { improving, declining } = getTopConfidenceMovers(target, 5);
  const all = computeConfidenceTrends(target);

  if (all.length === 0) {
    return `<div class="panel" style="margin-top:6px">
  <h2 style="margin-top:0">Confidence Trend Engine</h2>
  <p class="note">No confidence history yet — trends populate after the first few proposal refresh cycles. Check back after your next session.</p>
</div>`;
  }

  const improvingRows = improving
    .filter(t => t.delta7d > 0)
    .map(t => `<div class="skill-row">
  <div class="skill-head">
    <b>${esc(t.skill)}</b>
    <span class="cost conf-high">${t.current}%</span>
    <span style="font-family:monospace;font-size:11px;letter-spacing:1px;opacity:.8">${sparkline(t.history)}</span>
    ${deltaLabel(t.delta7d)} <span style="opacity:.6;font-size:10px">7d</span>
  </div>
</div>`).join("") || `<p class="note">No rising skills yet.</p>`;

  const decliningRows = declining
    .filter(t => t.delta7d < 0)
    .map(t => `<div class="skill-row">
  <div class="skill-head">
    <b>${esc(t.skill)}</b>
    <span class="cost roi-low">${t.current}%</span>
    <span style="font-family:monospace;font-size:11px;letter-spacing:1px;opacity:.8">${sparkline(t.history)}</span>
    ${deltaLabel(t.delta7d)} <span style="opacity:.6;font-size:10px">7d</span>
  </div>
</div>`).join("") || `<p class="note">No declining skills yet.</p>`;

  const allRows = all.slice(0, 12).map(t => `<div class="skill-row">
  <div class="skill-head">
    <b>${esc(t.skill)}</b>
    <span class="cost">${t.current}%</span>
    <span style="font-family:monospace;font-size:11px;letter-spacing:1px;opacity:.8">${sparkline(t.history)}</span>
    ${deltaLabel(t.delta7d)} <span style="opacity:.6;font-size:10px">7d</span>
    ${deltaLabel(t.delta30d)} <span style="opacity:.6;font-size:10px">30d</span>
  </div>
</div>`).join("");

  return `<div class="panel" style="margin-top:6px">
  <h2 style="margin-top:0">Confidence Trend Engine</h2>
  <p class="note" style="margin-top:0">Tracks proposal confidence over time per skill. Rising = more signals matched + acceptance history. Falling = rejection penalties + dormancy decay.</p>

  <details open style="margin-bottom:8px">
    <summary style="cursor:pointer;font-size:12px;font-weight:600">Top Improving (7d) ▲</summary>
    <div style="margin-top:6px">${improvingRows}</div>
  </details>

  <details style="margin-bottom:8px">
    <summary style="cursor:pointer;font-size:12px;font-weight:600">Top Declining (7d) ▼</summary>
    <div style="margin-top:6px">${decliningRows}</div>
  </details>

  <details>
    <summary style="cursor:pointer;font-size:12px;font-weight:600">All Skills · Confidence History</summary>
    <div style="margin-top:6px">${allRows}</div>
  </details>
</div>`;
}
