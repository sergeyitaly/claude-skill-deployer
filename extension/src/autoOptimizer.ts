import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { AgentId } from "./agentOps";
import { notifyBackground } from "./userNotify";
import { getCurrentBranch, saveBranchProfile } from "./branchProfiles";
import { generateOptimizationSuggestions, OptimizationSuggestion, OptimizationType } from "./costOptimizer";
import { isFeatureEnabled } from "./featureFlags";
import { archiveSkill, archivalRules, candidatesForArchival } from "./skillArchival";
import { computeSkillRoi, RoiBand } from "./skillRoi";
import { upgradeSkillsWithLowRoi, upgradeSkillInWorkspace, lifecycleAutoUpgradeOnLowRoiEnabled } from "./skillLifecycle";
import { autoApplySlotsRemaining, recordAutoApplies } from "./autoOptimizerRateLimit";
import { tokenCostUsd } from "./costRates";
import { setSkillOverride, loadManifest } from "./skillOps";
import { computeUsageStats } from "./usageStats";
import { assessAttributionHealth } from "./attributionHealth";
import { buildSystemModeContext } from "./systemMode";
import { evaluatePipelineStatus, readPipelineCycle } from "./pipelineCycle";
import {
  applyOptimizerSafetyCaps,
  capAutoApplySuggestions,
  countDisableSuggestions,
} from "./optimizerSafety";

const AGENT_PREFS_KEY = "claudeSkillsAgentPrefs";

interface LocalSettings {
  skillOverrides?: Record<string, string>;
  [key: string]: unknown;
}

function settingsPath(target: string): string {
  return path.join(target, ".claude", "settings.local.json");
}

function readSettings(target: string): LocalSettings {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(target), "utf-8")) as LocalSettings;
  } catch {
    return {};
  }
}

function writeSettings(target: string, settings: LocalSettings): void {
  fs.mkdirSync(path.dirname(settingsPath(target)), { recursive: true });
  fs.writeFileSync(settingsPath(target), JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

export function readAgentPreferences(target: string): Record<string, AgentId> {
  const prefs = readSettings(target)[AGENT_PREFS_KEY];
  if (!prefs || typeof prefs !== "object") {
    return {};
  }
  return prefs as Record<string, AgentId>;
}

export function setAgentPreference(target: string, skill: string, agent: AgentId): void {
  const settings = readSettings(target);
  const prefs = { ...(readAgentPreferences(target)), [skill]: agent };
  settings[AGENT_PREFS_KEY] = prefs;
  writeSettings(target, settings);
}

export function isAutoOptimizeEnabled(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.optimizer").get<boolean>("autoApply", false);
}

export function isAutoDetectOnPipelineEnabled(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.optimizer").get<boolean>("autoDetectOnPipeline", true);
}

const optimizeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const AUTO_DETECT_DELAY_MS = 5000;

/** Debounced detect → auto-adjust after pipeline or hook activity. */
export function scheduleAutoOptimizePass(target: string, libraryDir: string, delayMs = AUTO_DETECT_DELAY_MS): void {
  if (!isFeatureEnabled("autoOptimizer") || !isAutoOptimizeEnabled() || !isAutoDetectOnPipelineEnabled()) {
    return;
  }
  const key = path.resolve(target);
  const existing = optimizeTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  optimizeTimers.set(
    key,
    setTimeout(() => {
      optimizeTimers.delete(key);
      void runAutoOptimizePass(target, libraryDir);
    }, delayMs)
  );
}

/** Detect expensive/unused skills and auto-apply when `autoApply` is on. */
export async function runAutoOptimizePass(target: string, libraryDir: string): Promise<ApplyResult | null> {
  if (!isFeatureEnabled("autoOptimizer") || !isAutoOptimizeEnabled()) {
    return null;
  }

  const status = evaluatePipelineStatus(target, readPipelineCycle(target));
  if (!status.fresh) {
    return null;
  }

  const health = assessAttributionHealth(target, libraryDir);
  const modeCtx = buildSystemModeContext(health, target, status.cycle);
  if (!modeCtx.canAutoApplyOptimizations) {
    return null;
  }

  // Include archive/upgrade suggestion types in the auto-apply pass when the
  // corresponding features are enabled. These unify what were separate runArchivalPass
  // and upgradeSkillsWithLowRoi calls so each skill is touched only once per cycle.
  const autoArchiveEnabled = isFeatureEnabled("skillArchival") && archivalRules().auto_archive;
  const autoUpgradeEnabled = lifecycleAutoUpgradeOnLowRoiEnabled();

  const allowedTypes = new Set<OptimizationType>(["disable", "unused"]);
  if (autoArchiveEnabled) allowedTypes.add("archive");
  if (autoUpgradeEnabled) allowedTypes.add("upgrade");

  const suggestions = generateOptimizationSuggestions(target, libraryDir).filter(
    (s) => allowedTypes.has(s.type)
  );
  if (suggestions.length === 0) {
    return null;
  }

  return applyOptimizationSuggestions(target, libraryDir, suggestions, { auto: true });
}

export interface ApplyResult {
  applied: string[];
  skipped: string[];
}

export async function applyOptimizationSuggestions(
  target: string,
  libraryDir: string,
  suggestions: OptimizationSuggestion[],
  opts?: { auto?: boolean; directApply?: boolean }
): Promise<ApplyResult> {
  const auto = opts?.auto ?? false;
  const directApply = opts?.directApply ?? false;
  const result: ApplyResult = { applied: [], skipped: [] };

  const health = assessAttributionHealth(target, libraryDir);
  const modeCtx = buildSystemModeContext(health, target, readPipelineCycle(target));
  if (!modeCtx.canApplyOptimizations) {
    result.skipped.push(...suggestions.map((s) => s.skill));
    return result;
  }

  const manifest = loadManifest(libraryDir);
  const usageStats = computeUsageStats(target, manifest);
  suggestions = applyOptimizerSafetyCaps(suggestions, target, usageStats);

  if (auto && !isAutoOptimizeEnabled()) {
    return result;
  }

  if (auto && !modeCtx.canAutoApplyOptimizations) {
    return result;
  }

  if (auto) {
    const slots = autoApplySlotsRemaining(target);
    if (slots <= 0) {
      return result;
    }
    suggestions = capAutoApplySuggestions(suggestions).slice(0, slots);
  }

  if (!auto && !directApply && suggestions.length > 0) {
    const pick = await vscode.window.showQuickPick(
      suggestions.slice(0, 10).map((s) => ({
        label: s.skill,
        description: s.type,
        detail: s.action,
        suggestion: s,
      })),
      {
        title: "Apply cost optimizations",
        canPickMany: true,
        placeHolder: "Select suggestions to apply",
      }
    );
    if (!pick || pick.length === 0) {
      return result;
    }
    suggestions = pick.map((p) => p.suggestion);
    if (countDisableSuggestions(suggestions) > 1) {
      const bulk = await vscode.window.showWarningMessage(
        `Apply ${countDisableSuggestions(suggestions)} disable suggestions at once? Protected skills and safety caps already applied.`,
        { modal: true },
        "Apply all",
        "Cancel"
      );
      if (bulk !== "Apply all") {
        return result;
      }
    }
  }

  for (const suggestion of suggestions) {
    switch (suggestion.type) {
      case "disable":
      case "unused":
        setSkillOverride(target, suggestion.skill, "off");
        result.applied.push(`Disabled ${suggestion.skill}`);
        if (auto) {
          notifyBackground(
            `Auto-disabled ${suggestion.skill}` +
              (suggestion.savings ? ` (~$${suggestion.savings.toFixed(2)} attributed)` : "")
          );
        }
        break;

      case "switch_agent":
        if (suggestion.to) {
          setAgentPreference(target, suggestion.skill, suggestion.to);
          const branch = getCurrentBranch(target);
          if (branch) {
            saveBranchProfile(target, libraryDir);
          }
          result.applied.push(`Prefer ${suggestion.to} for ${suggestion.skill}`);
          if (auto) {
            notifyBackground(`Set ${suggestion.to} as preferred agent for ${suggestion.skill}`);
          }
        } else {
          result.skipped.push(suggestion.skill);
        }
        break;

      case "cache":
        result.skipped.push(`${suggestion.skill} (manual: ${suggestion.action})`);
        break;

      case "archive": {
        const archived = archiveSkill(target, suggestion.skill, libraryDir, {
          reason: auto ? "optimizer-auto: low-roi+idle" : "optimizer: low-roi+idle",
          roiBand: "LOW",
        });
        if (archived) {
          result.applied.push(`Archived ${suggestion.skill}`);
          if (auto) {
            notifyBackground(`Auto-archived "${suggestion.skill}" (LOW ROI, idle — restore any time)`);
          }
        } else {
          result.skipped.push(suggestion.skill);
        }
        break;
      }

      case "upgrade": {
        const upgradeStatus = await upgradeSkillInWorkspace(libraryDir, target, suggestion.skill, {
          force: true,
          confirmCost: false,
        });
        if (upgradeStatus === "installed") {
          result.applied.push(`Upgraded ${suggestion.skill}`);
          if (auto) {
            notifyBackground(`Auto-upgraded "${suggestion.skill}" — newer version may improve efficiency`);
          }
        } else {
          result.skipped.push(suggestion.skill);
        }
        break;
      }

      default:
        result.skipped.push(suggestion.skill);
    }
  }

  if (auto && result.applied.length > 0) {
    recordAutoApplies(target, result.applied.length);
  }

  return result;
}

export async function applySingleOptimizationSuggestion(
  target: string,
  libraryDir: string,
  skill: string,
  type: OptimizationType
): Promise<ApplyResult> {
  const suggestions = generateOptimizationSuggestions(target, libraryDir).filter(
    (s) => s.skill === skill && s.type === type
  );
  if (suggestions.length === 0) {
    return { applied: [], skipped: [skill] };
  }
  return applyOptimizationSuggestions(target, libraryDir, suggestions, { directApply: true });
}

export async function runArchivalPass(target: string, libraryDir: string): Promise<string[]> {
  if (!isFeatureEnabled("skillArchival")) {
    return [];
  }
  const manifest = loadManifest(libraryDir);
  const stats = computeUsageStats(target, manifest);
  const costPerUse = new Map<string, number>();
  for (const s of stats) {
    if (s.runs > 0 && s.totalTokens) {
      costPerUse.set(s.name, tokenCostUsd(s.totalTokens / s.runs));
    }
  }
  // Compute ROI band per skill — passed to candidatesForArchival so that skills with a
  // measured LOW ROI band can be archived even when they aren't fully idle.
  const roiBandBySkill = new Map<string, RoiBand>(
    stats.map((s) => [s.name, computeSkillRoi(s.name, manifest, s).roiBand])
  );
  const candidates = candidatesForArchival(stats, costPerUse, roiBandBySkill);
  if (candidates.length === 0) {
    return [];
  }
  const rules = archivalRules();
  if (!rules.auto_archive) {
    return [];
  }
  const archived: string[] = [];
  for (const skill of candidates.slice(0, 2)) {
    const stat = stats.find((s) => s.name === skill);
    const manifest2 = loadManifest(libraryDir);
    const roiBand = stat ? computeSkillRoi(skill, manifest2, stat).roiBand : undefined;
    const archived2 = archiveSkill(target, skill, libraryDir, {
      reason: "archival-pass: idle+cost",
      roiBand,
      runs: stat?.runs,
    });
    if (archived2) {
      archived.push(skill);
    }
  }
  return archived;
}
