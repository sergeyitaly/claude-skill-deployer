/**
 * Workspace Intelligence v1 — Safe Auto-Upgrade (Phase 8).
 *
 * skillLifecycle.ts already has a narrower auto-upgrade path gated on measured
 * low ROI. This module is a separate, more conservative gate: it never looks
 * at ROI or usage at all, only at whether the *release itself* is safe to
 * apply unattended — a patch-only version bump, or a changelog that reads as
 * purely documentation/metadata. Major/minor bumps, anything whose changelog
 * mentions a breaking change, and deprecated skills are never auto-upgraded.
 *
 * Every automatic upgrade snapshots the current skill directory first so it
 * can be rolled back — auto-upgrading unattended is only safe if undoing it
 * is just as automatic.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { listOutdatedSkills, SkillVersionStatus, upgradeSkillInWorkspace } from "./skillLifecycle";
import { appendWorkspaceIntelligenceEvent } from "./workspaceAffinity";

const SKILL_BACKUPS_REL = path.join(".claude", "learning", "skill-backups");

export function autoUpgradeTrustedSkillsEnabled(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills").get<boolean>("autoUpgradeTrustedSkills", false);
}

const BREAKING_MARKERS = /\bbreaking\b|\bincompatible\b|\bmajor rewrite\b|\bremoved\b/i;
const DOC_ONLY_MARKERS = /\bdocs?\b|\bdocumentation\b|\bmetadata\b|\btypo\b|\bwording\b|\breadme\b/i;

function parseVersionParts(v: string): [number, number, number] {
  const parts = v
    .trim()
    .replace(/^v/i, "")
    .split(".")
    .map((p) => parseInt(p.replace(/[^0-9].*$/, ""), 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/**
 * A release is "trusted" for unattended auto-upgrade only when it cannot
 * plausibly change behavior: a patch-only version bump, or a changelog that
 * reads as purely documentation/metadata. Never major/minor bumps, never a
 * changelog mentioning a breaking change, never deprecated skills.
 */
export function isTrustedRelease(status: SkillVersionStatus): boolean {
  if (status.deprecated || !status.outdated) return false;
  const changelog = status.changelog ?? "";
  if (BREAKING_MARKERS.test(changelog)) return false;
  const [iMaj, iMin] = parseVersionParts(status.installedVersion);
  const [cMaj, cMin] = parseVersionParts(status.catalogVersion);
  const patchOnly = iMaj === cMaj && iMin === cMin;
  return patchOnly || DOC_ONLY_MARKERS.test(changelog);
}

export interface SkillBackupMeta {
  skill: string;
  fromVersion: string;
  toVersion: string;
  backedUpAt: string;
  backupDir: string;
}

function backupsRoot(target: string): string {
  return path.join(target, SKILL_BACKUPS_REL);
}

/** Snapshots an installed skill directory before an automatic upgrade, for rollback. */
export function snapshotSkillForRollback(
  target: string,
  skillName: string,
  fromVersion: string,
  toVersion: string
): SkillBackupMeta | undefined {
  const skillDir = path.join(target, ".claude", "skills", skillName);
  if (!fs.existsSync(skillDir)) return undefined;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(backupsRoot(target), skillName, stamp);
  try {
    fs.mkdirSync(path.dirname(backupDir), { recursive: true });
    fs.cpSync(skillDir, backupDir, { recursive: true });
    const meta: SkillBackupMeta = {
      skill: skillName,
      fromVersion,
      toVersion,
      backedUpAt: new Date().toISOString(),
      backupDir,
    };
    fs.writeFileSync(path.join(backupDir, ".backup-meta.json"), JSON.stringify(meta, null, 2), "utf-8");
    return meta;
  } catch {
    return undefined;
  }
}

/** Backups for a skill, most recent first. */
export function listSkillBackups(target: string, skillName: string): SkillBackupMeta[] {
  const dir = path.join(backupsRoot(target), skillName);
  if (!fs.existsSync(dir)) return [];
  const out: SkillBackupMeta[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const meta = JSON.parse(
        fs.readFileSync(path.join(dir, entry.name, ".backup-meta.json"), "utf-8")
      ) as SkillBackupMeta;
      out.push(meta);
    } catch {
      /* skip malformed backup */
    }
  }
  return out.sort((a, b) => b.backedUpAt.localeCompare(a.backedUpAt));
}

/**
 * Restores the most recent (or a specific) backup over the currently
 * installed skill. Returns false when there is nothing to roll back to.
 */
export function rollbackSkillUpgrade(target: string, skillName: string, backupDir?: string): boolean {
  const backups = listSkillBackups(target, skillName);
  const backup = backupDir ? backups.find((b) => b.backupDir === backupDir) : backups[0];
  if (!backup) return false;

  const skillDir = path.join(target, ".claude", "skills", skillName);
  try {
    fs.rmSync(skillDir, { recursive: true, force: true });
    fs.cpSync(backup.backupDir, skillDir, { recursive: true });
    fs.rmSync(path.join(skillDir, ".backup-meta.json"), { force: true });
    appendWorkspaceIntelligenceEvent(target, "upgrade-installed", {
      skill: skillName,
      rolledBackTo: backup.fromVersion,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Automatically upgrades only trusted releases, snapshotting each skill first
 * so rollbackSkillUpgrade can undo it. Disabled by default — gated on
 * claudeSkills.autoUpgradeTrustedSkills. Returns the names of skills upgraded.
 */
export async function autoUpgradeTrustedSkills(libraryDir: string, target: string): Promise<string[]> {
  if (!autoUpgradeTrustedSkillsEnabled()) return [];

  const outdated = listOutdatedSkills(libraryDir, target);
  const upgraded: string[] = [];

  for (const status of outdated) {
    if (!isTrustedRelease(status)) continue;

    snapshotSkillForRollback(target, status.name, status.installedVersion, status.catalogVersion);
    const result = await upgradeSkillInWorkspace(libraryDir, target, status.name, {
      force: true,
      confirmCost: false,
    });
    if (result === "installed") {
      upgraded.push(status.name);
      appendWorkspaceIntelligenceEvent(target, "upgrade-installed", {
        skill: status.name,
        fromVersion: status.installedVersion,
        toVersion: status.catalogVersion,
        trusted: true,
      });
    }
  }
  return upgraded;
}
