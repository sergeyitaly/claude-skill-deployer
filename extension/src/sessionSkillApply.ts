import * as path from "node:path";
import {
  applyBranchProfile,
  ApplyProfileResult,
  BranchSkillProfile,
  getCurrentBranch,
  saveBranchProfile,
} from "./branchProfiles";
import { readJsonFile, writeJsonAtomic } from "./fileWriteCoordination";
import { listInstalledSkills } from "./usageStats";
import {
  readTaskSkillProposals,
  TaskSkillProposalsFile,
  writeTaskSkillProposals,
} from "./taskSkillProposals";
import { isFeatureEnabled } from "./featureFlags";

export const SESSION_APPLY_REQUEST_REL = path.join(
  ".claude",
  "learning",
  "session-skill-apply-request.json"
);
export const SESSION_APPLY_STATE_REL = path.join(".claude", "learning", "session-skill-apply-state.json");

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

/** Feature toggle: claudeSkills.features.sessionSkillAdaptation */
export function sessionSkillAdaptationEnabled(): boolean {
  return isFeatureEnabled("sessionSkillAdaptation");
}

/** @deprecated Use sessionSkillAdaptationEnabled — kept for setting migration. */
export function autoApplyProposalsOnSessionEnabled(): boolean {
  return sessionSkillAdaptationEnabled();
}

function sessionApplyRequestPath(target: string): string {
  return path.join(target, SESSION_APPLY_REQUEST_REL);
}

function sessionApplyStatePath(target: string): string {
  return path.join(target, SESSION_APPLY_STATE_REL);
}

export function queueSessionSkillApplyRequest(
  target: string,
  skills: string[],
  source: SessionSkillApplyRequest["source"],
  sessionId?: string
): void {
  const unique = [...new Set(skills.filter(Boolean))];
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

function readAppliedProfileSkillNames(target: string): string[] {
  const parsed = readJsonFile<{ status?: string; skills?: string[] }>(
    path.join(target, ".claude", "profile.local.json")
  );
  if (parsed?.status === "applied" && Array.isArray(parsed.skills)) {
    return parsed.skills.filter((s) => typeof s === "string" && s.length > 0);
  }
  return [];
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
    for (const p of proposals.proposals) {
      if (p.confidence >= 50) {
        names.add(p.name);
        fromProposals = true;
      }
    }
    if (names.size === 0) {
      for (const p of proposals.proposals.slice(0, 15)) {
        names.add(p.name);
        fromProposals = true;
      }
    }
  }

  const source: SessionSkillApplyRequest["source"] =
    fromProfile && fromProposals ? "profile+proposals" : fromProfile ? "profile" : "proposals";

  return { skills: [...names].slice(0, 20), source };
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

/** Install missing proposed skills and clear local skillOverrides "off" for them. */
export function applyProposedSkillsLocally(
  libraryDir: string,
  target: string,
  skillNames: string[]
): ApplyProfileResult {
  const unique = [...new Set(skillNames.filter(Boolean))];
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
  return result;
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
  const req = request ?? readSessionSkillApplyRequest(target);
  if (!req || !sessionSkillAdaptationEnabled()) {
    return { applied: false };
  }
  if (!shouldApplySessionSkillRequest(target, req)) {
    return { applied: false, request: req };
  }

  const result = applyProposedSkillsLocally(libraryDir, target, req.skills);
  writeSessionApplyState(target, {
    version: 1,
    lastSessionId: req.sessionId,
    lastAppliedAt: new Date().toISOString(),
    lastSkillCount: req.skills.length,
  });

  return { applied: true, result, request: req };
}
