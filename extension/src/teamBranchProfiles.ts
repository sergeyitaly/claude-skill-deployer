import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  applyBranchProfile,
  ApplyProfileResult,
  BranchSkillProfile,
  captureBranchProfile,
  getCurrentBranch,
} from "./branchProfiles";
import { SkillOverrideValue } from "./skillOps";

export interface TeamBranchEntry {
  skills: string[];
  skillOverrides?: Record<string, SkillOverrideValue>;
  updatedAt?: string;
  note?: string;
}

export interface TeamSkillsProfileFile {
  version: 1;
  /** Optional repo label for humans. */
  name?: string;
  branches: Record<string, TeamBranchEntry>;
}

export function teamProfileRelativePath(): string {
  return vscode.workspace.getConfiguration("claudeSkills.branchProfiles").get<string>("teamProfilePath", ".claude/skills-profile.json");
}

export function teamProfileAbsolutePath(target: string): string {
  return path.join(target, teamProfileRelativePath());
}

export function loadTeamSkillsProfile(target: string): TeamSkillsProfileFile | undefined {
  const file = teamProfileAbsolutePath(target);
  if (!fs.existsSync(file)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as TeamSkillsProfileFile;
    if (parsed.version !== 1 || !parsed.branches) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function saveTeamSkillsProfile(target: string, profile: TeamSkillsProfileFile): string {
  const file = teamProfileAbsolutePath(target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(profile, null, 2) + "\n", "utf-8");
  return file;
}

/** Export current branch effective skills into the team profile file (commit to git). */
export function exportTeamBranchProfile(target: string, libraryDir?: string): TeamSkillsProfileFile | undefined {
  const branch = getCurrentBranch(target);
  if (!branch) {
    return undefined;
  }
  const captured = captureBranchProfile(target, libraryDir);
  if (!captured) {
    return undefined;
  }

  const existing = loadTeamSkillsProfile(target) ?? { version: 1 as const, branches: {} };
  existing.branches[branch] = {
    skills: captured.skills,
    skillOverrides: captured.skillOverrides,
    updatedAt: new Date().toISOString(),
    note: "Exported from Claude Skills Manager — commit this file for team parity.",
  };
  saveTeamSkillsProfile(target, existing);
  return existing;
}

export function teamBranchProfileToApply(branch: string, team: TeamSkillsProfileFile): BranchSkillProfile | undefined {
  const entry = team.branches[branch];
  if (!entry) {
    return undefined;
  }
  return {
    branch,
    skills: entry.skills,
    skillOverrides: entry.skillOverrides ?? {},
    updatedAt: entry.updatedAt ?? new Date().toISOString(),
    workspacePath: "",
  };
}

/** Apply team profile from git for the current branch (baseline before personal profile). */
export function applyTeamBranchProfile(
  libraryDir: string,
  target: string,
  branch?: string
): ApplyProfileResult | undefined {
  const team = loadTeamSkillsProfile(target);
  if (!team) {
    return undefined;
  }
  const b = branch ?? getCurrentBranch(target);
  if (!b) {
    return undefined;
  }
  const profile = teamBranchProfileToApply(b, team);
  if (!profile) {
    return undefined;
  }
  profile.workspacePath = path.normalize(target);
  return applyBranchProfile(libraryDir, target, profile, { removeExtra: false });
}

export function formatTeamProfileReport(target: string): string {
  const team = loadTeamSkillsProfile(target);
  const rel = teamProfileRelativePath();
  if (!team) {
    return `No team profile at ${rel}. Use Export Team Branch Profile to create one.`;
  }
  const lines = [`Team profile: ${rel}`, `Branches: ${Object.keys(team.branches).length}`, ""];
  for (const [branch, entry] of Object.entries(team.branches).sort()) {
    lines.push(`- ${branch}: ${entry.skills.length} skill(s)${entry.note ? ` — ${entry.note}` : ""}`);
  }
  lines.push("", "Commit this file so teammates get the same skill layout on branch switch.");
  return lines.join("\n");
}
