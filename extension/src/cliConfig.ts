import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { AgentId, enabledAgents } from "./agentOps";
import { detectHostAgentId } from "./agentSkillProfiles";
import { DEFAULTS, FeatureKey, isFeatureEnabled } from "./featureFlags";
import { effectiveFeatureMap } from "./projectProfile";
import { readTaskFocusLimits } from "./taskFocusConfig";
import { writeJsonAtomic } from "./fileWriteCoordination";

export interface CliConfigFile {
  version: 1;
  updatedAt: string;
  updatedBy: "extension" | "cli";
  features: Record<string, boolean>;
  agents: {
    enabled: AgentId[];
    hostAgent?: AgentId;
  };
  taskFocus?: {
    enabled: boolean;
    maxActiveSkills: number;
    minProposalConfidence: number;
    approveSkillSets: boolean;
  };
  costDiscipline?: {
    enabled: boolean;
    propagateToAllAgents: boolean;
  };
}

const ALWAYS_ON_CLI_FEATURES = [
  "sessionSkillAdaptation", "autoApplyTaskProposals", "deterministicTaskProposals",
  "taskSkillFocus", "taskDriftReproposal", "branchProfiles", "multiAgent",
  "budgetControls", "skillSetResolver", "contextFocus", "practicalFocus",
];

export function cliConfigPath(target: string): string {
  return path.join(target, ".claude", "learning", "cli-config.json");
}

/** Mirror extension feature toggles + enabled agents for headless Claude CLI / generate_skills.py. */
export function buildCliConfig(libraryDir: string, target?: string): CliConfigFile {
  const features = target ? effectiveFeatureMap(target) : {};
  for (const key of ALWAYS_ON_CLI_FEATURES) {
    if (!(key in features)) features[key] = true;
  }
  for (const key of Object.keys(DEFAULTS) as FeatureKey[]) {
    if (!(key in features)) {
      features[key] = isFeatureEnabled(key);
    }
  }
  const taskFocus = readTaskFocusLimits();
  const costCfg = vscode.workspace.getConfiguration("claudeSkills.costDiscipline");
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: "extension",
    features,
    agents: {
      enabled: enabledAgents(libraryDir),
      hostAgent: detectHostAgentId(),
    },
    taskFocus: {
      enabled: taskFocus.enabled,
      maxActiveSkills: taskFocus.maxActiveSkills,
      minProposalConfidence: taskFocus.minProposalConfidence,
      approveSkillSets: taskFocus.approveSkillSets,
    },
    costDiscipline: {
      enabled: costCfg.get<boolean>("enabled", true),
      propagateToAllAgents: costCfg.get<boolean>("propagateToAllAgents", true),
    },
  };
}

export function syncCliConfigToWorkspace(target: string, libraryDir: string): CliConfigFile {
  const config = buildCliConfig(libraryDir, target);
  const file = cliConfigPath(target);
  const existing = readCliConfig(target);
  if (existing) {
    const sameFeatures =
      JSON.stringify(existing.features ?? {}) === JSON.stringify(config.features ?? {});
    const sameAgents =
      JSON.stringify(existing.agents?.enabled ?? []) === JSON.stringify(config.agents.enabled);
    const sameTaskFocus = JSON.stringify(existing.taskFocus ?? {}) === JSON.stringify(config.taskFocus ?? {});
    const sameCostDiscipline =
      JSON.stringify(existing.costDiscipline ?? {}) === JSON.stringify(config.costDiscipline ?? {});
    if (sameFeatures && sameAgents && sameTaskFocus && sameCostDiscipline) {
      return existing;
    }
  }
  writeJsonAtomic(file, config);
  return config;
}

export function readCliConfig(target: string): CliConfigFile | undefined {
  const file = cliConfigPath(target);
  if (!fs.existsSync(file)) {
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as CliConfigFile;
  } catch {
    return undefined;
  }
}
