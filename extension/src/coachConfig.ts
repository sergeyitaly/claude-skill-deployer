import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

export interface CoachConfig {
  /** Show HACE / prompt-quality coaching hints during conversations. */
  enabled: boolean;
  /** Maximum number of coaching hints surfaced per session (0 = suppress hints, still records metrics). */
  maxHintsPerSession: number;
}

const LEARNING_DIR = path.join(os.homedir(), ".claude", "learning");
export const COACH_CONFIG_PATH = path.join(LEARNING_DIR, "coach.json");

const DEFAULT_CONFIG: CoachConfig = {
  enabled: true,
  maxHintsPerSession: 3,
};

export function readCoachConfig(): CoachConfig {
  if (!fs.existsSync(COACH_CONFIG_PATH)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(COACH_CONFIG_PATH, "utf-8")) as Partial<CoachConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeCoachConfig(config: CoachConfig): void {
  fs.mkdirSync(LEARNING_DIR, { recursive: true });
  fs.writeFileSync(COACH_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function configFromVsCodeSettings(): CoachConfig {
  const cfg = vscode.workspace.getConfiguration("claudeSkills.sessionCoach");
  return {
    enabled: cfg.get<boolean>("enabled", true),
    maxHintsPerSession: cfg.get<number>("maxHintsPerSession", 3),
  };
}

export function syncCoachConfigToDisk(): CoachConfig {
  const config = configFromVsCodeSettings();
  writeCoachConfig(config);
  return config;
}
