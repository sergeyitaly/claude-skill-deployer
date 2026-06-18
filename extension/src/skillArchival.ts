import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { isFeatureEnabled } from "./featureFlags";
import { copySkill } from "./skillOps";
import { isValidSkillName } from "./skillLint";
import { SkillUsageStat } from "./usageStats";
import { RoiBand } from "./skillRoi";

export interface ArchiveMeta {
  archivedAt: string;
  from: string;
  libraryDir: string;
  reason: string;
  /** Measured ROI band at time of archival — helps decide whether to restore. */
  roiBand?: RoiBand;
  /** Total recorded invocations at time of archival. */
  runs?: number;
  /** Installed version at time of archival. */
  version?: string;
}

export interface ArchivalRules {
  no_usage_days: number;
  cost_per_use: number;
  auto_archive: boolean;
  /** Archive skills with measured LOW ROI band when they also meet the run/idle thresholds. */
  archive_on_low_roi: boolean;
  /** Minimum recorded invocations before ROI-based archival is considered. */
  low_roi_min_runs: number;
  /** Minimum idle days required in addition to LOW ROI band. */
  low_roi_idle_days: number;
}

export function archivalRules(): ArchivalRules {
  const cfg = vscode.workspace.getConfiguration("claudeSkills.archival");
  return {
    no_usage_days: cfg.get<number>("noUsageDays", 30),
    cost_per_use: cfg.get<number>("costPerUse", 2.0),
    auto_archive: cfg.get<boolean>("autoArchive", false),
    archive_on_low_roi: cfg.get<boolean>("archiveOnLowRoi", false),
    low_roi_min_runs: cfg.get<number>("lowRoiMinRuns", 5),
    low_roi_idle_days: cfg.get<number>("lowRoiIdleDays", 7),
  };
}

function bumpPatchVersion(skillDir: string): void {
  const skillMdPath = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillMdPath)) return;
  try {
    const content = fs.readFileSync(skillMdPath, "utf-8");
    const updated = content.replace(
      /^(version:\s*["']?)(\d+)\.(\d+)\.(\d+)(["']?)$/m,
      (_, pre, major, minor, patch, post) =>
        `${pre}${major}.${minor}.${parseInt(patch, 10) + 1}${post}`
    );
    if (updated !== content) {
      fs.writeFileSync(skillMdPath, updated, "utf-8");
    }
  } catch { /* non-fatal */ }
}

function archivedRoot(target: string): string {
  return path.join(target, ".claude", "skills-archived");
}

function globalArchivedRoot(): string {
  return path.join(os.homedir(), ".claude", "skills-archived");
}

export function listArchivedSkills(target: string): string[] {
  const roots = [archivedRoot(target), globalArchivedRoot()];
  const names = new Set<string>();
  for (const root of roots) {
    if (!fs.existsSync(root)) {
      continue;
    }
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(root, entry.name, "SKILL.md"))) {
        names.add(entry.name);
      }
    }
  }
  return [...names].sort();
}

export function candidatesForArchival(
  stats: SkillUsageStat[],
  attributionCostPerUse: Map<string, number>,
  /** Optional ROI band per skill — enables efficiency-based archival when archive_on_low_roi is set. */
  roiBandBySkill?: Map<string, RoiBand>
): string[] {
  if (!isFeatureEnabled("skillArchival")) {
    return [];
  }
  const rules = archivalRules();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of stats) {
    const idle = s.daysSinceLastUse ?? 999;
    const costPerUse = attributionCostPerUse.get(s.name) ?? 0;
    if (idle >= rules.no_usage_days) {
      out.push(s.name);
      seen.add(s.name);
    } else if (costPerUse >= rules.cost_per_use && idle >= 14) {
      out.push(s.name);
      seen.add(s.name);
    } else if (
      rules.archive_on_low_roi &&
      !seen.has(s.name) &&
      roiBandBySkill?.get(s.name) === "LOW" &&
      (s.runs ?? 0) >= rules.low_roi_min_runs &&
      idle >= rules.low_roi_idle_days
    ) {
      out.push(s.name);
      seen.add(s.name);
    }
  }
  return out;
}

export function archiveSkill(
  target: string,
  skillName: string,
  libraryDir: string,
  opts?: { reason?: string; roiBand?: RoiBand; runs?: number; version?: string }
): boolean {
  if (!isValidSkillName(skillName)) {
    return false;
  }
  const src = path.join(target, ".claude", "skills", skillName);
  if (!fs.existsSync(src)) {
    return false;
  }

  // Bump the installed skill's patch version BEFORE moving it to record the archival event.
  bumpPatchVersion(src);

  const destRoot = archivedRoot(target);
  const dest = path.join(destRoot, skillName);
  fs.mkdirSync(destRoot, { recursive: true });
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  // Copy first, then remove source — safer than renameSync which is not atomic across
  // filesystem boundaries (EPERM on Windows temp dirs) and leaves the skill in neither
  // location if it fails mid-operation.
  fs.cpSync(src, dest, { recursive: true });
  fs.rmSync(src, { recursive: true, force: true });

  const meta: ArchiveMeta = {
    archivedAt: new Date().toISOString(),
    from: src,
    libraryDir,
    reason: opts?.reason ?? "manual",
    roiBand: opts?.roiBand,
    runs: opts?.runs,
    version: opts?.version,
  };
  fs.writeFileSync(path.join(dest, ".archive-meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf-8");
  return true;
}

export function restoreArchivedSkill(target: string, skillName: string, libraryDir?: string): boolean {
  if (!isValidSkillName(skillName)) {
    return false;
  }
  const dest = path.join(target, ".claude", "skills", skillName);
  const candidates = [path.join(archivedRoot(target), skillName), path.join(globalArchivedRoot(), skillName)];
  const src = candidates.find((p) => fs.existsSync(path.join(p, "SKILL.md")));

  if (src) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    // Copy first, then remove source — safer than renameSync which is not atomic
    // across filesystem boundaries and leaves the skill in neither location if it fails.
    fs.cpSync(src, dest, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
    return true;
  }

  if (!libraryDir) {
    return false;
  }
  const sourceSkill = path.join(libraryDir, skillName, "SKILL.md");
  if (!fs.existsSync(sourceSkill)) {
    return false;
  }
  const status = copySkill(skillName, libraryDir, path.join(target, ".claude", "skills"), false, false);
  return status === "installed" || status === "skipped-exists";
}
