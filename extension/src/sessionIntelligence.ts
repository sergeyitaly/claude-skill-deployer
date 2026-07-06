/**
 * Workspace Intelligence v1 — Session Bootstrap (Phase 2) + Session Update
 * Advisor (Phase 7).
 *
 * Telemetry, enrichment, adoption, and lifecycle data are all mined
 * separately already; this module is the piece that turns them into
 * something a user actually sees at the start of a session — the top
 * workspace-proven skills and the highest-impact outdated skills — instead
 * of leaving that intelligence passive in JSON files nobody reads.
 *
 * Advisory only: this never installs, upgrades, or invokes a skill. It only
 * surfaces a prioritized summary; the user (or the recommendation engine,
 * via workspaceAffinityBoost in taskSkillProposals.ts) decides what to do
 * with it.
 */
import { Manifest, loadManifest } from "./skillOps";
import {
  appendWorkspaceIntelligenceEvent,
  computeWorkspaceAffinity,
  topWorkspaceSkills,
  WorkspaceAffinityRecord,
} from "./workspaceAffinity";
import {
  computeSkillLifecycleIntelligence,
  rankOutdatedSkillsByPriority,
  SkillLifecycleRecord,
} from "./skillLifecycleIntelligence";

export interface SessionIntelligenceReport {
  generatedAt: string;
  topSkills: WorkspaceAffinityRecord[];
  updatesAvailable: SkillLifecycleRecord[];
}

const DEFAULT_TOP_SKILLS_LIMIT = 3;
const DEFAULT_UPDATES_LIMIT = 5;

/**
 * Recomputes workspace affinity + lifecycle intelligence and assembles the
 * session-start report. Cheap to call every session start: affinity/lifecycle
 * computation is itself cached (see getOrComputeWorkspaceAffinity), so this
 * only does real work when adoption events or skill versions have changed.
 */
export function computeSessionIntelligence(
  target: string,
  libraryDir: string,
  manifest?: Manifest,
  opts?: { topSkillsLimit?: number; updatesLimit?: number }
): SessionIntelligenceReport {
  const mf = manifest ?? loadManifest(libraryDir);
  computeWorkspaceAffinity(target);
  const lifecycleIndex = computeSkillLifecycleIntelligence(target, libraryDir, mf);

  const topSkills = topWorkspaceSkills(target, opts?.topSkillsLimit ?? DEFAULT_TOP_SKILLS_LIMIT);
  const updatesAvailable = rankOutdatedSkillsByPriority(lifecycleIndex).slice(
    0,
    opts?.updatesLimit ?? DEFAULT_UPDATES_LIMIT
  );

  appendWorkspaceIntelligenceEvent(target, "bootstrap-generated", {
    topSkills: topSkills.map((s) => s.skill),
    updatesAvailable: updatesAvailable.map((u) => ({ skill: u.skill, priority: u.updatePriority })),
  });

  return { generatedAt: new Date().toISOString(), topSkills, updatesAvailable };
}

/**
 * Renders the "Workspace Intelligence" session-start block (Phase 7).
 * High-impact updates are shown first (rankOutdatedSkillsByPriority already
 * sorts by priority score). Returns undefined when there's nothing worth
 * showing, so callers can skip injecting an empty section.
 */
export function formatSessionIntelligenceMarkdown(report: SessionIntelligenceReport): string | undefined {
  if (report.topSkills.length === 0 && report.updatesAvailable.length === 0) {
    return undefined;
  }

  const lines: string[] = ["## Workspace Intelligence", ""];

  if (report.topSkills.length > 0) {
    lines.push("**Top Skills:**", "");
    for (const s of report.topSkills) {
      lines.push(`⭐ ${s.skill}`);
    }
    lines.push("");
  }

  if (report.updatesAvailable.length > 0) {
    lines.push("**Updates Available:**", "");
    for (const u of report.updatesAvailable) {
      lines.push(`⚠ ${u.skill}`);
      lines.push(`${u.installedVersion} → ${u.latestVersion}`);
      lines.push(
        u.usageLast30d > 0
          ? `Used ${u.usageLast30d} times recently`
          : `Priority: ${u.updatePriority.toLowerCase()}`
      );
      lines.push("");
    }
  }

  lines.push(
    "_Advisory only — top skills and updates are prioritized based on real usage, not auto-invoked or auto-installed._"
  );
  return lines.join("\n").trimEnd() + "\n";
}
