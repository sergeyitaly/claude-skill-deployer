import * as fs from "node:fs";
import * as path from "node:path";

const ADAPTATION_LOG_REL = path.join(".claude", "learning", "adaptation-log.jsonl");

export interface ApiSnapshot {
  apiScore: number;
  attribution: number;
  skillCount: number;
}

export type AeiVerdict = "effective" | "mixed" | "neutral" | "harmful";

export interface AdaptationEvent {
  ts: string;
  type: "hooks_installed" | "cost_control_enabled" | "skills_applied" | "profile_init" | "attribution_reset" | "manual";
  description: string;
  beforeSnapshot?: ApiSnapshot;
  afterSnapshot?: ApiSnapshot;
  metadata?: Record<string, unknown>;
  /** GAP 5: Adaptation Effectiveness Index fields */
  adaptation_id?: string;
  pre_snapshot?: ApiSnapshot & { dailyCostUsd?: number; precision?: number };
  resolve_after_days?: number;
  resolved_at?: string;
  post_snapshot?: ApiSnapshot & { dailyCostUsd?: number; precision?: number };
  impact_delta?: { apiScore?: number; costReductionPct?: number };
  verdict?: AeiVerdict;
}

export function adaptationLogPath(target: string): string {
  return path.join(target, ADAPTATION_LOG_REL);
}

export function appendAdaptationEvent(
  target: string,
  event: Omit<AdaptationEvent, "ts">,
  preSnapshot?: ApiSnapshot & { dailyCostUsd?: number; precision?: number }
): void {
  const file = adaptationLogPath(target);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Deduplication: skip if the last entry has the same type + description.
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, "utf-8");
      const lastLine = content.trimEnd().split("\n").pop() ?? "";
      if (lastLine) {
        try {
          const last = JSON.parse(lastLine) as AdaptationEvent;
          if (last.type === event.type && last.description === event.description) return;
        } catch { /* ignore parse error on last line */ }
      }
    }
    const ts = new Date().toISOString();
    const adaptation_id = `adapt_${ts.replace(/[^0-9]/g, "").slice(0, 14)}`;
    const record: AdaptationEvent = {
      ts,
      adaptation_id,
      resolve_after_days: 7,
      ...event,
      ...(preSnapshot ? { pre_snapshot: preSnapshot } : {}),
    };
    fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf-8");
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

const VERDICT_BADGE: Record<string, string> = {
  effective: `<span class="conf-high" style="font-size:10px">✅ effective</span>`,
  mixed:     `<span class="" style="font-size:10px">⚠ mixed</span>`,
  neutral:   `<span class="conf-low" style="font-size:10px">— neutral</span>`,
  harmful:   `<span class="roi-low" style="font-size:10px">❌ harmful</span>`,
};

export function formatAdaptationTimelineHtml(events: AdaptationEvent[]): string {
  if (events.length === 0) {
    return `<p class="note">No adaptation events recorded yet. Configuration changes will appear here with AEI verdict after 7 days.</p>`;
  }

  const rows = events.slice(0, 10).map((e) => {
    const dateLabel = new Date(e.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    // AEI path (GAP 5)
    if (e.pre_snapshot) {
      const pre = e.pre_snapshot.apiScore;
      const post = e.post_snapshot?.apiScore;
      const delta = post != null ? (post > pre ? `+${post - pre}` : String(post - pre)) : null;
      const resolveDate = new Date(new Date(e.ts).getTime() + 7 * 86_400_000)
        .toLocaleDateString(undefined, { month: "short", day: "numeric" });
      const statusLine = e.verdict
        ? `${VERDICT_BADGE[e.verdict] ?? ""} API ${pre} → ${post ?? "?"} ${delta ? `(${delta} pts)` : ""}`
        : `resolves ${resolveDate}`;
      return `<div class="skill-row" style="margin-bottom:6px">
  <div class="skill-head">
    <span style="font-size:10px;color:var(--vscode-descriptionForeground)">${dateLabel}</span>
    <b>${escHtml(e.description)}</b>
  </div>
  <div class="hint">${statusLine}</div>
</div>`;
    }
    // Legacy path
    const before = e.beforeSnapshot ? `API ${e.beforeSnapshot.apiScore}` : "—";
    const after  = e.afterSnapshot  ? `API ${e.afterSnapshot.apiScore}`  : "pending";
    const delta  = e.beforeSnapshot && e.afterSnapshot
      ? `+${e.afterSnapshot.apiScore - e.beforeSnapshot.apiScore}` : "";
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
