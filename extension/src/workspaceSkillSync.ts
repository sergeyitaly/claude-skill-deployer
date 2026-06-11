import * as vscode from "vscode";
import { saveBranchProfile } from "./branchProfiles";
import { shouldSyncWorkspaceToAll, syncWorkspaceSkillsToAllAgents } from "./agentOps";
import {
  areCostControlHooksConfigured,
  HookInstallStatus,
  refreshCostControlHookScripts,
} from "./hookOps";
import { listInstalledSkills } from "./usageStats";

export interface WorkspaceSkillSyncResult {
  agentPathsUpdated: number;
  hooksStatus?: HookInstallStatus | "refreshed";
}

function syncHooksOnSkillChangeEnabled(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.agents").get<boolean>("syncHooksOnSkillChange", true);
}

/** After .claude/skills changes: mirror to other agents and refresh/install cost hooks when appropriate. */
export function propagateWorkspaceSkillChange(
  extensionPath: string,
  target: string | undefined,
  libraryDir: string,
  log: (line: string) => void,
  opts?: { forceAgentSync?: boolean; saveBranchProfile?: boolean }
): WorkspaceSkillSyncResult {
  const result: WorkspaceSkillSyncResult = { agentPathsUpdated: 0 };
  if (!target) {
    return result;
  }

  if (opts?.saveBranchProfile !== false) {
    saveBranchProfile(target, libraryDir);
  }

  if (shouldSyncWorkspaceToAll()) {
    const synced = syncWorkspaceSkillsToAllAgents(libraryDir, target, { force: opts?.forceAgentSync });
    result.agentPathsUpdated = synced.length;
    if (synced.length > 0) {
      log(`Propagated workspace skills to ${synced.length} other agent path(s) (cursor/kiro/copilot).`);
    }
  }

  if (!syncHooksOnSkillChangeEnabled()) {
    return result;
  }

  if (listInstalledSkills(target).length === 0) {
    return result;
  }

  // Only refresh hook scripts when user already enabled hooks — never auto-install on skill toggle.
  if (areCostControlHooksConfigured(target)) {
    refreshCostControlHookScripts(extensionPath, target);
    result.hooksStatus = "refreshed";
    log("Cost control hook scripts refreshed in .claude/hooks/.");
  }

  return result;
}
