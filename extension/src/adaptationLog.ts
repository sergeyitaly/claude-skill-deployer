import * as fs from "node:fs";
import * as path from "node:path";

const ADAPTATION_LOG_REL = path.join(".claude", "learning", "adaptation-log.jsonl");

export interface ApiSnapshot {
  apiScore: number;
  attribution: number;
  skillCount: number;
}

export interface AdaptationEvent {
  ts: string;
  type: "hooks_installed" | "cost_control_enabled" | "skills_applied" | "profile_init" | "attribution_reset" | "manual";
  description: string;
  beforeSnapshot?: ApiSnapshot;
  afterSnapshot?: ApiSnapshot;
  metadata?: Record<string, unknown>;
}

export function adaptationLogPath(target: string): string {
  return path.join(target, ADAPTATION_LOG_REL);
}

export function appendAdaptationEvent(target: string, event: Omit<AdaptationEvent, "ts">): void {
  const file = adaptationLogPath(target);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n", "utf-8");
  } catch {
    // non-fatal — adaptation log is best-effort
  }
}

export function readAdaptationLog(target: string): AdaptationEvent[] {
  const file = adaptationLogPath(target);
  if (!fs.existsSync(file)) return [];
  const events: AdaptationEvent[] = [];
  try {
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line) as AdaptationEvent); } catch { /* skip */ }
    }
  } catch { /* non-fatal */ }
  return events.reverse(); // newest first
}

export function formatAdaptationTimelineHtml(events: AdaptationEvent[]): string {
  if (events.length === 0) {
    return `<p class="note">No adaptation events recorded yet. Configuration changes will appear here with before/after API Score snapshots.</p>`;
  }

  const rows = events.slice(0, 10).map((e) => {
    const before = e.beforeSnapshot ? `API ${e.beforeSnapshot.apiScore}` : "—";
    const after  = e.afterSnapshot  ? `API ${e.afterSnapshot.apiScore}`  : "pending";
    const delta  = e.beforeSnapshot && e.afterSnapshot
      ? `+${e.afterSnapshot.apiScore - e.beforeSnapshot.apiScore}` : "";
    const dateLabel = new Date(e.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `<div class="skill-row" style="margin-bottom:6px">
  <div class="skill-head">
    <span style="font-size:10px;color:var(--vscode-descriptionForeground)">${dateLabel}</span>
    <b>${escHtml(e.description)}</b>
    ${delta ? `<span class="conf-high" style="font-size:10px">${delta} pts</span>` : ""}
  </div>
  <div class="hint">${before} → ${after}</div>
</div>`;
  });

  return rows.join("\n");
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
