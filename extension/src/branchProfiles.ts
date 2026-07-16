import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { shouldSyncWorkspaceToAll, syncWorkspaceSkillsToAllAgents } from "./agentOps";
import { tierForSkill, estimateSessionCostUsd, formatCompactUsd } from "./skillCost";
import {
  copySkill,
  globalSkillsDir,
  isSkillCommittedOnBranch,
  listEffectiveEnabledSkills,
  loadManifest,
  Manifest,
  markSkillAsPersonalLocal,
  readSkillOverrides,
  removeSkill,
  setSkillOverride,
  SkillOverrideValue,
} from "./skillOps";
import { listInstalledSkills } from "./usageStats";

export interface BranchForecast {
  estimatedDailyCost: number;
  estimatedWeeklyCost: number;
  riskLevel: "low" | "medium" | "high";
  suggestion?: string;
}

export interface BranchSkillProfile {
  branch: string;
  /** Skills enabled for this user on this branch (excludes skillOverrides "off"). */
  skills: string[];
  forecast?: BranchForecast;
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

let cachedGitApi: GitApi | undefined;

/** Called after vscode.git activates so sync git lookups work. */
export function setGitApiCache(api: GitApi | undefined): void {
  cachedGitApi = api;
}

export interface FilesystemGitInfo {
  root: string;
  branch?: string;
  originUrl?: string;
}

function readStore(): BranchProfilesStore {
  if (!fs.existsSync(BRANCH_PROFILES_PATH)) {
    return { version: 1, repos: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(BRANCH_PROFILES_PATH, "utf-8")) as BranchProfilesStore;
    return { version: 1, repos: parsed.repos ?? {} };
  } catch {
    // Preserve the corrupt file instead of letting the next writeStore() silently
    // overwrite it (and every other repo's saved profiles) with an empty store.
    try {
      fs.renameSync(BRANCH_PROFILES_PATH, `${BRANCH_PROFILES_PATH}.corrupt-${Date.now()}`);
    } catch {
      // best-effort
    }
    return { version: 1, repos: {} };
  }
}

function writeStore(store: BranchProfilesStore): void {
  const dir = path.dirname(BRANCH_PROFILES_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.branch-profiles.json.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpPath, BRANCH_PROFILES_PATH);
}

function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * branch-profiles.json is shared machine-wide across every project — saveBranchProfile()
 * is its only writer, but a plain read-mutate-write is a classic cross-process race: two
 * different projects' extension-host processes can both read the store before either
 * writes, and the second write silently clobbers the first project's just-saved entry
 * (the atomic rename in writeStore prevents corruption, not this kind of lost update).
 * Serializes access with a real cross-process mutex via exclusive file creation ("wx"
 * fails with EEXIST if the lock already exists, which is atomic at the OS level on both
 * Windows and POSIX) — not the acquireWriteLock/fileWriteCoordination.ts primitive, which
 * only arbitrates between different kinds of owners (e.g. "hook" vs "extension"), not
 * multiple processes that are all this same "extension" owner.
 */
/** Exported for testing the cross-process mutex directly; not part of the public API used
 * by other modules — saveBranchProfile() is the only production caller. */
export function withBranchProfilesLock<T>(fn: () => T): T {
  const lockPath = `${BRANCH_PROFILES_PATH}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const start = Date.now();
  const maxWaitMs = 2000;
  const staleAfterMs = 5000;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockPath, "wx"));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > staleAfterMs) {
          fs.unlinkSync(lockPath); // owning process likely crashed/was killed — steal it
          continue;
        }
      } catch {
        continue; // lock disappeared between checks — retry acquire immediately
      }
      if (Date.now() - start > maxWaitMs) {
        break; // give up waiting rather than hang the extension host; proceed unlocked
      }
      sleepSyncMs(25);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // already removed (e.g. stolen as stale) — fine
    }
  }
}

function getGitApi(): GitApi | undefined {
  if (cachedGitApi) {
    return cachedGitApi;
  }
  try {
    const ext = vscode.extensions?.getExtension<{ getAPI(version: number): GitApi }>("vscode.git");
    if (!ext?.isActive) {
      return undefined;
    }
    cachedGitApi = ext.exports.getAPI(1);
    return cachedGitApi;
  } catch {
    return undefined;
  }
}

function gitCommand(root: string, args: string): string | undefined {
  try {
    const out = execFileSync("git", ["-C", root, ...args.split(" ")], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** Fallback when vscode.git API is not ready (common on extension activate). */
export function detectGitFromFilesystem(target: string): FilesystemGitInfo | undefined {
  const root = gitCommand(path.resolve(target), "rev-parse --show-toplevel");
  if (!root) {
    return undefined;
  }
  const branch = gitCommand(root, "rev-parse --abbrev-ref HEAD");
  const originUrl = gitCommand(root, "config --get remote.origin.url");
  return {
    root: path.normalize(root),
    branch: branch && branch !== "HEAD" ? branch : undefined,
    originUrl,
  };
}

/** Best-effort git repo for a workspace folder (undefined if not a git repo). */
export function getGitRepository(target: string): GitRepository | undefined {
  const api = getGitApi();
  if (api) {
    const normalized = path.normalize(target);
    const match = api.repositories.find((repo) => {
      const root = path.normalize(repo.rootUri.fsPath);
      return normalized === root || normalized.startsWith(root + path.sep);
    });
    if (match) {
      return match;
    }
  }
  const fsGit = detectGitFromFilesystem(target);
  if (!fsGit) {
    return undefined;
  }
  return {
    rootUri: { fsPath: fsGit.root },
    state: {
      HEAD: fsGit.branch ? { name: fsGit.branch } : undefined,
      remotes: fsGit.originUrl ? [{ name: "origin", fetchUrl: fsGit.originUrl }] : [],
    },
  };
}

export function getCurrentBranch(target: string): string | undefined {
  const repo = getGitRepository(target);
  if (repo?.state.HEAD?.name) {
    return repo.state.HEAD.name;
  }
  return detectGitFromFilesystem(target)?.branch;
}

export function isGitWorkspace(target: string): boolean {
  return getGitRepository(target) !== undefined;
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
  const remote = originRemoteUrl(repo) ?? detectGitFromFilesystem(target)?.originUrl;
  const basis = remote ?? path.normalize(repo.rootUri.fsPath);
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

export function branchProfilesFeatureActive(): boolean {
  return (
    vscode.workspace.getConfiguration("claudeSkills.features").get<boolean>("branchProfiles", true) &&
    branchProfilesEnabled()
  );
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

export function forecastForSkills(skillNames: string[], manifest: Manifest, sessionsPerDay = 2): BranchForecast {
  let daily = 0;
  let highCount = 0;
  for (const name of skillNames) {
    const tier = tierForSkill(manifest.skills[name]?.cost_estimate);
    daily += estimateSessionCostUsd(tier) * sessionsPerDay;
    if (tier === "high") {
      highCount++;
    }
  }
  const riskLevel: BranchForecast["riskLevel"] =
    highCount >= 2 ? "high" : highCount === 1 || daily > 1.5 ? "medium" : "low";
  const suggestion =
    highCount > 0
      ? `Branch uses ${highCount} high-tier skill(s) (~${formatCompactUsd(daily)}/day est.). Consider Cursor for diagramming or Economy mode.`
      : undefined;
  return {
    estimatedDailyCost: daily,
    estimatedWeeklyCost: daily * 5,
    riskLevel,
    suggestion,
  };
}

/** Capture the current workspace skill layout for the active git branch. */
export function captureBranchProfile(target: string, libraryDir?: string): BranchSkillProfile | undefined {
  const repo = getGitRepository(target);
  const branch = repo?.state.HEAD?.name;
  if (!branch) {
    return undefined;
  }

  const skills = listEffectiveEnabledSkills(target);
  const profile: BranchSkillProfile = {
    branch,
    skills,
    skillOverrides: { ...readSkillOverrides(target) },
    headCommit: repo?.state.HEAD?.commit,
    updatedAt: new Date().toISOString(),
    workspacePath: path.normalize(target),
    remoteUrl: repo ? originRemoteUrl(repo) : undefined,
  };
  if (libraryDir) {
    profile.forecast = forecastForSkills(skills, loadManifest(libraryDir));
  }
  return profile;
}

/** Persist the active branch profile to ~/.claude/learning/branch-profiles.json. */
export function saveBranchProfile(target: string, libraryDir?: string): BranchSkillProfile | undefined {
  if (!branchProfilesEnabled()) {
    return undefined;
  }
  const key = repoKeyFor(target);
  const profile = captureBranchProfile(target, libraryDir);
  if (!key || !profile) {
    return undefined;
  }

  withBranchProfilesLock(() => {
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
  });
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
  /** Branch-committed skills this call force-disabled via the disableUndesired sweep —
   * surfaced so callers can record them in taskSkillFocus's durable ledger; this function
   * has no ledger access of its own (see taskSkillFocus.ts:recordTaskFocusDisabled). */
  disabledUndesired: string[];
}

/** Mirrors taskSkillFocus.ts's taskSkillFocusEnabled() without importing it — taskSkillFocus.ts
 * already imports profileInit.ts, which calls applyBranchProfile(), so importing it back here
 * would create a require cycle. */
function taskFocusMasterSwitchEnabled(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.taskFocus").get<boolean>("enabled", true);
}

/** Reconcile workspace skills with a saved branch profile. */
export function applyBranchProfile(
  libraryDir: string,
  target: string,
  profile: BranchSkillProfile,
  opts?: { removeExtra?: boolean; disableUndesired?: boolean }
): ApplyProfileResult {
  const removeExtra = opts?.removeExtra ?? removeExtraOnApply();
  // Defaults to the task-focus master switch, not unconditional `true` — automatic/background
  // callers (branch-switch detection, team/agent profile sync, profile-init apply) must never
  // force-disable skills while claudeSkills.taskFocus.enabled is off. The one explicit user
  // command that restores a saved profile ("Apply Branch Skill Profile") passes
  // disableUndesired: true to opt back in, since an explicit restore request should still
  // restore in full.
  const disableUndesired = opts?.disableUndesired ?? taskFocusMasterSwitchEnabled();
  const destRoot = path.join(target, ".claude", "skills");
  const globalDir = globalSkillsDir();
  const installed = new Set(listInstalledSkills(target));
  const desired = new Set(profile.skills);
  const result: ApplyProfileResult = {
    installed: [],
    removed: [],
    overridesApplied: 0,
    skipped: [],
    disabledUndesired: [],
  };

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
    const status = copySkill(skill, sourceRoot, destRoot, false, false, { libraryDir });
    if (status === "installed" || status === "skipped-exists") {
      result.installed.push(skill);
      installed.add(skill);
      if (!isSkillCommittedOnBranch(target, skill)) {
        markSkillAsPersonalLocal(target, skill);
      }
    } else {
      result.skipped.push(skill);
    }
  }

  const currentOverrides = readSkillOverrides(target);
  const profileOverrides = profile.skillOverrides ?? {};

  for (const skill of [...installed]) {
    if (desired.has(skill)) {
      if (currentOverrides[skill] === "off") {
        setSkillOverride(target, skill, undefined);
        result.overridesApplied++;
      }
      continue;
    }
    if (isSkillCommittedOnBranch(target, skill)) {
      // disableUndesired=false lets a caller (e.g. session-proposal apply) install/refresh
      // a skill set via this same reconciliation machinery without force-disabling every
      // other installed skill outside it — that sweep is only correct for a genuine
      // branch-switch reconciliation, not "these are today's top proposals."
      if (disableUndesired && currentOverrides[skill] !== "off") {
        setSkillOverride(target, skill, "off");
        result.overridesApplied++;
        result.disabledUndesired.push(skill);
      }
      continue;
    }
    if (removeExtra) {
      const removed = removeSkill(destRoot, skill);
      if (removed) {
        result.removed.push(skill);
      }
    }
  }

  for (const [skill, value] of Object.entries(profileOverrides)) {
    if (currentOverrides[skill] === value) {
      continue;
    }
    // Reapplying a saved "off" is a disabling action with the same hazard as the
    // disableUndesired sweep above — this loop had no gate at all before, and was the
    // actual mechanism silently undoing reclaimOrphanedTaskFocusOverrides()'s work
    // (confirmed live, 2026-07-15 investigation). Reapplying "on" (or any other value)
    // never conflicts with task-focus, so only "off" needs the gate.
    if (value === "off" && !disableUndesired) {
      continue;
    }
    setSkillOverride(target, skill, value);
    result.overridesApplied++;
  }

  if (removeExtra) {
    for (const skill of Object.keys(currentOverrides)) {
      if (!(skill in profileOverrides)) {
        setSkillOverride(target, skill, undefined);
        result.overridesApplied++;
      }
    }
  }

  if (shouldSyncWorkspaceToAll()) {
    syncWorkspaceSkillsToAllAgents(libraryDir, target);
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
    if (p.forecast) {
      lines.push(
        `- Forecast: ~${formatCompactUsd(p.forecast.estimatedDailyCost)}/day, ~${formatCompactUsd(p.forecast.estimatedWeeklyCost)}/week (${p.forecast.riskLevel} risk)`
      );
      if (p.forecast.suggestion) {
        lines.push(`- Tip: ${p.forecast.suggestion}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

const _lastKnownBranchByTarget = new Map<string, string>();

export interface BranchChangeOptions {
  /** When set, called instead of auto-saving a snapshot for branches with no saved profile. */
  onNewBranchWithoutProfile?: (branch: string) => Promise<void>;
  /** Merge required platform skills into a saved branch profile before apply. */
  mergeProfileSkills?: (skills: string[]) => string[];
  /**
   * Reinstall missing required platform skills (e.g. accidental deletion).
   * Return true when anything was recovered or re-enabled.
   */
  recoverRequiredSkills?: (
    branch: string,
    context: { isFirstSync: boolean; hasSavedProfile: boolean }
  ) => Promise<boolean>;
}

async function maybeRecoverRequiredSkills(
  branch: string,
  hasSavedProfile: boolean,
  isFirstSync: boolean,
  opts: BranchChangeOptions | undefined,
  log: (line: string) => void
): Promise<void> {
  if (!opts?.recoverRequiredSkills) {
    return;
  }
  const recovered = await opts.recoverRequiredSkills(branch, { isFirstSync, hasSavedProfile });
  if (recovered) {
    log(`Recovered required platform skill(s) for \`${branch}\`.`);
  }
}

/** Call on extension activate and after git branch changes. */
export async function handleBranchChange(
  libraryDir: string,
  target: string,
  log: (line: string) => void,
  opts?: BranchChangeOptions
): Promise<void> {
  if (!branchProfilesEnabled()) {
    return;
  }

  const branch = getCurrentBranch(target);
  if (!branch) {
    return;
  }

  const _targetKey = path.normalize(target);
  const lastKnownBranch = _lastKnownBranchByTarget.get(_targetKey);

  if (lastKnownBranch === undefined) {
    _lastKnownBranchByTarget.set(_targetKey, branch);
    const hasSavedProfile = !!loadBranchProfile(target, branch);
    await maybeRecoverRequiredSkills(branch, hasSavedProfile, true, opts, log);
    if (!hasSavedProfile) {
      if (opts?.onNewBranchWithoutProfile) {
        await opts.onNewBranchWithoutProfile(branch);
      } else {
        saveBranchProfile(target);
        log(`Initialized branch skill profile for \`${branch}\`.`);
      }
    }
    return;
  }

  if (lastKnownBranch === branch) {
    return;
  }

  const previous = lastKnownBranch;
  _lastKnownBranchByTarget.set(_targetKey, branch);
  log(`Git branch changed: \`${previous}\` -> \`${branch}\` (leaving-branch profile was saved on last skill edit).`);

  const incoming = loadBranchProfile(target, branch);
  if (!incoming) {
    await maybeRecoverRequiredSkills(branch, false, false, opts, log);
    if (opts?.onNewBranchWithoutProfile) {
      log(`No saved skill profile for \`${branch}\` — offering profile init.`);
      await opts.onNewBranchWithoutProfile(branch);
      return;
    }
    log(`No saved skill profile for \`${branch}\` — using git checkout state. Saving snapshot now.`);
    saveBranchProfile(target);
    return;
  }

  if (!autoApplyOnSwitch()) {
    log(`Switched to \`${branch}\` — profile available (${incoming.skills.length} skill(s)). Run "Apply Branch Skill Profile" to restore.`);
    return;
  }

  const mergedSkills = opts?.mergeProfileSkills?.(incoming.skills) ?? incoming.skills;
  const profileToApply =
    mergedSkills === incoming.skills ? incoming : { ...incoming, skills: mergedSkills };
  const result = applyBranchProfile(libraryDir, target, profileToApply);
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

export function resetBranchTracking(target?: string): void {
  if (target) {
    _lastKnownBranchByTarget.delete(path.normalize(target));
  } else {
    _lastKnownBranchByTarget.clear();
  }
}

export function initBranchTracking(target: string | undefined): void {
  if (!target) return;
  const branch = getCurrentBranch(target);
  const key = path.normalize(target);
  if (branch) {
    _lastKnownBranchByTarget.set(key, branch);
  } else {
    _lastKnownBranchByTarget.delete(key);
  }
}
