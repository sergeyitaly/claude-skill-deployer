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
  const sessionDurations: number[] = [];

  for (const f of files) {
    const turns = parseSessionFile(f);
    if (turns.length === 0) continue;
    allTurns.push(...turns);
    const first = turns[0].humanTs;
    const last = turns[turns.length - 1].responseTs;
    if (last > first) sessionDurations.push((last - first) / 60_000);
  }

  if (allTurns.length === 0) {
    return {
      noData: true, sessions: 0, totalTurns: 0,
      avgResponseSecs: 0, thinkingRate: 0, correctionRate: 0, turnsPerMinute: 0,
      promptClarityScore: 0, taskVelocityScore: 0, accuracyScore: 0,
      cliEfficiencyScore: clamp(cliSuccessRate),
      haceScore: 0, grade: "—",
    };
  }

  const n = allTurns.length;
  const thinkingTurns = allTurns.filter(t => t.hasThinking).length;
  const correctionTurns = allTurns.filter(t => t.isCorrection).length;
  const totalResponseSec = allTurns.reduce((s, t) => s + t.responseSecs, 0);
  const totalDurMin = sessionDurations.reduce((s, d) => s + d, 0);

  const thinkingRate = thinkingTurns / n;
  const correctionRate = correctionTurns / n;
  const avgResponseSecs = totalResponseSec / n;
  const turnsPerMinute = totalDurMin > 0 ? n / totalDurMin : 0;

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
    promptClarityScore, taskVelocityScore, accuracyScore, cliEfficiencyScore,
    haceScore, grade: grade(haceScore),
  };
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
  <p class="note">Weights: Clarity 30% · Velocity 25% · Accuracy 25% · CLI 20% · Target: ≥70 (B). ${metrics.thinkingRate > 0 ? `Thinking blocks in ${Math.round(metrics.thinkingRate * 100)}% of turns — clearer prompts reduce model reasoning overhead.` : ""}</p>
</div>`;
}
