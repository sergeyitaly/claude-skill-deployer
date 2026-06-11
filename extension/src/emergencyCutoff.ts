import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { isFeatureEnabled } from "./featureFlags";
import { listInstalledSkills } from "./usageStats";
import { setSkillOverride } from "./skillOps";
import { computeTodayCreditUsage } from "./usageCost";

const EMERGENCY_LOG = path.join(os.homedir(), ".claude", "learning", "emergency-cutoff.jsonl");
const EMERGENCY_STATE = path.join(os.homedir(), ".claude", "learning", "emergency-state.json");

interface EmergencyState {
  active: boolean;
  triggeredAt?: string;
  costUsd?: number;
  disabledSkills?: string[];
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

function logEvent(costUsd: number, target: string): void {
  const row = { ts: new Date().toISOString(), costUsd, workspace: target };
  fs.mkdirSync(path.dirname(EMERGENCY_LOG), { recursive: true });
  fs.appendFileSync(EMERGENCY_LOG, JSON.stringify(row) + "\n", "utf-8");
}

export function isEmergencyCutoffActive(): boolean {
  return readState().active;
}

export function hardLimitUsd(): number {
  return vscode.workspace.getConfiguration("claudeSkills.emergency").get<number>("hardLimitUsd", 10);
}

export async function checkEmergencyCutoff(target: string | undefined): Promise<boolean> {
  if (!isFeatureEnabled("emergencyCutoff") || !target) {
    return false;
  }
  if (readState().active) {
    return true;
  }

  const { totalCost } = computeTodayCreditUsage();
  const limit = hardLimitUsd();
  if (totalCost <= limit) {
    return false;
  }

  const installed = listInstalledSkills(target);
  const disabled: string[] = [];
  for (const skill of installed) {
    setSkillOverride(target, skill, "off");
    disabled.push(skill);
  }

  const state: EmergencyState = {
    active: true,
    triggeredAt: new Date().toISOString(),
    costUsd: totalCost,
    disabledSkills: disabled,
  };
  writeState(state);
  logEvent(totalCost, target);

  await vscode.window.showErrorMessage(
    `EMERGENCY CUTOFF: Daily cost reached $${totalCost.toFixed(2)} (limit $${limit.toFixed(2)}). ` +
      `All ${disabled.length} workspace skill(s) disabled. Run "Reset Emergency Cutoff" to re-enable.`,
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
    "Reset emergency cutoff and re-enable skills that were disabled by the cutoff?",
    "Reset",
    "Cancel"
  );
  if (confirm !== "Reset") {
    return;
  }
  for (const skill of state.disabledSkills ?? []) {
    setSkillOverride(target, skill, undefined);
  }
  writeState({ active: false });
  vscode.window.showInformationMessage("Claude Skills: emergency cutoff reset.");
}
