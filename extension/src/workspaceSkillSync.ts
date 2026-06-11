import * as vscode from "vscode";
import { saveBranchProfile } from "./branchProfiles";
import { shouldSyncWorkspaceToAll, syncWorkspaceSkillsToAllAgents } from "./agentOps";
import {
  areCostControlHooksConfigured,
  HookInstallStatus,
  installAttributionHooks,
  installOfficialSkillsSessionHook,
  refreshCostControlHookScripts,
} from "./hookOps";
import { workspaceUsesOfficialSkillUpdater } from "./officialSkillsSync";
import { lintAgentMirrorsOnSync, lintOnSync } from "./skillLint";
import { listInstalledSkills } from "./usageStats";

export interface WorkspaceSkillSyncResult {
  agentPathsUpdated: number;
  hooksStatus?: HookInstallStatus | "refreshed";
}

function syncHooksOnSkillChangeEnabled(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.agents").get<boolean>("syncHooksOnSkillChange", true);
}

/** After .claude/skills changes: mirror to other agents and refresh/install hooks when appropriate. */
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

  if (
    vscode.workspace.getConfiguration("claudeSkills").get<boolean>("officialSkillsCheckOnSession", true) &&
    workspaceUsesOfficialSkillUpdater(target)
  ) {
    const officialStatus = installOfficialSkillsSessionHook(extensionPath, target);
    if (officialStatus === "installed" || officialStatus === "updated") {
      result.hooksStatus = officialStatus;
      log(`Official skills SessionStart hook ${officialStatus}.`);
    }
  }

  if (syncHooksOnSkillChangeEnabled() && listInstalledSkills(target).length > 0) {
    const attrStatus = installAttributionHooks(extensionPath, target);
    if (attrStatus === "installed" || attrStatus === "updated") {
      result.hooksStatus = attrStatus;
      log(`Attribution v2 hooks ${attrStatus}.`);
    }

    if (areCostControlHooksConfigured(target)) {
      refreshCostControlHookScripts(extensionPath, target);
      if (!result.hooksStatus) {
        result.hooksStatus = "refreshed";
      }
      log("Cost control hook scripts refreshed in .claude/hooks/.");
    }
  }

  const lintOk = lintOnSync(target, log);
  if (lintOk && shouldSyncWorkspaceToAll()) {
    const synced = syncWorkspaceSkillsToAllAgents(libraryDir, target, { force: opts?.forceAgentSync });
    result.agentPathsUpdated = synced.length;
    if (synced.length > 0) {
      log(`Propagated workspace skills to ${synced.length} other agent path(s) (cursor/kiro/copilot).`);
    }
  }

  lintAgentMirrorsOnSync(target, libraryDir, log);

  return result;
}
