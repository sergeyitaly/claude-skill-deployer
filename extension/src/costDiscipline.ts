import * as vscode from "vscode";
import { propagateCostDisciplineToAgents } from "./agentMirrorSync";
import { bootstrapWorkspaceForHostAgent, formatHostBootstrapLog } from "./hostAgentBootstrap";
import { applyBudgetTierGating } from "./budgetTierGating";
import { pruneIrrelevantPersonalSkills, relevantInstallOnlyEnabled } from "./branchSkillBootstrap";
import { isFeatureEnabled } from "./featureFlags";
import { loadManifest } from "./skillOps";
import { listInstalledSkills } from "./usageStats";
import { readTaskFocusLimits } from "./taskFocusConfig";

export interface CostDisciplineResult {
  budgetDisabled: string[];
  prunedIrrelevant: string[];
  mirroredArtifacts: string[];
  agentPathsUpdated: number;
  hostBootstrapMessage?: string;
  reason?: string;
}

export function costDisciplineEnabled(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.costDiscipline").get<boolean>("enabled", true);
}

function pruneThreshold(): number {
  const limits = readTaskFocusLimits();
  const cfg = vscode.workspace.getConfiguration("claudeSkills.costDiscipline");
  const multiplier = cfg.get<number>("pruneWhenInstalledOverMultiplier", 2);
  return Math.max(limits.maxActiveSkills + 4, limits.maxActiveSkills * multiplier);
}

/** Post-focus pass: budget tier gating + prune irrelevant personal installs + fan-out to all agents. */
export function runCostDisciplinePass(
  libraryDir: string,
  target: string
): CostDisciplineResult {
  if (!costDisciplineEnabled()) {
    return { budgetDisabled: [], prunedIrrelevant: [], mirroredArtifacts: [], agentPathsUpdated: 0 };
  }

  const manifest = loadManifest(libraryDir);
  const hostBootstrap = bootstrapWorkspaceForHostAgent(libraryDir, target);
  const hostBootstrapMessage = formatHostBootstrapLog(hostBootstrap);
  const budget = applyBudgetTierGating(target, manifest);

  let prunedIrrelevant: string[] = [];
  if (relevantInstallOnlyEnabled() && isFeatureEnabled("taskSkillFocus")) {
    const installedCount = listInstalledSkills(target).length;
    if (installedCount > pruneThreshold()) {
      prunedIrrelevant = pruneIrrelevantPersonalSkills(libraryDir, target, manifest);
    }
  }

  const shouldPropagate =
    budget.disabled.length > 0 ||
    prunedIrrelevant.length > 0 ||
    isFeatureEnabled("taskSkillFocus");
  let mirroredArtifacts: string[] = [];
  let agentPathsUpdated = 0;
  if (shouldPropagate) {
    const propagated = propagateCostDisciplineToAgents(libraryDir, target);
    mirroredArtifacts = propagated.mirrored;
    agentPathsUpdated = propagated.agentResults.filter(
      (r) => r.status === "installed" || r.status === "written"
    ).length;
  }

  return {
    budgetDisabled: budget.disabled,
    prunedIrrelevant,
    mirroredArtifacts,
    agentPathsUpdated,
    hostBootstrapMessage,
    reason: budget.reason,
  };
}
