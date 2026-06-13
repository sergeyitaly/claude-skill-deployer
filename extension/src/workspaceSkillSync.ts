import * as vscode from "vscode";
import { saveBranchProfile } from "./branchProfiles";
import { maybeSaveHostAgentSetWithBranchProfile } from "./agentSkillProfiles";
import {
  agentMirrorsNeedSync,
  missingAgentMirrorSkills,
  shouldSyncWorkspaceToAll,
  syncWorkspaceSkillsToAllAgents,
} from "./agentOps";
import {
  areAttributionHooksConfigured,
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

/** When true (default), install Attribution v2 hooks on activate and workspace setup. */
export function autoInstallAttributionHooksEnabled(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.agents").get<boolean>("autoInstallAttributionHooks", true);
}

/** Idempotent: register PostToolUse skill-invoke hook for per-skill cost attribution. */
export function ensureAttributionHooksActive(
  extensionPath: string,
  target: string,
  log: (line: string) => void
): HookInstallStatus | undefined {
  if (!autoInstallAttributionHooksEnabled()) {
    return undefined;
  }
  const status = installAttributionHooks(extensionPath, target);
  if (status === "installed" || status === "updated") {
    log(`Attribution v2 hooks ${status} (claude/cursor/kiro/copilot as enabled).`);
  }
  return status;
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
    maybeSaveHostAgentSetWithBranchProfile(target);
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

  const attrStatus = ensureAttributionHooksActive(extensionPath, target, log);
  if (attrStatus === "installed" || attrStatus === "updated") {
    result.hooksStatus = attrStatus;
  }

  if (syncHooksOnSkillChangeEnabled() && listInstalledSkills(target).length > 0) {
    if (areCostControlHooksConfigured(target)) {
      refreshCostControlHookScripts(extensionPath, target);
      if (!result.hooksStatus) {
        result.hooksStatus = "refreshed";
      }
      log("Cost control hook scripts refreshed in .claude/hooks/.");
    } else if (areAttributionHooksConfigured(target, extensionPath)) {
      refreshCostControlHookScripts(extensionPath, target);
    }
  }

  const lintOk = lintOnSync(target, log);
  const catchUpMirrors = agentMirrorsNeedSync(target, libraryDir);
  if (shouldSyncWorkspaceToAll() && (lintOk || catchUpMirrors || opts?.forceAgentSync)) {
    const synced = syncWorkspaceSkillsToAllAgents(libraryDir, target, { force: opts?.forceAgentSync });
    result.agentPathsUpdated = synced.length;
    if (synced.length > 0) {
      log(`Propagated workspace skills to ${synced.length} other agent path(s) (cursor/kiro/copilot).`);
    }
    if (catchUpMirrors && !lintOk) {
      for (const gap of missingAgentMirrorSkills(target, libraryDir)) {
        log(`SKILL lint: catch-up sync for ${gap.agent} — missing ${gap.missing.length} mirror(s).`);
      }
    }
  } else if (catchUpMirrors && !shouldSyncWorkspaceToAll()) {
    log("Multi-agent mirror catch-up skipped — enable claudeSkills.features.multiAgent and claudeSkills.agents.syncWorkspaceToAll.");
  }

  lintAgentMirrorsOnSync(target, libraryDir, log);

  return result;
}
