import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  copySkill,
  globalSkillsDir,
  readSkillOverrides,
  removeSkill,
  setSkillOverride,
  SkillOverrideValue,
} from "./skillOps";
import { listInstalledSkills } from "./usageStats";

export interface BranchSkillProfile {
  branch: string;
  /** Skill directories present in <workspace>/.claude/skills/ when saved. */
  skills: string[];
  /** Personal overrides from settings.local.json at save time. */
  skillOverrides: Record<string, SkillOverrideValue>;
  headCommit?: string;
  updatedAt: string;
  workspacePath: string;
  remoteUrl?: string;
}

interface RepoProfiles {
  remoteUrl?: string;
  workspacePath: string;
  branches: Record<string, BranchSkillProfile>;
  lastBranch?: string;
}

interface BranchProfilesStore {
  version: 1;
  repos: Record<string, RepoProfiles>;
}

export const BRANCH_PROFILES_PATH = path.join(os.homedir(), ".claude", "learning", "branch-profiles.json");

interface GitHead {
  name?: string;
  commit?: string;
}

interface GitRemote {
  name: string;
  fetchUrl?: string;
  pushUrl?: string;
}

interface GitRepository {
  rootUri: { fsPath: string };
  state: {
    HEAD?: GitHead;
    remotes: GitRemote[];
  };
}

interface GitApi {
  repositories: GitRepository[];
}

function readStore(): BranchProfilesStore {
  if (!fs.existsSync(BRANCH_PROFILES_PATH)) {
    return { version: 1, repos: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(BRANCH_PROFILES_PATH, "utf-8")) as BranchProfilesStore;
    return { version: 1, repos: parsed.repos ?? {} };
  } catch {
    return { version: 1, repos: {} };
  }
}

function writeStore(store: BranchProfilesStore): void {
  fs.mkdirSync(path.dirname(BRANCH_PROFILES_PATH), { recursive: true });
  fs.writeFileSync(BRANCH_PROFILES_PATH, JSON.stringify(store, null, 2) + "\n", "utf-8");
}

function getGitApi(): GitApi | undefined {
  const ext = vscode.extensions.getExtension<{ getAPI(version: number): GitApi }>("vscode.git");
  if (!ext) {
    return undefined;
  }
  try {
    return ext.isActive ? ext.exports.getAPI(1) : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort git repo for a workspace folder (undefined if not a git repo). */
export function getGitRepository(target: string): GitRepository | undefined {
  const api = getGitApi();
  if (!api) {
    return undefined;
  }
  const normalized = path.normalize(target);
  return api.repositories.find((repo) => {
    const root = path.normalize(repo.rootUri.fsPath);
    return normalized === root || normalized.startsWith(root + path.sep);
  });
}

export function getCurrentBranch(target: string): string | undefined {
  const repo = getGitRepository(target);
  return repo?.state.HEAD?.name;
}

function originRemoteUrl(repo: GitRepository): string | undefined {
  const origin = repo.state.remotes.find((r) => r.name === "origin");
  return origin?.fetchUrl ?? origin?.pushUrl;
}

/** Stable key for a repo — prefers origin URL, falls back to workspace path. */
export function repoKeyFor(target: string): string | undefined {
  const repo = getGitRepository(target);
  if (!repo) {
    return undefined;
  }
  const remote = originRemoteUrl(repo);
  const basis = remote ?? path.normalize(repo.rootUri.fsPath);
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

function branchProfilesEnabled(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.branchProfiles").get<boolean>("enabled", true);
}

function autoApplyOnSwitch(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.branchProfiles").get<boolean>("autoApplyOnSwitch", true);
}

function removeExtraOnApply(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.branchProfiles").get<boolean>("removeExtraOnApply", false);
}

/** Capture the current workspace skill layout for the active git branch. */
export function captureBranchProfile(target: string): BranchSkillProfile | undefined {
  const repo = getGitRepository(target);
  const branch = repo?.state.HEAD?.name;
  if (!branch) {
    return undefined;
  }

  return {
    branch,
    skills: listInstalledSkills(target),
    skillOverrides: { ...readSkillOverrides(target) },
    headCommit: repo?.state.HEAD?.commit,
    updatedAt: new Date().toISOString(),
    workspacePath: path.normalize(target),
    remoteUrl: repo ? originRemoteUrl(repo) : undefined,
  };
}

/** Persist the active branch profile to ~/.claude/learning/branch-profiles.json. */
export function saveBranchProfile(target: string): BranchSkillProfile | undefined {
  if (!branchProfilesEnabled()) {
    return undefined;
  }
  const key = repoKeyFor(target);
  const profile = captureBranchProfile(target);
  if (!key || !profile) {
    return undefined;
  }

  const store = readStore();
  const repo = store.repos[key] ?? {
    remoteUrl: profile.remoteUrl,
    workspacePath: profile.workspacePath,
    branches: {},
  };
  repo.remoteUrl = profile.remoteUrl ?? repo.remoteUrl;
  repo.workspacePath = profile.workspacePath;
  repo.branches[profile.branch] = profile;
  repo.lastBranch = profile.branch;
  store.repos[key] = repo;
  writeStore(store);
  return profile;
}

export function loadBranchProfile(target: string, branch: string): BranchSkillProfile | undefined {
  const key = repoKeyFor(target);
  if (!key) {
    return undefined;
  }
  return readStore().repos[key]?.branches[branch];
}

export interface ApplyProfileResult {
  installed: string[];
  removed: string[];
  overridesApplied: number;
  skipped: string[];
}

/** Reconcile workspace skills with a saved branch profile. */
export function applyBranchProfile(
  libraryDir: string,
  target: string,
  profile: BranchSkillProfile,
  opts?: { removeExtra?: boolean }
): ApplyProfileResult {
  const removeExtra = opts?.removeExtra ?? removeExtraOnApply();
  const destRoot = path.join(target, ".claude", "skills");
  const globalDir = globalSkillsDir();
  const installed = new Set(listInstalledSkills(target));
  const desired = new Set(profile.skills);
  const result: ApplyProfileResult = { installed: [], removed: [], overridesApplied: 0, skipped: [] };

  for (const skill of profile.skills) {
    if (installed.has(skill)) {
      continue;
    }
    const sourceRoot = fs.existsSync(path.join(globalDir, skill, "SKILL.md"))
      ? globalDir
      : fs.existsSync(path.join(libraryDir, skill, "SKILL.md"))
        ? libraryDir
        : undefined;
    if (!sourceRoot) {
      result.skipped.push(skill);
      continue;
    }
    const status = copySkill(skill, sourceRoot, destRoot, false, false);
    if (status === "installed" || status === "skipped-exists") {
      result.installed.push(skill);
      installed.add(skill);
    } else {
      result.skipped.push(skill);
    }
  }

  if (removeExtra) {
    for (const skill of [...installed]) {
      if (!desired.has(skill)) {
        if (removeSkill(destRoot, skill)) {
          result.removed.push(skill);
        }
      }
    }
  }

  const currentOverrides = readSkillOverrides(target);
  const profileOverrides = profile.skillOverrides ?? {};

  for (const [skill, value] of Object.entries(profileOverrides)) {
    if (currentOverrides[skill] !== value) {
      setSkillOverride(target, skill, value);
      result.overridesApplied++;
    }
  }

  if (removeExtra) {
    for (const skill of Object.keys(currentOverrides)) {
      if (!(skill in profileOverrides)) {
        setSkillOverride(target, skill, undefined);
        result.overridesApplied++;
      }
    }
  }

  return result;
}

export function listRepoBranchProfiles(target: string): BranchSkillProfile[] {
  const key = repoKeyFor(target);
  if (!key) {
    return [];
  }
  const branches = readStore().repos[key]?.branches ?? {};
  return Object.values(branches).sort((a, b) => a.branch.localeCompare(b.branch));
}

export function formatBranchProfilesReport(target: string): string {
  const profiles = listRepoBranchProfiles(target);
  const current = getCurrentBranch(target);
  const key = repoKeyFor(target);

  if (!key) {
    return "No git repository detected for this workspace — branch profiles require git.";
  }
  if (profiles.length === 0) {
    return `No saved branch skill profiles for this repo (key: ${key}). Install skills or run "Save Branch Skill Profile".`;
  }

  const lines = [
    `# Branch skill profiles`,
    ``,
    `Repo key: \`${key}\``,
    `Current branch: \`${current ?? "(detached)"}\``,
    `Store: \`${BRANCH_PROFILES_PATH}\``,
    ``,
    `| Branch | Skills | Overrides | Last updated | Commit |`,
    `|---|---|---|---|---|`,
  ];

  for (const p of profiles) {
    const marker = p.branch === current ? " (current)" : "";
    lines.push(
      `| ${p.branch}${marker} | ${p.skills.length} | ${Object.keys(p.skillOverrides).length} | ${p.updatedAt.slice(0, 16).replace("T", " ")} | ${p.headCommit?.slice(0, 7) ?? "-"} |`
    );
  }

  lines.push("", "## Detail", "");
  for (const p of profiles) {
    lines.push(`### ${p.branch}${p.branch === current ? " (current)" : ""}`);
    lines.push(`- Skills: ${p.skills.length ? p.skills.join(", ") : "(none)"}`);
    const overrideEntries = Object.entries(p.skillOverrides);
    lines.push(
      `- Overrides: ${overrideEntries.length ? overrideEntries.map(([k, v]) => `${k}=${v}`).join(", ") : "(none)"}`
    );
    lines.push("");
  }

  return lines.join("\n");
}

let lastKnownBranch: string | undefined;

/** Call on extension activate and after git branch changes. */
export async function handleBranchChange(
  libraryDir: string,
  target: string,
  log: (line: string) => void
): Promise<void> {
  if (!branchProfilesEnabled()) {
    return;
  }

  const branch = getCurrentBranch(target);
  if (!branch) {
    return;
  }

  if (lastKnownBranch === undefined) {
    lastKnownBranch = branch;
    if (!loadBranchProfile(target, branch)) {
      saveBranchProfile(target);
      log(`Initialized branch skill profile for \`${branch}\`.`);
    }
    return;
  }

  if (lastKnownBranch === branch) {
    return;
  }

  const previous = lastKnownBranch;
  lastKnownBranch = branch;
  log(`Git branch changed: \`${previous}\` -> \`${branch}\` (leaving-branch profile was saved on last skill edit).`);

  const incoming = loadBranchProfile(target, branch);
  if (!incoming) {
    log(`No saved skill profile for \`${branch}\` — using git checkout state. Saving snapshot now.`);
    saveBranchProfile(target);
    return;
  }

  if (!autoApplyOnSwitch()) {
    log(`Switched to \`${branch}\` — profile available (${incoming.skills.length} skill(s)). Run "Apply Branch Skill Profile" to restore.`);
    return;
  }

  const result = applyBranchProfile(libraryDir, target, incoming);
  log(
    `Switched to \`${branch}\` — applied profile: +${result.installed.length} skill(s)` +
      (result.removed.length ? `, -${result.removed.length} removed` : "") +
      (result.overridesApplied ? `, ${result.overridesApplied} override(s)` : "") +
      (result.skipped.length ? `, skipped: ${result.skipped.join(", ")}` : "") +
      "."
  );

  if (result.installed.length > 0 || result.removed.length > 0) {
    vscode.window.showInformationMessage(
      `Claude Skills: restored ${branch} profile (${result.installed.length} installed, ${result.removed.length} removed).`
    );
  }
}

export function resetBranchTracking(): void {
  lastKnownBranch = undefined;
}

export function initBranchTracking(target: string | undefined): void {
  lastKnownBranch = target ? getCurrentBranch(target) : undefined;
}
