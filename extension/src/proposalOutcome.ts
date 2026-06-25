import * as fs from "node:fs";
import * as path from "node:path";
import { readCachedEnrichedRuns } from "./runsStore";

const PROPOSAL_OUTCOME_REL = path.join(".claude", "learning", "proposalOutcome.jsonl");
const PENALTY_PER_NOT_USED = 10;
const PENALTY_DECAY_ON_USE = 20;
const MAX_PENALTY = 40;

export interface ProposalOutcomeRecord {
  ts: string;
  session_id: string;
  event: "session_end";
  proposed: string[];
  invoked: string[];
  not_invoked: string[];
  acceptance_rate: number;
  skills_proposed_count: number;
  skills_invoked_count: number;
}

// ---------------------------------------------------------------------------
// Rejection feedback — explicit per-skill dismissal tracking
// ---------------------------------------------------------------------------

export type RejectionReason = "ignored" | "dismissed" | "not_relevant" | "too_many";

export interface RecommendationFeedback {
  ts: string;
  session_id: string;
  skill: string;
  proposed: boolean;
  accepted: boolean;
  reason: RejectionReason;
  confidence?: number;
}

const FEEDBACK_REL = path.join(".claude", "learning", "recommendation-feedback.jsonl");

export function recommendationFeedbackPath(target: string): string {
  return path.join(target, FEEDBACK_REL);
}

export function appendRecommendationFeedback(
  target: string,
  record: Omit<RecommendationFeedback, "ts">
): void {
  const file = recommendationFeedbackPath(target);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n", "utf-8");
  } catch { /* non-fatal */ }
}

export function readRecommendationFeedback(target: string): RecommendationFeedback[] {
  const file = recommendationFeedbackPath(target);
  if (!fs.existsSync(file)) return [];
  const records: RecommendationFeedback[] = [];
  try {
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line) as RecommendationFeedback); } catch { /* skip */ }
    }
  } catch { /* non-fatal */ }
  return records;
}

/**
 * Write end-of-session rejection feedback for all not_invoked skills.
 * Called alongside recordSessionProposalOutcome to populate the feedback log.
 */
export function recordSessionRejectionFeedback(
  target: string,
  sessionId: string,
  proposed: string[],
  invoked: string[]
): void {
  const invokedSet = new Set(invoked);
  for (const skill of proposed) {
    // Only record feedback for skills that were NOT invoked — accepted skills are not rejections.
    // Accepted skills are positive signal captured via runs.jsonl; recording them here as
    // "ignored" was incorrectly polluting the rejection signal used for confidence decay.
    if (invokedSet.has(skill)) continue;
    appendRecommendationFeedback(target, {
      session_id: sessionId,
      skill,
      proposed: true,
      accepted: false,
      reason: "ignored", // skill was proposed but not used this session
    });
  }
}

export function proposalOutcomePath(target: string): string {
  return path.join(target, PROPOSAL_OUTCOME_REL);
}

export function appendProposalOutcome(target: string, record: Omit<ProposalOutcomeRecord, "ts">): void {
  const file = proposalOutcomePath(target);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n", "utf-8");
  } catch { /* non-fatal */ }
}

export function readProposalOutcomes(target: string): ProposalOutcomeRecord[] {
  const file = proposalOutcomePath(target);
  if (!fs.existsSync(file)) return [];
  const records: ProposalOutcomeRecord[] = [];
  try {
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line) as ProposalOutcomeRecord); } catch { /* skip */ }
    }
  } catch { /* non-fatal */ }
  return records;
}

/** Penalty map for all skills computed from session history + rejection feedback. */
export function computeAllSkillPenalties(target: string): Record<string, number> {
  const records = readProposalOutcomes(target);
  const penalties: Record<string, number> = {};
  for (const r of records) {
    if (r.event !== "session_end") continue;
    for (const sk of (r.invoked ?? [])) {
      penalties[sk] = Math.max(0, (penalties[sk] ?? 0) - PENALTY_DECAY_ON_USE);
    }
    for (const sk of (r.not_invoked ?? [])) {
      penalties[sk] = Math.min(MAX_PENALTY, (penalties[sk] ?? 0) + PENALTY_PER_NOT_USED);
    }
  }
  // Layer in explicit rejection feedback — each "ignored" record adds a small extra
  // penalty on top of the session-level signal, giving higher-frequency rejecters more weight.
  const feedback = readRecommendationFeedback(target);
  const rejectionCounts: Record<string, number> = {};
  for (const f of feedback) {
    if (!f.accepted) rejectionCounts[f.skill] = (rejectionCounts[f.skill] ?? 0) + 1;
  }
  for (const [sk, count] of Object.entries(rejectionCounts)) {
    if (count >= 3) {
      const extra = Math.min(10, Math.floor(count / 3) * 2);
      penalties[sk] = Math.min(MAX_PENALTY, (penalties[sk] ?? 0) + extra);
    }
  }
  return penalties;
}

export interface SkillHistory {
  invocations: number;
  successRate: number;
  acceptanceRate: number;
  proposedCount: number;
}

export function historicalSuccess(target: string, skillName: string): SkillHistory {
  const runs = readCachedEnrichedRuns(target).filter(r => r.skill === skillName);
  const invocations = runs.length;
  const successes = runs.filter(r => r.success).length;

  const outcomes = readProposalOutcomes(target);
  let proposedCount = 0;
  let invokedCount = 0;
  for (const o of outcomes) {
    if (o.proposed?.includes(skillName)) proposedCount++;
    if (o.invoked?.includes(skillName)) invokedCount++;
  }

  return {
    invocations,
    successRate: invocations > 0 ? successes / invocations : 0,
    acceptanceRate: proposedCount > 0 ? invokedCount / proposedCount : 0,
    proposedCount,
  };
}

/** Acceptance rate for a skill across all recorded sessions. */
export function getAcceptanceRate(target: string, skillName: string): { rate: number; sessions: number } {
  const outcomes = readProposalOutcomes(target);
  let proposedCount = 0;
  let invokedCount = 0;
  for (const o of outcomes) {
    if (o.event !== "session_end") continue;
    if (o.proposed?.includes(skillName)) {
      proposedCount++;
      if (o.invoked?.includes(skillName)) invokedCount++;
    }
  }
  return { rate: proposedCount > 0 ? invokedCount / proposedCount : -1, sessions: proposedCount };
}

/**
 * Confidence calibration multiplier for a skill.
 * If a skill has been proposed ≥3 times with acceptance < 10%, return 0.5 (halve the score).
 * If a skill has been proposed ≥5 times with acceptance < 5%, return 0 (dormant — suppress).
 */
export function confidenceCalibration(target: string, skillName: string): number {
  const { rate, sessions } = getAcceptanceRate(target, skillName);
  if (rate < 0) return 1.0; // no data yet
  if (sessions >= 5 && rate < 0.05) return 0.0; // dormant — suppress entirely
  if (sessions >= 3 && rate < 0.10) return 0.5; // low signal — halve confidence
  return 1.0;
}

/** Returns the set of dormant skill names (acceptance < 5% after ≥5 sessions). */
export function getDormantSkills(target: string): Set<string> {
  const outcomes = readProposalOutcomes(target);
  const proposed: Record<string, number> = {};
  const invoked: Record<string, number> = {};
  for (const o of outcomes) {
    if (o.event !== "session_end") continue;
    for (const s of o.proposed ?? []) proposed[s] = (proposed[s] ?? 0) + 1;
    for (const s of o.invoked ?? []) invoked[s] = (invoked[s] ?? 0) + 1;
  }
  const dormant = new Set<string>();
  for (const [skill, count] of Object.entries(proposed)) {
    if (count >= 5 && (invoked[skill] ?? 0) / count < 0.05) dormant.add(skill);
  }
  return dormant;
}

/** Write session-end outcome record. Accepts proposed names externally to avoid circular imports.
 *  When caller passes an empty array (session started before proposal refresh), falls back to
 *  reading task-skill-proposals.json so the learning loop is never silently starved. */
export function recordSessionProposalOutcome(
  target: string,
  sessionId: string,
  proposedSkillNames: string[]
): void {
  // Start with caller-supplied names (e.g. skills surfaced via _detectOpportunity),
  // then union with the proposals file if it is fresh (< 4 h old).
  // Using a Set prevents double-counting when both sources list the same skill.
  const nameSet = new Set<string>(proposedSkillNames);
  try {
    const file = path.join(target, ".claude", "learning", "task-skill-proposals.json");
    const data = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      proposals?: { name: string }[];
      generatedAt?: string;
    };
    // Reject stale files — proposals older than 4 h belong to a prior session.
    const ageMs = data.generatedAt ? Date.now() - new Date(data.generatedAt).getTime() : Infinity;
    if (ageMs < 4 * 60 * 60 * 1000) {
      for (const p of data.proposals ?? []) nameSet.add(p.name);
    }
  } catch { /* non-fatal — proposals file may not exist yet */ }
  const names = [...nameSet];
  // Always write a record — zero-invocation sessions are valid learning signal
  // (previously returning early here starved the entire learning loop).
  const runs = readCachedEnrichedRuns(target).filter(r => r.session_id === sessionId);
  const invokedSet = new Set(runs.map(r => r.skill));
  const invoked = names.filter(s => invokedSet.has(s));
  const not_invoked = names.filter(s => !invokedSet.has(s));
  appendProposalOutcome(target, {
    session_id: sessionId,
    event: "session_end",
    proposed: names,
    invoked,
    not_invoked,
    acceptance_rate: names.length > 0 ? invoked.length / names.length : 0,
    skills_proposed_count: names.length,
    skills_invoked_count: invoked.length,
  });
}

export interface ProposalFunnelStats {
  sessions: number;
  totalProposed: number;
  totalInvoked: number;
  totalSucceeded: number;
  daysBack: number;
  acceptanceRatePct: number;
  successRatePct: number;
  hasData: boolean;
}

export function computeProposalFunnel(target: string, daysBack = 30): ProposalFunnelStats {
  const cutoff = Date.now() - daysBack * 86_400_000;
  const outcomes = readProposalOutcomes(target).filter(
    o => o.event === "session_end" && new Date(o.ts).getTime() >= cutoff
  );
  const runs = readCachedEnrichedRuns(target).filter(
    r => new Date(r.ts).getTime() >= cutoff && r.metadata?.invoked === true
  );

  let totalProposed = 0;
  let totalInvoked = 0;
  for (const o of outcomes) {
    totalProposed += o.skills_proposed_count ?? 0;
    totalInvoked += o.skills_invoked_count ?? 0;
  }

  // Only count successes from sessions that are tracked in proposal outcomes — otherwise
  // runs.jsonl sessions (which pre-date or exist outside proposal tracking) inflate the
  // "Succeeded" step and can make successRate > 100% vs the tracked "Invoked" count.
  const trackedSessionIds = new Set(outcomes.map(o => o.session_id));
  const totalSucceeded = runs.filter(r => r.success && trackedSessionIds.has(r.session_id)).length;

  return {
    sessions: outcomes.length,
    totalProposed,
    totalInvoked,
    totalSucceeded,
    daysBack,
    acceptanceRatePct: totalProposed > 0 ? Math.round((totalInvoked / totalProposed) * 100) : 0,
    successRatePct: totalInvoked > 0 ? Math.round((totalSucceeded / totalInvoked) * 100) : 0,
    hasData: outcomes.length > 0,
  };
}

export function formatProposalFunnelHtml(stats: ProposalFunnelStats): string {
  if (!stats.hasData) {
    return `<p class="note">No session outcome data yet — funnel populates after first session completes.</p>`;
  }
  const fmtPct = (n: number) => `${n}%`;
  const rows = [
    { label: "Proposed", value: String(stats.totalProposed), pct: "100%" },
    { label: "Invoked", value: String(stats.totalInvoked), pct: fmtPct(stats.acceptanceRatePct) },
    { label: "Succeeded", value: String(stats.totalSucceeded), pct: fmtPct(stats.successRatePct) },
  ];
  const rowsHtml = rows.map(r =>
    `<div class="skill-row"><div class="skill-head"><b>${r.label}</b><span class="cost">${r.value}</span><span class="bar">${r.pct}</span></div></div>`
  ).join("");
  return `<div class="stat-grid" style="margin-bottom:8px">
  <div class="stat-pill"><b>Sessions</b><span class="val">${stats.sessions}</span></div>
  <div class="stat-pill"><b>Acceptance</b><span class="val">${fmtPct(stats.acceptanceRatePct)}</span></div>
  <div class="stat-pill"><b>Success</b><span class="val">${fmtPct(stats.successRatePct)}</span></div>
</div>
${rowsHtml}
<p class="note" style="margin-top:4px">Proposal → Invocation → Success funnel · ${stats.daysBack}d window</p>`;
}
