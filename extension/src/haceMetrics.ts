/**
 * Human-AI Collaboration Efficiency (HACE) score.
 *
 * Computes four observable components from Claude session transcripts
 * (~/.claude/projects/<workspace>/*.jsonl) and mcp-usage.jsonl CLI telemetry:
 *
 *   Prompt Clarity   (30%) — fraction of turns WITHOUT thinking blocks (clear prompts need less thinking)
 *   Task Velocity    (25%) — assistant turns per session minute
 *   Accuracy Rate    (25%) — inverse of correction-turn rate
 *   CLI Efficiency   (20%) — CLI success rate from mcp-usage.jsonl
 *
 * HACE = 0.30×clarity + 0.25×velocity + 0.25×accuracy + 0.20×cli
 *
 * @deprecated Superseded by efficiencyMetrics.ts which implements the live HACE 2.0
 * six-component formula (0.25/0.20/0.20/0.15/0.10/0.10) and writes hace-sessions.jsonl.
 * This file's formula and dashboard HTML are no longer used for scoring.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { encodeWorkspacePath } from "./workspaceTranscripts";

export interface HaceTurn {
  humanTs: number;
  responseTs: number;
  responseSecs: number;
  promptChars: number;
  outputTokens: number;
  hasThinking: boolean;
  isCorrection: boolean;
}

export interface HaceMetrics {
  noData: boolean;
  sessions: number;
  totalTurns: number;
  avgResponseSecs: number;
  thinkingRate: number;
  correctionRate: number;
  turnsPerMinute: number;
  /** Wall-clock average session minutes (raw, inflated by idle time). */
  avgSessionMinutes: number;
  /** Active-work-only average session minutes — idle gaps >30min stripped. */
  avgSessionActiveMinutes: number;
  promptClarityScore: number;
  taskVelocityScore: number;
  accuracyScore: number;
  cliEfficiencyScore: number;
  haceScore: number;
  grade: string;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function sessionFilesForWorkspace(target: string, cutoffMs: number): string[] {
  const root = path.join(os.homedir(), ".claude", "projects");
  const encoded = encodeWorkspacePath(target).toLowerCase();
  const projectDir = path.join(root, encoded);
  try {
    return fs.readdirSync(projectDir)
      .filter(f => f.endsWith(".jsonl"))
      .map(f => path.join(projectDir, f))
      .filter(f => { try { return fs.statSync(f).mtimeMs >= cutoffMs; } catch { return false; } });
  } catch {
    try {
      const dirs = fs.readdirSync(root, { withFileTypes: true });
      const match = dirs.find(d => d.isDirectory() && d.name.toLowerCase() === encoded);
      if (!match) return [];
      const pd = path.join(root, match.name);
      return fs.readdirSync(pd)
        .filter(f => f.endsWith(".jsonl"))
        .map(f => path.join(pd, f))
        .filter(f => { try { return fs.statSync(f).mtimeMs >= cutoffMs; } catch { return false; } });
    } catch { return []; }
  }
}

// ---------------------------------------------------------------------------
// Single-file parsing
// ---------------------------------------------------------------------------

const CORRECTION_MAX_CHARS = 80;
const CORRECTION_MIN_TOKENS = 250;
const MAX_RESPONSE_SECS = 300;
const VELOCITY_TARGET = 2.0;
// Gaps longer than this are treated as idle time (overnight, pause, lunch break).
// Only active intervals count toward TTR and velocity so metrics reflect real work pace.
const IDLE_GAP_MS = 30 * 60_000;

function parseSessionFile(filePath: string): HaceTurn[] {
  let lines: string[];
  try { lines = fs.readFileSync(filePath, "utf-8").split("\n"); } catch { return []; }

  const turns: HaceTurn[] = [];
  let humanTs = 0;
  let promptChars = 0;
  let responseTs = 0;
  let outputTokens = 0;
  let hasThinking = false;
  const seenReqIds = new Set<string>();
  let prevOutputTokens = 0;

  function commitTurn() {
    if (humanTs === 0 || responseTs === 0) return;
    const secs = Math.min((responseTs - humanTs) / 1000, MAX_RESPONSE_SECS);
    if (secs < 0) return;
    const isCorrection = promptChars < CORRECTION_MAX_CHARS && prevOutputTokens > CORRECTION_MIN_TOKENS;
    turns.push({ humanTs, responseTs, responseSecs: secs, promptChars, outputTokens, hasThinking, isCorrection });
    prevOutputTokens = outputTokens;
    humanTs = 0; promptChars = 0; responseTs = 0; outputTokens = 0; hasThinking = false;
    seenReqIds.clear();
  }

  for (const raw of lines) {
    if (!raw.trim()) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
    const ts = e.timestamp ? Date.parse(e.timestamp as string) : 0;
    if (!ts) continue;

    if (e.type === "user" && (e.message as Record<string, unknown>)?.role === "user") {
      const content = ((e.message as Record<string, unknown>)?.content ?? []) as Array<Record<string, unknown>>;
      const isToolResult = content.some(c => c.type === "tool_result");
      if (!isToolResult) {
        const chars = content.reduce((n, c) => n + ((c.text as string)?.length ?? 0), 0);
        if (chars > 0) { commitTurn(); humanTs = ts; promptChars = chars; }
      }
    }

    if (e.type === "assistant" && (e.message as Record<string, unknown>)?.role === "assistant" && humanTs > 0) {
      if (responseTs === 0) responseTs = ts;
      const reqId = String(e.requestId ?? e.uuid ?? "");
      if (!seenReqIds.has(reqId)) {
        seenReqIds.add(reqId);
        const usage = (e.message as Record<string, unknown>)?.usage as Record<string, number> | undefined;
        if (usage?.output_tokens) outputTokens = Math.max(outputTokens, usage.output_tokens);
      }
      const content = ((e.message as Record<string, unknown>)?.content ?? []) as Array<Record<string, unknown>>;
      if (!hasThinking && content.some(c => c.type === "thinking")) hasThinking = true;
    }
  }
  commitTurn();
  return turns;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function clamp(v: number): number { return Math.max(0, Math.min(100, Math.round(v))); }

function grade(score: number): string {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

// ---------------------------------------------------------------------------
// Active Work Time — strips idle gaps > IDLE_GAP_MS so TTR reflects real pace
// ---------------------------------------------------------------------------

function activeWorkMinutes(turns: HaceTurn[]): number {
  if (turns.length === 0) return 0;
  let activeMs = 0;
  for (let i = 0; i < turns.length; i++) {
    // Count the time to produce each response as active
    activeMs += turns[i].responseSecs * 1000;
    // Count the gap between response and next human message only if ≤ IDLE_GAP_MS
    if (i < turns.length - 1) {
      const gap = turns[i + 1].humanTs - turns[i].responseTs;
      if (gap > 0 && gap <= IDLE_GAP_MS) activeMs += gap;
    }
  }
  return activeMs / 60_000;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function computeHaceMetrics(
  target: string,
  cliSuccessRate: number,
  daysBack = 14
): HaceMetrics {
  const cutoffMs = Date.now() - daysBack * 86_400_000;
  const files = sessionFilesForWorkspace(target, cutoffMs);
  const allTurns: HaceTurn[] = [];
  const activeSessionDurations: number[] = [];
  const wallClockDurations: number[] = [];

  for (const f of files) {
    const turns = parseSessionFile(f);
    if (turns.length === 0) continue;
    allTurns.push(...turns);
    activeSessionDurations.push(activeWorkMinutes(turns));
    const first = turns[0].humanTs;
    const last = turns[turns.length - 1].responseTs;
    if (last > first) wallClockDurations.push((last - first) / 60_000);
  }

  if (allTurns.length === 0) {
    return {
      noData: true, sessions: files.length, totalTurns: 0,
      avgResponseSecs: 0, thinkingRate: 0, correctionRate: 0, turnsPerMinute: 0,
      avgSessionMinutes: 0, avgSessionActiveMinutes: 0,
      promptClarityScore: 0, taskVelocityScore: 0, accuracyScore: 0,
      cliEfficiencyScore: clamp(cliSuccessRate),
      haceScore: 0, grade: "—",
    };
  }

  const n = allTurns.length;
  const thinkingTurns = allTurns.filter(t => t.hasThinking).length;
  const correctionTurns = allTurns.filter(t => t.isCorrection).length;
  const totalResponseSec = allTurns.reduce((s, t) => s + t.responseSecs, 0);
  const totalActiveMin = activeSessionDurations.reduce((s, d) => s + d, 0);
  const totalWallMin = wallClockDurations.reduce((s, d) => s + d, 0);
  const sessionCount = activeSessionDurations.length || 1;

  const thinkingRate = thinkingTurns / n;
  const correctionRate = correctionTurns / n;
  const avgResponseSecs = totalResponseSec / n;
  const avgSessionMinutes = totalWallMin / sessionCount;
  const avgSessionActiveMinutes = totalActiveMin / sessionCount;
  // Use active work time for velocity so idle overnight gaps don't crush the score
  const turnsPerMinute = totalActiveMin > 0 ? n / totalActiveMin : 0;

  const promptClarityScore = clamp((1 - thinkingRate) * 100);
  const taskVelocityScore = clamp(Math.min(turnsPerMinute / VELOCITY_TARGET, 1) * 100);
  const accuracyScore = clamp((1 - correctionRate) * 100);
  const cliEfficiencyScore = clamp(cliSuccessRate);

  const haceScore = clamp(
    0.30 * promptClarityScore +
    0.25 * taskVelocityScore +
    0.25 * accuracyScore +
    0.20 * cliEfficiencyScore
  );

  return {
    noData: false, sessions: files.length, totalTurns: n,
    avgResponseSecs, thinkingRate, correctionRate, turnsPerMinute,
    avgSessionMinutes, avgSessionActiveMinutes,
    promptClarityScore, taskVelocityScore, accuracyScore, cliEfficiencyScore,
    haceScore, grade: grade(haceScore),
  };
}

// ---------------------------------------------------------------------------
// HACE Action Engine — converts raw scores into actionable recommendations
// ---------------------------------------------------------------------------

interface HaceAction {
  metric: string;
  score: number;
  advice: string;
  priority: "critical" | "high" | "medium";
}

export function computeHaceActions(metrics: HaceMetrics): HaceAction[] {
  const actions: HaceAction[] = [];

  if (metrics.promptClarityScore < 25) {
    actions.push({
      metric: "Prompt Clarity",
      score: metrics.promptClarityScore,
      advice: "Break large requests into smaller, focused tasks. Shorter prompts reduce model reasoning overhead — aim for one goal per message.",
      priority: "critical",
    });
  } else if (metrics.promptClarityScore < 50) {
    actions.push({
      metric: "Prompt Clarity",
      score: metrics.promptClarityScore,
      advice: "Split multi-step requests. Provide file paths and context upfront to avoid back-and-forth clarification rounds.",
      priority: "high",
    });
  }

  if (metrics.taskVelocityScore < 20) {
    actions.push({
      metric: "Task Velocity",
      score: metrics.taskVelocityScore,
      advice: "Use focused, single-topic sessions. Long omnibus sessions dilute velocity. Consider /clear between unrelated tasks.",
      priority: "critical",
    });
  } else if (metrics.taskVelocityScore < 40) {
    actions.push({
      metric: "Task Velocity",
      score: metrics.taskVelocityScore,
      advice: "Keep sessions task-focused. Avoid switching topics mid-session — context switching slows throughput.",
      priority: "high",
    });
  }

  if (metrics.accuracyScore < 60) {
    actions.push({
      metric: "Accuracy Rate",
      score: metrics.accuracyScore,
      advice: "High correction rate detected. Provide clearer success criteria upfront. Specify exact file paths, function names, and expected outputs before the agent starts.",
      priority: "high",
    });
  }

  if (metrics.avgSessionActiveMinutes > 60) {
    actions.push({
      metric: "Resolution Velocity",
      score: 0,
      advice: `Active work time averages ${Math.round(metrics.avgSessionActiveMinutes)} min. Create task-focused sessions instead of open-ended sessions. Use /clear to start fresh when switching tasks.`,
      priority: "high",
    });
  } else if (metrics.avgSessionActiveMinutes > 30) {
    actions.push({
      metric: "Resolution Velocity",
      score: 0,
      advice: `Sessions average ${Math.round(metrics.avgSessionActiveMinutes)} min of active work. Target ≤ 30 min per focused task.`,
      priority: "medium",
    });
  }

  if (metrics.cliEfficiencyScore < 80) {
    actions.push({
      metric: "CLI Efficiency",
      score: metrics.cliEfficiencyScore,
      advice: "Multiple CLI failures detected. Check credentials, paths, and allow-lists. Fix root causes — don't retry blindly.",
      priority: "high",
    });
  }

  return actions.sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2 };
    return order[a.priority] - order[b.priority];
  });
}

function formatHaceActionsHtml(actions: HaceAction[]): string {
  if (actions.length === 0) {
    return `<p class="note" style="color:var(--vscode-charts-green,#4CAF50)">No critical actions — scores are within target ranges.</p>`;
  }
  const colorMap = { critical: "var(--vscode-charts-red,#F44336)", high: "var(--vscode-charts-yellow,#FFC107)", medium: "var(--vscode-descriptionForeground)" };
  return actions.map(a =>
    `<div class="skill-row" style="margin-bottom:6px">
  <div class="skill-head">
    <span style="color:${colorMap[a.priority]};font-size:10px;text-transform:uppercase">${a.priority}</span>
    <b style="margin-left:4px">${a.metric}</b>
    ${a.score > 0 ? `<span class="cost roi-low" style="margin-left:4px">${a.score}%</span>` : ""}
  </div>
  <div class="hint" style="margin-top:2px">${a.advice}</div>
</div>`
  ).join("");
}

export function formatHacePanelHtml(metrics: HaceMetrics): string {
  if (metrics.noData) {
    return `<div class="panel">
  <h2>HACE 2.0 — Human-AI Collaboration Efficiency</h2>
  <p class="note">No session data yet — HACE computes from transcript files in <code>~/.claude/projects/</code>. Score appears after the first completed session.</p>
</div>`;
  }

  const pct = (v: number) => `${v}%`;
  const fmt1 = (v: number) => v.toFixed(1);

  const gradeClass = metrics.haceScore >= 70 ? "roi-high" : metrics.haceScore >= 40 ? "roi-medium" : "roi-low";

  return `<div class="panel">
  <h2>HACE 2.0 — Human-AI Collaboration Efficiency</h2>
  <div class="stat-grid" style="margin-bottom:10px">
    <div class="stat-pill" title="Composite Human-AI Collaboration Efficiency score (0–100)">
      <b>HACE Score</b>
      <span class="val ${gradeClass}">${metrics.haceScore}/100 (${metrics.grade})</span>
    </div>
    <div class="stat-pill"><b>Sessions</b><span class="val">${metrics.sessions}</span></div>
    <div class="stat-pill"><b>Turns</b><span class="val">${metrics.totalTurns}</span></div>
    <div class="stat-pill"><b>Avg response</b><span class="val">${fmt1(metrics.avgResponseSecs)}s</span></div>
    <div class="stat-pill" title="Active work time per session — idle gaps >30min excluded. Wall-clock: ${Math.round(metrics.avgSessionMinutes)}min">
      <b>Active TTR</b><span class="val ${metrics.avgSessionActiveMinutes <= 30 ? "roi-high" : metrics.avgSessionActiveMinutes <= 60 ? "roi-medium" : "roi-low"}">${Math.round(metrics.avgSessionActiveMinutes)} min</span>
    </div>
  </div>
  <div class="stat-grid" style="margin-bottom:6px">
    <div class="stat-pill" title="Prompt Clarity (30%) — fraction of turns that did NOT trigger thinking blocks">
      <b>Prompt Clarity</b><span class="val">${pct(metrics.promptClarityScore)}</span>
    </div>
    <div class="stat-pill" title="Task Velocity (25%) — assistant turns per session minute vs 2.0 target">
      <b>Task Velocity</b><span class="val">${pct(metrics.taskVelocityScore)}</span>
    </div>
    <div class="stat-pill" title="Accuracy Rate (25%) — inverse of correction-turn rate">
      <b>Accuracy Rate</b><span class="val">${pct(metrics.accuracyScore)}</span>
    </div>
    <div class="stat-pill" title="CLI Efficiency (20%) — CLI success rate from mcp-usage.jsonl">
      <b>CLI Efficiency</b><span class="val">${pct(metrics.cliEfficiencyScore)}</span>
    </div>
  </div>
  <p class="note">Weights: Clarity 30% · Velocity 25% · Accuracy 25% · CLI 20% · Target: ≥70 (B). Active TTR strips idle gaps &gt;30min. ${metrics.thinkingRate > 0 ? `Thinking blocks in ${Math.round(metrics.thinkingRate * 100)}% of turns — clearer prompts reduce model reasoning overhead.` : ""}</p>
  <details style="margin-top:8px">
    <summary style="cursor:pointer;font-size:12px;font-weight:600">Action Recommendations</summary>
    <div style="margin-top:8px">${formatHaceActionsHtml(computeHaceActions(metrics))}</div>
  </details>
</div>`;
}
