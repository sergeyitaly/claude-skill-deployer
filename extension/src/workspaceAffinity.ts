/**
 * Workspace Intelligence v1 — Workspace Affinity Engine (Phase 1) + Observability (Phase 10).
 *
 * Turns the existing adoption event log (skillAdoption.ts) and enrichment index
 * (enrichmentIntelligence.ts) into one normalized 0-100 "affinity score" per
 * skill, persisted to `.claude/learning/workspace-affinity.json`. This is the
 * signal that lets session bootstrap (sessionIntelligence.ts) and recommendation
 * ranking (taskSkillProposals.ts) favor skills this specific workspace has
 * actually proven out, rather than only what a generic tech-stack fingerprint
 * (repoAffinity.ts) suggests.
 *
 * Manual invocation (`/skill-name`) is treated as the strongest signal of
 * intent — stronger than accepting a recommendation — so it gets its own
 * scoring component rather than being folded into a generic "usage" count.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { readAdoptionEvents } from "./skillAdoption";
import { readSkillEnrichmentIndex } from "./enrichmentIntelligence";

const WORKSPACE_AFFINITY_JSON_REL = path.join(".claude", "learning", "workspace-affinity.json");
const WORKSPACE_AFFINITY_LOG_REL = path.join(".claude", "learning", "workspace-affinity.jsonl");

const DAY_MS = 86_400_000;
const RECENCY_HALF_LIFE_DAYS = 14;

// Saturation points: the raw count at which a component reaches 100.
// Manual invocations saturate fastest — a handful of direct invocations is
// already strong proof this skill belongs in the workspace.
const MANUAL_SATURATION = 10;
const OBSERVATION_SATURATION = 100;
const REUSE_SATURATION = 5;

const AFFINITY_CACHE_MS = 60 * 60 * 1000; // 1h — adoption events change within a session
const _memCache = new Map<string, { index: WorkspaceAffinityIndex; mtimeMs: number }>();

export type WorkspaceIntelligenceEventType =
  | "affinity-created"
  | "affinity-updated"
  | "bootstrap-generated"
  | "recommendation-boosted"
  | "upgrade-available"
  | "upgrade-installed";

export interface WorkspaceAffinityRecord {
  skill: string;
  observations: number;
  manualInvocations: number;
  recommendationInvocations: number;
  successCount: number;
  reuseCount: number;
  lastUsed?: string;
  /** 0-100 composite: 30% manual + 30% observations + 20% success + 10% reuse + 10% recency. */
  affinityScore: number;
}

export interface WorkspaceAffinityIndex {
  version: 1;
  computedAt: string;
  skills: Record<string, WorkspaceAffinityRecord>;
}

export function workspaceAffinityPath(target: string): string {
  return path.join(target, WORKSPACE_AFFINITY_JSON_REL);
}

export function workspaceAffinityLogPath(target: string): string {
  return path.join(target, WORKSPACE_AFFINITY_LOG_REL);
}

/** Append-only observability log for Workspace Intelligence (Phase 10). Non-fatal on error. */
export function appendWorkspaceIntelligenceEvent(
  target: string,
  event: WorkspaceIntelligenceEventType,
  details: Record<string, unknown> = {}
): void {
  try {
    const file = workspaceAffinityLogPath(target);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...details });
    fs.appendFileSync(file, line + "\n", "utf-8");
  } catch {
    /* non-fatal */
  }
}

export function readWorkspaceAffinity(target: string): WorkspaceAffinityIndex | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(workspaceAffinityPath(target), "utf-8")) as WorkspaceAffinityIndex;
    if (parsed?.version === 1 && parsed.skills) return parsed;
  } catch {
    /* absent or corrupt */
  }
  return undefined;
}

function writeWorkspaceAffinity(target: string, index: WorkspaceAffinityIndex): void {
  try {
    const file = workspaceAffinityPath(target);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(index, null, 2) + "\n", "utf-8");
  } catch {
    /* non-fatal */
  }
}

function clamp0to100(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function recencyComponent(lastUsed: string | undefined, nowMs: number): number {
  if (!lastUsed) return 0;
  const ageDays = Math.max(0, (nowMs - new Date(lastUsed).getTime()) / DAY_MS);
  return clamp0to100(100 * Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS));
}

/**
 * Composite 0-100 affinity score. Each input is normalized to 0-100 before
 * weighting so no single raw count (e.g. 265 observations vs 10 manual
 * invocations) dominates the formula by scale alone.
 */
export function computeAffinityScore(
  input: {
    manualInvocations: number;
    observations: number;
    successCount: number;
    totalInvocations: number;
    reuseCount: number;
    lastUsed?: string;
  },
  nowMs = Date.now()
): number {
  const manualComponent = clamp0to100((input.manualInvocations / MANUAL_SATURATION) * 100);
  const observationsComponent = clamp0to100((input.observations / OBSERVATION_SATURATION) * 100);
  const successComponent =
    input.totalInvocations > 0 ? clamp0to100((input.successCount / input.totalInvocations) * 100) : 0;
  const reuseComponent = clamp0to100((input.reuseCount / REUSE_SATURATION) * 100);
  const recency = recencyComponent(input.lastUsed, nowMs);

  return clamp0to100(
    manualComponent * 0.3 +
      observationsComponent * 0.3 +
      successComponent * 0.2 +
      reuseComponent * 0.1 +
      recency * 0.1
  );
}

/**
 * Recomputes workspace affinity for every skill with adoption or enrichment
 * history, and persists the result. Emits affinity-created / affinity-updated
 * observability events per skill (Phase 10).
 */
export function computeWorkspaceAffinity(target: string, nowMs = Date.now()): WorkspaceAffinityIndex {
  const events = readAdoptionEvents(target);
  const enrichment = readSkillEnrichmentIndex(target);
  const previous = readWorkspaceAffinity(target);

  const skillNames = new Set<string>();
  for (const e of events) skillNames.add(e.skill);
  for (const name of Object.keys(enrichment?.skills ?? {})) skillNames.add(name);

  const skills: Record<string, WorkspaceAffinityRecord> = {};
  for (const skill of skillNames) {
    const skillEvents = events.filter((e) => e.skill === skill);
    const invoked = skillEvents.filter((e) => e.event === "invoked");
    const manualInvocations = invoked.filter((e) => e.source === "manual").length;
    const recommendationInvocations = invoked.filter((e) => e.source !== "manual").length;
    const successCount = skillEvents.filter((e) => e.event === "successful").length;
    const reuseCount = skillEvents.filter((e) => e.event === "reused").length;
    const lastUsed = invoked.map((e) => e.timestamp).sort().pop();
    const enrichedUsage = enrichment?.skills[skill]?.usageCount ?? 0;
    const observations = Math.max(enrichedUsage, invoked.length);

    const affinityScore = computeAffinityScore(
      {
        manualInvocations,
        observations,
        successCount,
        totalInvocations: invoked.length,
        reuseCount,
        lastUsed,
      },
      nowMs
    );

    skills[skill] = {
      skill,
      observations,
      manualInvocations,
      recommendationInvocations,
      successCount,
      reuseCount,
      lastUsed,
      affinityScore,
    };

    const prevScore = previous?.skills[skill]?.affinityScore;
    if (prevScore === undefined) {
      appendWorkspaceIntelligenceEvent(target, "affinity-created", { skill, affinityScore });
    } else if (prevScore !== affinityScore) {
      appendWorkspaceIntelligenceEvent(target, "affinity-updated", {
        skill,
        previousScore: prevScore,
        affinityScore,
      });
    }
  }

  const index: WorkspaceAffinityIndex = { version: 1, computedAt: new Date().toISOString(), skills };
  writeWorkspaceAffinity(target, index);
  return index;
}

/** Cached accessor (1h TTL) — avoids recomputing on every proposal ranking call. */
export function getOrComputeWorkspaceAffinity(target: string, nowMs = Date.now()): WorkspaceAffinityIndex {
  const key = path.resolve(target);
  const mem = _memCache.get(key);
  if (mem && nowMs - new Date(mem.index.computedAt).getTime() < AFFINITY_CACHE_MS) {
    return mem.index;
  }
  try {
    const cached = readWorkspaceAffinity(target);
    if (cached && nowMs - new Date(cached.computedAt).getTime() < AFFINITY_CACHE_MS) {
      _memCache.set(key, { index: cached, mtimeMs: nowMs });
      return cached;
    }
  } catch {
    /* recompute */
  }
  const fresh = computeWorkspaceAffinity(target, nowMs);
  _memCache.set(key, { index: fresh, mtimeMs: nowMs });
  return fresh;
}

/** Test hook: clears the in-process cache so a fresh computeWorkspaceAffinity is forced. */
export function invalidateWorkspaceAffinity(target?: string): void {
  if (target) _memCache.delete(path.resolve(target));
  else _memCache.clear();
}

export function getWorkspaceAffinityScore(target: string, skill: string): number {
  return getOrComputeWorkspaceAffinity(target).skills[skill]?.affinityScore ?? 0;
}

/** Skills ranked by affinity score, above `minScore` (default 60 — "proven" threshold). */
export function topWorkspaceSkills(
  target: string,
  limit = 3,
  minScore = 60
): WorkspaceAffinityRecord[] {
  const index = getOrComputeWorkspaceAffinity(target);
  return Object.values(index.skills)
    .filter((r) => r.affinityScore >= minScore)
    .sort((a, b) => b.affinityScore - a.affinityScore || a.skill.localeCompare(b.skill))
    .slice(0, limit);
}

/**
 * Recommendation boost tier for Phase 3 ranking (Affinity > 90 -> +25,
 * > 75 -> +15, > 60 -> +10). Kept separate from the general enrichment/adoption
 * adjustments already in taskSkillProposals.ts — this is a distinct, workspace-
 * proven-usage signal, not a re-weighting of the same evidence.
 */
export function workspaceAffinityBoost(affinityScore: number): number {
  if (affinityScore > 90) return 25;
  if (affinityScore > 75) return 15;
  if (affinityScore > 60) return 10;
  return 0;
}

// ── Phase 9: Dashboard panel ──────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatWorkspaceIntelligencePanelHtml(target: string): string {
  const index = getOrComputeWorkspaceAffinity(target);
  const records = Object.values(index.skills);

  if (records.length === 0) {
    return `<div class="panel" style="margin-top:6px">
  <h2 style="margin-top:0">Workspace Intelligence</h2>
  <p class="note">No workspace affinity data yet — this populates as skills are invoked and observed (.claude/learning/workspace-affinity.json).</p>
</div>`;
  }

  const top = topWorkspaceSkills(target, 10, 1);
  const summary = `<div class="stat-grid" style="margin-bottom:10px">
  <div class="stat-pill"><b>Skills Tracked</b><span class="val">${records.length}</span></div>
  <div class="stat-pill"><b>Proven Skills (&gt;60)</b><span class="val roi-high">${topWorkspaceSkills(target, 999, 60).length}</span></div>
</div>`;

  const rows = top
    .map(
      (r) => `<div class="skill-row"><div class="skill-head">
    <b>⭐ ${esc(r.skill)}</b>
    <span class="val">${r.affinityScore}/100</span>
    </div>
    <div class="hint">Manual: ${r.manualInvocations} · Recommended: ${r.recommendationInvocations} · Successes: ${r.successCount} · Reuse: ${r.reuseCount} · Observations: ${r.observations}${r.lastUsed ? ` · Last used: ${esc(r.lastUsed.slice(0, 10))}` : ""}</div>
    </div>`
    )
    .join("") || `<p class="note">No skill has reached the affinity threshold yet.</p>`;

  return `<div class="panel" style="margin-top:6px">
  <h2 style="margin-top:0">Workspace Intelligence</h2>
  ${summary}
  <details open style="margin-bottom:8px">
    <summary style="cursor:pointer;font-size:12px;font-weight:600">Top Workspace Skills</summary>
    <div style="margin-top:6px">${rows}</div>
  </details>
</div>`;
}
