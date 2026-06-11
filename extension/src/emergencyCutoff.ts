import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { buildCostAttribution, resolveDisplayAttribution } from "./costAttribution";
import { isFeatureEnabled } from "./featureFlags";
import { readSkillOverrides, setSkillOverride, SkillOverrideValue } from "./skillOps";
import { listInstalledSkills } from "./usageStats";
import { computeTodayCreditUsage } from "./usageCost";

const EMERGENCY_LOG = path.join(os.homedir(), ".claude", "learning", "emergency-cutoff.jsonl");
const EMERGENCY_STATE = path.join(os.homedir(), ".claude", "learning", "emergency-state.json");

interface EmergencyState {
  active: boolean;
  triggeredAt?: string;
  costUsd?: number;
  disabledSkills?: string[];
  /** Overrides that existed before cutoff — restored on reset. */
  priorOverrides?: Record<string, SkillOverrideValue | undefined>;
}

function readState(): EmergencyState {
  try {
    return JSON.parse(fs.readFileSync(EMERGENCY_STATE, "utf-8")) as EmergencyState;
  } catch {
    return { active: false };
  }
}

function writeState(state: EmergencyState): void {
  fs.mkdirSync(path.dirname(EMERGENCY_STATE), { recursive: true });
  fs.writeFileSync(EMERGENCY_STATE, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function logEvent(costUsd: number, target: string, skills: string[]): void {
  const row = { ts: new Date().toISOString(), costUsd, workspace: target, disabledSkills: skills };
  fs.mkdirSync(path.dirname(EMERGENCY_LOG), { recursive: true });
  fs.appendFileSync(EMERGENCY_LOG, JSON.stringify(row) + "\n", "utf-8");
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

export function isEmergencyCutoffActive(): boolean {
  return readState().active;
}

export function hardLimitUsd(): number {
  return vscode.workspace.getConfiguration("claudeSkills.emergency").get<number>("hardLimitUsd", 10);
}

export function perSkillLimitUsd(): number {
  return vscode.workspace.getConfiguration("claudeSkills.emergency").get<number>("perSkillLimitUsd", 3);
}

export async function checkEmergencyCutoff(target: string | undefined, libraryDir?: string): Promise<boolean> {
  if (!isFeatureEnabled("emergencyCutoff") || !target) {
    return false;
  }
  if (readState().active) {
    return true;
  }

  const { totalCost } = computeTodayCreditUsage();
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
  writeState(state);
  logEvent(totalCost, target, disabled);

  await vscode.window.showErrorMessage(
    `EMERGENCY CUTOFF: Daily cost reached $${totalCost.toFixed(2)} (limit $${hardLimit.toFixed(2)}). ` +
      `Disabled ${disabled.length} skill(s) over $${perSkillLimit.toFixed(2)} attributed. Run "Reset Emergency Cutoff" to restore prior overrides.`,
    { modal: true }
  );
  return true;
}

export async function resetEmergencyCutoff(target: string | undefined): Promise<void> {
  const state = readState();
  if (!state.active || !target) {
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
  writeState({ active: false });
  vscode.window.showInformationMessage("Claude Skills: emergency cutoff reset.");
}
