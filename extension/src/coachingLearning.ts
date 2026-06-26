/**
 * Coaching Learning Loop (Phase 10)
 *
 * Tracks whether coaching advice is followed and improves HACE, or is ignored repeatedly.
 *
 * Reward path:  advice shown → user follows → HACE metric improves → increase frequency
 * Decay path:   advice shown 3× → no improvement → reduce frequency (cooldown grows)
 *
 * Storage: .claude/learning/coaching-events.jsonl
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { CoachingMetric } from "./haceCoaching";

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

const EVENTS_REL = path.join(".claude", "learning", "coaching-events.jsonl");
const STATE_REL  = path.join(".claude", "learning", "coaching-state.json");

export type CoachingEventType =
  | "advice_shown"
  | "score_improved"
  | "score_unchanged"
  | "cooldown_applied";

export interface CoachingEvent {
  ts: string;
  metric: CoachingMetric;
  type: CoachingEventType;
  scoreBefore?: number;
  scoreAfter?: number;
  adviceText?: string;
}

export interface MetricCoachingState {
  metric: CoachingMetric;
  showCount: number;           // total times advice was surfaced
  improvedCount: number;       // times followed by score improvement
  ignoredCount: number;        // consecutive shows with no improvement
  cooldownUntil: string | null; // ISO timestamp when advice can resurface
  lastScore: number | null;
  lastShownAt: string | null;
  lastEvaluatedAt: string | null; // ISO timestamp of last evaluateAdviceOutcome run
  adaptedMultiplier: number;   // 0.25–2.0 frequency multiplier; 1.0 = default
}

export interface CoachingState {
  version: 1;
  updatedAt: string;
  metrics: Partial<Record<CoachingMetric, MetricCoachingState>>;
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function eventsPath(target: string): string { return path.join(target, EVENTS_REL); }
function statePath(target: string): string  { return path.join(target, STATE_REL); }

function readState(target: string): CoachingState {
  try {
    return JSON.parse(fs.readFileSync(statePath(target), "utf-8")) as CoachingState;
  } catch {
    return { version: 1, updatedAt: new Date().toISOString(), metrics: {} };
  }
}

function writeState(target: string, state: CoachingState): void {
  try {
    fs.mkdirSync(path.dirname(statePath(target)), { recursive: true });
    fs.writeFileSync(statePath(target), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2) + "\n", "utf-8");
  } catch { /* non-fatal */ }
}

function appendEvent(target: string, event: CoachingEvent): void {
  try {
    const file = eventsPath(target);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + "\n", "utf-8");
  } catch { /* non-fatal */ }
}

function defaultMetricState(metric: CoachingMetric): MetricCoachingState {
  return {
    metric, showCount: 0, improvedCount: 0, ignoredCount: 0,
    cooldownUntil: null, lastScore: null, lastShownAt: null, lastEvaluatedAt: null,
    adaptedMultiplier: 1.0,
  };
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Called when a coaching hint is surfaced for a metric.
 * Records the event and checks cooldown status.
 * Returns false if the metric is currently in cooldown (should be suppressed).
 */
export function recordAdviceShown(
  target: string,
  metric: CoachingMetric,
  currentScore: number,
  adviceText: string
): boolean {
  const state = readState(target);
  const ms = state.metrics[metric] ?? defaultMetricState(metric);

  // Check cooldown
  if (ms.cooldownUntil && new Date(ms.cooldownUntil).getTime() > Date.now()) {
    return false; // suppressed — in cooldown
  }

  ms.showCount++;
  ms.lastScore = currentScore;
  ms.lastShownAt = new Date().toISOString();
  state.metrics[metric] = ms;
  writeState(target, state);
  appendEvent(target, {
    ts: new Date().toISOString(),
    metric, type: "advice_shown",
    scoreBefore: currentScore, adviceText,
  });

  return true;
}

/**
 * Called during the pipeline analysis phase.
 * Compares current score against the score when advice was last shown.
 * Awards improvement credit or increments ignore counter.
 */
export function evaluateAdviceOutcome(
  target: string,
  metric: CoachingMetric,
  currentScore: number
): void {
  const state = readState(target);
  const ms = state.metrics[metric];
  if (!ms || ms.lastShownAt === null || ms.lastScore === null) return;

  // Debounce: skip if evaluated within the last 5 minutes.
  // Guard uses lastEvaluatedAt — not lastShownAt — because recordAdviceShown runs on
  // the same prompt pass just after this call, which would make lastShownAt always
  // appear "too recent" and permanently block the decay loop.
  const minsSinceEvaluated = ms.lastEvaluatedAt
    ? (Date.now() - new Date(ms.lastEvaluatedAt).getTime()) / 60_000
    : Infinity;
  if (minsSinceEvaluated < 0.5) return;
  ms.lastEvaluatedAt = new Date().toISOString();

  const improved = currentScore > ms.lastScore + 3; // >3pt gain = meaningful

  if (improved) {
    ms.improvedCount++;
    ms.ignoredCount = 0;
    // Reward: increase frequency (lower future threshold to show advice)
    ms.adaptedMultiplier = Math.min(2.0, ms.adaptedMultiplier * 1.2);
    appendEvent(target, {
      ts: new Date().toISOString(),
      metric, type: "score_improved",
      scoreBefore: ms.lastScore, scoreAfter: currentScore,
    });
  } else {
    ms.ignoredCount++;
    appendEvent(target, {
      ts: new Date().toISOString(),
      metric, type: "score_unchanged",
      scoreBefore: ms.lastScore, scoreAfter: currentScore,
    });

    // Decay: after 3 consecutive ignored showings, apply cooldown
    if (ms.ignoredCount >= 3) {
      const cooldownHours = Math.min(72, 24 * ms.ignoredCount); // max 3 days
      ms.cooldownUntil = new Date(Date.now() + cooldownHours * 3_600_000).toISOString();
      ms.adaptedMultiplier = Math.max(0.25, ms.adaptedMultiplier * 0.7);
      appendEvent(target, {
        ts: new Date().toISOString(),
        metric, type: "cooldown_applied",
        scoreBefore: ms.lastScore,
      });
    }
  }

  ms.lastScore = currentScore;
  state.metrics[metric] = ms;
  writeState(target, state);
}

/**
 * Returns true if advice for this metric should be shown right now.
 * Factors in cooldown and the adapted frequency multiplier.
 */
export function shouldShowAdvice(target: string, metric: CoachingMetric): boolean {
  const state = readState(target);
  const ms = state.metrics[metric];
  if (!ms) return true; // no history — always show on first encounter

  if (ms.cooldownUntil && new Date(ms.cooldownUntil).getTime() > Date.now()) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export interface CoachingLearningReport {
  totalAdviceShown: number;
  totalImproved: number;
  improvementRate: number;
  activeCooldowns: Array<{ metric: CoachingMetric; until: string }>;
  mostEffective: CoachingMetric | null;
  leastEffective: CoachingMetric | null;
  metricStates: MetricCoachingState[];
}

export function buildLearningReport(target: string): CoachingLearningReport {
  const state = readState(target);
  const msList = Object.values(state.metrics) as MetricCoachingState[];

  const totalAdviceShown = msList.reduce((s, m) => s + m.showCount, 0);
  const totalImproved    = msList.reduce((s, m) => s + m.improvedCount, 0);
  const improvementRate  = totalAdviceShown > 0
    ? Math.round(totalAdviceShown > 0 ? (totalImproved / totalAdviceShown) * 100 : 0)
    : 0;

  const activeCooldowns = msList
    .filter(m => m.cooldownUntil && new Date(m.cooldownUntil).getTime() > Date.now())
    .map(m => ({ metric: m.metric, until: m.cooldownUntil! }));

  const withHistory = msList.filter(m => m.showCount >= 2);
  const sortedByRate = [...withHistory].sort((a, b) =>
    (b.improvedCount / b.showCount) - (a.improvedCount / a.showCount)
  );
  const mostEffective  = sortedByRate[0]?.metric ?? null;
  const leastEffective = sortedByRate[sortedByRate.length - 1]?.metric ?? null;

  return {
    totalAdviceShown, totalImproved, improvementRate,
    activeCooldowns, mostEffective, leastEffective,
    metricStates: msList,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatLearningLoopHtml(target: string): string {
  const report = buildLearningReport(target);

  if (report.totalAdviceShown === 0) {
    return `<div class="panel" style="margin-top:6px">
  <h2 style="margin-top:0">Coaching Learning Loop</h2>
  <p class="note">No coaching interactions yet. The loop activates after the first coaching hint is surfaced and the next session's HACE scores are computed.</p>
</div>`;
  }

  const cooldownRows = report.activeCooldowns.map(c => {
    const until = new Date(c.until).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `<div class="hint">• <b>${esc(c.metric)}</b> — advice suppressed until ${esc(until)} (repeatedly shown without improvement)</div>`;
  }).join("") || `<p class="note">No active cooldowns.</p>`;

  const stateRows = report.metricStates
    .filter(m => m.showCount > 0)
    .map(m => `<div class="skill-row">
  <div class="skill-head">
    <b>${esc(m.metric)}</b>
    <span class="cost">${m.showCount} shown</span>
    <span class="cost roi-high">${m.improvedCount} improved</span>
    <span class="hint">${Math.round(m.adaptedMultiplier * 100)}% frequency</span>
  </div>
</div>`).join("");

  return `<div class="panel" style="margin-top:6px">
  <h2 style="margin-top:0">Coaching Learning Loop</h2>
  <div class="stat-grid" style="margin-bottom:10px">
    <div class="stat-pill"><b>Advice shown</b><span class="val">${report.totalAdviceShown}</span></div>
    <div class="stat-pill"><b>Led to improvement</b><span class="val roi-high">${report.totalImproved}</span></div>
    <div class="stat-pill"><b>Improvement rate</b><span class="val ${report.improvementRate >= 40 ? "roi-high" : "roi-medium"}">${report.improvementRate}%</span></div>
    <div class="stat-pill"><b>Cooldowns active</b><span class="val">${report.activeCooldowns.length}</span></div>
  </div>
  <details style="margin-bottom:8px">
    <summary style="cursor:pointer;font-size:12px;font-weight:600">Active Cooldowns (suppressed advice)</summary>
    <div style="margin-top:6px">${cooldownRows}</div>
  </details>
  <details>
    <summary style="cursor:pointer;font-size:12px;font-weight:600">Per-metric Adaptation State</summary>
    <div style="margin-top:6px">${stateRows || '<p class="note">No metric history yet.</p>'}</div>
  </details>
  <p class="note" style="margin-top:4px">Advice that leads to score improvement is shown more often. Advice ignored 3× enters cooldown to avoid fatigue.</p>
</div>`;
}
