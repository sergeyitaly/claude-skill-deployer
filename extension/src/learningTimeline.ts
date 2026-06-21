import * as fs from "node:fs";
import * as path from "node:path";
import { readCachedEnrichedRuns } from "./runsStore";

export interface TimelineEvent {
  date: string;
  skill: string;
  type: "invoked" | "proposed_unused";
  cost?: number;
  sessionId: string;
  confidenceDelta?: number;
  savedMin?: number;
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

export function buildLearningTimeline(target: string, daysBack = 30): TimelineEvent[] {
  const cutoff = Date.now() - daysBack * 86_400_000;
  const runs = readCachedEnrichedRuns(target).filter(
    (r) => r.metadata?.source === "skill-invoke-hook-v2" && r.metadata?.invoked === true
      && new Date(r.ts).getTime() >= cutoff
  );

  const events: TimelineEvent[] = runs.map((r) => ({
    date: dayKey(r.ts),
    skill: r.skill,
    type: "invoked" as const,
    cost: r.cost,
    sessionId: r.session_id,
    confidenceDelta: 25, // history boost kicks in for next session
    savedMin: estimateMinutesSaved(r.skill),
  }));

  // Cross-reference current proposals: skills proposed but with 0 runs are over-predicted
  const proposalsFile = path.join(target, ".claude", "learning", "task-skill-proposals.json");
  try {
    const proposals = JSON.parse(fs.readFileSync(proposalsFile, "utf-8")) as { proposals?: { name: string }[] };
    const usedSkills = new Set(runs.map((r) => r.skill));
    for (const p of proposals.proposals ?? []) {
      if (!usedSkills.has(p.name)) {
        events.push({
          date: dayKey(new Date().toISOString()),
          skill: p.name,
          type: "proposed_unused",
          sessionId: "current-proposals",
          confidenceDelta: 0,
        });
      }
    }
  } catch {
    // proposals file may not exist
  }

  return events.sort((a, b) => b.date.localeCompare(a.date));
}

function estimateMinutesSaved(skill: string): number {
  const highValue = ["terraform-plan-review", "ci-preflight", "ci-pipeline-debug", "github-actions-ci", "azure-infra-preflight"];
  const medValue  = ["skill-creator", "mcp-builder", "vscode-extension-publishing"];
  if (highValue.some((s) => skill.includes(s.split("-")[0]))) return 15;
  if (medValue.some((s) => skill.includes(s.split("-")[0]))) return 10;
  return 5;
}

export function formatLearningTimelineHtml(events: TimelineEvent[]): string {
  if (events.length === 0) {
    return `<p class="note">No skill invocations recorded yet. Skills used by the AI agent will appear here with confidence trends.</p>`;
  }

  const byDate = new Map<string, TimelineEvent[]>();
  for (const e of events) {
    const list = byDate.get(e.date) ?? [];
    list.push(e);
    byDate.set(e.date, list);
  }

  const rows: string[] = [];
  for (const [date, dayEvents] of byDate) {
    const label = formatDateLabel(date);
    const invoked = dayEvents.filter((e) => e.type === "invoked");
    const unused  = dayEvents.filter((e) => e.type === "proposed_unused");

    rows.push(`<div style="margin-bottom:12px">
  <div style="font-size:11px;font-weight:600;color:var(--vscode-descriptionForeground);margin-bottom:4px">${label}</div>`);

    for (const e of invoked) {
      const costStr = e.cost ? ` · ${(e.cost * 100).toFixed(1)}¢` : "";
      const savedStr = e.savedMin ? ` · ~${e.savedMin} min saved` : "";
      rows.push(`  <div class="skill-row" style="margin-bottom:2px">
    <div class="skill-head">
      <span style="color:var(--vscode-charts-green,#4CAF50)">✓</span>
      <b>${escHtml(e.skill)}</b>
      <span class="hint">${costStr}${savedStr}</span>
      <span class="conf-high" style="font-size:10px">+${e.confidenceDelta ?? 0} confidence</span>
    </div>
  </div>`);
    }

    if (unused.length > 0 && date === dayKey(new Date().toISOString())) {
      rows.push(`  <div class="skill-row" style="margin-bottom:2px;opacity:0.7">
    <div class="skill-head">
      <span style="color:var(--vscode-charts-yellow,#FFC107)">⚠</span>
      <span>${unused.length} skill(s) proposed but not used this session</span>
      <span class="hint">${unused.map((e) => e.skill).slice(0, 3).join(", ")}${unused.length > 3 ? "…" : ""}</span>
    </div>
  </div>`);
    }

    rows.push(`</div>`);
  }

  return rows.join("\n");
}

function formatDateLabel(dateKey: string): string {
  try {
    const d = new Date(dateKey + "T12:00:00Z");
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return dateKey;
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
