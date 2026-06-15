import * as vscode from "vscode";
import {
  generateForAllAgents,
  removeSkillFromAllWorkspaceAgents,
  shouldSyncWorkspaceToAll,
} from "./agentOps";
import { saveBranchProfile } from "./branchProfiles";
import { assessAttributionHealth } from "./attributionHealth";
import { buildCostAttribution, resolveDisplayAttribution, SkillAttributionMap } from "./costAttribution";
import { isFeatureEnabled } from "./featureFlags";
import { archiveSkill } from "./skillArchival";
import { detectRelevantSkills, generateForWorkspace, loadManifest, Manifest } from "./skillOps";
import { tierForSkill } from "./skillCost";
import { computeUsageStats, listInstalledSkills, SkillUsageStat, UsageRating } from "./usageStats";
import { notifyBackground } from "./userNotify";

export interface SkillSetUsageRules {
  /** Master switch for usage/token/cost-based removal (in addition to relevance rules). */
  enabled: boolean;
  removeNeverUsed: boolean;
  /** When true, zero-run skills are removed even if detect_globs still match. */
  removeNeverUsedEvenIfRelevant: boolean;
  removeIdleSkills: boolean;
  unusedIdleDays: number;
  minAttributedCostUsd: number;
  removeStaleLowUsage: boolean;
  lowUsageIdleDays: number;
  removeBySessions: boolean;
  minSessionsToKeep: number;
  removeByTokens: boolean;
  minTotalTokensToKeep: number;
  removeByCost: boolean;
  maxCostPerUseUsd: number;
  maxRunsForCostRemoval: number;
  requireReliableAttribution: boolean;
  archiveInsteadOfRemove: boolean;
  skipHighCostInstall: boolean;
}

export interface SkillSetResolverConfig {
  enabled: boolean;
  dayOfWeek: number;
  hour: number;
  minute: number;
  installRelevant: boolean;
  removeIrrelevant: boolean;
  keepActiveSkills: boolean;
  protectedSkills: string[];
  usageRules: SkillSetUsageRules;
}

export interface SkillUsageMetrics {
  runs: number;
  totalTokens: number;
  attributedCost: number;
  attributedSessions: number;
  costPerUse: number;
  rating: UsageRating;
  daysSinceLastUse: number | null;
}

export interface SkillSetResolverPlan {
  toInstall: string[];
  toRemove: string[];
  toArchive: string[];
  keep: string[];
  reasons: Record<string, string>;
}

export interface SkillSetResolverResult {
  plan: SkillSetResolverPlan;
  installed: string[];
  removed: string[];
  archived: string[];
  dryRun: boolean;
}

const LAST_RUN_WEEK_KEY = "claudeSkills.lastSkillSetResolverWeek";

const DEFAULT_PROTECTED = [
  "self-learning",
  "skill-usage-insights",
  "skill-feedback-adaptation",
  "file-style-conventions",
  "skill-official-updater",
];

function isoWeekKey(d: Date): string {
  const copy = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  copy.setUTCDate(copy.getUTCDate() + 4 - (copy.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((copy.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${copy.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function readUsageRules(cfg: vscode.WorkspaceConfiguration): SkillSetUsageRules {
  return {
    enabled: cfg.get<boolean>("usageRules.enabled", false),
    removeNeverUsed: cfg.get<boolean>("usageRules.removeNeverUsed", false),
    removeNeverUsedEvenIfRelevant: cfg.get<boolean>("usageRules.removeNeverUsedEvenIfRelevant", true),
    removeIdleSkills: cfg.get<boolean>("usageRules.removeIdleSkills", false),
    unusedIdleDays: cfg.get<number>("usageRules.unusedIdleDays", 14),
    minAttributedCostUsd: cfg.get<number>("usageRules.minAttributedCostUsd", 0.5),
    removeStaleLowUsage: cfg.get<boolean>("usageRules.removeStaleLowUsage", false),
    lowUsageIdleDays: cfg.get<number>("usageRules.lowUsageIdleDays", 30),
    removeBySessions: cfg.get<boolean>("usageRules.removeBySessions", false),
    minSessionsToKeep: cfg.get<number>("usageRules.minSessionsToKeep", 2),
    removeByTokens: cfg.get<boolean>("usageRules.removeByTokens", false),
    minTotalTokensToKeep: cfg.get<number>("usageRules.minTotalTokensToKeep", 50_000),
    removeByCost: cfg.get<boolean>("usageRules.removeByCost", false),
    maxCostPerUseUsd: cfg.get<number>("usageRules.maxCostPerUseUsd", 1),
    maxRunsForCostRemoval: cfg.get<number>("usageRules.maxRunsForCostRemoval", 5),
    requireReliableAttribution: cfg.get<boolean>("usageRules.requireReliableAttribution", true),
    archiveInsteadOfRemove: cfg.get<boolean>("usageRules.archiveInsteadOfRemove", false),
    skipHighCostInstall: cfg.get<boolean>("usageRules.skipHighCostInstall", false),
  };
}

export function readSkillSetResolverConfig(): SkillSetResolverConfig {
  const cfg = vscode.workspace.getConfiguration("claudeSkills.skillSetResolver");
  const inspected = cfg.inspect<boolean>("enabled");
  const tierDefault = isFeatureEnabled("skillSetResolver");
  const enabled =
    inspected?.workspaceFolderValue ??
    inspected?.workspaceValue ??
    inspected?.globalValue ??
    tierDefault;
  return {
    enabled,
    dayOfWeek: cfg.get<number>("dayOfWeek", 1),
    hour: cfg.get<number>("hour", 8),
    minute: cfg.get<number>("minute", 0),
    installRelevant: cfg.get<boolean>("installRelevant", true),
    removeIrrelevant: cfg.get<boolean>("removeIrrelevant", true),
    keepActiveSkills: cfg.get<boolean>("keepActiveSkills", true),
    protectedSkills: cfg.get<string[]>("protectedSkills", DEFAULT_PROTECTED),
    usageRules: readUsageRules(cfg),
  };
}

export function shouldRunSkillSetResolver(
  config: SkillSetResolverConfig,
  lastRunWeek: string | undefined
): boolean {
  if (!config.enabled) {
    return false;
  }
  const now = new Date();
  if (now.getDay() !== config.dayOfWeek) {
    return false;
  }
  if (now.getHours() < config.hour || (now.getHours() === config.hour && now.getMinutes() < config.minute)) {
    return false;
  }
  return isoWeekKey(now) !== lastRunWeek;
}

function skillAttributedTotals(
  skill: string,
  attribution: SkillAttributionMap
): { cost: number; sessions: number } {
  const entry = attribution[skill];
  if (!entry) {
    return { cost: 0, sessions: 0 };
  }
  let cost = 0;
  let sessions = 0;
  for (const row of Object.values(entry)) {
    cost += row?.cost ?? 0;
    sessions += row?.sessions ?? 0;
  }
  return { cost, sessions };
}

export function buildSkillUsageMetrics(
  stats: SkillUsageStat[],
  attribution: SkillAttributionMap
): Map<string, SkillUsageMetrics> {
  const map = new Map<string, SkillUsageMetrics>();
  for (const s of stats) {
    const { cost, sessions } = skillAttributedTotals(s.name, attribution);
    const runs = Math.max(s.runs, sessions);
    map.set(s.name, {
      runs: s.runs,
      totalTokens: s.totalTokens ?? 0,
      attributedCost: cost,
      attributedSessions: sessions,
      costPerUse: runs > 0 ? cost / runs : cost,
      rating: s.rating,
      daysSinceLastUse: s.daysSinceLastUse,
    });
  }
  return map;
}

export function evaluateUsageRemoval(
  metrics: SkillUsageMetrics,
  rules: SkillSetUsageRules,
  attributionReliable: boolean
): string | null {
  if (!rules.enabled) {
    return null;
  }

  if (rules.removeNeverUsed && metrics.runs === 0) {
    return "never used (0 recorded sessions)";
  }

  if (rules.removeIdleSkills && metrics.daysSinceLastUse !== null && metrics.daysSinceLastUse >= rules.unusedIdleDays) {
    if (!rules.requireReliableAttribution || attributionReliable) {
      if (metrics.attributedCost >= rules.minAttributedCostUsd || metrics.runs === 0) {
        return `idle ${metrics.daysSinceLastUse}d (≥${rules.unusedIdleDays}d)`;
      }
    }
  }

  if (rules.removeStaleLowUsage && metrics.rating === "low-usage") {
    const idle = metrics.daysSinceLastUse ?? 999;
    if (idle >= rules.lowUsageIdleDays) {
      return `low usage, idle ${idle}d`;
    }
  }

  if (rules.removeBySessions && metrics.runs > 0 && metrics.runs < rules.minSessionsToKeep) {
    return `${metrics.runs} session(s) < min ${rules.minSessionsToKeep}`;
  }

  if (rules.removeByTokens && metrics.runs > 0 && metrics.totalTokens < rules.minTotalTokensToKeep) {
    return `${metrics.totalTokens} tokens < min ${rules.minTotalTokensToKeep}`;
  }

  if (rules.removeByCost && (!rules.requireReliableAttribution || attributionReliable)) {
    const runs = Math.max(metrics.runs, 1);
    const costPerUse = metrics.attributedCost / runs;
    if (
      metrics.attributedCost >= rules.minAttributedCostUsd &&
      metrics.runs <= rules.maxRunsForCostRemoval &&
      costPerUse >= rules.maxCostPerUseUsd
    ) {
      return `~$${costPerUse.toFixed(2)}/session, ${metrics.runs} run(s)`;
    }
  }

  return null;
}

function shouldSkipInstall(skillName: string, manifest: Manifest, metrics: SkillUsageMetrics | undefined, rules: SkillSetUsageRules): boolean {
  if (!rules.skipHighCostInstall) {
    return false;
  }
  const tier = tierForSkill(manifest.skills[skillName]?.cost_estimate);
  if (tier !== "high") {
    return false;
  }
  return (metrics?.runs ?? 0) === 0;
}

/** Plan which library skills to install (relevant) and remove (irrelevant / unused). */
export function planSkillSetResolution(
  target: string,
  libraryDir: string,
  config: SkillSetResolverConfig = readSkillSetResolverConfig()
): SkillSetResolverPlan {
  const manifest = loadManifest(libraryDir);
  const relevant = new Set(Object.keys(detectRelevantSkills(target, manifest)));
  const installed = listInstalledSkills(target);
  const stats = computeUsageStats(target, manifest);
  const statByName = new Map(stats.map((s) => [s.name, s]));
  const built = buildCostAttribution(target, libraryDir);
  const health = assessAttributionHealth(target, libraryDir);
  const { attribution } = resolveDisplayAttribution(built, target);
  const metricsBySkill = buildSkillUsageMetrics(stats, attribution);
  const protectedSet = new Set(config.protectedSkills);
  const useArchive =
    config.usageRules.archiveInsteadOfRemove && isFeatureEnabled("skillArchival");

  const reasons: Record<string, string> = {};
  const toInstall: string[] = [];
  const toRemove: string[] = [];
  const toArchive: string[] = [];
  const keep: string[] = [];

  if (config.installRelevant) {
    for (const name of relevant) {
      if (!(name in manifest.skills)) {
        continue;
      }
      if (installed.includes(name)) {
        continue;
      }
      const metrics = metricsBySkill.get(name);
      if (shouldSkipInstall(name, manifest, metrics, config.usageRules)) {
        keep.push(name);
        reasons[name] = "skipped install (high cost tier, never used)";
        continue;
      }
      toInstall.push(name);
      reasons[name] = "matches workspace detect_globs";
    }
  }

  for (const name of installed) {
    if (!(name in manifest.skills)) {
      keep.push(name);
      reasons[name] = "project-local skill (never auto-removed)";
      continue;
    }
    if (protectedSet.has(name)) {
      keep.push(name);
      reasons[name] = "protected";
      continue;
    }

    const metrics = metricsBySkill.get(name) ?? {
      runs: 0,
      totalTokens: 0,
      attributedCost: 0,
      attributedSessions: 0,
      costPerUse: 0,
      rating: "unused" as UsageRating,
      daysSinceLastUse: null,
    };

    const usageReason = evaluateUsageRemoval(metrics, config.usageRules, health.reliable);
    if (usageReason) {
      const blockUsage =
        relevant.has(name) &&
        !config.usageRules.removeNeverUsedEvenIfRelevant &&
        metrics.runs === 0 &&
        config.usageRules.removeNeverUsed;
      const blockActive = config.keepActiveSkills && metrics.rating === "active";
      if (!blockUsage && !blockActive) {
        if (useArchive) {
          toArchive.push(name);
          reasons[name] = `archive: ${usageReason}`;
        } else {
          toRemove.push(name);
          reasons[name] = `usage: ${usageReason}`;
        }
        continue;
      }
    }

    if (relevant.has(name)) {
      keep.push(name);
      reasons[name] = "relevant to workspace";
      continue;
    }
    if (config.keepActiveSkills && metrics.rating === "active") {
      keep.push(name);
      reasons[name] = "active usage (2+ runs in last 30 days)";
      continue;
    }
    if (!config.removeIrrelevant) {
      keep.push(name);
      reasons[name] = "removal disabled";
      continue;
    }
    if (statByName.get(name)?.rating === "needs-attention") {
      keep.push(name);
      reasons[name] = "needs attention (fix before removing)";
      continue;
    }
    if (useArchive) {
      toArchive.push(name);
      reasons[name] = `archive: not relevant (${metrics.rating})`;
    } else {
      toRemove.push(name);
      reasons[name] = `not relevant (${metrics.rating})`;
    }
  }

  toInstall.sort();
  toRemove.sort();
  toArchive.sort();
  keep.sort();
  return { toInstall, toRemove, toArchive, keep, reasons };
}

export function formatSkillSetResolverPlan(plan: SkillSetResolverPlan): string[] {
  const lines = ["## Skill set resolver plan", ""];
  if (plan.toInstall.length === 0 && plan.toRemove.length === 0 && plan.toArchive.length === 0) {
    lines.push("No changes — workspace skill set already matches relevance and usage.");
    return lines;
  }
  if (plan.toInstall.length > 0) {
    lines.push("### Install (relevant, missing)");
    for (const name of plan.toInstall) {
      lines.push(`- ${name}: ${plan.reasons[name] ?? ""}`);
    }
    lines.push("");
  }
  if (plan.toRemove.length > 0) {
    lines.push("### Remove");
    for (const name of plan.toRemove) {
      lines.push(`- ${name}: ${plan.reasons[name] ?? ""}`);
    }
    lines.push("");
  }
  if (plan.toArchive.length > 0) {
    lines.push("### Archive");
    for (const name of plan.toArchive) {
      lines.push(`- ${name}: ${plan.reasons[name] ?? ""}`);
    }
    lines.push("");
  }
  if (plan.keep.length > 0) {
    lines.push(`### Keep (${plan.keep.length} skill(s))`);
    for (const name of plan.keep.slice(0, 12)) {
      lines.push(`- ${name}: ${plan.reasons[name] ?? ""}`);
    }
    if (plan.keep.length > 12) {
      lines.push(`- … and ${plan.keep.length - 12} more`);
    }
  }
  return lines;
}

function cleanSkillFromAllAgents(libraryDir: string, target: string, skillName: string): boolean {
  return removeSkillFromAllWorkspaceAgents(libraryDir, target, skillName).some((r) => r.removed);
}

export function executeSkillSetResolution(
  target: string,
  libraryDir: string,
  opts?: { dryRun?: boolean; config?: SkillSetResolverConfig }
): SkillSetResolverResult {
  const dryRun = opts?.dryRun ?? false;
  const config = opts?.config ?? readSkillSetResolverConfig();
  const plan = planSkillSetResolution(target, libraryDir, config);
  const installed: string[] = [];
  const removed: string[] = [];
  const archived: string[] = [];

  if (dryRun) {
    return { plan, installed, removed, archived, dryRun: true };
  }

  for (const skillName of plan.toArchive) {
    if (archiveSkill(target, skillName, libraryDir)) {
      archived.push(skillName);
    }
    cleanSkillFromAllAgents(libraryDir, target, skillName);
  }

  for (const skillName of plan.toRemove) {
    if (cleanSkillFromAllAgents(libraryDir, target, skillName)) {
      removed.push(skillName);
    }
  }

  if (config.installRelevant && plan.toInstall.length > 0) {
    if (shouldSyncWorkspaceToAll()) {
      const results = generateForAllAgents(libraryDir, target, { all: false, force: false, dryRun: false });
      for (const skillName of plan.toInstall) {
        if (results.some((r) => r.skill === skillName && (r.status === "installed" || r.status === "written"))) {
          installed.push(skillName);
        }
      }
    } else {
      const results = generateForWorkspace(libraryDir, target, { all: false, force: false, dryRun: false });
      for (const skillName of plan.toInstall) {
        if (results.some((r) => r.skill === skillName && r.status === "installed")) {
          installed.push(skillName);
        }
      }
    }
  }

  if (isFeatureEnabled("branchProfiles")) {
    saveBranchProfile(target, libraryDir);
  }

  return { plan, installed, removed, archived, dryRun: false };
}

export async function runScheduledSkillSetResolver(
  context: vscode.ExtensionContext,
  target: string | undefined,
  libraryDir: string,
  log: (line: string) => void,
  refresh: () => void,
  propagate: () => void
): Promise<void> {
  if (!target || !isFeatureEnabled("skillSetResolver")) {
    return;
  }
  const config = readSkillSetResolverConfig();
  const lastRun = context.globalState.get<string>(LAST_RUN_WEEK_KEY);
  if (!shouldRunSkillSetResolver(config, lastRun)) {
    return;
  }

  const result = executeSkillSetResolution(target, libraryDir);
  await context.globalState.update(LAST_RUN_WEEK_KEY, isoWeekKey(new Date()));

  log("\n=== Scheduled skill set resolver ===");
  log(formatSkillSetResolverPlan(result.plan).join("\n"));
  if (result.installed.length > 0) {
    log(`Installed: ${result.installed.join(", ")}`);
  }
  if (result.removed.length > 0) {
    log(`Removed: ${result.removed.join(", ")}`);
  }
  if (result.archived.length > 0) {
    log(`Archived: ${result.archived.join(", ")}`);
  }
  propagate();
  refresh();

  const summary = [
    result.installed.length > 0 ? `installed ${result.installed.length}` : null,
    result.removed.length > 0 ? `removed ${result.removed.length}` : null,
    result.archived.length > 0 ? `archived ${result.archived.length}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  if (summary) {
    notifyBackground(`Skill set resolver — ${summary}.`, log);
  }
}

export function startSkillSetResolverScheduler(
  context: vscode.ExtensionContext,
  getTarget: () => string | undefined,
  libraryDir: string,
  log: (line: string) => void,
  refresh: () => void,
  propagate: () => void
): void {
  const tick = () => {
    const target = getTarget();
    if (target) {
      void runScheduledSkillSetResolver(context, target, libraryDir, log, refresh, propagate);
    }
  };
  tick();
  const timer = setInterval(tick, 15 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}
