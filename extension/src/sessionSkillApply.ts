import * as path from "node:path";
import { syncWorkspaceSkillsToAllAgents } from "./agentOps";
import {
  applyBranchProfile,
  ApplyProfileResult,
  BranchSkillProfile,
  getCurrentBranch,
  saveBranchProfile,
} from "./branchProfiles";
import { readJsonFile, writeJsonAtomic } from "./fileWriteCoordination";
import { isFeatureEnabled } from "./featureFlags";
import { mergeProfileInitSkills, profileInitRequiredSkills } from "./profileInit";
import { listInstalledSkills } from "./usageStats";
import {
  readTaskSkillProposals,
  TaskSkillProposalsFile,
  writeTaskSkillProposals,
} from "./taskSkillProposals";
import {
  applyTaskSkillFocus,
  taskSkillFocusEnabled,
} from "./taskSkillFocus";

export const SESSION_APPLY_REQUEST_REL = path.join(
  ".claude",
  "learning",
  "session-skill-apply-request.json"
);
export const SESSION_APPLY_STATE_REL = path.join(".claude", "learning", "session-skill-apply-state.json");
export const TASK_PROPOSALS_APPLY_STATE_REL = path.join(
  ".claude",
  "learning",
  "task-proposals-apply-state.json"
);

export interface SessionSkillApplyRequest {
  version: 1;
  requestedAt: string;
  sessionId: string;
  platform?: string;
  skills: string[];
  source: "profile" | "proposals" | "profile+proposals";
}

interface SessionSkillApplyState {
  version: 1;
  lastSessionId?: string;
  lastAppliedAt?: string;
  lastSkillCount?: number;
}

interface TaskProposalsApplyState {
  version: 1;
  lastGeneratedAt?: string;
  lastAppliedAt?: string;
  lastSkillCount?: number;
}

/** Feature toggle: claudeSkills.features.sessionSkillAdaptation */
export function sessionSkillAdaptationEnabled(): boolean {
  return isFeatureEnabled("sessionSkillAdaptation");
}

/** Feature toggle: claudeSkills.features.autoApplyTaskProposals (default on) */
export function taskProposalsAutoApplyEnabled(): boolean {
  return isFeatureEnabled("autoApplyTaskProposals");
}

/** @deprecated Use sessionSkillAdaptationEnabled — kept for setting migration. */
export function autoApplyProposalsOnSessionEnabled(): boolean {
  return sessionSkillAdaptationEnabled() && taskProposalsAutoApplyEnabled();
}

function sessionApplyRequestPath(target: string): string {
  return path.join(target, SESSION_APPLY_REQUEST_REL);
}

function sessionApplyStatePath(target: string): string {
  return path.join(target, SESSION_APPLY_STATE_REL);
}

function taskProposalsApplyStatePath(target: string): string {
  return path.join(target, TASK_PROPOSALS_APPLY_STATE_REL);
}

export function mergeWithRequiredPlatformSkills(skillNames: string[]): string[] {
  return mergeProfileInitSkills(skillNames);
}

export function queueSessionSkillApplyRequest(
  target: string,
  skills: string[],
  source: SessionSkillApplyRequest["source"],
  sessionId?: string
): void {
  const unique = mergeWithRequiredPlatformSkills([...new Set(skills.filter(Boolean))]);
  if (unique.length === 0) {
    return;
  }
  const request: SessionSkillApplyRequest = {
    version: 1,
    requestedAt: new Date().toISOString(),
    sessionId: sessionId ?? `extension-${Date.now()}`,
    platform: "extension",
    skills: unique,
    source,
  };
  writeJsonAtomic(sessionApplyRequestPath(target), request);
}

export function readSessionSkillApplyRequest(target: string): SessionSkillApplyRequest | null {
  const parsed = readJsonFile<SessionSkillApplyRequest>(sessionApplyRequestPath(target));
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.skills)) {
    return null;
  }
  return parsed;
}

function readSessionApplyState(target: string): SessionSkillApplyState {
  const parsed = readJsonFile<SessionSkillApplyState>(sessionApplyStatePath(target));
  if (parsed?.version === 1) {
    return parsed;
  }
  return { version: 1 };
}

function writeSessionApplyState(target: string, state: SessionSkillApplyState): void {
  writeJsonAtomic(sessionApplyStatePath(target), state);
}

function readTaskProposalsApplyState(target: string): TaskProposalsApplyState {
  const parsed = readJsonFile<TaskProposalsApplyState>(taskProposalsApplyStatePath(target));
  if (parsed?.version === 1) {
    return parsed;
  }
  return { version: 1 };
}

function writeTaskProposalsApplyState(target: string, state: TaskProposalsApplyState): void {
  writeJsonAtomic(taskProposalsApplyStatePath(target), state);
}

function readAppliedProfileSkillNames(target: string): string[] {
  const parsed = readJsonFile<{ status?: string; skills?: string[] }>(
    path.join(target, ".claude", "profile.local.json")
  );
  if (parsed?.status === "applied" && Array.isArray(parsed.skills)) {
    return parsed.skills.filter((s) => typeof s === "string" && s.length > 0);
  }
  return [];
}

function proposalNamesForApply(proposals: TaskSkillProposalsFile): string[] {
  if (taskProposalsAutoApplyEnabled()) {
    return proposals.proposals.map((p) => p.name).filter(Boolean);
  }
  const names = new Set<string>();
  for (const p of proposals.proposals) {
    if (p.confidence >= 50) {
      names.add(p.name);
    }
  }
  if (names.size === 0) {
    for (const p of proposals.proposals.slice(0, 15)) {
      names.add(p.name);
    }
  }
  return [...names];
}

/** Skill names from applied branch profile and/or task-skill-proposals.json. */
export function resolveProposedSkillNamesWithSource(
  target: string
): { skills: string[]; source: SessionSkillApplyRequest["source"] } {
  const names = new Set<string>();
  let fromProfile = false;
  let fromProposals = false;

  for (const name of readAppliedProfileSkillNames(target)) {
    names.add(name);
    fromProfile = true;
  }

  const proposals = readTaskSkillProposals(target);
  if (proposals?.proposals.length) {
    for (const name of proposalNamesForApply(proposals)) {
      names.add(name);
      fromProposals = true;
    }
  }

  const merged = mergeWithRequiredPlatformSkills([...names]);
  const source: SessionSkillApplyRequest["source"] =
    fromProfile && fromProposals ? "profile+proposals" : fromProfile ? "profile" : "proposals";

  return { skills: merged, source };
}

function refreshProposalInstalledFlags(target: string, installedNames: Set<string>): void {
  const proposals = readTaskSkillProposals(target);
  if (!proposals) {
    return;
  }
  let changed = false;
  const updated: TaskSkillProposalsFile = {
    ...proposals,
    proposals: proposals.proposals.map((p) => {
      const installed = installedNames.has(p.name);
      if (p.installed !== installed) {
        changed = true;
        return { ...p, installed };
      }
      return p;
    }),
  };
  if (changed) {
    writeTaskSkillProposals(target, updated);
  }
}

/** Install missing proposed skills and clear local skillOverrides "off" for them (workspace-local). */
export function applyProposedSkillsLocally(
  libraryDir: string,
  target: string,
  skillNames: string[]
): ApplyProfileResult {
  const unique = mergeWithRequiredPlatformSkills([...new Set(skillNames.filter(Boolean))]);
  if (unique.length === 0) {
    return { installed: [], removed: [], overridesApplied: 0, skipped: [] };
  }

  const branch = getCurrentBranch(target) ?? "unknown";
  const profile: BranchSkillProfile = {
    branch,
    skills: unique,
    skillOverrides: {},
    updatedAt: new Date().toISOString(),
    workspacePath: path.normalize(target),
  };

  const result = applyBranchProfile(libraryDir, target, profile, { removeExtra: false });
  saveBranchProfile(target, libraryDir);
  refreshProposalInstalledFlags(target, new Set(listInstalledSkills(target)));

  if (taskSkillFocusEnabled()) {
    const proposals = readTaskSkillProposals(target);
    const focus = applyTaskSkillFocus(
      target,
      unique,
      "session-apply",
      proposals?.generatedAt
    );
    result.overridesApplied += focus.overridesApplied;
    syncWorkspaceSkillsToAllAgents(libraryDir, target, { force: true });
  }

  return result;
}

/** Apply task-skill-proposals.json when the file changes (local workspace only). */
export function applyTaskProposalsIfPending(
  libraryDir: string,
  target: string
): { applied: boolean; result?: ApplyProfileResult } {
  if (!sessionSkillAdaptationEnabled() || !taskProposalsAutoApplyEnabled()) {
    return { applied: false };
  }
  const proposals = readTaskSkillProposals(target);
  if (!proposals?.proposals.length) {
    return { applied: false };
  }
  const state = readTaskProposalsApplyState(target);
  if (state.lastGeneratedAt === proposals.generatedAt) {
    return { applied: false };
  }
  const names = proposalNamesForApply(proposals);
  const result = applyProposedSkillsLocally(libraryDir, target, names);
  writeTaskProposalsApplyState(target, {
    version: 1,
    lastGeneratedAt: proposals.generatedAt,
    lastAppliedAt: new Date().toISOString(),
    lastSkillCount: names.length,
  });
  return { applied: true, result };
}

export function shouldApplySessionSkillRequest(
  target: string,
  request: SessionSkillApplyRequest
): boolean {
  if (!request.sessionId || request.skills.length === 0) {
    return false;
  }
  const state = readSessionApplyState(target);
  return state.lastSessionId !== request.sessionId;
}

/** Process a sessionStart hook apply request; returns summary when work was done. */
export function processSessionSkillApplyRequest(
  libraryDir: string,
  target: string,
  request?: SessionSkillApplyRequest | null
): { applied: boolean; result?: ApplyProfileResult; request?: SessionSkillApplyRequest } {
  if (!sessionSkillAdaptationEnabled()) {
    return { applied: false };
  }
  const req = request ?? readSessionSkillApplyRequest(target);
  if (!req) {
    return { applied: false };
  }
  if (!shouldApplySessionSkillRequest(target, req)) {
    return { applied: false, request: req };
  }

  const skills = mergeWithRequiredPlatformSkills(req.skills);
  const result = applyProposedSkillsLocally(libraryDir, target, skills);
  writeSessionApplyState(target, {
    version: 1,
    lastSessionId: req.sessionId,
    lastAppliedAt: new Date().toISOString(),
    lastSkillCount: skills.length,
  });

  const proposals = readTaskSkillProposals(target);
  if (proposals) {
    writeTaskProposalsApplyState(target, {
      version: 1,
      lastGeneratedAt: proposals.generatedAt,
      lastAppliedAt: new Date().toISOString(),
      lastSkillCount: skills.length,
    });
  }

  return { applied: true, result, request: req };
}

export function requiredPlatformSkillNames(): string[] {
  return profileInitRequiredSkills();
}
