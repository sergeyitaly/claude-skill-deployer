import { BudgetConfig, budgetUsagePercent, readBudgetConfig } from "./budgetConfig";
import { disableHighTierSkills } from "./budgetOps";
import { Manifest, readSkillOverrides, setSkillOverride } from "./skillOps";
import { readTaskActiveSkills } from "./taskSkillFocus";
import { readTodayCostUsd } from "./todayCostSnapshot";

export interface BudgetTierGatingResult {
  disabled: string[];
  reason?: string;
}

function activeSkillSet(target: string): Set<string> {
  const active = readTaskActiveSkills(target);
  if (active?.activeSkills.length) {
    return new Set(active.activeSkills);
  }
  return new Set();
}

/** Disable high/medium-tier skills outside the active task set when budget is tight. */
export function applyBudgetTierGating(
  target: string,
  manifest: Manifest,
  config: BudgetConfig = readBudgetConfig()
): BudgetTierGatingResult {
  void manifest;
  const todayCost = readTodayCostUsd();
  const pct = budgetUsagePercent(todayCost, config);
  const active = activeSkillSet(target);
  const overrides = readSkillOverrides(target);
  const disabled: string[] = [];

  if (config.mode === "economy") {
    const toDisable = config.highTierSkills.filter((s) => overrides[s] !== "off");
    if (toDisable.length === 0) {
      return { disabled: [] };
    }
    return { disabled: disableHighTierSkills(target, toDisable, "economy"), reason: "economy-mode" };
  }

  if (pct === null || !config.autoDisableHighTierOnBudgetHit) {
    return { disabled: [] };
  }

  const warnAt = config.warnThresholdPercent ?? 80;

  if (pct >= warnAt) {
    const highOutsideActive = config.highTierSkills.filter(
      (name) => !active.has(name) && overrides[name] !== "off"
    );
    if (highOutsideActive.length > 0) {
      disabled.push(...disableHighTierSkills(target, highOutsideActive, "budget-warn"));
    }
  }

  if (pct >= 95) {
    for (const name of config.mediumTierSkills) {
      if (active.has(name) || overrides[name] === "off") {
        continue;
      }
      setSkillOverride(target, name, "off");
      disabled.push(name);
    }
  }

  const unique = [...new Set(disabled)];
  return {
    disabled: unique,
    reason: unique.length > 0 ? (pct >= 95 ? "budget-critical" : "budget-warn") : undefined,
  };
}
