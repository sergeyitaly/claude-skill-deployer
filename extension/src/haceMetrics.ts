/**
 * Human-AI Collaboration Efficiency (HACE) score.
 *
 * Computes four observable components from Claude session transcripts
 * (~/.claude/projects/<workspace>/*.jsonl) and mcp-usage.jsonl CLI telemetry:
 *
 *   Prompt Clarity   (30%) — fraction of turns that triggered thinking blocks
 *   Task Velocity    (25%) — assistant turns per session minute
 *   Accuracy Rate    (25%) — inverse of correction-turn rate
 *   CLI Efficiency   (20%) — CLI success rate from mcp-usage.jsonl
 *
 * HACE = 0.30×clarity + 0.25×velocity + 0.25×accuracy + 0.20×cli
 */

import * as fs   from "node:fs";
import * as os   from "node:os";
import * as path from "node:path";
import { encodeWorkspacePath } from "./workspaceTranscripts";

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface HaceTurn {
  humanTs:      number;   // ms epoch — when user sent message
  responseTs:   number;   // ms epoch — when first assistant token arrived
  responseSecs: number;   // wall-clock seconds to first response
  promptChars:  number;   // character count of the user message
  outputTokens: number;   // assistant output tokens for this exchange
  hasThinking:  boolean;  // true if model emitted a thinking block
  isCorrection: boolean;  // true if short re-prompt after long previous response
}

export interface HaceMetrics {
  noData:              boolean;
  sessions:            number;
  totalTurns:          number;
  avgResponseSecs:     number;
  thinkingRate:        number;   // 0-1
  correctionRate:      number;   // 0-1
  turnsPerMinute:      number;
  promptClarityScore:  number;   // 0-100
  taskVelocityScore:   number;   // 0-100
  accuracyScore:       number;   // 0-100
  cliEfficiencyScore:  number;   // 0-100  (passed in)
  haceScore:           number;   // 0-100 composite
  grade:               string;   // A/B/C/D/F
}

// ---------------------------------------------------------------------------
// JSONL entry shape (minimal subset we need)
// ---------------------------------------------------------------------------

interface RawEntry {
  type?:       string;
  timestamp?:  string;
  uuid?:       string;
  requestId?:  string;
  message?: {
    role?:    string;
    content?: Array<{ type: string; text?: string; thinking?: string }>;
    usage?:   { output_tokens?: number };
  };
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function sessionFilesForWorkspace(target: string, cutoffMs: number): string[] {
  const root  = path.join(os.homedir(), ".claude", "projects");
  const encoded = encodeWorkspacePath(target).toLowerCase();
  const projectDir = path.join(root, encoded);

  try {
    return fs.readdirSync(projectDir)
      .filter(f => f.endsWith(".jsonl"))
      .map(f => path.join(projectDir, f))
      .filter(f => {
        try { return fs.statSync(f).mtimeMs >= cutoffMs; } catch { return false; }
      });
  } catch {
    // Try case-insensitive scan in case the folder name differs by case
    try {
      const dirs = fs.readdirSync(root, { withFileTypes: true });
      const match = dirs.find(d => d.isDirectory() && d.name.toLowerCase() === encoded);
      if (!match) return [];
      const pd = path.join(root, match.name);
      return fs.readdirSync(pd)
        .filter(f => f.endsWith(".jsonl"))
        .map(f => path.join(pd, f))
        .filter(f => {
          try { return fs.statSync(f).mtimeMs >= cutoffMs; } catch { return false; }
        });
    } catch { return []; }
  }
}

// ---------------------------------------------------------------------------
// Single-file parsing
// ---------------------------------------------------------------------------

const CORRECTION_MAX_CHARS  = 80;   // user message shorter than this = possible correction
const CORRECTION_MIN_TOKENS = 250;  // previous AI response longer than this = context for correction
const MAX_RESPONSE_SECS     = 300;  // cap outliers (long waits, idle sessions)
const VELOCITY_TARGET       = 2.0;  // turns/min that maps to 100% velocity score

function parseSessionFile(filePath: string): HaceTurn[] {
  let lines: string[];
  try { lines = fs.readFileSync(filePath, "utf-8").split("\n"); }
  catch { return []; }

  const turns: HaceTurn[] = [];

  // State for current human turn
  let humanTs     = 0;
  let promptChars = 0;

  // State for current assistant exchange
  let responseTs    = 0;
  let outputTokens  = 0;
  let hasThinking   = false;
  const seenReqIds  = new Set<string>();

  // State for correction detection
  let prevOutputTokens = 0;

  function commitTurn() {
    if (humanTs === 0 || responseTs === 0) return;
    const secs = Math.min((responseTs - humanTs) / 1000, MAX_RESPONSE_SECS);
    if (secs < 0) return; // clock skew guard
    const isCorrection = promptChars < CORRECTION_MAX_CHARS && prevOutputTokens > CORRECTION_MIN_TOKENS;
    turns.push({
      humanTs, responseTs,
      responseSecs: secs,
      promptChars, outputTokens, hasThinking, isCorrection,
    });
    prevOutputTokens = outputTokens;
    humanTs = 0; promptChars = 0; responseTs = 0; outputTokens = 0; hasThinking = false;
    seenReqIds.clear();
  }

  for (const raw of lines) {
    if (!raw.trim()) continue;
    let e: RawEntry;
    try { e = JSON.parse(raw) as RawEntry; } catch { continue; }

    const ts = e.timestamp ? Date.parse(e.timestamp) : 0;
    if (!ts) continue;

    if (e.type === "user" && e.message?.role === "user") {
      const content = e.message.content ?? [];
      const isToolResult = content.some(c => c.type === "tool_result");
      if (!isToolResult) {
        // Real human prompt — commit previous turn first
        commitTurn();
        humanTs     = ts;
        promptChars = content.reduce((n, c) => n + (c.text?.length ?? 0), 0);
      }
    }

    if (e.type === "assistant" && e.message?.role === "assistant" && humanTs > 0) {
      // First response timestamp
      if (responseTs === 0) responseTs = ts;

      // Deduplicate per requestId so we don't double-count usage
      const reqId = e.requestId ?? e.uuid ?? "";
      if (!seenReqIds.has(reqId)) {
        seenReqIds.add(reqId);
        const usage = e.message.usage;
        if (usage?.output_tokens) outputTokens = Math.max(outputTokens, usage.output_tokens);
      }

      // Check for thinking blocks
      if (!hasThinking && e.message.content?.some(c => c.type === "thinking")) {
        hasThinking = true;
      }
    }
  }
  commitTurn(); // flush last turn
  return turns;
}

// ---------------------------------------------------------------------------
// Scoring helpers
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
  cliSuccessRate: number,   // 0-100 from cliKpi.overallSuccessRate
  daysBack = 14,
): HaceMetrics {
  const cutoffMs = Date.now() - daysBack * 86_400_000;
  const files    = sessionFilesForWorkspace(target, cutoffMs);

  const allTurns: HaceTurn[]  = [];
  const sessionDurations: number[] = [];

  for (const f of files) {
    const turns = parseSessionFile(f);
    if (turns.length === 0) continue;
    allTurns.push(...turns);
    const first = turns[0].humanTs;
    const last  = turns[turns.length - 1].responseTs;
    if (last > first) sessionDurations.push((last - first) / 60_000); // minutes
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
  const thinkingTurns    = allTurns.filter(t => t.hasThinking).length;
  const correctionTurns  = allTurns.filter(t => t.isCorrection).length;
  const totalResponseSec = allTurns.reduce((s, t) => s + t.responseSecs, 0);
  const totalDurMin      = sessionDurations.reduce((s, d) => s + d, 0);

  const thinkingRate    = thinkingTurns / n;
  const correctionRate  = correctionTurns / n;
  const avgResponseSecs = totalResponseSec / n;
  const turnsPerMinute  = totalDurMin > 0 ? n / totalDurMin : 0;

  // Component scores (0-100)
  const promptClarityScore = clamp((1 - thinkingRate) * 100);
  const taskVelocityScore  = clamp(Math.min(turnsPerMinute / VELOCITY_TARGET, 1) * 100);
  const accuracyScore      = clamp((1 - correctionRate) * 100);
  const cliEfficiencyScore = clamp(cliSuccessRate);

  const haceScore = clamp(
    0.30 * promptClarityScore +
    0.25 * taskVelocityScore  +
    0.25 * accuracyScore      +
    0.20 * cliEfficiencyScore
  );

  return {
    noData: false,
    sessions:            files.length,
    totalTurns:          n,
    avgResponseSecs,
    thinkingRate,
    correctionRate,
    turnsPerMinute,
    promptClarityScore,
    taskVelocityScore,
    accuracyScore,
    cliEfficiencyScore,
    haceScore,
    grade:               grade(haceScore),
  };
}
