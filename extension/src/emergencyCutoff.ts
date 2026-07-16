import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { computeEnabledAgentsCreditUsage } from "./agentOps";
import { buildCostAttribution, resolveDisplayAttribution } from "./costAttribution";
import { localDateKey } from "./localDate";
import { readSkillOverrides, setSkillOverride, SkillOverrideValue } from "./skillOps";
import { listInstalledSkills } from "./usageStats";

// Legacy machine-wide location, from before this was made per-project. New triggers never
// write here again, but it's still read as a one-time fallback so a cutoff that was already
// active keeps being visible/resettable instead of silently stranding the skills it disabled.
const LEGACY_EMERGENCY_STATE = path.join(os.homedir(), ".claude", "learning", "emergency-state.json");

function emergencyStatePath(target: string): string {
  return path.join(target, ".claude", "learning", "emergency-state.json");
}

function emergencyLogPath(target: string): string {
  return path.join(target, ".claude", "learning", "emergency-cutoff.jsonl");
}

interface EmergencyState {
  active: boolean;
  triggeredAt?: string;
  costUsd?: number;
  disabledSkills?: string[];
  /** Overrides that existed before cutoff — restored on reset. */
  priorOverrides?: Record<string, SkillOverrideValue | undefined>;
}

function readLegacyState(): EmergencyState {
  try {
    return JSON.parse(fs.readFileSync(LEGACY_EMERGENCY_STATE, "utf-8")) as EmergencyState;
  } catch {
    return { active: false };
  }
}

/** Per-project state, falling back to the legacy shared file only when this project has
 * never had its own (i.e. a cutoff triggered before the per-project fix shipped). */
function readState(target: string): EmergencyState {
  try {
    return JSON.parse(fs.readFileSync(emergencyStatePath(target), "utf-8")) as EmergencyState;
  } catch {
    return readLegacyState();
  }
}

function writeState(target: string, state: EmergencyState): void {
  const file = emergencyStatePath(target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

/** Closes out the legacy shared file once its state has been surfaced/reset through any
 * project, so it can never be picked up as a fallback by a different project afterward. */
function clearLegacyStateIfActive(): void {
  try {
    if (readLegacyState().active) {
      fs.writeFileSync(LEGACY_EMERGENCY_STATE, JSON.stringify({ active: false }, null, 2) + "\n", "utf-8");
    }
  } catch {
    // non-fatal
  }
}

function logEvent(target: string, costUsd: number, skills: string[]): void {
  const row = { ts: new Date().toISOString(), costUsd, workspace: target, disabledSkills: skills };
  const file = emergencyLogPath(target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf-8");
}

function skillAttributedCost(
  skill: string,
  attribution: ReturnType<typeof resolveDisplayAttribution>["attribution"]
): number {
  const agents = attribution[skill];
  if (!agents) {
    return 0;
  }
  return Object.values(agents).reduce((sum, a) => sum + (a?.cost ?? 0), 0);
}

export function isEmergencyCutoffActive(target: string): boolean {
  return readState(target).active;
}

/** Skills currently forced off by emergency cutoff — used to exclude them from unrelated
 * cleanup sweeps (e.g. taskSkillFocus.ts's legacy-override reclaim) that must not touch
 * overrides this subsystem owns. */
export function emergencyDisabledSkillNames(target: string): string[] {
  const state = readState(target);
  return state.active ? (state.disabledSkills ?? []) : [];
}

export interface EmergencyCutoffReminder {
  daysSinceTriggered: number;
  costUsd: number;
  disabledCount: number;
}

/** Non-null while cutoff is active — the only ongoing visibility besides the one-time
 * error dialog at trigger time, since nothing previously reminded anyone it was still in
 * effect (confirmed live: a real cutoff from weeks earlier was still silently disabling
 * skills with the triggering error dialog long dismissed and forgotten). */
export function getActiveEmergencyCutoffReminder(target: string): EmergencyCutoffReminder | null {
  const state = readState(target);
  if (!state.active || !state.triggeredAt) {
    return null;
  }
  const daysSinceTriggered = Math.max(
    0,
    Math.floor((Date.now() - new Date(state.triggeredAt).getTime()) / (24 * 60 * 60 * 1000))
  );
  return {
    daysSinceTriggered,
    costUsd: state.costUsd ?? 0,
    disabledCount: state.disabledSkills?.length ?? 0,
  };
}

export function formatEmergencyCutoffReminderText(reminder: EmergencyCutoffReminder): string {
  const dayLabel = reminder.daysSinceTriggered === 1 ? "1 day" : `${reminder.daysSinceTriggered} days`;
  return (
    `[Claude Skills] Emergency cutoff still active (triggered ${dayLabel} ago at ~$${reminder.costUsd.toFixed(2)}` +
    ` spend): ${reminder.disabledCount} skill(s) forced off. Run "Reset Emergency Cutoff" ` +
    `(claudeSkills.resetEmergencyCutoff) if this is resolved.`
  );
}

export function hardLimitUsd(): number {
  return vscode.workspace.getConfiguration("claudeSkills.emergency").get<number>("hardLimitUsd", 10);
}

export function perSkillLimitUsd(): number {
  return vscode.workspace.getConfiguration("claudeSkills.emergency").get<number>("perSkillLimitUsd", 3);
}

/** Today's spend for THIS project only — not a total across every project on the machine.
 * Confirmed live: the previous machine-wide total could trigger a cutoff (and later restore
 * prior overrides) against whichever project happened to be active at the time, regardless
 * of whether that project contributed to the spend at all. */
function todayCostForWorkspace(target: string, libraryDir: string): number {
  const summary = computeEnabledAgentsCreditUsage(libraryDir, 1, target);
  const today = localDateKey();
  return summary.byDay.find((d) => d.date === today)?.cost ?? 0;
}

export async function checkEmergencyCutoff(target: string | undefined, libraryDir?: string): Promise<boolean> {
  if (!target) {
    return false;
  }
  if (readState(target).active) {
    return true;
  }
  if (!libraryDir) {
    return false;
  }

  const totalCost = todayCostForWorkspace(target, libraryDir);
  const hardLimit = hardLimitUsd();
  const perSkillLimit = perSkillLimitUsd();
  if (totalCost <= hardLimit) {
    return false;
  }

  const priorOverrides = readSkillOverrides(target);
  const disabled: string[] = [];
  const snapshot: Record<string, SkillOverrideValue | undefined> = {};

  if (libraryDir) {
    const built = buildCostAttribution(target, libraryDir);
    const { attribution } = resolveDisplayAttribution(built, target);
    for (const [skill] of Object.entries(attribution)) {
      if (skill === "unattributed" || skill === "base_context") {
        continue;
      }
      const cost = skillAttributedCost(skill, attribution);
      if (cost >= perSkillLimit) {
        snapshot[skill] = priorOverrides[skill] as SkillOverrideValue | undefined;
        setSkillOverride(target, skill, "off");
        disabled.push(skill);
      }
    }
  }

  if (disabled.length === 0) {
    const ranked = libraryDir
      ? Object.entries(resolveDisplayAttribution(buildCostAttribution(target, libraryDir), target).attribution)
          .filter(([skill]) => skill !== "unattributed" && skill !== "base_context")
          .map(([skill, agents]) => ({
            skill,
            cost: Object.values(agents ?? {}).reduce((s, a) => s + (a?.cost ?? 0), 0),
          }))
          .sort((a, b) => b.cost - a.cost)
          .slice(0, 3)
          .map((r) => r.skill)
      : listInstalledSkills(target).slice(0, 3);
    for (const skill of ranked) {
      snapshot[skill] = priorOverrides[skill] as SkillOverrideValue | undefined;
      setSkillOverride(target, skill, "off");
      disabled.push(skill);
    }
  }

  const state: EmergencyState = {
    active: true,
    triggeredAt: new Date().toISOString(),
    costUsd: totalCost,
    disabledSkills: disabled,
    priorOverrides: snapshot,
  };
  writeState(target, state);
  logEvent(target, totalCost, disabled);

  await vscode.window.showErrorMessage(
    `EMERGENCY CUTOFF: Daily cost reached $${totalCost.toFixed(2)} (limit $${hardLimit.toFixed(2)}). ` +
      `Disabled ${disabled.length} skill(s) over $${perSkillLimit.toFixed(2)} attributed. Run "Reset Emergency Cutoff" to restore prior overrides.`,
    { modal: true }
  );
  return true;
}

export async function resetEmergencyCutoff(target: string | undefined): Promise<void> {
  if (!target) {
    vscode.window.showInformationMessage("Claude Skills: emergency cutoff is not active.");
    return;
  }
  const state = readState(target);
  if (!state.active) {
    vscode.window.showInformationMessage("Claude Skills: emergency cutoff is not active.");
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    "Reset emergency cutoff and restore skill overrides from before the cutoff?",
    "Reset",
    "Cancel"
  );
  if (confirm !== "Reset") {
    return;
  }
  for (const skill of state.disabledSkills ?? []) {
    const prior = state.priorOverrides?.[skill];
    setSkillOverride(target, skill, prior);
  }
  writeState(target, { active: false });
  // In case this project's state came from the legacy shared fallback, close that out too
  // so it can't be picked up by a different project afterward.
  clearLegacyStateIfActive();
  vscode.window.showInformationMessage("Claude Skills: emergency cutoff reset.");
}
