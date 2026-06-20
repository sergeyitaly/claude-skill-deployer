import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

/** How much to rely on workspace files vs general model knowledge. */
export type ContextFocusLevel = "knowledge" | "balanced" | "local-first" | "strict-local";

export interface ContextFocusConfig {
  enabled: boolean;
  level: ContextFocusLevel;
  /** Tighten grounding when the session transcript grows (session-size-watch levels). */
  autoEscalateOnSessionSize: boolean;
  /** Inject grounding on every prompt; when false, only on large sessions or session start. */
  injectEveryPrompt: boolean;
  /** When many skills are installed, remind the agent to load only task-relevant skills. */
  limitSkillCatalogHints: boolean;
  /** Skill count at which catalog-limit hints apply (local-first and above). */
  manySkillsThreshold: number;
}

export const CONTEXT_FOCUS_LEVELS: ContextFocusLevel[] = [
  "knowledge",
  "balanced",
  "local-first",
  "strict-local",
];

export const CONTEXT_FOCUS_LABELS: Record<ContextFocusLevel, string> = {
  knowledge: "Knowledge-forward",
  balanced: "Balanced",
  "local-first": "Local-first",
  "strict-local": "Strict local",
};

export const CONTEXT_FOCUS_DESCRIPTIONS: Record<ContextFocusLevel, string> = {
  knowledge: "Use general LLM knowledge freely; read workspace files when editing or when asked about this repo.",
  balanced:
    "Verify repo-specific facts in files; use general knowledge for concepts. Re-read when the session is long.",
  "local-first":
    "Read and cite workspace files before claiming how this project works. Minimize unstated assumptions about this codebase.",
  "strict-local":
    "Only assert facts from read files, user input, or tool output. Say uncertain rather than guess about this project.",
};

const LEARNING_DIR = path.join(os.homedir(), ".claude", "learning");
export const CONTEXT_FOCUS_CONFIG_PATH = path.join(LEARNING_DIR, "context-focus.json");

const DEFAULT_CONFIG: ContextFocusConfig = {
  enabled: true,
  level: "balanced",
  autoEscalateOnSessionSize: true,
  injectEveryPrompt: true,
  limitSkillCatalogHints: true,
  manySkillsThreshold: 12,
};

export function readContextFocusConfig(): ContextFocusConfig {
  if (!fs.existsSync(CONTEXT_FOCUS_CONFIG_PATH)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CONTEXT_FOCUS_CONFIG_PATH, "utf-8")) as Partial<ContextFocusConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeContextFocusConfig(config: ContextFocusConfig): void {
  fs.mkdirSync(LEARNING_DIR, { recursive: true });
  fs.writeFileSync(CONTEXT_FOCUS_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function configFromVsCodeSettings(): ContextFocusConfig {
  const cfg = vscode.workspace.getConfiguration("claudeSkills.contextFocus");
  return {
    enabled: cfg.get<boolean>("enabled", true),
    level: cfg.get<ContextFocusLevel>("level", "balanced"),
    autoEscalateOnSessionSize: cfg.get<boolean>("autoEscalateOnSessionSize", true),
    injectEveryPrompt: cfg.get<boolean>("injectEveryPrompt", true),
    limitSkillCatalogHints: cfg.get<boolean>("limitSkillCatalogHints", true),
    manySkillsThreshold: cfg.get<number>("manySkillsThreshold", 12),
  };
}

export function syncContextFocusConfigToDisk(): ContextFocusConfig {
  const config = configFromVsCodeSettings();
  const effective: ContextFocusConfig = {
    ...config,
    enabled: config.enabled,
  };
  writeContextFocusConfig(effective);
  return effective;
}

/** Resolve effective level after optional session-size escalation (mirrors hook logic). */
export function effectiveContextFocusLevel(
  config: ContextFocusConfig,
  sessionSizeLevel: "ok" | "warn" | "critical" = "ok"
): ContextFocusLevel {
  if (!config.enabled || !config.autoEscalateOnSessionSize || sessionSizeLevel === "ok") {
    return config.level;
  }
  if (sessionSizeLevel === "critical") {
    return "strict-local";
  }
  const idx = CONTEXT_FOCUS_LEVELS.indexOf(config.level);
  return CONTEXT_FOCUS_LEVELS[Math.min(CONTEXT_FOCUS_LEVELS.length - 1, idx + 1)];
}

export function nextContextFocusLevel(current: ContextFocusLevel): ContextFocusLevel {
  const idx = CONTEXT_FOCUS_LEVELS.indexOf(current);
  return CONTEXT_FOCUS_LEVELS[(idx + 1) % CONTEXT_FOCUS_LEVELS.length];
}
