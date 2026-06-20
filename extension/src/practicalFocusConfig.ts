import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

/** How much to favor theoretical advice vs concrete deployable architecture. */
export type PracticalFocusLevel = "exploratory" | "balanced" | "architecture-first" | "deploy-ready";

export interface PracticalFocusConfig {
  enabled: boolean;
  level: PracticalFocusLevel;
  /** Inject on every prompt; when false, once per session. */
  injectEveryPrompt: boolean;
  /** Remind the agent to read the deployment-practical skill at strict levels. */
  recommendDeploymentSkill: boolean;
  /** Require validation commands (plan, lint, dry-run) before calling deploy done. */
  requireValidationSteps: boolean;
}

export const PRACTICAL_FOCUS_LEVELS: PracticalFocusLevel[] = [
  "exploratory",
  "balanced",
  "architecture-first",
  "deploy-ready",
];

export const PRACTICAL_FOCUS_LABELS: Record<PracticalFocusLevel, string> = {
  exploratory: "Exploratory",
  balanced: "Balanced",
  "architecture-first": "Architecture-first",
  "deploy-ready": "Deploy-ready",
};

export const PRACTICAL_FOCUS_DESCRIPTIONS: Record<PracticalFocusLevel, string> = {
  exploratory: "Options, trade-offs, and theory are fine — good for early design discussions.",
  balanced: "Mix theory with concrete next steps and repo-specific patterns.",
  "architecture-first":
    "Prefer concrete architecture and IaC aligned with this repo; read existing infra before advising.",
  "deploy-ready":
    "Every recommendation must be first-try deployable: exact commands, prereqs, validation, and rollback.",
};

const LEARNING_DIR = path.join(os.homedir(), ".claude", "learning");
export const PRACTICAL_FOCUS_CONFIG_PATH = path.join(LEARNING_DIR, "practical-focus.json");

const DEFAULT_CONFIG: PracticalFocusConfig = {
  enabled: false,
  level: "architecture-first",
  injectEveryPrompt: true,
  recommendDeploymentSkill: true,
  requireValidationSteps: true,
};

export function readPracticalFocusConfig(): PracticalFocusConfig {
  if (!fs.existsSync(PRACTICAL_FOCUS_CONFIG_PATH)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(PRACTICAL_FOCUS_CONFIG_PATH, "utf-8")) as Partial<PracticalFocusConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writePracticalFocusConfig(config: PracticalFocusConfig): void {
  fs.mkdirSync(LEARNING_DIR, { recursive: true });
  fs.writeFileSync(PRACTICAL_FOCUS_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function configFromVsCodeSettings(): PracticalFocusConfig {
  const cfg = vscode.workspace.getConfiguration("claudeSkills.practicalFocus");
  return {
    enabled: cfg.get<boolean>("enabled", false),
    level: cfg.get<PracticalFocusLevel>("level", "architecture-first"),
    injectEveryPrompt: cfg.get<boolean>("injectEveryPrompt", true),
    recommendDeploymentSkill: cfg.get<boolean>("recommendDeploymentSkill", true),
    requireValidationSteps: cfg.get<boolean>("requireValidationSteps", true),
  };
}

export function syncPracticalFocusConfigToDisk(): PracticalFocusConfig {
  const config = configFromVsCodeSettings();
  const effective: PracticalFocusConfig = {
    ...config,
    enabled: config.enabled,
  };
  writePracticalFocusConfig(effective);
  return effective;
}

export function nextPracticalFocusLevel(current: PracticalFocusLevel): PracticalFocusLevel {
  const idx = PRACTICAL_FOCUS_LEVELS.indexOf(current);
  return PRACTICAL_FOCUS_LEVELS[(idx + 1) % PRACTICAL_FOCUS_LEVELS.length];
}
