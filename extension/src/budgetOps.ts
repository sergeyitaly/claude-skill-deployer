import * as fs from "node:fs";
import * as path from "node:path";
import { BudgetConfig, BudgetMode, syncBudgetConfigToDisk } from "./budgetConfig";
import { Manifest, readSkillOverrides, SkillOverrideValue } from "./skillOps";

const BUDGET_META_KEY = "claudeSkillsBudget";

interface BudgetMeta {
  /** Skills turned off by economy/budget enforcement (not manual disables). */
  disabledByBudget?: string[];
  /** Skills turned off by the 95% "restrict to low-tier" fallback. */
  disabledByBudgetRestrict?: string[];
  /** Why those skills were disabled */
  disabledReason?: string;
}

interface LocalSettingsWithBudget {
  skillOverrides?: Record<string, SkillOverrideValue>;
  [key: string]: unknown;
}

function settingsLocalPath(target: string): string {
  return path.join(target, ".claude", "settings.local.json");
}

function readLocalSettings(target: string): LocalSettingsWithBudget {
  const file = settingsLocalPath(target);
  if (!fs.existsSync(file)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as LocalSettingsWithBudget;
  } catch {
    return {};
  }
}

function writeLocalSettings(target: string, settings: LocalSettingsWithBudget): void {
  const file = settingsLocalPath(target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

function isBudgetMeta(raw: unknown): raw is BudgetMeta {
  return raw !== null && typeof raw === "object";
}

function budgetMeta(settings: LocalSettingsWithBudget): BudgetMeta {
  const raw = settings[BUDGET_META_KEY];
  if (!isBudgetMeta(raw)) {
    return {};
  }
  return raw;
}

function setBudgetMeta(settings: LocalSettingsWithBudget, meta: BudgetMeta): void {
  if (!meta.disabledByBudget?.length && !meta.disabledByBudgetRestrict?.length && !meta.disabledReason) {
    delete settings[BUDGET_META_KEY];
    return;
  }
  settings[BUDGET_META_KEY] = meta;
}

/** Disable high-tier skills locally, tracking which ones we disabled for restore. */
export function disableHighTierSkills(
  target: string,
  highTierSkills: string[],
  reason: BudgetMeta["disabledReason"]
): string[] {
  const settings = readLocalSettings(target);
  const overrides = { ...settings.skillOverrides };
  const meta = budgetMeta(settings);
  const previouslyBudgetDisabled = new Set(meta.disabledByBudget ?? []);
  const disabledNow: string[] = [];

  for (const skill of highTierSkills) {
    if (overrides[skill] === "off" && !previouslyBudgetDisabled.has(skill)) {
      continue;
    }
    if (overrides[skill] !== "off") {
      overrides[skill] = "off";
      disabledNow.push(skill);
    } else if (previouslyBudgetDisabled.has(skill)) {
      disabledNow.push(skill);
    }
  }

  if (disabledNow.length === 0) {
    return [];
  }

  settings.skillOverrides = overrides;
  setBudgetMeta(settings, {
    disabledByBudget: [...new Set([...(meta.disabledByBudget ?? []), ...disabledNow])].sort((a, b) =>
      a.localeCompare(b)
    ),
    disabledReason: reason,
  });
  writeLocalSettings(target, settings);
  return disabledNow;
}

/** Re-enable skills that were disabled by economy/budget enforcement only. */
export function restoreBudgetDisabledSkills(target: string): string[] {
  const settings = readLocalSettings(target);
  const meta = budgetMeta(settings);
  const toRestore = [...(meta.disabledByBudget ?? []), ...(meta.disabledByBudgetRestrict ?? [])];
  if (toRestore.length === 0) {
    return [];
  }

  const overrides = { ...settings.skillOverrides };
  const restored: string[] = [];
  for (const skill of toRestore) {
    if (overrides[skill] === "off") {
      delete overrides[skill];
      restored.push(skill);
    }
  }

  if (Object.keys(overrides).length > 0) {
    settings.skillOverrides = overrides;
  } else {
    delete settings.skillOverrides;
  }
  setBudgetMeta(settings, {});
  writeLocalSettings(target, settings);
  return restored;
}

/** Apply economy mode: disable all high-tier skills in the workspace. */
export function applyEconomyMode(target: string, config: BudgetConfig): string[] {
  return disableHighTierSkills(target, config.highTierSkills, "economy");
}

/** Leaving economy mode: restore budget-tracked disables. */
export function clearEconomyMode(target: string): string[] {
  return restoreBudgetDisabledSkills(target);
}

/** Sync global budget.json and apply mode side-effects for the open workspace. */
export function syncAndApplyBudgetMode(
  libraryDir: string,
  target: string | undefined,
  mode: BudgetMode
): { config: BudgetConfig; disabled: string[]; restored: string[] } {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(libraryDir, "manifest.json"), "utf-8")
  ) as Manifest;
  const config = syncBudgetConfigToDisk(manifest);

  if (!target) {
    return { config, disabled: [], restored: [] };
  }

  if (mode === "economy") {
    return { config, disabled: applyEconomyMode(target, config), restored: [] };
  }
  return { config, disabled: [], restored: clearEconomyMode(target) };
}

/** Used when user manually re-enables a skill — drop it from budget tracking. */
export function clearBudgetTrackingForSkill(target: string, skillName: string): void {
  const settings = readLocalSettings(target);
  const meta = budgetMeta(settings);
  const inBudget = meta.disabledByBudget?.includes(skillName) ?? false;
  const inRestrict = meta.disabledByBudgetRestrict?.includes(skillName) ?? false;
  if (!inBudget && !inRestrict) {
    return;
  }

  const updated: BudgetMeta = { ...meta };
  if (inBudget) {
    updated.disabledByBudget = meta.disabledByBudget!.filter((s) => s !== skillName);
    if (updated.disabledByBudget.length === 0) {
      delete updated.disabledByBudget;
    }
  }
  if (inRestrict) {
    updated.disabledByBudgetRestrict = meta.disabledByBudgetRestrict!.filter((s) => s !== skillName);
    if (updated.disabledByBudgetRestrict.length === 0) {
      delete updated.disabledByBudgetRestrict;
    }
  }
  if (!updated.disabledByBudget?.length && !updated.disabledByBudgetRestrict?.length) {
    delete updated.disabledReason;
  }

  setBudgetMeta(settings, updated);
  writeLocalSettings(target, settings);
}

/** Whether a skill is currently off due to budget/economy (for tree display). */
export function isBudgetDisabled(target: string, skillName: string): boolean {
  const settings = readLocalSettings(target);
  const meta = budgetMeta(settings);
  const tracked =
    (meta.disabledByBudget ?? []).includes(skillName) || (meta.disabledByBudgetRestrict ?? []).includes(skillName);
  return tracked && readSkillOverrides(target)[skillName] === "off";
}
