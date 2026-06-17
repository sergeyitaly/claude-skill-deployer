import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { isFeatureEnabled } from "./featureFlags";
import { copySkill, removeSkill } from "./skillOps";
import { isValidSkillName } from "./skillLint";
import { SkillUsageStat } from "./usageStats";

export interface ArchivalRules {
  no_usage_days: number;
  cost_per_use: number;
  auto_archive: boolean;
}

export function archivalRules(): ArchivalRules {
  const cfg = vscode.workspace.getConfiguration("claudeSkills.archival");
  return {
    no_usage_days: cfg.get<number>("noUsageDays", 30),
    cost_per_use: cfg.get<number>("costPerUse", 2.0),
    auto_archive: cfg.get<boolean>("autoArchive", false),
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
  attributionCostPerUse: Map<string, number>
): string[] {
  if (!isFeatureEnabled("skillArchival")) {
    return [];
  }
  const rules = archivalRules();
  const out: string[] = [];
  for (const s of stats) {
    const idle = s.daysSinceLastUse ?? 999;
    const costPerUse = attributionCostPerUse.get(s.name) ?? 0;
    if (idle >= rules.no_usage_days) {
      out.push(s.name);
    } else if (costPerUse >= rules.cost_per_use && idle >= 14) {
      out.push(s.name);
    }
  }
  return out;
}

export function archiveSkill(target: string, skillName: string, libraryDir: string): boolean {
  if (!isValidSkillName(skillName)) {
    return false;
  }
  const src = path.join(target, ".claude", "skills", skillName);
  if (!fs.existsSync(src)) {
    return false;
  }
  const destRoot = archivedRoot(target);
  const dest = path.join(destRoot, skillName);
  fs.mkdirSync(destRoot, { recursive: true });
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.renameSync(src, dest);
  bumpPatchVersion(dest);
  removeSkill(path.join(target, ".claude", "skills"), skillName);
  const meta = {
    archivedAt: new Date().toISOString(),
    from: src,
    libraryDir,
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
    fs.renameSync(src, dest);
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
