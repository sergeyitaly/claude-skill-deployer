import * as fs from "node:fs";
import * as path from "node:path";
import { Manifest } from "./skillOps";
import { readCachedEnrichedRuns } from "./runsStore";

export interface ApiBreakdown extends Record<string, number> {
  precision: number;
  attribution: number;
  skillEfficiency: number;
  learningRate: number;
  taskCompletion: number;
  humanCorrection: number;
}

export interface ApiScore {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  breakdown: ApiBreakdown;
}

function gradeFromScore(score: number): ApiScore["grade"] {
  if (score >= 80) return "A";
  if (score >= 65) return "B";
  if (score >= 50) return "C";
  if (score >= 35) return "D";
  return "F";
}

function clamp(v: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, v));
}

function readJsonSafe<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

// ── Sub-score: Precision ──────────────────────────────────────────────────────
// Uses proposalOutcome.jsonl acceptance rate when available (GAP 1), falling back to
// the simple proposals-vs-used ratio when no session outcome data exists yet.
function precisionScore(target: string): number {
  const outcomeFile = path.join(target, ".claude", "learning", "proposalOutcome.jsonl");
  if (fs.existsSync(outcomeFile)) {
    try {
      const lines = fs.readFileSync(outcomeFile, "utf-8").split("\n").filter(Boolean);
      if (lines.length >= 3) {
        let totalProposed = 0;
        let totalInvoked = 0;
        for (const line of lines) {
          try {
            const r = JSON.parse(line) as { event?: string; skills_proposed_count?: number; skills_invoked_count?: number };
            if (r.event === "session_end") {
              totalProposed += r.skills_proposed_count ?? 0;
              totalInvoked += r.skills_invoked_count ?? 0;
            }
          } catch { /* skip */ }
        }
        if (totalProposed > 0) {
          return clamp(Math.round((totalInvoked / totalProposed) * 100));
        }
      }
    } catch { /* fall through to legacy */ }
  }

  // Legacy: single-proposal snapshot ratio
  const proposalsFile = path.join(target, ".claude", "learning", "task-skill-proposals.json");
  const proposed = readJsonSafe<{ proposals?: { name: string }[] }>(proposalsFile);
  if (!proposed?.proposals?.length) return 0;
  const proposedNames = new Set(proposed.proposals.map((p) => p.name));

  const runs = readCachedEnrichedRuns(target);
  if (runs.length === 0) return 0;
  const usedNames = new Set(runs.map((r) => r.skill));

  let hits = 0;
  for (const name of usedNames) {
    if (proposedNames.has(name)) hits++;
  }
  return clamp(Math.round((hits / proposedNames.size) * 100));
}

// ── Sub-score: Attribution ────────────────────────────────────────────────────
// Taken directly from attribution-trust.json scorePct (stored as 0–100, not 0–1).
function attributionScore(target: string): number {
  const trustFile = path.join(target, ".claude", "learning", "attribution-trust.json");
  const trust = readJsonSafe<{ scorePct?: number }>(trustFile);
  return clamp(Math.round(trust?.scorePct ?? 0));
}

// ── Sub-score: Skill Efficiency ───────────────────────────────────────────────
// Maps net ROI from team-economics-cache.json onto 0–100.
// ROI of 50x → 100. Cold-start (no runs yet) returns 50 (neutral) to avoid
// "safe mode" triggering on new installs with zero invocations.
function skillEfficiencyScore(target: string): number {
  const cacheFile = path.join(target, ".claude", "learning", "team-economics-cache.json");
  const cache = readJsonSafe<{ teamEconomics?: { netRoi?: number } }>(cacheFile);
  const roi = cache?.teamEconomics?.netRoi ?? 0;
  if (roi === 0 && readCachedEnrichedRuns(target).length === 0) return 50;
  return clamp(Math.round((roi / 50) * 100));
}

// ── Sub-score: Learning Rate ──────────────────────────────────────────────────
// Grows as telemetry accumulates. Full score at 30 v2 hook runs across ≥5 sessions.
function learningRateScore(target: string): number {
  const runs = readCachedEnrichedRuns(target).filter(
    (r) => r.metadata?.source === "skill-invoke-hook-v2" && r.metadata?.invoked === true
  );
  const sessionIds = new Set(runs.map((r) => r.session_id));
  const runScore = clamp(Math.round((runs.length / 30) * 100));
  const sessionScore = clamp(Math.round((sessionIds.size / 5) * 100));
  return Math.round((runScore + sessionScore) / 2);
}

// ── Sub-score: Task Completion ────────────────────────────────────────────────
// Percentage of skill runs that succeeded (rc === 0).
function taskCompletionScore(target: string): number {
  const runs = readCachedEnrichedRuns(target);
  if (runs.length === 0) return 100;
  const successes = runs.filter((r) => r.success).length;
  return clamp(Math.round((successes / runs.length) * 100));
}

// ── Sub-score: Human Correction ──────────────────────────────────────────────
// 100 when no feedback corrections exist; decreases by 10 per correction entry.
function humanCorrectionScore(target: string): number {
  const feedbackFile = path.join(target, ".claude", "learning", "skill-feedback.jsonl");
  if (!fs.existsSync(feedbackFile)) return 100;
  try {
    const lines = fs.readFileSync(feedbackFile, "utf-8").split("\n").filter(Boolean);
    return clamp(100 - lines.length * 10);
  } catch {
    return 100;
  }
}

// ── Composite ─────────────────────────────────────────────────────────────────

/**
 * Compute the Agent Performance Index (0–100) for the workspace.
 * Weights: Precision 25% | Attribution 20% | Efficiency 15% |
 *          Learning 15% | Completion 15% | Correction 10%
 */
export function computeApiScore(target: string, _manifest: Manifest): ApiScore {
  const breakdown: ApiBreakdown = {
    precision: precisionScore(target),
    attribution: attributionScore(target),
    skillEfficiency: skillEfficiencyScore(target),
    learningRate: learningRateScore(target),
    taskCompletion: taskCompletionScore(target),
    humanCorrection: humanCorrectionScore(target),
  };

  const score = clamp(Math.round(
    breakdown.precision       * 0.25 +
    breakdown.attribution     * 0.20 +
    breakdown.skillEfficiency * 0.15 +
    breakdown.learningRate    * 0.15 +
    breakdown.taskCompletion  * 0.15 +
    breakdown.humanCorrection * 0.10
  ));

  return { score, grade: gradeFromScore(score), breakdown };
}
