import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  applyBranchProfile,
  ApplyProfileResult,
  BranchSkillProfile,
  captureBranchProfile,
  getCurrentBranch,
  loadBranchProfile,
  saveBranchProfile,
} from "./branchProfiles";
import { installProfileInitSessionHook } from "./hookOps";
import { shouldSyncWorkspaceToAll, syncWorkspaceSkillsToAllAgents } from "./agentOps";
import { copySkill, ensureGitExcludeEntry, listSkillStatuses, readSkillOverrides, SkillStatus } from "./skillOps";
import { ensureLearningDir, listInstalledSkills } from "./usageStats";
import {
  readJsonFile,
  writeCoordinatedJson,
  writeJsonAtomic,
  acquireWriteLock,
  releaseWriteLock,
} from "./fileWriteCoordination";

export const POSITION_OPTIONS = [
  { id: "devops", label: "DevOps" },
  { id: "qa", label: "QA" },
  { id: "aqa", label: "AQA" },
  { id: "backend-developer", label: "Backend Developer" },
  { id: "frontend-developer", label: "Frontend Developer" },
  { id: "ba", label: "BA" },
  { id: "resource-manager", label: "Resource Manager" },
  { id: "team-lead", label: "Team Lead" },
] as const;

export type PositionRole = (typeof POSITION_OPTIONS)[number]["id"];

export interface UserPosition {
  version: 1;
  role: PositionRole;
  label: string;
  setAt: string;
}

export interface SkillsCatalogEntry {
  name: string;
  description: string;
  detectGlobs: string[];
  costEstimate?: string;
  isRelevant: boolean;
  matchedGlobs: string[];
  installedInWorkspace: boolean;
  availableInGlobal: boolean;
  inLibrary: boolean;
  /** Included in every profile-init apply (extension platform skills). */
  requiredForProfileInit?: boolean;
}

export interface SkillsCatalog {
  version: 1;
  generatedAt: string;
  workspacePath: string;
  branch?: string;
  skills: SkillsCatalogEntry[];
}

export interface BranchProfileInit {
  version: 1;
  branch: string;
  role: PositionRole;
  roleLabel: string;
  skills: string[];
  rationale?: Record<string, string>;
  initBy: "agent" | "manual";
  status: "pending" | "applied";
  createdAt: string;
  appliedAt?: string;
}

export interface ProfileInitRequest {
  version: 1;
  requestedAt: string;
  branch: string;
  position: UserPosition;
  catalogPath: string;
  outputPath: string;
  relevantSkillNames: string[];
  requiredSkillNames: string[];
  skillCount: number;
  status: "pending" | "completed";
  agentInstructions: string;
}

const LOCAL_PATHS = [
  ".claude/position.local.json",
  ".claude/profile.local.json",
  ".claude/learning/skills-catalog.json",
  ".claude/learning/profile-init-request.json",
] as const;

export const PROFILE_INIT_SKILL = "profile-init";

/** Always active after profile init — extension platform / skill-management skills. */
export const DEFAULT_PROFILE_INIT_REQUIRED_SKILLS = [
  "self-learning",
  "file-style-conventions",
  "skill-creator",
  "skill-usage-insights",
  "skill-feedback-adaptation",
  "skill-official-updater",
] as const;

export function profileInitRequiredSkills(): string[] {
  const cfg = vscode.workspace.getConfiguration("claudeSkills.profileInit");
  const configured = cfg.get<string[]>("requiredSkills");
  if (Array.isArray(configured) && configured.length > 0) {
    return [...new Set(configured.map((s) => s.trim()).filter(Boolean))];
  }
  return [...DEFAULT_PROFILE_INIT_REQUIRED_SKILLS];
}

/** Merge role/branch picks with required platform skills (required first, deduped). */
export function mergeProfileInitSkills(selected: string[]): string[] {
  const required = profileInitRequiredSkills();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [...required, ...selected]) {
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    out.push(name);
  }
  return out;
}

export interface RequiredSkillRecoveryResult {
  recovered: string[];
  reEnabled: string[];
  skipped: string[];
}

export function recoverRequiredSkillsOnNewBranchEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("claudeSkills.profileInit")
    .get<boolean>("recoverRequiredSkillsOnNewBranch", true);
}

/** Required platform skills missing from disk or locally disabled via skillOverrides. */
export function findMissingRequiredProfileSkills(target: string): string[] {
  const required = profileInitRequiredSkills();
  const installed = new Set(listInstalledSkills(target));
  const overrides = readSkillOverrides(target);
  return required.filter((name) => !installed.has(name) || overrides[name] === "off");
}

/** Reinstall missing required platform skills from library/global (no branch profile save). */
export function recoverRequiredProfileSkills(
  libraryDir: string,
  target: string
): RequiredSkillRecoveryResult {
  const missing = findMissingRequiredProfileSkills(target);
  const result: RequiredSkillRecoveryResult = { recovered: [], reEnabled: [], skipped: [] };
  if (missing.length === 0) {
    return result;
  }

  const installedBefore = new Set(listInstalledSkills(target));
  const overridesBefore = readSkillOverrides(target);
  const branch = getCurrentBranch(target) ?? "";
  const applyResult = applyBranchProfile(
    libraryDir,
    target,
    {
      branch,
      skills: missing,
      skillOverrides: {},
      updatedAt: new Date().toISOString(),
      workspacePath: path.normalize(target),
    },
    { removeExtra: false }
  );

  for (const name of missing) {
    if (applyResult.skipped.includes(name)) {
      result.skipped.push(name);
      continue;
    }
    if (!installedBefore.has(name) && applyResult.installed.includes(name)) {
      result.recovered.push(name);
    }
    if (overridesBefore[name] === "off") {
      result.reEnabled.push(name);
    }
  }

  return result;
}

export function positionLocalPath(target: string): string {
  return path.join(target, ".claude", "position.local.json");
}

export function profileLocalPath(target: string): string {
  return path.join(target, ".claude", "profile.local.json");
}

export function skillsCatalogPath(target: string): string {
  return path.join(target, ".claude", "learning", "skills-catalog.json");
}

export function profileInitRequestPath(target: string): string {
  return path.join(target, ".claude", "learning", "profile-init-request.json");
}

export function profileInitEnabled(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.profileInit").get<boolean>("enabled", true);
}

export function promptOnNewBranchEnabled(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.profileInit").get<boolean>("promptOnNewBranch", true);
}

export function autoStartOnSessionEnabled(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.profileInit").get<boolean>("autoStartOnSession", true);
}

export function profileInitRequestPending(target: string): boolean {
  const request = readProfileInitRequest(target);
  if (!request || request.status === "completed") {
    return false;
  }
  const profile = readBranchProfileInit(target);
  if (profile?.status === "applied" && profile.skills.length > 0) {
    return false;
  }
  return true;
}

export function markProfileInitRequestCompleted(target: string): void {
  const request = readProfileInitRequest(target);
  if (!request) {
    return;
  }
  writeJsonAtomic(profileInitRequestPath(target), { ...request, status: "completed" as const });
}

function buildAgentInstructions(
  branch: string,
  position: UserPosition,
  relevantSkillNames: string[],
  requiredSkillNames: string[]
): string {
  const relevant =
    relevantSkillNames.length > 0
      ? `Prioritize workspace-relevant skills: ${relevantSkillNames.join(", ")}.`
      : "No detect_globs matches yet — choose from catalog descriptions and branch context.";
  return [
    "Read and follow the profile-init skill immediately — do not wait for the user to ask.",
    `Pick skills for git branch "${branch}" as a ${position.label}.`,
    `Always include these required platform skills in skills[] (mandatory): ${requiredSkillNames.join(", ")}.`,
    relevant,
    "Add role/branch-specific skills on top of the required set (often 5–15 total).",
    "Write .claude/profile.local.json with status \"pending\" and skills[] from the catalog.",
    "The extension auto-installs when the file is saved (required skills are merged even if omitted).",
  ].join(" ");
}

export function autoApplyProfileFileEnabled(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.profileInit").get<boolean>("autoApplyProfileFile", true);
}

/** Install SessionStart hook and sync profile-init skill to enabled agents. */
export function ensureProfileInitSessionReady(
  extensionPath: string,
  libraryDir: string,
  target: string,
  log: (line: string) => void
): void {
  if (!profileInitEnabled() || !autoStartOnSessionEnabled() || !profileInitRequestPending(target)) {
    return;
  }
  const hookStatus = installProfileInitSessionHook(extensionPath, target);
  if (hookStatus === "installed" || hookStatus === "updated") {
    log(`Profile init SessionStart hook ${hookStatus}.`);
  }
  if (shouldSyncWorkspaceToAll()) {
    const synced = syncWorkspaceSkillsToAllAgents(libraryDir, target, { force: true });
    if (synced.length > 0) {
      log(`Synced profile-init to ${synced.length} agent path(s).`);
    }
  }
}

const PROFILE_LOCAL_KEY = "profile.local.json";
const PROFILE_REQUEST_KEY = "profile-init-request.json";

/** Gitignore local profile-init artifacts via .git/info/exclude. */
export function ensureProfileInitGitIgnored(target: string): void {
  for (const rel of LOCAL_PATHS) {
    ensureGitExcludeEntry(target, rel);
  }
}

export function writeBranchProfileInit(target: string, profile: BranchProfileInit): void {
  ensureProfileInitGitIgnored(target);
  writeCoordinatedJson(target, profileLocalPath(target), PROFILE_LOCAL_KEY, "extension", profile);
}

export function readUserPosition(target: string): UserPosition | undefined {
  const parsed = readJsonFile<UserPosition>(positionLocalPath(target));
  if (!parsed || parsed.version !== 1 || !parsed.role) {
    return undefined;
  }
  return parsed;
}

export function writeUserPosition(target: string, role: PositionRole): UserPosition {
  ensureProfileInitGitIgnored(target);
  const label = POSITION_OPTIONS.find((o) => o.id === role)?.label ?? role;
  const position: UserPosition = {
    version: 1,
    role,
    label,
    setAt: new Date().toISOString(),
  };
  writeJsonAtomic(positionLocalPath(target), position);
  return position;
}

function statusToCatalogEntry(s: SkillStatus, requiredNames: Set<string>): SkillsCatalogEntry {
  return {
    name: s.name,
    description: s.description,
    detectGlobs: s.detectGlobs,
    costEstimate: undefined,
    isRelevant: s.isRelevant,
    matchedGlobs: s.matchedGlobs,
    installedInWorkspace: s.installedInWorkspace,
    availableInGlobal: s.availableInGlobal,
    inLibrary: s.inLibrary,
    requiredForProfileInit: requiredNames.has(s.name),
  };
}

/** Snapshot of skills the extension knows about (library + project-local). */
export function refreshSkillsCatalog(target: string, libraryDir: string): SkillsCatalog {
  ensureLearningDir(target);
  ensureProfileInitGitIgnored(target);
  const requiredNames = new Set(profileInitRequiredSkills());
  const catalog: SkillsCatalog = {
    version: 1,
    generatedAt: new Date().toISOString(),
    workspacePath: path.normalize(target),
    branch: getCurrentBranch(target),
    skills: listSkillStatuses(libraryDir, target).map((s) => statusToCatalogEntry(s, requiredNames)),
  };
  writeJsonAtomic(skillsCatalogPath(target), catalog);
  return catalog;
}

export function readBranchProfileInit(target: string): BranchProfileInit | undefined {
  const parsed = readJsonFile<BranchProfileInit>(profileLocalPath(target));
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.skills)) {
    return undefined;
  }
  return parsed;
}

export function readProfileInitRequest(target: string): ProfileInitRequest | undefined {
  const parsed = readJsonFile<ProfileInitRequest>(profileInitRequestPath(target));
  if (!parsed || parsed.version !== 1) {
    return undefined;
  }
  if (!parsed.status) {
    parsed.status = "pending";
  }
  return parsed;
}

export function buildProfileInitRequest(
  target: string,
  libraryDir: string,
  position: UserPosition,
  branch: string
): ProfileInitRequest {
  const catalog = refreshSkillsCatalog(target, libraryDir);
  const relevantSkillNames = catalog.skills.filter((s) => s.isRelevant).map((s) => s.name);
  const requiredSkillNames = profileInitRequiredSkills();
  const request: ProfileInitRequest = {
    version: 1,
    requestedAt: new Date().toISOString(),
    branch,
    position,
    catalogPath: ".claude/learning/skills-catalog.json",
    outputPath: ".claude/profile.local.json",
    relevantSkillNames,
    requiredSkillNames,
    skillCount: catalog.skills.length,
    status: "pending",
    agentInstructions: buildAgentInstructions(branch, position, relevantSkillNames, requiredSkillNames),
  };
  writeCoordinatedJson(target, profileInitRequestPath(target), PROFILE_REQUEST_KEY, "extension", request);
  return request;
}

export function validateProfileSkills(
  skills: string[],
  catalog: SkillsCatalog | undefined
): { valid: string[]; invalid: string[] } {
  if (!catalog) {
    return { valid: [...new Set(skills)], invalid: [] };
  }
  const known = new Set(catalog.skills.map((s) => s.name));
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const name of skills) {
    if (known.has(name)) {
      valid.push(name);
    } else {
      invalid.push(name);
    }
  }
  return { valid: [...new Set(valid)], invalid: [...new Set(invalid)] };
}

export function branchNeedsProfileInit(target: string, branch: string): boolean {
  if (!profileInitEnabled()) {
    return false;
  }
  return loadBranchProfile(target, branch) === undefined;
}

export function installProfileInitSkill(libraryDir: string, target: string): boolean {
  const destRoot = path.join(target, ".claude", "skills");
  const status = copySkill(PROFILE_INIT_SKILL, libraryDir, destRoot, false, false);
  return status === "installed" || status === "skipped-exists";
}

export function profileInitToBranchProfile(
  init: BranchProfileInit,
  target: string
): BranchSkillProfile {
  return {
    branch: init.branch,
    skills: mergeProfileInitSkills(init.skills),
    skillOverrides: {},
    updatedAt: new Date().toISOString(),
    workspacePath: path.normalize(target),
  };
}

/** Apply agent-written profile.local.json and persist branch profile. */
export function applyLocalProfileInit(
  libraryDir: string,
  target: string,
  init?: BranchProfileInit
): { result?: ApplyProfileResult; init?: BranchProfileInit; invalid: string[] } {
  if (!acquireWriteLock(target, PROFILE_LOCAL_KEY, "extension")) {
    return { invalid: [] };
  }
  try {
    const profile = init ?? readBranchProfileInit(target);
    if (!profile) {
      return { invalid: [] };
    }
    if (profile.status === "applied") {
      return { invalid: [] };
    }
    if (!profile.skills.length) {
      return { invalid: [] };
    }

    const branch = getCurrentBranch(target);
    if (branch && profile.branch !== branch) {
      return { invalid: [] };
    }

    const catalog = readJsonFile<SkillsCatalog>(skillsCatalogPath(target));
    const mergedSkills = mergeProfileInitSkills(profile.skills);
    const { valid, invalid } = validateProfileSkills(mergedSkills, catalog);
    if (valid.length === 0) {
      return { invalid };
    }

    const toApply: BranchProfileInit = { ...profile, skills: valid };
    const branchProfile = profileInitToBranchProfile(toApply, target);
    const result = applyBranchProfile(libraryDir, target, branchProfile, { removeExtra: false });
    saveBranchProfile(target, libraryDir);

    const applied: BranchProfileInit = {
      ...toApply,
      status: "applied",
      appliedAt: new Date().toISOString(),
    };
    writeBranchProfileInit(target, applied);
    markProfileInitRequestCompleted(target);

    return { result, init: applied, invalid };
  } finally {
    releaseWriteLock(target, PROFILE_LOCAL_KEY, "extension");
  }
}

export function markProfileInitPending(
  target: string,
  branch: string,
  position: UserPosition
): BranchProfileInit {
  const pending: BranchProfileInit = {
    version: 1,
    branch,
    role: position.role,
    roleLabel: position.label,
    skills: [],
    initBy: "agent",
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  writeBranchProfileInit(target, pending);
  return pending;
}

export async function promptForPosition(target: string): Promise<UserPosition | undefined> {
  const existing = readUserPosition(target);
  if (existing) {
    const change = await vscode.window.showQuickPick(
      [
        { label: `Keep: ${existing.label}`, id: "keep" as const },
        ...POSITION_OPTIONS.map((o) => ({ label: o.label, id: o.id })),
      ],
      { title: "Your role on this team", placeHolder: "Select your position" }
    );
    if (!change) {
      return undefined;
    }
    if (change.id === "keep") {
      return existing;
    }
    return writeUserPosition(target, change.id as PositionRole);
  }

  const picked = await vscode.window.showQuickPick(
    POSITION_OPTIONS.map((o) => ({ label: o.label, id: o.id })),
    { title: "What is your position?", placeHolder: "Select your role (saved locally, not committed to git)" }
  );
  if (!picked) {
    return undefined;
  }
  return writeUserPosition(target, picked.id as PositionRole);
}

export async function startProfileInitFlow(
  extensionPath: string,
  libraryDir: string,
  target: string,
  branch: string,
  log: (line: string) => void
): Promise<boolean> {
  if (!profileInitEnabled()) {
    return false;
  }

  ensureProfileInitGitIgnored(target);
  const position = await promptForPosition(target);
  if (!position) {
    return false;
  }

  installProfileInitSkill(libraryDir, target);
  markProfileInitPending(target, branch, position);
  const request = buildProfileInitRequest(target, libraryDir, position, branch);
  ensureProfileInitSessionReady(extensionPath, libraryDir, target, log);

  log(`\n=== Profile init for branch \`${branch}\` ===`);
  log(`Position: ${position.label}`);
  log(`Catalog: ${skillsCatalogPath(target)} (${request.skillCount} skills)`);
  log(`Relevant to workspace: ${request.relevantSkillNames.join(", ") || "(none detected)"}`);
  log(`Required platform skills: ${request.requiredSkillNames.join(", ")}`);
  log(`SessionStart hook will inject profile-init on the next AI agent session.`);

  void vscode.window.showInformationMessage(
    `Profile init ready for "${branch}" (${position.label}). Start a new AI agent session — profile-init runs automatically.`
  );

  return true;
}

const dismissedBranchesThisSession = new Set<string>();

function dismissedKey(target: string, branch: string): string {
  return `${path.normalize(target)}::${branch}`;
}

export async function maybePromptProfileInitOnNewBranch(
  extensionPath: string,
  libraryDir: string,
  target: string,
  branch: string,
  log: (line: string) => void
): Promise<void> {
  if (!profileInitEnabled() || !promptOnNewBranchEnabled()) {
    return;
  }
  if (!branchNeedsProfileInit(target, branch)) {
    return;
  }

  if (dismissedBranchesThisSession.has(dismissedKey(target, branch))) {
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `New branch "${branch}" has no skill profile yet. Initialize skills for your role?`,
    "Init profile",
    "Not now"
  );

  if (choice === "Init profile") {
    await startProfileInitFlow(extensionPath, libraryDir, target, branch, log);
  } else if (choice === "Not now") {
    dismissedBranchesThisSession.add(dismissedKey(target, branch));
    captureBranchProfile(target, libraryDir);
    saveBranchProfile(target, libraryDir);
    log(`Profile init dismissed for \`${branch}\` — saved current skill snapshot instead.`);
  }
}
