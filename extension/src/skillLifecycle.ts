import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  copySkill,
  globalSkillsDir,
  loadManifest,
  readSkillVersionSidecar,
  skillCatalogVersion,
  SkillRule,
  writeSkillVersionSidecar,
} from "./skillOps";
import { listInstalledSkills } from "./usageStats";
import { warnOnCostlySkillUpdate } from "./skillVersionCost";

export interface SkillVersionStatus {
  name: string;
  installedVersion: string;
  catalogVersion: string;
  changelog?: string;
  deprecated: boolean;
  outdated: boolean;
}

export function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/i, "")
      .split(".")
      .map((p) => parseInt(p.replace(/[^0-9].*$/, ""), 10) || 0);
  const av = parse(a);
  const bv = parse(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

export function getInstalledSkillVersion(target: string, skillName: string): string {
  const skillDir = path.join(target, ".claude", "skills", skillName);
  const sidecar = readSkillVersionSidecar(skillDir);
  if (sidecar?.version) {
    return sidecar.version;
  }
  return "1.0.0";
}

export function assessSkillVersion(
  skillName: string,
  rule: SkillRule | undefined,
  target: string
): SkillVersionStatus {
  const catalogVersion = skillCatalogVersion(rule);
  const installedVersion = getInstalledSkillVersion(target, skillName);
  const outdated = compareSemver(installedVersion, catalogVersion) < 0;
  return {
    name: skillName,
    installedVersion,
    catalogVersion,
    changelog: rule?.changelog,
    deprecated: rule?.deprecation === true,
    outdated,
  };
}

export function listSkillVersionStatuses(libraryDir: string, target: string): SkillVersionStatus[] {
  const manifest = loadManifest(libraryDir);
  return listInstalledSkills(target)
    .map((name) => assessSkillVersion(name, manifest.skills[name], target))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function listOutdatedSkills(libraryDir: string, target: string): SkillVersionStatus[] {
  return listSkillVersionStatuses(libraryDir, target).filter((s) => s.outdated);
}

export function listDeprecatedSkills(libraryDir: string, target: string): SkillVersionStatus[] {
  return listSkillVersionStatuses(libraryDir, target).filter((s) => s.deprecated);
}

export function lifecycleAlertsEnabled(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.lifecycle").get<boolean>("alertOnOutdated", true);
}

export function lifecycleAutoSuggestEnabled(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.lifecycle").get<boolean>("autoSuggestUpgrades", true);
}

export async function upgradeSkillInWorkspace(
  libraryDir: string,
  target: string,
  skillName: string,
  opts?: { force?: boolean; confirmCost?: boolean }
): Promise<"installed" | "skipped" | "cancelled" | "missing"> {
  const manifest = loadManifest(libraryDir);
  const rule = manifest.skills[skillName];
  if (!rule) {
    return "missing";
  }
  const installedVersion = getInstalledSkillVersion(target, skillName);
  const catalogVersion = skillCatalogVersion(rule);
  if (opts?.confirmCost !== false && compareSemver(installedVersion, catalogVersion) < 0) {
    const ok = await warnOnCostlySkillUpdate(libraryDir, skillName, installedVersion, catalogVersion);
    if (!ok) {
      return "cancelled";
    }
  }

  const globalDir = globalSkillsDir();
  const sourceRoot = fs.existsSync(path.join(libraryDir, skillName, "SKILL.md"))
    ? libraryDir
    : fs.existsSync(path.join(globalDir, skillName, "SKILL.md"))
      ? globalDir
      : undefined;
  if (!sourceRoot) {
    return "missing";
  }

  const destRoot = path.join(target, ".claude", "skills");
  const status = copySkill(skillName, sourceRoot, destRoot, opts?.force ?? true, false, { libraryDir });
  return status === "installed" || status === "skipped-exists" ? "installed" : "skipped";
}

export async function upgradeOutdatedSkills(
  libraryDir: string,
  target: string,
  skillNames?: string[]
): Promise<string[]> {
  const outdated = listOutdatedSkills(libraryDir, target);
  const names = skillNames?.length ? skillNames : outdated.map((s) => s.name);
  const upgraded: string[] = [];
  for (const name of names) {
    const result = await upgradeSkillInWorkspace(libraryDir, target, name);
    if (result === "installed") {
      upgraded.push(name);
    }
  }
  return upgraded;
}

export function formatOutdatedSkillsLines(statuses: SkillVersionStatus[]): string[] {
  const outdated = statuses.filter((s) => s.outdated);
  if (outdated.length === 0) {
    return [];
  }
  const lines = ["## Outdated skills", ""];
  for (const s of outdated) {
    const note = s.changelog ? ` — ${s.changelog}` : "";
    lines.push(`- **${s.name}** \`${s.installedVersion}\` → \`${s.catalogVersion}\`${note}`);
  }
  lines.push("", "Run **Claude Skills: Upgrade Outdated Skills** to reinstall from the library.", "");
  return lines;
}

export function stampMissingVersionSidecars(libraryDir: string, target: string): number {
  const manifest = loadManifest(libraryDir);
  let stamped = 0;
  for (const name of listInstalledSkills(target)) {
    const skillDir = path.join(target, ".claude", "skills", name);
    if (readSkillVersionSidecar(skillDir)) {
      continue;
    }
    const rule = manifest.skills[name];
    writeSkillVersionSidecar(skillDir, skillCatalogVersion(rule), rule?.changelog);
    stamped++;
  }
  return stamped;
}
