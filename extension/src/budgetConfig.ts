import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { Manifest } from "./skillOps";
import { CostEstimateTier } from "./skillCost";

export type BudgetMode = "economy" | "normal" | "unlimited";

export interface BudgetConfig {
  mode: BudgetMode;
  /** Daily spend cap in USD (estimated). 0 disables the cap. */
  dailyBudgetUsd: number;
  /** Warn when today's spend reaches this percent of dailyBudgetUsd. */
  warnThresholdPercent: number;
  /** In economy mode, warn once today's spend crosses this USD amount. */
  economyWarnUsd: number;
  /** In unlimited mode, notify once per day when spend crosses this USD amount. */
  unlimitedNotifyUsd: number;
  /** When the daily budget is exceeded, turn off high-tier skills locally. */
  autoDisableHighTierOnBudgetHit: boolean;
  /** Synced from manifest — skills with cost_estimate === "high". */
  highTierSkills: string[];
  /** Synced from manifest — skills with cost_estimate === "medium". */
  mediumTierSkills: string[];
  /** Synced from manifest — skills with cost_estimate === "low". */
  lowTierSkills: string[];
}

export interface BudgetState {
  /** ISO date (YYYY-MM-DD) -> last notification level emitted */
  notifications?: Record<string, { warn?: boolean; critical?: boolean; economyWarn?: boolean; unlimitedNotify?: boolean }>;
  /** ISO date when high-tier skills were auto-disabled by budget enforcement */
  lastAutoDisableDate?: string;
  /** Skills disabled on lastAutoDisableDate (for idempotency) */
  lastAutoDisabledSkills?: string[];
}

const LEARNING_DIR = path.join(os.homedir(), ".claude", "learning");
export const BUDGET_CONFIG_PATH = path.join(LEARNING_DIR, "budget.json");
export const BUDGET_STATE_PATH = path.join(LEARNING_DIR, "budget-state.json");

const DEFAULT_CONFIG: BudgetConfig = {
  mode: "normal",
  dailyBudgetUsd: 5,
  warnThresholdPercent: 80,
  economyWarnUsd: 0.1,
  unlimitedNotifyUsd: 10,
  autoDisableHighTierOnBudgetHit: true,
  highTierSkills: [],
  mediumTierSkills: [],
  lowTierSkills: [],
};

function tierSkillsFromManifest(manifest: Manifest, tier: CostEstimateTier): string[] {
  return Object.entries(manifest.skills)
    .filter(([, rule]) => (rule.cost_estimate ?? "medium") === tier)
    .map(([name]) => name)
    .sort();
}

export function highTierSkillsFromManifest(manifest: Manifest): string[] {
  return tierSkillsFromManifest(manifest, "high");
}

export function mediumTierSkillsFromManifest(manifest: Manifest): string[] {
  return tierSkillsFromManifest(manifest, "medium");
}

export function lowTierSkillsFromManifest(manifest: Manifest): string[] {
  return tierSkillsFromManifest(manifest, "low");
}

export function readBudgetConfig(): BudgetConfig {
  if (!fs.existsSync(BUDGET_CONFIG_PATH)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(BUDGET_CONFIG_PATH, "utf-8")) as Partial<BudgetConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      highTierSkills: parsed.highTierSkills ?? DEFAULT_CONFIG.highTierSkills,
      mediumTierSkills: parsed.mediumTierSkills ?? DEFAULT_CONFIG.mediumTierSkills,
      lowTierSkills: parsed.lowTierSkills ?? DEFAULT_CONFIG.lowTierSkills,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeBudgetConfig(config: BudgetConfig): void {
  fs.mkdirSync(LEARNING_DIR, { recursive: true });
  fs.writeFileSync(BUDGET_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function readBudgetState(): BudgetState {
  if (!fs.existsSync(BUDGET_STATE_PATH)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(BUDGET_STATE_PATH, "utf-8")) as BudgetState;
  } catch {
    return {};
  }
}

export function writeBudgetState(state: BudgetState): void {
  fs.mkdirSync(LEARNING_DIR, { recursive: true });
  fs.writeFileSync(BUDGET_STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

/** Build BudgetConfig from VS Code workspace settings + manifest high-tier list. */
export function configFromVsCodeSettings(manifest: Manifest): BudgetConfig {
  const cfg = vscode.workspace.getConfiguration("claudeSkills.budget");
  return {
    mode: cfg.get<BudgetMode>("mode", "normal"),
    dailyBudgetUsd: cfg.get<number>("dailyBudgetUsd", 5),
    warnThresholdPercent: cfg.get<number>("warnThresholdPercent", 80),
    economyWarnUsd: cfg.get<number>("economyWarnUsd", 0.1),
    unlimitedNotifyUsd: cfg.get<number>("unlimitedNotifyUsd", 10),
    autoDisableHighTierOnBudgetHit: cfg.get<boolean>("autoDisableHighTier", true),
    highTierSkills: highTierSkillsFromManifest(manifest),
    mediumTierSkills: mediumTierSkillsFromManifest(manifest),
    lowTierSkills: lowTierSkillsFromManifest(manifest),
  };
}

export function syncBudgetConfigToDisk(manifest: Manifest): BudgetConfig {
  const config = configFromVsCodeSettings(manifest);
  writeBudgetConfig(config);
  return config;
}

export function budgetUsagePercent(todayCostUsd: number, config: BudgetConfig): number | null {
  if (config.dailyBudgetUsd <= 0) {
    return null;
  }
  return (todayCostUsd / config.dailyBudgetUsd) * 100;
}
