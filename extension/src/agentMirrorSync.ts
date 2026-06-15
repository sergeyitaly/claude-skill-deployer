import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  AgentInstallResult,
  mirrorLearningArtifacts,
  pruneExcessAgentMirrors,
  PrunedAgentMirror,
  syncCopilotBootstrap,
  syncWorkspaceSkillsToAllAgents,
  workspaceMirrorAgentIds,
  workspaceMirrorAllowed,
} from "./agentOps";
import { hostOnlyMirrorModeForTarget } from "./projectProfile";

/** Whether cost-discipline changes should fan out to agent mirrors (host-only on solo-dev). */
export function shouldPropagateCostDisciplineToAgents(libraryDir: string): boolean {
  const cfg = vscode.workspace.getConfiguration("claudeSkills.costDiscipline");
  if (!cfg.get<boolean>("propagateToAllAgents", true)) {
    return false;
  }
  if (!vscode.workspace.getConfiguration("claudeSkills.agents").get<boolean>("syncWorkspaceToAll", true)) {
    return false;
  }
  return workspaceMirrorAgentIds(libraryDir).length > 0;
}

/** Mirror learning artifacts + effective skill set to enabled agent paths (host IDE only on solo-dev). */
export function propagateCostDisciplineToAgents(
  libraryDir: string,
  target: string
): { mirrored: string[]; agentResults: AgentInstallResult[]; copilotBootstrap?: string } {
  if (!fs.existsSync(path.join(libraryDir, "agents.json"))) {
    return { mirrored: [], agentResults: [] };
  }
  if (!workspaceMirrorAllowed(libraryDir, true)) {
    return { mirrored: [], agentResults: [] };
  }

  const mirrored = mirrorLearningArtifacts(target, libraryDir);
  const agentResults = syncWorkspaceSkillsToAllAgents(libraryDir, target, {
    force: true,
    costDisciplinePropagation: true,
  });
  const copilotBootstrap = workspaceMirrorAgentIds(libraryDir).includes("copilot")
    ? syncCopilotBootstrap(target, libraryDir)
    : undefined;
  return { mirrored, agentResults, copilotBootstrap };
}

/** Drop non-host agent mirrors after switching to solo-dev / budget-focused tier, then re-sync host. */
export function applyHostOnlyTierMirrorCleanup(
  target: string,
  libraryDir: string,
  log?: (line: string) => void
): { pruned: PrunedAgentMirror[]; agentResults: AgentInstallResult[] } {
  if (!hostOnlyMirrorModeForTarget(target)) {
    log?.("Host-only mirror cleanup skipped (multi-agent tier or profile not host-only).");
    return { pruned: [], agentResults: [] };
  }
  const pruned = pruneExcessAgentMirrors(target, libraryDir);
  if (pruned.length > 0) {
    log?.(`Removed ${pruned.length} excess agent mirror path(s) for host-only tier.`);
    for (const row of pruned) {
      const rel = row.path.replace(/\\/g, "/");
      log?.(`  - ${row.agent}: ${rel}`);
    }
  }
  const agentResults =
    workspaceMirrorAllowed(libraryDir, false) ? syncWorkspaceSkillsToAllAgents(libraryDir, target, { force: true }) : [];
  return { pruned, agentResults };
}
