import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { AgentId } from "./agentOps";
import { getCurrentBranch, saveBranchProfile } from "./branchProfiles";
import { OptimizationSuggestion } from "./costOptimizer";
import { isFeatureEnabled } from "./featureFlags";
import { archiveSkill, archivalRules, candidatesForArchival } from "./skillArchival";
import { setSkillOverride, loadManifest } from "./skillOps";
import { computeUsageStats } from "./usageStats";

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

export interface ApplyResult {
  applied: string[];
  skipped: string[];
}

export async function applyOptimizationSuggestions(
  target: string,
  libraryDir: string,
  suggestions: OptimizationSuggestion[],
  opts?: { auto?: boolean }
): Promise<ApplyResult> {
  const auto = opts?.auto ?? false;
  const result: ApplyResult = { applied: [], skipped: [] };

  if (auto && !isAutoOptimizeEnabled()) {
    return result;
  }

  if (!auto && suggestions.length > 0) {
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
  }

  for (const suggestion of suggestions) {
    switch (suggestion.type) {
      case "disable":
      case "unused":
        setSkillOverride(target, suggestion.skill, "off");
        result.applied.push(`Disabled ${suggestion.skill}`);
        if (auto) {
          vscode.window.showInformationMessage(
            `Claude Skills: auto-disabled ${suggestion.skill}` +
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
            vscode.window.showInformationMessage(
              `Claude Skills: set ${suggestion.to} as preferred agent for ${suggestion.skill}`
            );
          }
        } else {
          result.skipped.push(suggestion.skill);
        }
        break;

      case "cache":
        result.skipped.push(`${suggestion.skill} (manual: ${suggestion.action})`);
        break;

      default:
        result.skipped.push(suggestion.skill);
    }
  }

  return result;
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
      costPerUse.set(s.name, (s.totalTokens / s.runs / 1_000_000) * 9);
    }
  }
  const candidates = candidatesForArchival(stats, costPerUse);
  if (candidates.length === 0) {
    return [];
  }
  const rules = archivalRules();
  if (!rules.auto_archive) {
    return [];
  }
  const archived: string[] = [];
  for (const skill of candidates.slice(0, 2)) {
    if (archiveSkill(target, skill, libraryDir)) {
      archived.push(skill);
    }
  }
  return archived;
}
