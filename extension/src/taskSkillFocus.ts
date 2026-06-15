import * as path from "node:path";
import { propagateCostDisciplineToAgents } from "./agentMirrorSync";
import { bootstrapWorkspaceForHostAgent } from "./hostAgentBootstrap";
import { isFeatureEnabled } from "./featureFlags";
import { readJsonFile, writeJsonAtomic } from "./fileWriteCoordination";
import { mergeProfileInitSkills, profileInitRequiredSkills } from "./profileInit";
import { setSkillOverride, readSkillOverrides } from "./skillOps";
import { readTaskSkillProposals, resolveProposalSkillNames, taskSkillSetApprovalPending } from "./taskSkillProposals";
import { listInstalledSkills } from "./usageStats";
import { capActiveSkills, readTaskFocusLimits } from "./taskFocusConfig";

export const TASK_ACTIVE_SKILLS_REL = path.join(".claude", "learning", "task-active-skills.json");

export interface TaskActiveSkillsFile {
  version: 1;
  generatedAt: string;
  proposalsGeneratedAt?: string;
  source: "task-skill-proposals" | "session-apply" | "manual";
  activeSkills: string[];
  /** Installed skills set to skillOverrides off for this task (still on disk). */
  ignoredSkills: string[];
}

export function taskSkillFocusEnabled(): boolean {
  return isFeatureEnabled("taskSkillFocus");
}

export function taskActiveSkillsPath(target: string): string {
  return path.join(target, TASK_ACTIVE_SKILLS_REL);
}

export function readTaskActiveSkills(target: string): TaskActiveSkillsFile | null {
  const parsed = readJsonFile<TaskActiveSkillsFile>(taskActiveSkillsPath(target));
  if (parsed?.version !== 1 || !Array.isArray(parsed.activeSkills)) {
    return null;
  }
  return parsed;
}

export function writeTaskActiveSkills(target: string, data: TaskActiveSkillsFile): void {
  writeJsonAtomic(taskActiveSkillsPath(target), data);
}

/** Personal ignore list: skillOverrides off for installed skills outside the task set. */
export function applyTaskSkillFocus(
  target: string,
  activeSkillNames: string[],
  source: TaskActiveSkillsFile["source"],
  proposalsGeneratedAt?: string
): { activeSkills: string[]; ignoredSkills: string[]; overridesApplied: number } {
  const limits = readTaskFocusLimits();
  const required = profileInitRequiredSkills();
  let cappedNames = activeSkillNames;
  if (limits.enabled) {
    const { active } = capActiveSkills(activeSkillNames, {
      maxActiveSkills: limits.maxActiveSkills,
      requiredSkills: required,
    });
    cappedNames = active;
  }
  const activeSkills = mergeProfileInitSkills([...new Set(cappedNames.filter(Boolean))]);
  const activeSet = new Set(activeSkills);
  const installed = listInstalledSkills(target);
  const overrides = readSkillOverrides(target);
  const ignoredSkills: string[] = [];
  let overridesApplied = 0;

  for (const name of installed) {
    if (activeSet.has(name)) {
      if (overrides[name] === "off") {
        setSkillOverride(target, name, undefined);
        overridesApplied++;
      }
      continue;
    }
    if (overrides[name] !== "off") {
      setSkillOverride(target, name, "off");
      ignoredSkills.push(name);
      overridesApplied++;
    } else {
      ignoredSkills.push(name);
    }
  }

  writeTaskActiveSkills(target, {
    version: 1,
    generatedAt: new Date().toISOString(),
    proposalsGeneratedAt,
    source,
    activeSkills,
    ignoredSkills: [...ignoredSkills].sort((a, b) => a.localeCompare(b)),
  });

  return { activeSkills, ignoredSkills, overridesApplied };
}

/** Re-apply focus from current task-skill-proposals.json when stale or missing. */
export function applyTaskSkillFocusFromProposals(
  libraryDir: string,
  target: string
): { applied: boolean; focus?: ReturnType<typeof applyTaskSkillFocus> } {
  if (!taskSkillFocusEnabled()) {
    return { applied: false };
  }
  const proposals = readTaskSkillProposals(target);
  if (!proposals?.proposals.length) {
    return { applied: false };
  }
  if (taskSkillSetApprovalPending(proposals)) {
    return { applied: false };
  }
  const state = readTaskActiveSkills(target);
  if (state?.proposalsGeneratedAt === proposals.generatedAt) {
    return { applied: false };
  }
  const names = resolveProposalSkillNames(proposals).filter(Boolean);
  const focus = applyTaskSkillFocus(target, names, "task-skill-proposals", proposals.generatedAt);
  bootstrapWorkspaceForHostAgent(libraryDir, target);
  propagateCostDisciplineToAgents(libraryDir, target);
  return { applied: true, focus };
}

/** Clear task-focus overrides that this feature applied (ignoredSkills list). */
export function clearTaskSkillFocus(target: string): number {
  const state = readTaskActiveSkills(target);
  if (!state?.ignoredSkills.length) {
    return 0;
  }
  let cleared = 0;
  const overrides = readSkillOverrides(target);
  for (const name of state.ignoredSkills) {
    if (overrides[name] === "off") {
      setSkillOverride(target, name, undefined);
      cleared++;
    }
  }
  writeJsonAtomic(taskActiveSkillsPath(target), {
    ...state,
    generatedAt: new Date().toISOString(),
    activeSkills: [],
    ignoredSkills: [],
  });
  return cleared;
}
