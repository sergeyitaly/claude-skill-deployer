import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  AgentInstallResult,
  enabledAgents,
  mirrorLearningArtifacts,
  syncCopilotBootstrap,
  syncWorkspaceSkillsToAllAgents,
} from "./agentOps";
import { isFeatureEnabled } from "./featureFlags";

/** Whether cost-discipline changes should fan out to Cursor/Kiro/Copilot mirrors. */
export function shouldPropagateCostDisciplineToAgents(libraryDir: string): boolean {
  const cfg = vscode.workspace.getConfiguration("claudeSkills.costDiscipline");
  if (!cfg.get<boolean>("propagateToAllAgents", true)) {
    return false;
  }
  if (!vscode.workspace.getConfiguration("claudeSkills.agents").get<boolean>("syncWorkspaceToAll", true)) {
    return false;
  }
  return enabledAgents(libraryDir).some((id) => id !== "claude");
}

function workspaceMirrorAllowed(libraryDir: string, costDisciplinePropagation: boolean): boolean {
  if (!vscode.workspace.getConfiguration("claudeSkills.agents").get<boolean>("syncWorkspaceToAll", true)) {
    return false;
  }
  if (costDisciplinePropagation && shouldPropagateCostDisciplineToAgents(libraryDir)) {
    return true;
  }
  return isFeatureEnabled("multiAgent");
}

/** Mirror learning artifacts + effective skill set to all enabled non-Claude agents. */
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
  const copilotBootstrap = syncCopilotBootstrap(target, libraryDir);
  return { mirrored, agentResults, copilotBootstrap };
}
