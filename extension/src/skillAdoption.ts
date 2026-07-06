/**
 * Skill Adoption Intelligence v1
 *
 * Unified append-only adoption event log (.claude/learning/skill-adoption.jsonl)
 * tracking the full recommendation funnel:
 *
 *   proposed -> accepted -> invoked -> successful -> reused
 *                \-> rejected
 *
 * Answers: which recommendations users accept, which skills deliver value,
 * which are ignored, and what the actual precision / recall / F1 of the
 * recommendation engine is. Feeds confidence adjustments back into ranking
 * with exponential recency weighting.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { readCachedEnrichedRuns, RunAgent } from "./runsStore";
import { readSkillFeedbackRecords } from "./skillFeedback";

// ---------------------------------------------------------------------------
// Event model (Phase 1)
// ---------------------------------------------------------------------------

export type AdoptionEventType =
  | "proposed"
  | "accepted"
  | "rejected"
  | "invoked"
  | "successful"
  | "reused";

/**
 * "manual" = user directly invoked the skill (e.g. `/skill-name`) — the strongest
 * signal of intent. "recommended" = invocation followed an accepted proposal from
 * task-skill-proposals.json. "auto"/"profile-init" = system-driven installs with
 * no explicit user invocation signal.
 */
export type AdoptionSource = "auto" | "manual" | "recommended" | "profile-init";

export type ReuseWindow = "7d" | "30d" | "90d";

export interface SkillAdoptionEvent {
  timestamp: string;
  workspace: string;
  branch: string | null;
  /** Session id for runtime events; proposal batch id (generatedAt) for proposed/accepted. */
  taskId: string;
  skill: string;
  event: AdoptionEventType;
  source: AdoptionSource;
  /** 0-100 proposal confidence (proposed/accepted/invoked) or success confidence (successful). */
  confidence?: number;
  agent?: RunAgent;
  /** Only on reused events: which window the reuse fell into. */
  reuseWindow?: ReuseWindow;
  /** Only on reused events: days since the previous use. */
  daysSincePreviousUse?: number;
}

export const ADOPTION_LOG_RELATIVE = path.join(".claude", "learning", "skill-adoption.jsonl");
const ADOPTION_STATE_RELATIVE = path.join(".claude", "learning", "skill-adoption-state.json");

const VALID_EVENTS = new Set<string>([
  "proposed", "accepted", "rejected", "invoked", "successful", "reused",
]);

export function adoptionLogPath(target: string): string {
  return path.join(target, ADOPTION_LOG_RELATIVE);
}

function adoptionStatePath(target: string): string {
  return path.join(target, ADOPTION_STATE_RELATIVE);
}

/** Best-effort branch detection without spawning git (reads .git/HEAD). */
export function detectBranch(target: string): string | null {
  try {
    const head = fs.readFileSync(path.join(target, ".git", "HEAD"), "utf-8").trim();
    const m = /^ref: refs\/heads\/(.+)$/.exec(head);
    return m ? m[1] : head.slice(0, 12) || null;
  } catch {
    return null;
  }
}

export type AdoptionEventInput = Omit<SkillAdoptionEvent, "timestamp" | "workspace" | "branch"> & {
  timestamp?: string;
  branch?: string | null;
};

/**
 * Append adoption events. Append-only, auto-creates the file, non-fatal on error.
 * All events in one call are written with a single append syscall so concurrent
 * writers (extension host + hook server) cannot interleave inside a line.
 */
export function appendAdoptionEvents(target: string, entries: AdoptionEventInput[]): void {
  if (entries.length === 0) return;
  const file = adoptionLogPath(target);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const branch = detectBranch(target);
    const now = new Date().toISOString();
    const lines = entries
      .filter((e) => e.skill && VALID_EVENTS.has(e.event))
      .map((e) => {
        const { timestamp, branch: entryBranch, ...rest } = e;
        return JSON.stringify({
          timestamp: timestamp ?? now,
          workspace: target,
          branch: entryBranch !== undefined ? entryBranch : branch,
          ...rest,
        });
      });
    if (lines.length === 0) return;
    fs.appendFileSync(file, lines.join("\n") + "\n", "utf-8");
  } catch {
    /* non-fatal */
  }
}

export function appendAdoptionEvent(target: string, entry: AdoptionEventInput): void {
  appendAdoptionEvents(target, [entry]);
}

/** Corruption-tolerant read: invalid JSON lines and malformed records are skipped. */
export function readAdoptionEvents(target: string): SkillAdoptionEvent[] {
  const file = adoptionLogPath(target);
  if (!fs.existsSync(file)) return [];
  const out: SkillAdoptionEvent[] = [];
  try {
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as SkillAdoptionEvent;
        if (typeof row.skill !== "string" || !row.skill) continue;
        if (typeof row.event !== "string" || !VALID_EVENTS.has(row.event)) continue;
        if (typeof row.timestamp !== "string") continue;
        out.push(row);
      } catch {
        /* skip corrupt line */
      }
    }
  } catch {
    /* non-fatal */
  }
  return out;
}

// ---------------------------------------------------------------------------
// Proposal recording (Phase 2/3) — deduplicated per proposal batch
// ---------------------------------------------------------------------------

interface AdoptionState {
  version: 1;
  /** generatedAt ids of proposal batches already recorded (last 50 kept). */
  recordedBatches?: string[];
}

function readAdoptionState(target: string): AdoptionState {
  try {
    const parsed = JSON.parse(fs.readFileSync(adoptionStatePath(target), "utf-8")) as AdoptionState;
    if (parsed?.version === 1) return parsed;
  } catch {
    /* fresh state */
  }
  return { version: 1 };
}

function writeAdoptionState(target: string, state: AdoptionState): void {
  try {
    const file = adoptionStatePath(target);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state), "utf-8");
  } catch {
    /* non-fatal */
  }
}

/**
 * Record one "proposed" event per skill for a proposal batch.
 * Deduplicated by batch id (generatedAt) so re-writes of the proposals file
 * (e.g. installed-flag refreshes) don't double count.
 */
export function recordProposedSkills(
  target: string,
  batch: { generatedAt: string; proposals: Array<{ name: string; confidence?: number }> },
  source: AdoptionSource = "auto",
  agent?: RunAgent
): boolean {
  if (!batch.generatedAt || batch.proposals.length === 0) return false;
  const state = readAdoptionState(target);
  const recorded = state.recordedBatches ?? [];
  if (recorded.includes(batch.generatedAt)) return false;

  appendAdoptionEvents(
    target,
    batch.proposals.map((p) => ({
      taskId: batch.generatedAt,
      skill: p.name,
      event: "proposed" as const,
      source,
      confidence: p.confidence,
      agent,
    }))
  );
  writeAdoptionState(target, {
    version: 1,
    recordedBatches: [...recorded, batch.generatedAt].slice(-50),
  });
  return true;
}

// ---------------------------------------------------------------------------
// Acceptance / rejection detection (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Record "accepted" for proposed skills that became installed.
 * Only skills present in the supplied proposal set are recorded — installing a
 * skill that was never recommended is not a recommendation acceptance.
 */
export function recordAcceptedSkills(
  target: string,
  installedNames: string[],
  proposals: Array<{ name: string; confidence?: number }>,
  source: AdoptionSource = "auto",
  taskId?: string,
  agent?: RunAgent
): number {
  if (installedNames.length === 0 || proposals.length === 0) return 0;
  const byName = new Map(proposals.map((p) => [p.name, p] as const));
  const alreadyAccepted = new Set(
    readAdoptionEvents(target)
      .filter((e) => e.event === "accepted")
      .map((e) => `${e.taskId}|${e.skill}`)
  );
  const id = taskId ?? `apply-${new Date().toISOString()}`;
  const events: AdoptionEventInput[] = [];
  for (const name of installedNames) {
    const prop = byName.get(name);
    if (!prop) continue;
    if (alreadyAccepted.has(`${id}|${name}`)) continue;
    events.push({
      taskId: id,
      skill: name,
      event: "accepted",
      source,
      confidence: prop.confidence,
      agent,
    });
  }
  appendAdoptionEvents(target, events);
  return events.length;
}

/**
 * Record "rejected" for proposals dismissed / expired without invocation.
 * Idempotent per (session, skill): the Stop hook can fire multiple times per
 * session, and duplicate rejections would over-penalize ranking adjustments.
 */
export function recordRejectedSkills(
  target: string,
  sessionId: string,
  skills: Array<{ name: string; confidence?: number }>,
  source: AdoptionSource = "auto",
  agent?: RunAgent
): void {
  if (skills.length === 0) return;
  const alreadyRejected = new Set(
    readAdoptionEvents(target)
      .filter((e) => e.event === "rejected" && e.taskId === sessionId)
      .map((e) => e.skill)
  );
  appendAdoptionEvents(
    target,
    skills
      .filter((s) => !alreadyRejected.has(s.name))
      .map((s) => ({
        taskId: sessionId,
        skill: s.name,
        event: "rejected" as const,
        source,
        confidence: s.confidence,
        agent,
      }))
  );
}

/**
 * Record an "invoked" event. When the skill was in the proposal set but no
 * "accepted" event exists yet (skill was already installed, so no install
 * transition fired), invocation is the strongest acceptance signal — an
 * implicit "accepted" is recorded first so the funnel stays consistent.
 */
export function recordInvokedSkill(
  target: string,
  entry: {
    skill: string;
    sessionId: string;
    agent?: RunAgent;
    confidence?: number;
    proposed?: boolean;
    source?: AdoptionSource;
  }
): void {
  const events: AdoptionEventInput[] = [];
  if (entry.proposed) {
    const hasAccepted = readAdoptionEvents(target).some(
      (e) => e.event === "accepted" && e.skill === entry.skill
    );
    if (!hasAccepted) {
      events.push({
        taskId: entry.sessionId,
        skill: entry.skill,
        event: "accepted",
        source: entry.source ?? "auto",
        confidence: entry.confidence,
        agent: entry.agent,
      });
    }
  }
  events.push({
    taskId: entry.sessionId,
    skill: entry.skill,
    event: "invoked",
    source: entry.source ?? "auto",
    confidence: entry.confidence,
    agent: entry.agent,
  });
  appendAdoptionEvents(target, events);
}

// ---------------------------------------------------------------------------
// Success detection (Phase 4)
// ---------------------------------------------------------------------------

export interface SuccessSignal {
  invocations: number;
  successes: number;
  /** Negative / correction feedback entries attributable to the skill. */
  corrections: number;
}

/**
 * Success confidence 0-100 from feedback, invocation count, and completion signals.
 * 1 clean successful invocation lands ~84; corrections pull hard toward 0.
 */
export function computeSuccessConfidence(signal: SuccessSignal): number {
  if (signal.invocations <= 0) return 0;
  const successRate = signal.successes / signal.invocations;
  const raw =
    successRate * 60 +
    Math.min(signal.invocations, 5) * 4 +
    (signal.corrections === 0 ? 20 : -signal.corrections * 20);
  return Math.max(0, Math.min(100, Math.round(raw)));
}

// ---------------------------------------------------------------------------
// Reuse detection (Phase 5)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

export function classifyReuseWindow(gapDays: number): ReuseWindow | null {
  if (gapDays < 0) return null;
  if (gapDays <= 7) return "7d";
  if (gapDays <= 30) return "30d";
  if (gapDays <= 90) return "90d";
  return null;
}

export interface SkillReuseStats {
  skill: string;
  firstUseDate?: string;
  lastUseDate?: string;
  /** Number of reused events recorded for the skill. */
  reuseCount: number;
}

export function getSkillReuseStats(target: string, skill: string): SkillReuseStats {
  const events = readAdoptionEvents(target).filter((e) => e.skill === skill);
  const uses = events
    .filter((e) => e.event === "invoked")
    .map((e) => e.timestamp)
    .sort();
  return {
    skill,
    firstUseDate: uses[0],
    lastUseDate: uses[uses.length - 1],
    reuseCount: events.filter((e) => e.event === "reused").length,
  };
}

/**
 * Session teardown hook (Phases 4+5): for every skill invoked in the session,
 * decide success (successful completion, no correction signal) and reuse
 * (a successful use with a prior use within 7/30/90 days).
 * Idempotent per (session, skill): re-running for the same session is a no-op.
 */
export function recordSessionAdoptionOutcomes(
  target: string,
  sessionId: string,
  agent?: RunAgent
): { successful: string[]; reused: string[] } {
  const result = { successful: [] as string[], reused: [] as string[] };
  const runs = readCachedEnrichedRuns(target).filter((r) => r.session_id === sessionId);
  if (runs.length === 0) return result;

  const events = readAdoptionEvents(target);
  const alreadySuccessful = new Set(
    events.filter((e) => e.event === "successful" && e.taskId === sessionId).map((e) => e.skill)
  );
  const alreadyReused = new Set(
    events.filter((e) => e.event === "reused" && e.taskId === sessionId).map((e) => e.skill)
  );

  const sessionStartMs = Math.min(...runs.map((r) => new Date(r.ts).getTime()));
  const feedback = readSkillFeedbackRecords(target);

  const bySkill = new Map<string, { invocations: number; successes: number }>();
  for (const r of runs) {
    const e = bySkill.get(r.skill) ?? { invocations: 0, successes: 0 };
    e.invocations++;
    if (r.success) e.successes++;
    bySkill.set(r.skill, e);
  }

  const toAppend: AdoptionEventInput[] = [];
  for (const [skill, counts] of bySkill.entries()) {
    // Corrections: negative/correction feedback for this skill since the session started.
    const corrections = feedback.filter(
      (f) => f.skill === skill && new Date(f.ts).getTime() >= sessionStartMs - 60_000
    ).length;

    const succeeded = counts.successes > 0 && corrections === 0;
    if (succeeded && !alreadySuccessful.has(skill)) {
      toAppend.push({
        taskId: sessionId,
        skill,
        event: "successful",
        source: "auto",
        confidence: computeSuccessConfidence({ ...counts, corrections }),
        agent,
      });
      result.successful.push(skill);
    }

    // Reuse: successful use again after a prior use (invoked/successful) in an
    // earlier session within the 90d horizon.
    if (succeeded && !alreadyReused.has(skill)) {
      const priorUses = events
        .filter(
          (e) =>
            e.skill === skill &&
            (e.event === "invoked" || e.event === "successful") &&
            e.taskId !== sessionId &&
            new Date(e.timestamp).getTime() < sessionStartMs
        )
        .map((e) => new Date(e.timestamp).getTime());
      if (priorUses.length > 0) {
        const gapDays = (sessionStartMs - Math.max(...priorUses)) / DAY_MS;
        const window = classifyReuseWindow(gapDays);
        if (window) {
          toAppend.push({
            taskId: sessionId,
            skill,
            event: "reused",
            source: "auto",
            agent,
            reuseWindow: window,
            daysSincePreviousUse: Math.round(gapDays * 10) / 10,
          });
          result.reused.push(skill);
        }
      }
    }
  }
  appendAdoptionEvents(target, toAppend);
  return result;
}

// ---------------------------------------------------------------------------
// Funnel metrics (Phase 2)
// ---------------------------------------------------------------------------

export interface AdoptionFunnel {
  daysBack: number;
  proposed: number;
  accepted: number;
  rejected: number;
  invoked: number;
  successful: number;
  reused: number;
  /** accepted / proposed */
  acceptanceRatePct: number;
  /** invoked / accepted */
  invocationRatePct: number;
  /** successful / invoked */
  successRatePct: number;
  /** reused / successful */
  reuseRatePct: number;
  /** invoked / proposed */
  globalAdoptionRatePct: number;
  /** Composite 0-100: acceptance 30% + invocation 20% + success 30% + reuse 20%. */
  adoptionScore: number;
  hasData: boolean;
}

function pct(numer: number, denom: number): number {
  return denom > 0 ? Math.round((numer / denom) * 100) : 0;
}

function cappedPct(numer: number, denom: number): number {
  return Math.min(100, pct(numer, denom));
}

export function computeAdoptionFunnel(target: string, daysBack = 90): AdoptionFunnel {
  const cutoff = Date.now() - daysBack * DAY_MS;
  const events = readAdoptionEvents(target).filter(
    (e) => new Date(e.timestamp).getTime() >= cutoff
  );
  const count = (t: AdoptionEventType) => events.filter((e) => e.event === t).length;
  const proposed = count("proposed");
  const accepted = count("accepted");
  const rejected = count("rejected");
  const invoked = count("invoked");
  const successful = count("successful");
  const reused = count("reused");

  const acceptanceRatePct = pct(accepted, proposed);
  const invocationRatePct = pct(invoked, accepted);
  const successRatePct = pct(successful, invoked);
  const reuseRatePct = pct(reused, successful);
  const adoptionScore = Math.round(
    cappedPct(accepted, proposed) * 0.30 +
    cappedPct(invoked, accepted) * 0.20 +
    cappedPct(successful, invoked) * 0.30 +
    cappedPct(reused, successful) * 0.20
  );

  return {
    daysBack, proposed, accepted, rejected, invoked, successful, reused,
    acceptanceRatePct, invocationRatePct, successRatePct, reuseRatePct,
    globalAdoptionRatePct: pct(invoked, proposed),
    adoptionScore,
    hasData: events.length > 0,
  };
}

export interface SkillAdoptionFunnelStats {
  skill: string;
  proposed: number;
  accepted: number;
  rejected: number;
  invoked: number;
  successful: number;
  reused: number;
  acceptanceRatePct: number;
  successRatePct: number;
  reuseRatePct: number;
  /** Composite 0-100 per-skill adoption score. */
  adoptionScore: number;
  firstUseDate?: string;
  lastUseDate?: string;
}

export function computePerSkillAdoption(target: string, daysBack = 90): SkillAdoptionFunnelStats[] {
  const cutoff = Date.now() - daysBack * DAY_MS;
  const events = readAdoptionEvents(target).filter(
    (e) => new Date(e.timestamp).getTime() >= cutoff
  );
  const bySkill = new Map<string, SkillAdoptionEvent[]>();
  for (const e of events) {
    const arr = bySkill.get(e.skill) ?? [];
    arr.push(e);
    bySkill.set(e.skill, arr);
  }
  const out: SkillAdoptionFunnelStats[] = [];
  for (const [skill, evts] of bySkill.entries()) {
    const count = (t: AdoptionEventType) => evts.filter((e) => e.event === t).length;
    const proposed = count("proposed");
    const accepted = count("accepted");
    const invoked = count("invoked");
    const successful = count("successful");
    const reused = count("reused");
    const uses = evts.filter((e) => e.event === "invoked").map((e) => e.timestamp).sort();
    out.push({
      skill,
      proposed, accepted, rejected: count("rejected"), invoked, successful, reused,
      acceptanceRatePct: pct(accepted, proposed),
      successRatePct: pct(successful, invoked),
      reuseRatePct: pct(reused, successful),
      adoptionScore: Math.round(
        cappedPct(accepted, proposed) * 0.30 +
        cappedPct(invoked, accepted) * 0.20 +
        cappedPct(successful, invoked) * 0.30 +
        cappedPct(reused, successful) * 0.20
      ),
      firstUseDate: uses[0],
      lastUseDate: uses[uses.length - 1],
    });
  }
  return out.sort((a, b) => b.adoptionScore - a.adoptionScore || a.skill.localeCompare(b.skill));
}

// ---------------------------------------------------------------------------
// Recommendation quality: precision / recall / F1 (Phase 7)
// ---------------------------------------------------------------------------

export interface RecommendationQuality {
  proposed: number;
  accepted: number;
  successful: number;
  /** successful / accepted (capped at 100). */
  precisionPct: number;
  /** successful / proposed (capped at 100). */
  recallPct: number;
  f1Pct: number;
  hasData: boolean;
}

export function computeRecommendationQuality(target: string, daysBack = 90): RecommendationQuality {
  const funnel = computeAdoptionFunnel(target, daysBack);
  const precisionPct = cappedPct(funnel.successful, funnel.accepted);
  const recallPct = cappedPct(funnel.successful, funnel.proposed);
  const f1Pct =
    precisionPct + recallPct > 0
      ? Math.round((2 * precisionPct * recallPct) / (precisionPct + recallPct))
      : 0;
  return {
    proposed: funnel.proposed,
    accepted: funnel.accepted,
    successful: funnel.successful,
    precisionPct,
    recallPct,
    f1Pct,
    hasData: funnel.proposed > 0,
  };
}

// ---------------------------------------------------------------------------
// Feedback loop: exponentially weighted confidence adjustment (Phase 8)
// ---------------------------------------------------------------------------

export const ADOPTION_HALF_LIFE_DAYS = 14;
export const ADOPTION_ADJUSTMENT_CAP = 25;

const EVENT_WEIGHTS: Partial<Record<AdoptionEventType, number>> = {
  accepted: 5,
  invoked: 3,
  successful: 9,
  reused: 12,
  rejected: -7,
};

/**
 * Confidence delta (integer, clamped to +/-25) for a skill based on its
 * adoption history. Recent behavior is weighted exponentially higher than old
 * behavior (half-life 14 days). Invocations that never produced a successful
 * outcome contribute a penalty so unsuccessful skills decay too.
 */
export function adoptionConfidenceAdjustment(
  target: string,
  skill: string,
  nowMs = Date.now()
): number {
  const events = readAdoptionEvents(target).filter((e) => e.skill === skill);
  if (events.length === 0) return 0;

  let score = 0;
  let weightedInvoked = 0;
  let weightedSuccessful = 0;
  for (const e of events) {
    const ageDays = Math.max(0, (nowMs - new Date(e.timestamp).getTime()) / DAY_MS);
    const decay = Math.pow(0.5, ageDays / ADOPTION_HALF_LIFE_DAYS);
    score += (EVENT_WEIGHTS[e.event] ?? 0) * decay;
    if (e.event === "invoked") weightedInvoked += decay;
    if (e.event === "successful") weightedSuccessful += decay;
  }
  // Unsuccessful-use penalty: invoked weight not backed by successful weight.
  score -= Math.max(0, weightedInvoked - weightedSuccessful) * 3;

  const clamped = Math.max(-ADOPTION_ADJUSTMENT_CAP, Math.min(ADOPTION_ADJUSTMENT_CAP, score));
  return Math.round(clamped);
}

// ---------------------------------------------------------------------------
// Dashboard panel (Phase 6)
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function skillListHtml(
  rows: SkillAdoptionFunnelStats[],
  detail: (s: SkillAdoptionFunnelStats) => string,
  emptyNote: string
): string {
  if (rows.length === 0) return `<p class="note">${emptyNote}</p>`;
  return rows
    .map(
      (s) =>
        `<div class="skill-row"><div class="skill-head"><b>${esc(s.skill)}</b>
        <span class="cost">${s.adoptionScore}/100</span></div>
        <div class="hint">${detail(s)}</div></div>`
    )
    .join("");
}

export function formatAdoptionFunnelPanelHtml(target: string, daysBack = 90): string {
  const funnel = computeAdoptionFunnel(target, daysBack);
  const quality = computeRecommendationQuality(target, daysBack);

  if (!funnel.hasData) {
    return `<div class="panel" style="margin-top:6px">
  <h2 style="margin-top:0">Skill Adoption Funnel</h2>
  <p class="note">No adoption events yet — the funnel populates as skills are proposed, installed, and invoked (.claude/learning/skill-adoption.jsonl).</p>
</div>`;
  }

  const pctClass = (v: number, lo: number, hi: number) =>
    v >= hi ? "roi-high" : v >= lo ? "roi-medium" : "roi-low";

  const summary = `<div class="stat-grid" style="margin-bottom:10px">
  <div class="stat-pill" title="Composite: acceptance 30% + invocation 20% + success 30% + reuse 20%">
    <b>Adoption Score</b><span class="val ${pctClass(funnel.adoptionScore, 25, 50)}">${funnel.adoptionScore}/100</span>
  </div>
  <div class="stat-pill" title="accepted / proposed"><b>Acceptance</b>
    <span class="val ${pctClass(funnel.acceptanceRatePct, 10, 25)}">${funnel.acceptanceRatePct}%</span></div>
  <div class="stat-pill" title="invoked / accepted"><b>Invocation</b>
    <span class="val ${pctClass(funnel.invocationRatePct, 25, 50)}">${funnel.invocationRatePct}%</span></div>
  <div class="stat-pill" title="successful / invoked"><b>Success</b>
    <span class="val ${pctClass(funnel.successRatePct, 40, 70)}">${funnel.successRatePct}%</span></div>
  <div class="stat-pill" title="reused / successful"><b>Reuse</b>
    <span class="val ${pctClass(funnel.reuseRatePct, 20, 50)}">${funnel.reuseRatePct}%</span></div>
</div>`;

  const stages: Array<{ label: string; value: number; pctOfPrev: number }> = [
    { label: "Proposed", value: funnel.proposed, pctOfPrev: 100 },
    { label: "Accepted", value: funnel.accepted, pctOfPrev: cappedPct(funnel.accepted, funnel.proposed) },
    { label: "Invoked", value: funnel.invoked, pctOfPrev: cappedPct(funnel.invoked, funnel.accepted) },
    { label: "Successful", value: funnel.successful, pctOfPrev: cappedPct(funnel.successful, funnel.invoked) },
    { label: "Reused", value: funnel.reused, pctOfPrev: cappedPct(funnel.reused, funnel.successful) },
  ];
  const maxStage = Math.max(1, funnel.proposed);
  const funnelHtml = stages
    .map(
      (s) => `<div class="skill-row"><div class="skill-head"><b>${s.label}</b>
    <span class="cost">${s.value}</span>
    <span class="bar">${s.pctOfPrev}%</span>
    <div style="display:inline-block;width:${Math.round((Math.min(s.value, maxStage) / maxStage) * 120)}px;height:6px;background:var(--vscode-charts-green,#4CAF50);border-radius:2px;vertical-align:middle;margin-left:4px"></div>
    </div></div>`
    )
    .join("");

  const perSkill = computePerSkillAdoption(target, daysBack);
  const topAccepted = perSkill.filter((s) => s.accepted > 0).sort((a, b) => b.accepted - a.accepted).slice(0, 5);
  const topIgnored = perSkill
    .filter((s) => s.proposed >= 2 && s.accepted === 0 && s.invoked === 0)
    .sort((a, b) => b.proposed - a.proposed || b.rejected - a.rejected)
    .slice(0, 5);
  const topSuccessful = perSkill.filter((s) => s.successful > 0).sort((a, b) => b.successful - a.successful).slice(0, 5);
  const topReused = perSkill.filter((s) => s.reused > 0).sort((a, b) => b.reused - a.reused).slice(0, 5);
  const leastEffective = perSkill
    .filter((s) => s.invoked >= 2 && s.successRatePct < 50)
    .sort((a, b) => a.successRatePct - b.successRatePct)
    .slice(0, 5);

  const section = (title: string, body: string) => `<details style="margin-bottom:8px">
    <summary style="cursor:pointer;font-size:12px;font-weight:600">${title}</summary>
    <div style="margin-top:6px">${body}</div>
  </details>`;

  const qualityGrid = `<div class="stat-grid" style="margin-bottom:8px">
  <div class="stat-pill" title="successful / accepted recommendations"><b>Precision</b>
    <span class="val ${pctClass(quality.precisionPct, 25, 50)}">${quality.precisionPct}%</span></div>
  <div class="stat-pill" title="successful / total recommendations"><b>Recall</b>
    <span class="val ${pctClass(quality.recallPct, 10, 30)}">${quality.recallPct}%</span></div>
  <div class="stat-pill" title="harmonic mean of precision and recall"><b>F1</b>
    <span class="val ${pctClass(quality.f1Pct, 15, 35)}">${quality.f1Pct}%</span></div>
</div>`;

  return `<div class="panel" style="margin-top:6px">
  <h2 style="margin-top:0">Skill Adoption Funnel</h2>
  ${summary}
  <div style="margin-bottom:8px">${funnelHtml}</div>
  <p class="note" style="margin:4px 0 8px">Global adoption (invoked / proposed): ${funnel.globalAdoptionRatePct}% · ${funnel.rejected} rejections · ${funnel.daysBack}d window</p>
  ${qualityGrid}
  ${section("Top Accepted Skills", skillListHtml(topAccepted, (s) => `accepted ${s.accepted}x · ${s.acceptanceRatePct}% acceptance`, "No accepted recommendations yet."))}
  ${section("Top Ignored Skills", skillListHtml(topIgnored, (s) => `proposed ${s.proposed}x, never accepted or invoked (${s.rejected} rejections)`, "No consistently ignored skills."))}
  ${section("Top Successful Skills", skillListHtml(topSuccessful, (s) => `${s.successful} successful uses · ${s.successRatePct}% success rate`, "No successful uses recorded yet."))}
  ${section("Top Reused Skills", skillListHtml(topReused, (s) => `reused ${s.reused}x · ${s.reuseRatePct}% reuse rate`, "No reuse recorded yet."))}
  ${section("Least Effective Skills", skillListHtml(leastEffective, (s) => `${s.invoked} invocations, only ${s.successRatePct}% successful`, "No underperforming skills detected."))}
</div>`;
}

// ---------------------------------------------------------------------------
// Reporting (Phase 9)
// ---------------------------------------------------------------------------

export function formatAdoptionReport(target: string, daysBack = 90): string {
  const funnel = computeAdoptionFunnel(target, daysBack);
  if (!funnel.hasData) {
    return [
      "=== Skill Adoption Intelligence ===",
      "No adoption events recorded yet (.claude/learning/skill-adoption.jsonl).",
    ].join("\n");
  }
  const quality = computeRecommendationQuality(target, daysBack);
  const perSkill = computePerSkillAdoption(target, daysBack);
  const top = perSkill.find((s) => s.invoked > 0) ?? perSkill[0];

  const lines = [
    "=== Skill Adoption Intelligence ===",
    `Window: last ${daysBack} days`,
    "",
    `Proposed:   ${funnel.proposed}`,
    `Accepted:   ${funnel.accepted}`,
    `Invoked:    ${funnel.invoked}`,
    `Successful: ${funnel.successful}`,
    `Reused:     ${funnel.reused}`,
    "",
    `Acceptance Rate:      ${funnel.acceptanceRatePct}%`,
    `Invocation Rate:      ${funnel.invocationRatePct}%`,
    `Success Rate:         ${funnel.successRatePct}%`,
    `Reuse Rate:           ${funnel.reuseRatePct}%`,
    `Global Adoption Rate: ${funnel.globalAdoptionRatePct}%`,
    `Adoption Score:       ${funnel.adoptionScore}/100`,
    "",
    `Recommendation Precision: ${quality.precisionPct}%`,
    `Recommendation Recall:    ${quality.recallPct}%`,
    `Recommendation F1:        ${quality.f1Pct}%`,
  ];
  if (top) {
    lines.push(
      "",
      `Top Performing Skill: ${top.skill}`,
      `  Acceptance: ${top.acceptanceRatePct}%`,
      `  Success:    ${top.successRatePct}%`,
      `  Reuse:      ${top.reuseRatePct}%`,
      `  Score:      ${top.adoptionScore}/100`
    );
  }
  return lines.join("\n");
}
