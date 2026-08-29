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
  /**
   * Skills the user explicitly re-enabled after budget/economy enforcement disabled them.
   * Two independent, uncoordinated callers can invoke disableHighTierSkills() for the same
   * skill — budgetTierGating.ts on every throttled workspace refresh (no memory of its own),
   * and hookHandlers.ts's handleBudget on every UserPromptSubmit (date-scoped idempotency,
   * but for a different reason set). Without this list, a user re-enabling a skill mid-day
   * while spend is still above the warn threshold would see it silently re-disabled by
   * whichever of the two next happened to run — sometimes within seconds, since both are
   * driven by ordinary tool-call activity. Cleared only by an explicit restore/mode-change,
   * not by time — an explicit user action should stick until the user changes it back.
   */
  userReenabledSkills?: string[];
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
  if (
    !meta.disabledByBudget?.length &&
    !meta.disabledByBudgetRestrict?.length &&
    !meta.disabledReason &&
    !meta.userReenabledSkills?.length
  ) {
    delete settings[BUDGET_META_KEY];
    return;
  }
  settings[BUDGET_META_KEY] = meta;
}

type SkillDisableAction = "skip" | "reclaim" | "disable" | "already-disabled";

/** Classifies a single skill for disableHighTierSkills()'s sweep — pulled out to keep that
 *  function's own cognitive complexity down (SonarQube S3776). */
function classifySkillForBudgetDisable(
  skill: string,
  overrides: Record<string, SkillOverrideValue>,
  previouslyBudgetDisabled: Set<string>,
  userReenabled: Set<string>
): SkillDisableAction {
  if (userReenabled.has(skill)) {
    return "skip";
  }
  const wasBudgetDisabled = previouslyBudgetDisabled.has(skill);
  const isOff = overrides[skill] === "off";
  if (wasBudgetDisabled && !isOff) {
    // Budget disabled this last time, but its override isn't "off" anymore — something
    // cleared it since then, by whatever means (the enableSkillLocally command, a direct
    // edit to settings.local.json, another tool). Respect that instead of re-disabling it.
    return "reclaim";
  }
  if (isOff && !wasBudgetDisabled) {
    return "skip"; // already off for a different reason — not budget's business
  }
  if (!isOff) {
    return "disable";
  }
  return wasBudgetDisabled ? "already-disabled" : "skip";
}

/** Disable high-tier skills locally, tracking which ones we disabled for restore. Skips any
 *  skill the user has explicitly re-enabled since (see BudgetMeta.userReenabledSkills) —
 *  without this, a user's manual re-enable gets silently undone by whichever of the two
 *  independent budget-gating callers (budgetTierGating.ts's refresh loop, hookHandlers.ts's
 *  handleBudget) next happens to run, sometimes within seconds. Also detects an *implicit*
 *  re-enable via classifySkillForBudgetDisable()'s "reclaim" case, since userReenabledSkills
 *  alone only catches the command path. */
export function disableHighTierSkills(
  target: string,
  highTierSkills: string[],
  reason: BudgetMeta["disabledReason"]
): string[] {
  const settings = readLocalSettings(target);
  const overrides = { ...settings.skillOverrides };
  const meta = budgetMeta(settings);
  const previouslyBudgetDisabled = new Set(meta.disabledByBudget ?? []);
  const userReenabled = new Set(meta.userReenabledSkills ?? []);
  const disabledNow: string[] = [];
  const newlyReclaimed: string[] = [];

  for (const skill of highTierSkills) {
    const action = classifySkillForBudgetDisable(skill, overrides, previouslyBudgetDisabled, userReenabled);
    if (action === "reclaim") {
      newlyReclaimed.push(skill);
    } else if (action === "disable") {
      overrides[skill] = "off";
      disabledNow.push(skill);
    } else if (action === "already-disabled") {
      disabledNow.push(skill);
    }
  }

  if (disabledNow.length === 0 && newlyReclaimed.length === 0) {
    return [];
  }

  if (disabledNow.length > 0) {
    settings.skillOverrides = overrides;
  }
  const remainingDisabledByBudget = (meta.disabledByBudget ?? []).filter((s) => !newlyReclaimed.includes(s));
  setBudgetMeta(settings, {
    ...meta,
    disabledByBudget: [...new Set([...remainingDisabledByBudget, ...disabledNow])].sort((a, b) =>
      a.localeCompare(b)
    ),
    disabledReason: reason,
    userReenabledSkills: newlyReclaimed.length
      ? [...new Set([...(meta.userReenabledSkills ?? []), ...newlyReclaimed])].sort((a, b) => a.localeCompare(b))
      : meta.userReenabledSkills,
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

/** Used when user manually re-enables a skill — drop it from budget tracking, and record
 *  the re-enable so disableHighTierSkills() won't silently undo it on its next pass (see
 *  BudgetMeta.userReenabledSkills). Always records the re-enable, even for a skill budget
 *  gating never touched — harmless, and covers the case where gating disables it later. */
export function clearBudgetTrackingForSkill(target: string, skillName: string): void {
  const settings = readLocalSettings(target);
  const meta = budgetMeta(settings);
  const inBudget = meta.disabledByBudget?.includes(skillName) ?? false;
  const inRestrict = meta.disabledByBudgetRestrict?.includes(skillName) ?? false;

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
  if (!meta.userReenabledSkills?.includes(skillName)) {
    updated.userReenabledSkills = [...(meta.userReenabledSkills ?? []), skillName].sort((a, b) =>
      a.localeCompare(b)
    );
  }

  setBudgetMeta(settings, updated);
  writeLocalSettings(target, settings);
}

/** True when the user has explicitly re-enabled this skill after budget/economy enforcement
 *  disabled it — other disable paths with no awareness of budget's own ledger (e.g.
 *  branchProfiles.ts's branch-committed-skill sweep) should check this before disabling too,
 *  or they silently undo the user's choice the same way disableHighTierSkills() itself used
 *  to (see 1.0.142). */
export function isBudgetUserReenabled(target: string, skillName: string): boolean {
  return !!budgetMeta(readLocalSettings(target)).userReenabledSkills?.includes(skillName);
}

/** Skills currently forced off by budget/economy enforcement — used to exclude them from
 * unrelated cleanup sweeps (e.g. taskSkillFocus.ts's legacy-override reclaim) that must
 * not touch overrides this subsystem owns. */
export function budgetDisabledSkillNames(target: string): string[] {
  const meta = budgetMeta(readLocalSettings(target));
  return [...new Set([...(meta.disabledByBudget ?? []), ...(meta.disabledByBudgetRestrict ?? [])])];
}

/** Whether a skill is currently off due to budget/economy (for tree display). */
export function isBudgetDisabled(target: string, skillName: string): boolean {
  const settings = readLocalSettings(target);
  const meta = budgetMeta(settings);
  const tracked =
    (meta.disabledByBudget ?? []).includes(skillName) || (meta.disabledByBudgetRestrict ?? []).includes(skillName);
  return tracked && readSkillOverrides(target)[skillName] === "off";
}
