import * as vscode from "vscode";
import { setActiveProjectProfileContext } from "./activeProjectProfile";
import {
  buildProjectProfile,
  formatRepoEvidence,
  isMultiAgentGreenfield,
  isNascentRepo,
  PROFILE_TYPE_LABELS,
  ProjectProfileFile,
  ProjectProfileType,
  projectProfileApplyTierEnabled,
  projectProfilePromptOnFirstDetectEnabled,
  refreshProjectProfileContext,
  tierForUserPlan,
  UserProjectPlan,
  writeProjectProfile,
} from "./projectProfile";
import {
  formatProjectProfileNotifyMessage,
  PROFILE_TYPE_BADGE,
} from "./projectProfileDisplay";

const PROMPTED_KEY_PREFIX = "claudeSkills.projectProfilePrompted:";

export function projectTierPromptStateKey(target: string): string {
  return PROMPTED_KEY_PREFIX + target.toLowerCase();
}

export function wasProjectTierPromptShown(
  context: vscode.ExtensionContext,
  target: string
): boolean {
  return context.workspaceState.get<boolean>(projectTierPromptStateKey(target), false);
}

export function markProjectTierPromptShown(
  context: vscode.ExtensionContext,
  target: string
): void {
  void context.workspaceState.update(projectTierPromptStateKey(target), true);
}

export interface ProjectPlanPickItem extends vscode.QuickPickItem {
  id: UserProjectPlan;
}

export function formatDetectedTierSummary(detected: ProjectProfileFile): string {
  const s = detected.detectedFrom;
  return [
    `Detected: ${PROFILE_TYPE_BADGE[detected.profileType]} (${Math.round(detected.confidence * 100)}%)`,
    formatRepoEvidence(s),
    detected.rationale,
  ].join("\n");
}

export function buildProjectPlanQuickPickItems(
  detected: ProjectProfileFile
): ProjectPlanPickItem[] {
  const badge = PROFILE_TYPE_BADGE[detected.profileType];
  const s = detected.detectedFrom;
  const nascent = isNascentRepo(s);
  const greenfieldMultiAgent = nascent && detected.profileType === "solo-dev";
  const acceptPicked = !greenfieldMultiAgent && !s.hasAidlcWorkflow;

  const items: ProjectPlanPickItem[] = [
    {
      id: "accept-detected",
      label: `Use detected tier — ${badge}`,
      description: "Recommended from git/repo analysis",
      detail: detected.rationale,
      picked: acceptPicked,
    },
  ];

  if (greenfieldMultiAgent || s.hasAidlcWorkflow || nascent) {
    items.push({
      id: "aidlc-greenfield",
      label: "Plan: AIDLC greenfield (solo, multi-agent from day 1)",
      description: "Enable TEAM MULTI-AGENT",
      detail:
        "For new AI-DLC projects: sync Claude, Cursor, Copilot, and Kiro even with one author and a fresh repo.",
      picked: greenfieldMultiAgent && !s.hasAidlcWorkflow,
    });
  }

  items.push(
    {
      id: "multi-agent-workflow",
      label: "Plan: multiple AI tools (Claude + Cursor + Copilot)",
      description: "Enable TEAM MULTI-AGENT",
      detail: "Full multi-agent sync on a new or solo repo without waiting for git activity",
    },
    {
      id: "team-product",
      label: "Plan: team product / shared repo",
      description: "Enable TEAM MULTI-AGENT",
      detail: "Attribution, branch profiles, and team cost sharing",
    },
    {
      id: "budget-focused",
      label: "Plan: tight budget / economy mode",
      description: "Enable BUDGET-SENSITIVE",
      detail: "Full cost tracking, alerts, and optimization",
    },
    {
      id: "quick-spike",
      label: "Plan: quick spike or throwaway script",
      description: "Enable THROWAWAY",
      detail: "Minimal extension overhead",
    }
  );

  if (isMultiAgentGreenfield(s) && detected.profileType === "team-multi-agent") {
    const accept = items.find((i) => i.id === "accept-detected");
    if (accept) {
      accept.picked = true;
    }
  }

  return items;
}

/**
 * Confirm extension-detected tier and ask about the user's plans (not a raw tier catalog).
 */
export async function promptProjectPlanOnFirstDetect(
  context: vscode.ExtensionContext,
  target: string,
  detected: ProjectProfileFile
): Promise<UserProjectPlan | undefined> {
  if (!projectProfilePromptOnFirstDetectEnabled()) {
    return undefined;
  }
  if (wasProjectTierPromptShown(context, target)) {
    return undefined;
  }

  const items = buildProjectPlanQuickPickItems(detected);
  const pick = await vscode.window.showQuickPick(items, {
    title: "Claude Skills — repo analyzed, confirm your plans",
    placeHolder: formatDetectedTierSummary(detected).replace(/\n/g, " · "),
    ignoreFocusOut: true,
  });

  markProjectTierPromptShown(context, target);

  if (!pick) {
    return undefined;
  }
  return pick.id;
}

export async function applyUserProjectPlan(
  target: string,
  detected: ProjectProfileFile,
  plan: UserProjectPlan
): Promise<ProjectProfileFile> {
  const tier = tierForUserPlan(detected.profileType, plan);
  const lockTier = plan !== "accept-detected" && plan !== "quick-spike";
  if (lockTier) {
    const cfg = vscode.workspace.getConfiguration("claudeSkills.projectProfile");
    await cfg.update("lockedTier", tier, vscode.ConfigurationTarget.Workspace);
  }
  const profile = buildProjectProfile(target, plan === "accept-detected" ? undefined : tier, plan);
  writeProjectProfile(target, profile);
  setActiveProjectProfileContext(profile.enabledFeatures, projectProfileApplyTierEnabled());
  refreshProjectProfileContext(target);
  return profile;
}

export async function maybePromptProjectTierOnFirstDetect(
  context: vscode.ExtensionContext,
  target: string,
  detected: ProjectProfileFile,
  isFirstDetect: boolean
): Promise<ProjectProfileFile> {
  if (!isFirstDetect) {
    return detected;
  }
  const plan = await promptProjectPlanOnFirstDetect(context, target, detected);
  if (!plan || plan === "accept-detected") {
    const confirmed = buildProjectProfile(target, undefined, "accept-detected");
    writeProjectProfile(target, confirmed);
    return confirmed;
  }
  return applyUserProjectPlan(target, detected, plan);
}

export function formatPlanAppliedMessage(
  profile: ProjectProfileFile,
  plan: UserProjectPlan
): string {
  if (plan === "accept-detected") {
    return formatProjectProfileNotifyMessage(profile);
  }
  return `Plan confirmed (${plan.replace(/-/g, " ")}). Tier: ${PROFILE_TYPE_LABELS[profile.profileType as ProjectProfileType]}.`;
}

export function formatFirstDetectFallbackMessage(profile: ProjectProfileFile): string {
  return formatProjectProfileNotifyMessage(profile);
}
