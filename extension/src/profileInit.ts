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
import { copySkill, ensureGitExcludeEntry, listSkillStatuses, SkillStatus } from "./skillOps";
import { ensureLearningDir } from "./usageStats";
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

function buildAgentInstructions(branch: string, position: UserPosition, relevantSkillNames: string[]): string {
  const relevant =
    relevantSkillNames.length > 0
      ? `Prioritize workspace-relevant skills: ${relevantSkillNames.join(", ")}.`
      : "No detect_globs matches yet — choose from catalog descriptions and branch context.";
  return [
    "Read and follow the profile-init skill immediately — do not wait for the user to ask.",
    `Pick skills for git branch "${branch}" as a ${position.label}.`,
    relevant,
    "Write .claude/profile.local.json with status \"pending\" and a focused skills[] list from the catalog.",
    "The extension auto-installs when the file is saved.",
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

function statusToCatalogEntry(s: SkillStatus): SkillsCatalogEntry {
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
  };
}

/** Snapshot of skills the extension knows about (library + project-local). */
export function refreshSkillsCatalog(target: string, libraryDir: string): SkillsCatalog {
  ensureLearningDir(target);
  ensureProfileInitGitIgnored(target);
  const catalog: SkillsCatalog = {
    version: 1,
    generatedAt: new Date().toISOString(),
    workspacePath: path.normalize(target),
    branch: getCurrentBranch(target),
    skills: listSkillStatuses(libraryDir, target).map(statusToCatalogEntry),
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
  const request: ProfileInitRequest = {
    version: 1,
    requestedAt: new Date().toISOString(),
    branch,
    position,
    catalogPath: ".claude/learning/skills-catalog.json",
    outputPath: ".claude/profile.local.json",
    relevantSkillNames,
    skillCount: catalog.skills.length,
    status: "pending",
    agentInstructions: buildAgentInstructions(branch, position, relevantSkillNames),
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
    skills: [...init.skills],
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
    const { valid, invalid } = validateProfileSkills(profile.skills, catalog);
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
