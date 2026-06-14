import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { AgentId } from "./agentOps";
import { detectGitFromFilesystem, getGitRepository } from "./branchProfiles";
import { setActiveProjectProfileContext } from "./activeProjectProfile";
import { DEFAULTS, FeatureKey } from "./featureFlags";
import { ensureLearningDir } from "./usageStats";
import { readJsonFile, writeJsonAtomic } from "./fileWriteCoordination";

const PROFILE_REDETECT_MS = 24 * 60 * 60 * 1000;

export type ProjectProfileType =
  | "solo-dev"
  | "team-multi-agent"
  | "budget-sensitive"
  | "enterprise"
  | "throwaway";

export type TeamSize = "solo" | "small" | "team";
export type BudgetPattern = "unlimited" | "configured" | "none";
export type CostTrackingLevel = "off" | "minimal" | "full";

export interface ProjectProfileSignals {
  gitRemotes: string[];
  teamSize: TeamSize;
  aiTools: AgentId[];
  budgetPattern: BudgetPattern;
  hasSharedClaudeSkills: boolean;
  isGitRepo: boolean;
}

export interface ProjectProfileFile {
  version: 1;
  profileType: ProjectProfileType;
  detectedFrom: ProjectProfileSignals;
  enabledFeatures: Partial<Record<FeatureKey, boolean>>;
  costTracking: CostTrackingLevel;
  confidence: number;
  detectedAt: string;
  appliedAt?: string;
  manualOverride?: ProjectProfileType;
  rationale: string;
}

export const PROFILE_TYPE_LABELS: Record<ProjectProfileType, string> = {
  "solo-dev": "Solo developer",
  "team-multi-agent": "Multi-agent team",
  "budget-sensitive": "Budget-conscious",
  enterprise: "Enterprise team",
  throwaway: "Throwaway / scripts",
};

const THROWAWAY_DIR_RE = /^(tmp|temp|scratch|playground|sandbox|demo|test-)/i;

export function projectProfilePath(target: string): string {
  return path.join(target, ".claude", "learning", "project-profile.json");
}

export function projectProfileAutoDetectEnabled(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.projectProfile").get<boolean>("autoDetect", true);
}

export function projectProfileApplyTierEnabled(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.projectProfile").get<boolean>("applyTierFeatures", true);
}

export function projectProfilePromptOnFirstDetectEnabled(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.projectProfile").get<boolean>("promptOnFirstDetect", true);
}

export function lockedProjectProfileTier(): ProjectProfileType | undefined {
  const raw = vscode.workspace
    .getConfiguration("claudeSkills.projectProfile")
    .get<string>("lockedTier", "");
  if (!raw) {
    return undefined;
  }
  return raw as ProjectProfileType;
}

function gitCommand(root: string, args: string[]): string | undefined {
  try {
    const out = execFileSync("git", ["-C", root, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 4000,
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function detectGitRemotes(target: string): { remotes: string[]; isGitRepo: boolean } {
  const repo = getGitRepository(target);
  if (repo?.state.remotes?.length) {
    return {
      isGitRepo: true,
      remotes: repo.state.remotes
        .map((r) => r.fetchUrl ?? r.pushUrl ?? "")
        .filter(Boolean),
    };
  }
  const fsGit = detectGitFromFilesystem(target);
  if (!fsGit) {
    return { isGitRepo: false, remotes: [] };
  }
  return {
    isGitRepo: true,
    remotes: fsGit.originUrl ? [fsGit.originUrl] : [],
  };
}

function detectTeamSize(target: string, isGitRepo: boolean): TeamSize {
  if (!isGitRepo) {
    return "solo";
  }
  const root = gitCommand(target, ["rev-parse", "--show-toplevel"]) ?? target;
  const out = gitCommand(root, ["log", "--since=30 days ago", "--format=%ae"]);
  if (!out) {
    return "solo";
  }
  const authors = new Set(out.split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter(Boolean));
  if (authors.size <= 1) {
    return "solo";
  }
  if (authors.size <= 4) {
    return "small";
  }
  return "team";
}

function detectAiTools(target: string): AgentId[] {
  const tools = new Set<AgentId>();
  const check = (rel: string) => fs.existsSync(path.join(target, rel));
  if (check(".cursor") || check(".cursor/rules")) {
    tools.add("cursor");
  }
  if (check(".claude") || check(".claude/skills")) {
    tools.add("claude");
  }
  if (check(".github/instructions") || check(".github/copilot-instructions.md")) {
    tools.add("copilot");
  }
  if (check(".kiro") || check(".kiro/settings")) {
    tools.add("kiro");
  }
  if (tools.size === 0) {
    tools.add("claude");
  }
  return [...tools];
}

function detectBudgetPattern(): BudgetPattern {
  const cfg = vscode.workspace.getConfiguration("claudeSkills.budget");
  const mode = cfg.get<"economy" | "normal" | "unlimited">("mode", "normal");
  if (mode === "economy") {
    return "configured";
  }
  if (mode === "unlimited") {
    return "unlimited";
  }
  return "none";
}

function detectSharedClaudeSkills(target: string, isGitRepo: boolean): boolean {
  const skillsDir = path.join(target, ".claude", "skills");
  if (!fs.existsSync(skillsDir)) {
    return false;
  }
  let hasSkill = false;
  try {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, "SKILL.md"))) {
        hasSkill = true;
        break;
      }
    }
  } catch {
    return false;
  }
  if (!hasSkill) {
    return false;
  }
  if (!isGitRepo) {
    return false;
  }
  const tracked = gitCommand(target, ["ls-files", "--", ".claude/skills"]);
  return Boolean(tracked?.trim());
}

function looksThrowaway(target: string, isGitRepo: boolean): boolean {
  if (!isGitRepo) {
    return true;
  }
  const base = path.basename(target);
  if (THROWAWAY_DIR_RE.test(base)) {
    return true;
  }
  const hasPackage = fs.existsSync(path.join(target, "package.json"));
  const hasReadme = fs.existsSync(path.join(target, "README.md"));
  if (!isGitRepo && !hasPackage && !hasReadme) {
    try {
      const entries = fs.readdirSync(target);
      if (entries.length <= 4) {
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}

export function detectProjectProfileSignals(target: string): ProjectProfileSignals {
  const { remotes, isGitRepo } = detectGitRemotes(target);
  return {
    gitRemotes: remotes,
    teamSize: detectTeamSize(target, isGitRepo),
    aiTools: detectAiTools(target),
    budgetPattern: detectBudgetPattern(),
    hasSharedClaudeSkills: detectSharedClaudeSkills(target, isGitRepo),
    isGitRepo,
  };
}

function costTrackingForTier(type: ProjectProfileType): CostTrackingLevel {
  switch (type) {
    case "throwaway":
      return "off";
    case "solo-dev":
    case "enterprise":
      return "minimal";
    default:
      return "full";
  }
}

/** Tier presets — only keys that differ from DEFAULTS unless tier is exhaustive. */
export function tierFeaturePreset(
  type: ProjectProfileType,
  signals: ProjectProfileSignals
): Partial<Record<FeatureKey, boolean>> {
  const multiAgent = signals.aiTools.length >= 2;
  switch (type) {
    case "throwaway":
      return {
        multiAgent: false,
        attributionCollector: false,
        costIntelligence: false,
        autoOptimizer: false,
        branchProfiles: false,
        budgetControls: false,
        teamCostSharing: false,
        sessionSkillAdaptation: false,
        autoApplyTaskProposals: false,
        deterministicTaskProposals: false,
        taskSkillFocus: false,
        skillSetResolver: false,
        costAwareSearch: false,
        contextFocus: false,
        practicalFocus: false,
        emergencyCutoff: false,
        predictiveAlerts: false,
        skillArchival: false,
        communityBenchmarks: false,
        prCostEstimate: false,
      };
    case "solo-dev":
      return {
        multiAgent: false,
        attributionCollector: false,
        autoOptimizer: false,
        teamCostSharing: false,
        costAwareSearch: false,
        skillSetResolver: false,
        predictiveAlerts: false,
        communityBenchmarks: false,
        prCostEstimate: false,
        branchProfiles: true,
        budgetControls: true,
        costIntelligence: true,
        sessionSkillAdaptation: true,
        deterministicTaskProposals: true,
        taskSkillFocus: true,
        autoApplyTaskProposals: true,
      };
    case "team-multi-agent":
      return {
        multiAgent: true,
        attributionCollector: true,
        costIntelligence: true,
        autoOptimizer: true,
        branchProfiles: true,
        budgetControls: true,
        teamCostSharing: true,
        sessionSkillAdaptation: true,
        autoApplyTaskProposals: true,
        deterministicTaskProposals: true,
        taskSkillFocus: true,
        costAwareSearch: true,
        skillSetResolver: true,
        predictiveAlerts: true,
        emergencyCutoff: true,
        skillArchival: true,
      };
    case "budget-sensitive":
      return {
        multiAgent,
        attributionCollector: true,
        costIntelligence: true,
        autoOptimizer: true,
        branchProfiles: true,
        budgetControls: true,
        teamCostSharing: true,
        sessionSkillAdaptation: true,
        autoApplyTaskProposals: true,
        deterministicTaskProposals: true,
        taskSkillFocus: true,
        costAwareSearch: true,
        predictiveAlerts: true,
        emergencyCutoff: true,
      };
    case "enterprise":
      return {
        multiAgent: true,
        attributionCollector: false,
        costIntelligence: true,
        autoOptimizer: false,
        branchProfiles: true,
        budgetControls: true,
        teamCostSharing: false,
        costAwareSearch: false,
        communityBenchmarks: false,
        prCostEstimate: false,
        sessionSkillAdaptation: true,
        deterministicTaskProposals: true,
        taskSkillFocus: true,
      };
    default:
      return {};
  }
}

export function resolveProjectProfileType(signals: ProjectProfileSignals, target: string): {
  profileType: ProjectProfileType;
  confidence: number;
  rationale: string;
} {
  if (looksThrowaway(target, signals.isGitRepo)) {
    return {
      profileType: "throwaway",
      confidence: 0.9,
      rationale: "No git repo or throwaway workspace layout — minimal extension overhead.",
    };
  }
  const multiTool = signals.aiTools.length >= 2;
  const teamish = signals.teamSize !== "solo" || signals.hasSharedClaudeSkills;
  if (multiTool && teamish) {
    return {
      profileType: "team-multi-agent",
      confidence: 0.85,
      rationale: `${signals.aiTools.length} AI tool roots and team/shared-skill signals — full sync and attribution.`,
    };
  }
  if (signals.budgetPattern === "configured") {
    return {
      profileType: "budget-sensitive",
      confidence: 0.8,
      rationale: "Budget or economy mode configured — full cost tracking with alerts.",
    };
  }
  if (signals.teamSize === "team" && signals.budgetPattern === "unlimited") {
    return {
      profileType: "enterprise",
      confidence: 0.7,
      rationale: "Large team with unlimited budget — multi-agent sync without per-skill ROI overhead.",
    };
  }
  return {
    profileType: "solo-dev",
    confidence: 0.75,
    rationale: "Single-agent solo workflow — branch profiles and token-saving focus, light background work.",
  };
}

export function buildProjectProfile(
  target: string,
  overrideType?: ProjectProfileType
): ProjectProfileFile {
  const signals = detectProjectProfileSignals(target);
  const resolved = overrideType
    ? {
        profileType: overrideType,
        confidence: 1,
        rationale: `Manual tier: ${PROFILE_TYPE_LABELS[overrideType]}.`,
      }
    : resolveProjectProfileType(signals, target);
  const enabledFeatures = tierFeaturePreset(resolved.profileType, signals);
  return {
    version: 1,
    profileType: resolved.profileType,
    detectedFrom: signals,
    enabledFeatures,
    costTracking: costTrackingForTier(resolved.profileType),
    confidence: resolved.confidence,
    detectedAt: new Date().toISOString(),
    appliedAt: new Date().toISOString(),
    manualOverride: overrideType,
    rationale: resolved.rationale,
  };
}

export function shouldRefreshProjectProfile(existing: ProjectProfileFile, built: ProjectProfileFile): boolean {
  if (existing.profileType !== built.profileType) {
    return true;
  }
  if (existing.manualOverride !== built.manualOverride) {
    return true;
  }
  const age = Date.now() - new Date(existing.detectedAt).getTime();
  if (age > PROFILE_REDETECT_MS) {
    return true;
  }
  return JSON.stringify(existing.detectedFrom) !== JSON.stringify(built.detectedFrom);
}

export function readProjectProfile(target: string): ProjectProfileFile | undefined {
  return readJsonFile<ProjectProfileFile>(projectProfilePath(target));
}

export function writeProjectProfile(target: string, profile: ProjectProfileFile): void {
  ensureLearningDir(target);
  writeJsonAtomic(projectProfilePath(target), profile);
}

export interface ProjectProfileRefreshResult {
  profile?: ProjectProfileFile;
  changed: boolean;
  /** True when project-profile.json did not exist before this refresh wrote one. */
  isFirstDetect: boolean;
}

export function refreshProjectProfileContext(target: string | undefined): ProjectProfileRefreshResult {
  const apply = projectProfileApplyTierEnabled();
  if (!target) {
    setActiveProjectProfileContext(null, apply);
    return { changed: false, isFirstDetect: false };
  }
  const existing = readProjectProfile(target);
  const locked = lockedProjectProfileTier();
  if (projectProfileAutoDetectEnabled() && !locked) {
    const built = buildProjectProfile(target);
    if (!existing || shouldRefreshProjectProfile(existing, built)) {
      const isFirstDetect = !existing;
      writeProjectProfile(target, built);
      setActiveProjectProfileContext(built.enabledFeatures, apply);
      return { profile: built, changed: true, isFirstDetect };
    }
    setActiveProjectProfileContext(existing.enabledFeatures, apply);
    return { profile: existing, changed: false, isFirstDetect: false };
  }
  if (locked) {
    const built = buildProjectProfile(target, locked);
    const changed = !existing || existing.profileType !== built.profileType || existing.manualOverride !== built.manualOverride;
    writeProjectProfile(target, built);
    setActiveProjectProfileContext(built.enabledFeatures, apply);
    return { profile: built, changed, isFirstDetect: !existing };
  }
  setActiveProjectProfileContext(existing?.enabledFeatures ?? null, apply);
  return { profile: existing, changed: false, isFirstDetect: false };
}

export function formatProjectProfileSummary(profile: ProjectProfileFile): string {
  const on = (k: FeatureKey) => profile.enabledFeatures[k] ?? DEFAULTS[k];
  const lines = [
    `Profile: ${PROFILE_TYPE_LABELS[profile.profileType]} (${profile.profileType})`,
    profile.rationale,
    `Cost tracking: ${profile.costTracking}`,
    `AI tools: ${profile.detectedFrom.aiTools.join(", ")}`,
    `Team: ${profile.detectedFrom.teamSize}`,
    `Features: multiAgent=${on("multiAgent") ? "on" : "off"}, attribution=${on("attributionCollector") ? "on" : "off"}, costIntel=${on("costIntelligence") ? "on" : "off"}, sessionAdapt=${on("sessionSkillAdaptation") ? "on" : "off"}`,
  ];
  return lines.join("\n");
}

export function effectiveFeatureMap(target: string): Record<string, boolean> {
  const profile = readProjectProfile(target);
  const apply = projectProfileApplyTierEnabled();
  const out: Record<string, boolean> = {};
  for (const key of Object.keys(DEFAULTS) as FeatureKey[]) {
    if (apply && profile?.enabledFeatures && key in profile.enabledFeatures) {
      out[key] = profile.enabledFeatures[key]!;
      continue;
    }
    out[key] = vscode.workspace.getConfiguration("claudeSkills.features").get<boolean>(key, DEFAULTS[key]);
  }
  return out;
}
