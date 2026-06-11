import * as vscode from "vscode";

export type FeatureKey =
  | "budgetControls"
  | "branchProfiles"
  | "multiAgent"
  | "attributionCollector"
  | "costIntelligence"
  | "autoOptimizer"
  | "predictiveAlerts"
  | "communityBenchmarks"
  | "teamCostSharing"
  | "skillArchival"
  | "emergencyCutoff"
  | "prCostEstimate"
  | "costAwareSearch";

const DEFAULTS: Record<FeatureKey, boolean> = {
  budgetControls: true,
  branchProfiles: true,
  multiAgent: true,
  attributionCollector: true,
  costIntelligence: true,
  autoOptimizer: true,
  predictiveAlerts: true,
  communityBenchmarks: false,
  teamCostSharing: true,
  skillArchival: true,
  emergencyCutoff: true,
  prCostEstimate: false,
  costAwareSearch: true,
};

export function isFeatureEnabled(key: FeatureKey): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.features").get<boolean>(key, DEFAULTS[key]);
}

export function featureFlagLines(): string[] {
  return (Object.keys(DEFAULTS) as FeatureKey[]).map(
    (k) => `  ${k}: ${isFeatureEnabled(k) ? "on" : "off"}`
  );
}
