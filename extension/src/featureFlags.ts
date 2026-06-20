import * as vscode from "vscode";
import { getProjectProfileFeatureOverride } from "./activeProjectProfile";

export type FeatureKey =
  | "autoOptimizer"
  | "communityBenchmarks"
  | "prCostEstimate";

export const DEFAULTS: Record<FeatureKey, boolean> = {
  autoOptimizer: false,
  communityBenchmarks: false,
  prCostEstimate: false,
};

export const FEATURE_DESCRIPTIONS: Record<FeatureKey, string> = {
  autoOptimizer: "Enable the auto-optimizer timer (off by default; turn on only after attribution looks reliable).",
  communityBenchmarks: "Community cost benchmarks (opt-in telemetry).",
  prCostEstimate: "GitHub PR cost estimate via gh CLI.",
};

export function isFeatureEnabled(key: FeatureKey): boolean {
  const tierOverride = getProjectProfileFeatureOverride(key);
  if (tierOverride !== undefined) {
    return tierOverride;
  }
  return vscode.workspace.getConfiguration("claudeSkills.features").get<boolean>(key, DEFAULTS[key]);
}

export function featureFlagLines(): string[] {
  return (Object.keys(DEFAULTS) as FeatureKey[]).map(
    (k) => `  ${k}: ${isFeatureEnabled(k) ? "on" : "off"}`
  );
}
