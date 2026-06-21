import * as vscode from "vscode";

export type FeatureMode = "starter" | "professional" | "power" | "team";

const FEATURE_MAP: Record<string, FeatureMode> = {
  // Starter features
  "skills":           "starter",
  "dashboard.basic":  "starter",
  "cost.today":       "starter",
  "cost.control":     "starter",
  "profile.init":     "starter",

  // Professional (+ all starter)
  "attribution":      "professional",
  "api.score":        "professional",
  "optimization":     "professional",
  "prediction":       "professional",
  "learning.timeline":"professional",
  "roi.matrix":       "professional",

  // Power user (+ all professional)
  "governance":       "power",
  "adaptation.log":   "power",
  "prediction.detail":"power",
  "export.audit":     "power",
  "community.bench":  "power",

  // Team (+ all power)
  "team.telemetry":   "team",
  "team.reporting":   "team",
  "team.governance":  "team",
};

const MODE_ORDER: FeatureMode[] = ["starter", "professional", "power", "team"];

export function getFeatureMode(): FeatureMode {
  const raw = vscode.workspace.getConfiguration("claudeSkills").get<string>("featureMode", "professional");
  if (raw === "starter" || raw === "professional" || raw === "power" || raw === "team") return raw;
  return "professional";
}

export function isFeatureAvailable(feature: string): boolean {
  const required = FEATURE_MAP[feature];
  if (!required) return true; // unknown features default to available
  const current = getFeatureMode();
  return MODE_ORDER.indexOf(current) >= MODE_ORDER.indexOf(required);
}
