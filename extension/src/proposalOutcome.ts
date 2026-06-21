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

/** Penalty map for all skills computed from session history. */
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
  return penalties;
}

export interface SkillHistory {
  invocations: number;
  successRate: number;
  acceptanceRate: number;
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
  };
}

/** Write session-end outcome record. Accepts proposed names externally to avoid circular imports. */
export function recordSessionProposalOutcome(
  target: string,
  sessionId: string,
  proposedSkillNames: string[]
): void {
  if (proposedSkillNames.length === 0) return;
  const runs = readCachedEnrichedRuns(target).filter(r => r.session_id === sessionId);
  const invokedSet = new Set(runs.map(r => r.skill));
  const invoked = proposedSkillNames.filter(s => invokedSet.has(s));
  const not_invoked = proposedSkillNames.filter(s => !invokedSet.has(s));
  appendProposalOutcome(target, {
    session_id: sessionId,
    event: "session_end",
    proposed: proposedSkillNames,
    invoked,
    not_invoked,
    acceptance_rate: proposedSkillNames.length > 0 ? invoked.length / proposedSkillNames.length : 0,
    skills_proposed_count: proposedSkillNames.length,
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
  const totalSucceeded = runs.filter(r => r.success).length;

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
