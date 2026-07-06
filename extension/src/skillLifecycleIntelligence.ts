/**
 * Workspace Intelligence v1 — Skill Lifecycle Intelligence (Phase 5) +
 * Outdated Skill Prioritization (Phase 6).
 *
 * skillLifecycle.ts already detects *that* a skill is outdated/deprecated.
 * This module answers the more useful question: outdated skills are not
 * equally worth upgrading — one used 120 times this month is a very
 * different priority than one nobody has touched in months. Combines that
 * version-status detection with workspace affinity (workspaceAffinity.ts)
 * and recent usage to rank upgrades by actual impact.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { listSkillVersionStatuses } from "./skillLifecycle";
import { Manifest, readSkillVersionSidecar } from "./skillOps";
import { readAdoptionEvents, computePerSkillAdoption } from "./skillAdoption";
import { appendWorkspaceIntelligenceEvent, getOrComputeWorkspaceAffinity } from "./workspaceAffinity";

const LIFECYCLE_INDEX_REL = path.join(".claude", "learning", "skill-lifecycle.json");
const DAY_MS = 86_400_000;

export type SkillLifecycleStatus = "current" | "outdated" | "deprecated" | "missing";
export type UpdatePriority = "HIGH" | "MEDIUM" | "LOW";

export interface SkillLifecycleRecord {
  skill: string;
  installedVersion: string;
  latestVersion: string;
  status: SkillLifecycleStatus;
  affinity: number;
  usageLast30d: number;
  daysOutdated: number;
  updatePriority: UpdatePriority;
  /** 0-100 composite driving updatePriority — affinity 50% + usage 25% + recommendation impact 15% + version delta 10%. */
  priorityScore: number;
}

export interface SkillLifecycleIndex {
  version: 1;
  computedAt: string;
  skills: Record<string, SkillLifecycleRecord>;
}

export function skillLifecycleIndexPath(target: string): string {
  return path.join(target, LIFECYCLE_INDEX_REL);
}

export function readSkillLifecycleIndex(target: string): SkillLifecycleIndex | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(skillLifecycleIndexPath(target), "utf-8")) as SkillLifecycleIndex;
    if (parsed?.version === 1 && parsed.skills) return parsed;
  } catch {
    /* absent or corrupt */
  }
  return undefined;
}

function writeSkillLifecycleIndex(target: string, index: SkillLifecycleIndex): void {
  try {
    const file = skillLifecycleIndexPath(target);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(index, null, 2) + "\n", "utf-8");
  } catch {
    /* non-fatal */
  }
}

const USAGE_SATURATION_30D = 20; // 20+ invocations in 30d -> full usage score

function usageLast30d(target: string, skill: string, nowMs: number): number {
  const cutoff = nowMs - 30 * DAY_MS;
  return readAdoptionEvents(target).filter(
    (e) => e.skill === skill && e.event === "invoked" && new Date(e.timestamp).getTime() >= cutoff
  ).length;
}

/** Version-delta severity 0-100: major bumps weigh far more than patch bumps. */
function versionDeltaScore(installed: string, latest: string): number {
  const parse = (v: string) =>
    v.trim().replace(/^v/i, "").split(".").map((p) => parseInt(p.replace(/[^0-9].*$/, ""), 10) || 0);
  const [iMaj, iMin, iPatch] = parse(installed);
  const [lMaj, lMin, lPatch] = parse(latest);
  const majorDelta = Math.max(0, (lMaj ?? 0) - (iMaj ?? 0));
  const minorDelta = Math.max(0, (lMin ?? 0) - (iMin ?? 0));
  const patchDelta = Math.max(0, (lPatch ?? 0) - (iPatch ?? 0));
  return Math.min(100, majorDelta * 40 + minorDelta * 10 + patchDelta * 2);
}

function daysSinceInstalled(target: string, skill: string, nowMs: number): number {
  try {
    const skillDir = path.join(target, ".claude", "skills", skill);
    const sidecar = readSkillVersionSidecar(skillDir);
    if (sidecar?.installedAt) {
      return Math.max(0, Math.floor((nowMs - new Date(sidecar.installedAt).getTime()) / DAY_MS));
    }
  } catch {
    /* fall through */
  }
  return 0;
}

function bucketPriority(score: number): UpdatePriority {
  if (score >= 65) return "HIGH";
  if (score >= 35) return "MEDIUM";
  return "LOW";
}

/**
 * Builds `.claude/learning/skill-lifecycle.json`: one record per skill that is
 * installed, outdated, deprecated, or has usage/affinity history but is no
 * longer installed ("missing"). Ranked by affinity -> usage -> recommendation
 * impact -> version delta (Phase 6).
 */
export function computeSkillLifecycleIntelligence(
  target: string,
  libraryDir: string,
  manifest: Manifest,
  nowMs = Date.now()
): SkillLifecycleIndex {
  const statuses = listSkillVersionStatuses(libraryDir, target);
  const affinityIndex = getOrComputeWorkspaceAffinity(target, nowMs);
  const perSkillAdoption = new Map(computePerSkillAdoption(target).map((s) => [s.skill, s]));
  const previous = readSkillLifecycleIndex(target);

  // Skills with affinity/adoption history that are no longer installed at all.
  const installedNames = new Set(statuses.map((s) => s.name));
  const historicalNames = new Set([
    ...Object.keys(affinityIndex.skills),
    ...perSkillAdoption.keys(),
  ]);

  const skills: Record<string, SkillLifecycleRecord> = {};

  for (const status of statuses) {
    const affinity = affinityIndex.skills[status.name]?.affinityScore ?? 0;
    const usage = usageLast30d(target, status.name, nowMs);
    const recommendationImpact = perSkillAdoption.get(status.name)?.adoptionScore ?? 0;
    const versionDelta = versionDeltaScore(status.installedVersion, status.catalogVersion);
    const priorityScore = Math.round(
      affinity * 0.5 + Math.min(100, (usage / USAGE_SATURATION_30D) * 100) * 0.25 +
        recommendationImpact * 0.15 +
        versionDelta * 0.1
    );

    const lifecycleStatus: SkillLifecycleStatus = status.deprecated
      ? "deprecated"
      : status.outdated
        ? "outdated"
        : "current";

    skills[status.name] = {
      skill: status.name,
      installedVersion: status.installedVersion,
      latestVersion: status.catalogVersion,
      status: lifecycleStatus,
      affinity,
      usageLast30d: usage,
      daysOutdated: status.outdated ? daysSinceInstalled(target, status.name, nowMs) : 0,
      updatePriority: bucketPriority(priorityScore),
      priorityScore,
    };

    // Phase 10 observability: only fire once, when a skill first becomes outdated/
    // deprecated — not on every recompute, or the log would fill with repeats.
    const wasUpToDate = previous?.skills[status.name]?.status !== "outdated" &&
      previous?.skills[status.name]?.status !== "deprecated";
    if ((lifecycleStatus === "outdated" || lifecycleStatus === "deprecated") && wasUpToDate) {
      appendWorkspaceIntelligenceEvent(target, "upgrade-available", {
        skill: status.name,
        installedVersion: status.installedVersion,
        latestVersion: status.catalogVersion,
        updatePriority: bucketPriority(priorityScore),
      });
    }
  }

  for (const name of historicalNames) {
    if (installedNames.has(name)) continue;
    const affinity = affinityIndex.skills[name]?.affinityScore ?? 0;
    const usage = usageLast30d(target, name, nowMs);
    const rule = manifest.skills[name];
    skills[name] = {
      skill: name,
      installedVersion: "not installed",
      latestVersion: rule?.version?.trim() || "1.0.0",
      status: "missing",
      affinity,
      usageLast30d: usage,
      daysOutdated: 0,
      updatePriority: bucketPriority(affinity * 0.5 + Math.min(100, (usage / USAGE_SATURATION_30D) * 100) * 0.5),
      priorityScore: Math.round(affinity * 0.5 + Math.min(100, (usage / USAGE_SATURATION_30D) * 100) * 0.5),
    };
  }

  const index: SkillLifecycleIndex = { version: 1, computedAt: new Date().toISOString(), skills };
  writeSkillLifecycleIndex(target, index);
  return index;
}

/** Outdated (or deprecated) skills ranked by priority — highest impact upgrades first (Phase 6). */
export function rankOutdatedSkillsByPriority(index: SkillLifecycleIndex): SkillLifecycleRecord[] {
  return Object.values(index.skills)
    .filter((r) => r.status === "outdated" || r.status === "deprecated")
    .sort((a, b) => b.priorityScore - a.priorityScore || a.skill.localeCompare(b.skill));
}

// ── Phase 9: Dashboard panel ──────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const PRIORITY_CLASS: Record<UpdatePriority, string> = {
  HIGH: "roi-low", // red/urgent styling reused from existing ROI palette
  MEDIUM: "roi-medium",
  LOW: "roi-high",
};

export function formatSkillLifecyclePanelHtml(target: string): string {
  const index = readSkillLifecycleIndex(target);
  if (!index || Object.keys(index.skills).length === 0) {
    return `<div class="panel" style="margin-top:6px">
  <h2 style="margin-top:0">Skill Lifecycle Intelligence</h2>
  <p class="note">No lifecycle data yet — run the Workspace Intelligence refresh after skills are installed (.claude/learning/skill-lifecycle.json).</p>
</div>`;
  }

  const records = Object.values(index.skills);
  const byStatus = (s: SkillLifecycleStatus) => records.filter((r) => r.status === s);
  const current = byStatus("current");
  const outdated = byStatus("outdated");
  const deprecated = byStatus("deprecated");
  const missing = byStatus("missing");

  const summary = `<div class="stat-grid" style="margin-bottom:10px">
  <div class="stat-pill"><b>Current</b><span class="val roi-high">${current.length}</span></div>
  <div class="stat-pill"><b>Outdated</b><span class="val ${outdated.length > 0 ? "roi-medium" : ""}">${outdated.length}</span></div>
  <div class="stat-pill"><b>Deprecated</b><span class="val ${deprecated.length > 0 ? "roi-low" : ""}">${deprecated.length}</span></div>
  <div class="stat-pill"><b>Missing</b><span class="val">${missing.length}</span></div>
</div>`;

  const priorityRows = rankOutdatedSkillsByPriority(index)
    .map(
      (r) => `<div class="skill-row"><div class="skill-head">
    <b>⚠ ${esc(r.skill)}</b>
    <span class="cost">${esc(r.installedVersion)} → ${esc(r.latestVersion)}</span>
    <span class="cost ${PRIORITY_CLASS[r.updatePriority]}">${r.updatePriority}</span>
    </div>
    <div class="hint">Affinity ${r.affinity} · Used ${r.usageLast30d}x in last 30d${r.daysOutdated > 0 ? ` · outdated ${r.daysOutdated}d` : ""}</div>
    </div>`
    )
    .join("") || `<p class="note">No outdated or deprecated skills.</p>`;

  const section = (title: string, body: string) => `<details style="margin-bottom:8px">
    <summary style="cursor:pointer;font-size:12px;font-weight:600">${title}</summary>
    <div style="margin-top:6px">${body}</div>
  </details>`;

  return `<div class="panel" style="margin-top:6px">
  <h2 style="margin-top:0">Skill Lifecycle Intelligence</h2>
  ${summary}
  ${section("Upgrade Priority", priorityRows)}
</div>`;
}
