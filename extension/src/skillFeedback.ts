import * as fs from "node:fs";
import * as path from "node:path";
import { invalidateLearningCache } from "./runsStore";
import { RunAgent } from "./runsStore";

export const FEEDBACK_LOG_RELATIVE = path.join(".claude", "learning", "skill-feedback.jsonl");

export type FeedbackSentiment = "negative" | "correction" | "disagreement";

export interface SkillFeedbackRecord {
  ts: string;
  skill: string;
  sentiment: FeedbackSentiment;
  /** Short trigger word/phrase detected, e.g. "no", "wrong". */
  signal: string;
  /** Truncated user message (max ~300 chars). */
  user_text: string;
  /** What the agent did that prompted the reaction. */
  context: string;
  session_id?: string;
  agent?: RunAgent;
}

export interface SkillInefficiencyStat {
  name: string;
  negativeCount: number;
  /** 0–100: higher = more user-reported inefficiency. */
  inefficiencyPct: number;
  /** CSS heat level 1–5 for dashboard coloring. */
  heatLevel: 0 | 1 | 2 | 3 | 4 | 5;
  lastFeedback: string | null;
  signals: string[];
  updateSuggestion: string;
}

export function feedbackFilePath(target: string): string {
  return path.join(target, FEEDBACK_LOG_RELATIVE);
}

export function readSkillFeedbackRecords(target: string): SkillFeedbackRecord[] {
  const file = feedbackFilePath(target);
  if (!fs.existsSync(file)) {
    return [];
  }
  const out: SkillFeedbackRecord[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const row = JSON.parse(line) as Partial<SkillFeedbackRecord>;
      if (typeof row.ts !== "string" || typeof row.skill !== "string") {
        continue;
      }
      out.push({
        ts: row.ts,
        skill: row.skill,
        sentiment: row.sentiment ?? "negative",
        signal: typeof row.signal === "string" ? row.signal : "",
        user_text: typeof row.user_text === "string" ? row.user_text : "",
        context: typeof row.context === "string" ? row.context : "",
        session_id: typeof row.session_id === "string" ? row.session_id : undefined,
        agent: row.agent as RunAgent | undefined,
      });
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

export function appendSkillFeedback(
  target: string,
  entry: Omit<SkillFeedbackRecord, "ts"> & { ts?: string }
): SkillFeedbackRecord {
  const file = feedbackFilePath(target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record: SkillFeedbackRecord = {
    ts: entry.ts ?? new Date().toISOString(),
    skill: entry.skill,
    sentiment: entry.sentiment,
    signal: entry.signal,
    user_text: entry.user_text.slice(0, 300),
    context: entry.context.slice(0, 500),
    session_id: entry.session_id,
    agent: entry.agent,
  };
  fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf-8");
  invalidateLearningCache(target);
  return record;
}

/** Common user disagreement signals (lowercase). Used by agent skill and heuristics. */
export const NEGATIVE_FEEDBACK_SIGNALS = [
  "no",
  "not that",
  "not what",
  "that's wrong",
  "that is wrong",
  "wrong",
  "incorrect",
  "don't do",
  "do not",
  "stop",
  "bad idea",
  "that's not",
  "that is not",
  "disagree",
  "instead",
  "no,",
  "nope",
  "actually,",
  "you missed",
  "you forgot",
  "that's incorrect",
] as const;

export function detectNegativeFeedbackSignal(text: string): string | null {
  const lower = text.trim().toLowerCase();
  if (!lower) {
    return null;
  }
  for (const signal of NEGATIVE_FEEDBACK_SIGNALS) {
    if (lower.startsWith(signal) || lower.includes(` ${signal}`)) {
      return signal;
    }
  }
  return null;
}

function heatLevelFromPct(pct: number): 0 | 1 | 2 | 3 | 4 | 5 {
  if (pct <= 0) {
    return 0;
  }
  if (pct < 20) {
    return 1;
  }
  if (pct < 40) {
    return 2;
  }
  if (pct < 60) {
    return 3;
  }
  if (pct < 80) {
    return 4;
  }
  return 5;
}

function inefficiencyPct(count: number, maxCount: number): number {
  if (count <= 0) {
    return 0;
  }
  if (maxCount <= 0) {
    return Math.min(100, count * 20);
  }
  return Math.min(100, Math.round((count / maxCount) * 100));
}

function buildUpdateSuggestion(skill: string, signals: string[], count: number): string {
  const uniqueSignals = [...new Set(signals)].slice(0, 3);
  const signalHint = uniqueSignals.length > 0 ? ` Users often react with "${uniqueSignals.join('", "')}".` : "";
  if (count >= 5) {
    return `High negative feedback (${count} reports). Rewrite ${skill} SKILL.md triggers and workflow; review session-learnings.md for recurring corrections.${signalHint}`;
  }
  if (count >= 3) {
    return `Review and tighten ${skill} instructions — ${count} negative reactions recorded.${signalHint} Check .claude/learning/skill-feedback.jsonl for context.`;
  }
  return `Minor inefficiency signal for ${skill}.${signalHint} Consider a small SKILL.md update if pattern continues.`;
}

/** Aggregate negative feedback per skill for dashboard display. */
export function computeSkillInefficiencyStats(
  target: string,
  skillNames?: string[]
): SkillInefficiencyStat[] {
  const records = readSkillFeedbackRecords(target);
  const bySkill = new Map<string, SkillFeedbackRecord[]>();
  for (const rec of records) {
    const list = bySkill.get(rec.skill) ?? [];
    list.push(rec);
    bySkill.set(rec.skill, list);
  }

  const names = skillNames ?? [...bySkill.keys()];
  const counts = names.map((n) => bySkill.get(n)?.length ?? 0);
  const maxCount = Math.max(1, ...counts);

  return names
    .map((name) => {
      const recs = bySkill.get(name) ?? [];
      const negativeCount = recs.length;
      const pct = inefficiencyPct(negativeCount, maxCount);
      const signals = recs.map((r) => r.signal).filter(Boolean);
      let lastFeedback: string | null = null;
      for (const r of recs) {
        if (!lastFeedback || new Date(r.ts).getTime() > new Date(lastFeedback).getTime()) {
          lastFeedback = r.ts;
        }
      }
      return {
        name,
        negativeCount,
        inefficiencyPct: negativeCount > 0 ? Math.max(pct, Math.min(100, negativeCount * 15)) : 0,
        heatLevel: heatLevelFromPct(negativeCount > 0 ? Math.max(pct, Math.min(100, negativeCount * 15)) : 0),
        lastFeedback,
        signals,
        updateSuggestion: buildUpdateSuggestion(name, signals, negativeCount),
      };
    })
    .filter((s) => s.negativeCount > 0)
    .sort((a, b) => b.inefficiencyPct - a.inefficiencyPct || b.negativeCount - a.negativeCount);
}
