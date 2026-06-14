import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { AgentId, enabledAgents } from "./agentOps";
import { DEFAULTS, FeatureKey, isFeatureEnabled } from "./featureFlags";
import { effectiveFeatureMap } from "./projectProfile";
import { writeJsonAtomic } from "./fileWriteCoordination";

export interface CliConfigFile {
  version: 1;
  updatedAt: string;
  updatedBy: "extension" | "cli";
  features: Record<string, boolean>;
  agents: {
    enabled: AgentId[];
  };
}

const CLI_RELEVANT_FEATURES: FeatureKey[] = [
  "sessionSkillAdaptation",
  "autoApplyTaskProposals",
  "deterministicTaskProposals",
  "taskSkillFocus",
  "branchProfiles",
  "multiAgent",
  "budgetControls",
  "contextFocus",
  "practicalFocus",
];

export function cliConfigPath(target: string): string {
  return path.join(target, ".claude", "learning", "cli-config.json");
}

/** Mirror extension feature toggles + enabled agents for headless Claude CLI / generate_skills.py. */
export function buildCliConfig(libraryDir: string, target?: string): CliConfigFile {
  const features = target ? effectiveFeatureMap(target) : {};
  for (const key of CLI_RELEVANT_FEATURES) {
    if (!(key in features)) {
      features[key] = isFeatureEnabled(key);
    }
  }
  for (const key of Object.keys(DEFAULTS) as FeatureKey[]) {
    if (!(key in features)) {
      features[key] = isFeatureEnabled(key);
    }
  }
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: "extension",
    features,
    agents: {
      enabled: enabledAgents(libraryDir),
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
    if (sameFeatures && sameAgents) {
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
