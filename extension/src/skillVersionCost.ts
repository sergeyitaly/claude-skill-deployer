import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { estimateSessionCostUsd, tierForSkill } from "./skillCost";
import { loadManifest } from "./skillOps";

export interface SkillVersionCostRecord {
  skill: string;
  version: string;
  costUsd: number;
  recordedAt: string;
}

const VERSION_COST_PATH = path.join(os.homedir(), ".claude", "learning", "skill-version-costs.json");

function readStore(): Record<string, SkillVersionCostRecord[]> {
  if (!fs.existsSync(VERSION_COST_PATH)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(VERSION_COST_PATH, "utf-8")) as Record<string, SkillVersionCostRecord[]>;
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, SkillVersionCostRecord[]>): void {
  fs.mkdirSync(path.dirname(VERSION_COST_PATH), { recursive: true });
  fs.writeFileSync(VERSION_COST_PATH, JSON.stringify(store, null, 2) + "\n", "utf-8");
}

export function recordSkillVersionCost(skill: string, version: string, costUsd: number): void {
  const store = readStore();
  const list = store[skill] ?? [];
  list.push({ skill, version, costUsd, recordedAt: new Date().toISOString() });
  store[skill] = list.slice(-20);
  writeStore(store);
}

export function getSkillVersionCost(skill: string, version?: string): number | null {
  const list = readStore()[skill];
  if (!list?.length) {
    return null;
  }
  if (version) {
    const hit = list.find((r) => r.version === version);
    return hit?.costUsd ?? null;
  }
  return list[list.length - 1].costUsd;
}

export async function warnOnCostlySkillUpdate(
  libraryDir: string,
  skill: string,
  oldVersion: string,
  newVersion: string
): Promise<boolean> {
  const manifest = loadManifest(libraryDir);
  const tier = tierForSkill(manifest.skills[skill]?.cost_estimate);
  const newCost = estimateSessionCostUsd(tier);
  const oldCost = getSkillVersionCost(skill, oldVersion) ?? estimateSessionCostUsd(tier) * 0.9;
  recordSkillVersionCost(skill, newVersion, newCost);

  if (newCost <= oldCost * 1.2) {
    return true;
  }
  const pct = ((newCost / oldCost - 1) * 100).toFixed(0);
  const choice = await vscode.window.showWarningMessage(
    `Skill update increases estimated cost by ${pct}%.\n${oldVersion}: $${oldCost.toFixed(2)} | ${newVersion}: $${newCost.toFixed(2)}\nContinue?`,
    "Continue",
    "Cancel"
  );
  return choice === "Continue";
}
