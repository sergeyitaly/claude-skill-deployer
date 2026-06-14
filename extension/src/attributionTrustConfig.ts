import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { assessAttributionHealth } from "./attributionHealth";
import { ConfidenceLevel } from "./attributionConfidence";
import { buildGlobalTrustBadge, GlobalTrustTier } from "./attributionTrust";
import { isFeatureEnabled } from "./featureFlags";
import { getWorkspaceHookStatus } from "./hookOps";

export const ATTRIBUTION_TRUST_REL = path.join(".claude", "learning", "attribution-trust.json");

export interface AttributionTrustPromptFile {
  version: 1;
  updatedAt: string;
  enabled: boolean;
  thresholdPct: number;
  scorePct: number;
  level: ConfidenceLevel;
  tier: GlobalTrustTier;
  summary: string;
  /** True when enabled and scorePct is below thresholdPct — hooks read this. */
  shouldInject: boolean;
}

export function attributionTrustPath(target: string): string {
  return path.join(target, ATTRIBUTION_TRUST_REL);
}

export function readLowTrustPromptSettings(): { enabled: boolean; thresholdPct: number } {
  const cfg = vscode.workspace.getConfiguration("claudeSkills.costIntelligence");
  const enabled = cfg.get<boolean>("lowTrustPromptEnabled", true);
  let thresholdPct = cfg.get<number>("lowTrustPromptThresholdPct", 50);
  if (!Number.isFinite(thresholdPct)) {
    thresholdPct = 50;
  }
  return {
    enabled,
    thresholdPct: Math.max(0, Math.min(100, Math.round(thresholdPct))),
  };
}

/** Write workspace attribution trust snapshot for SessionStart hooks (silent agent context). */
export function syncAttributionTrustConfig(target: string, libraryDir: string): AttributionTrustPromptFile | null {
  if (!isFeatureEnabled("costIntelligence")) {
    return null;
  }

  const { enabled, thresholdPct } = readLowTrustPromptSettings();
  const health = assessAttributionHealth(target, libraryDir);
  const badge = buildGlobalTrustBadge(health, getWorkspaceHookStatus(target, libraryDir));
  const scorePct = badge.scorePct;
  const shouldInject = enabled && scorePct < thresholdPct;

  const payload: AttributionTrustPromptFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    enabled,
    thresholdPct,
    scorePct,
    level: health.confidenceLevel,
    tier: badge.tier,
    summary: badge.detail,
    shouldInject,
  };

  const file = attributionTrustPath(target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  return payload;
}
