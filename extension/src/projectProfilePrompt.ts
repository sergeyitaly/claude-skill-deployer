import * as vscode from "vscode";
import { setActiveProjectProfileContext } from "./activeProjectProfile";
import {
  buildProjectProfile,
  PROFILE_TYPE_LABELS,
  ProjectProfileFile,
  ProjectProfileType,
  projectProfileApplyTierEnabled,
  projectProfilePromptOnFirstDetectEnabled,
  refreshProjectProfileContext,
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

const TIER_PICK_ORDER: ProjectProfileType[] = [
  "team-multi-agent",
  "solo-dev",
  "budget-sensitive",
  "enterprise",
  "throwaway",
];

const TIER_PICK_HINTS: Record<ProjectProfileType, string> = {
  "team-multi-agent": "Claude + Cursor + Copilot — full sync and attribution",
  "solo-dev": "One agent — lighter overhead, token-saving focus",
  "budget-sensitive": "Economy mode — full cost tracking and alerts",
  enterprise: "Large team — multi-agent without per-skill ROI overhead",
  throwaway: "Scripts / no git — minimal extension features",
};

export interface ProjectTierPromptItem extends vscode.QuickPickItem {
  id: ProjectProfileType;
}

export function buildProjectTierQuickPickItems(
  detected: ProjectProfileFile
): ProjectTierPromptItem[] {
  return TIER_PICK_ORDER.map((id) => ({
    id,
    label: PROFILE_TYPE_BADGE[id],
    description: PROFILE_TYPE_LABELS[id],
    detail: TIER_PICK_HINTS[id],
    picked: id === detected.profileType,
  }));
}

/**
 * Ask how the user plans to use AI agents on first workspace open.
 * Returns the chosen tier, or undefined if dismissed (keeps auto-detected profile).
 */
export async function promptProjectTierOnFirstDetect(
  context: vscode.ExtensionContext,
  target: string,
  detected: ProjectProfileFile
): Promise<ProjectProfileType | undefined> {
  if (!projectProfilePromptOnFirstDetectEnabled()) {
    return undefined;
  }
  if (wasProjectTierPromptShown(context, target)) {
    return undefined;
  }

  const items = buildProjectTierQuickPickItems(detected);
  const pick = await vscode.window.showQuickPick(items, {
    title: "Claude Skills — how will you use AI agents on this project?",
    placeHolder: `Auto-detected: ${PROFILE_TYPE_BADGE[detected.profileType]} — pick multi-agent if you use Claude + Cursor + Copilot`,
    ignoreFocusOut: true,
  });

  markProjectTierPromptShown(context, target);

  if (!pick) {
    return undefined;
  }
  return pick.id;
}

export async function applyChosenProjectTier(
  target: string,
  tier: ProjectProfileType,
  lockTier = true
): Promise<ProjectProfileFile> {
  if (lockTier) {
    const cfg = vscode.workspace.getConfiguration("claudeSkills.projectProfile");
    await cfg.update("lockedTier", tier, vscode.ConfigurationTarget.Workspace);
  }
  const profile = buildProjectProfile(target, tier);
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
  const chosen = await promptProjectTierOnFirstDetect(context, target, detected);
  if (!chosen || chosen === detected.profileType) {
    return detected;
  }
  const lock = chosen === "team-multi-agent" || chosen === "enterprise" || chosen === "budget-sensitive";
  return applyChosenProjectTier(target, chosen, lock);
}

export function formatFirstDetectFallbackMessage(profile: ProjectProfileFile): string {
  return formatProjectProfileNotifyMessage(profile);
}
