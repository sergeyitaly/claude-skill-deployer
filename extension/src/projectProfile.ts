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
import {
  formatRemoteGitEvidence,
  probeRemoteGitSignals,
  RemoteGitSignals,
} from "./repoRemoteProbe";

const PROFILE_REDETECT_MS = 24 * 60 * 60 * 1000;

function configUriForTarget(target?: string): vscode.Uri | undefined {
  if (!target) {
    return undefined;
  }
  return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(target))?.uri;
}

function projectProfileConfiguration(target?: string): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("claudeSkills.projectProfile", configUriForTarget(target));
}

/** Settings lock, manual override, or an explicit user plan (not accept-detected). */
export function effectiveLockedTier(
  existing: ProjectProfileFile | undefined,
  target?: string
): ProjectProfileType | undefined {
  // Explicit user plan wins — derive tier from plan, not a stale profileType on disk.
  if (existing?.userPlan && existing.userPlan !== "accept-detected") {
    return tierForUserPlan(existing.profileType, existing.userPlan);
  }
  if (existing?.manualOverride) {
    return existing.manualOverride;
  }
  const fromSettings = lockedProjectProfileTier(target);
  if (fromSettings) {
    return fromSettings;
  }
  return undefined;
}

export type ProjectProfileType =
  | "solo-dev"
  | "team-multi-agent"
  | "budget-sensitive"
  | "enterprise"
  | "throwaway";

export type TeamSize = "solo" | "small" | "team";
export type BudgetPattern = "unlimited" | "configured" | "none";
export type CostTrackingLevel = "off" | "minimal" | "full";
export type ActivityLevel = "none" | "low" | "moderate" | "high";

export type UserProjectPlan =
  | "accept-detected"
  | "solo-focused"
  | "aidlc-greenfield"
  | "multi-agent-workflow"
  | "team-product"
  | "budget-focused"
  | "enterprise-team"
  | "quick-spike";

export interface ProjectProfileSignals {
  gitRemotes: string[];
  teamSize: TeamSize;
  aiTools: AgentId[];
  budgetPattern: BudgetPattern;
  hasSharedClaudeSkills: boolean;
  isGitRepo: boolean;
  hasAidlcWorkflow: boolean;
  hasPendingProfileInit: boolean;
  branchCount: number;
  trackedFileCount: number;
  repoSizeKb: number;
  commitsLast30d: number;
  commitsTotal: number;
  projectAgeDays: number;
  authorCount30d: number;
  activityLevel: ActivityLevel;
  remoteReachable: boolean;
  remoteOriginUrl: string;
  remoteBranchCount: number;
  remoteAuthors30d: number;
  upstreamAhead: number;
  upstreamBehind: number;
  remoteProbeSource: RemoteGitSignals["remoteProbeSource"];
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
  userPlan?: UserProjectPlan;
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

export type RepoMetrics = Pick<
  ProjectProfileSignals,
  | "branchCount"
  | "trackedFileCount"
  | "repoSizeKb"
  | "commitsLast30d"
  | "commitsTotal"
  | "projectAgeDays"
  | "authorCount30d"
  | "activityLevel"
>;

const EMPTY_REPO_METRICS: RepoMetrics = {
  branchCount: 0,
  trackedFileCount: 0,
  repoSizeKb: 0,
  commitsLast30d: 0,
  commitsTotal: 0,
  projectAgeDays: 0,
  authorCount30d: 0,
  activityLevel: "none",
};

const EMPTY_REMOTE_SIGNALS: RemoteGitSignals = {
  remoteReachable: false,
  remoteOriginUrl: "",
  remoteBranchCount: 0,
  remoteAuthors30d: 0,
  upstreamAhead: 0,
  upstreamBehind: 0,
  remoteProbeSource: "none",
};

export function effectiveBranchCount(signals: ProjectProfileSignals): number {
  return Math.max(signals.branchCount, signals.remoteBranchCount);
}

export function effectiveAuthorCount30d(signals: ProjectProfileSignals): number {
  return Math.max(signals.authorCount30d, signals.remoteAuthors30d);
}

export function projectProfilePath(target: string): string {
  return path.join(target, ".claude", "learning", "project-profile.json");
}

export function projectProfileAutoDetectEnabled(target?: string): boolean {
  return projectProfileConfiguration(target).get<boolean>("autoDetect", true);
}

export function projectProfileApplyTierEnabled(target?: string): boolean {
  return projectProfileConfiguration(target).get<boolean>("applyTierFeatures", true);
}

export function projectProfilePromptOnFirstDetectEnabled(target?: string): boolean {
  return projectProfileConfiguration(target).get<boolean>("promptOnFirstDetect", true);
}

export function isLockedTierSettingRegistered(target?: string): boolean {
  return projectProfileConfiguration(target).inspect<string>("lockedTier") !== undefined;
}

export function lockedProjectProfileTier(target?: string): ProjectProfileType | undefined {
  if (!isLockedTierSettingRegistered(target)) {
    return undefined;
  }
  const raw = projectProfileConfiguration(target).get<string>("lockedTier", "");
  if (!raw) {
    return undefined;
  }
  return raw as ProjectProfileType;
}

/** Optional mirror to workspace settings — tier lock is persisted in project-profile.json. */
export async function setLockedProjectProfileTier(
  target: string,
  tier: ProjectProfileType | ""
): Promise<void> {
  if (!isLockedTierSettingRegistered(target)) {
    return;
  }
  const folderUri = configUriForTarget(target);
  const cfg = projectProfileConfiguration(target);
  const value = tier === "" ? undefined : tier;
  const scope = folderUri
    ? vscode.ConfigurationTarget.WorkspaceFolder
    : vscode.ConfigurationTarget.Workspace;
  try {
    await cfg.update("lockedTier", value, scope);
  } catch {
    // Untrusted workspace or settings UI unavailable — project-profile.json remains authoritative.
  }
}

function gitCommand(root: string, args: string[]): string | undefined {
  try {
    const out = execFileSync("git", ["-C", root, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function gitRoot(target: string): string | undefined {
  return gitCommand(target, ["rev-parse", "--show-toplevel"]);
}

export function findProjectRoot(target: string): string {
  return gitRoot(target) ?? target;
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

function parseCount(raw: string | undefined): number {
  if (!raw) {
    return 0;
  }
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

function detectAuthorCount30d(root: string): number {
  const out = gitCommand(root, ["log", "--since=30 days ago", "--format=%ae"]);
  if (!out) {
    return 0;
  }
  return new Set(out.split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter(Boolean)).size;
}

function detectTeamSize(authorCount30d: number): TeamSize {
  if (authorCount30d <= 1) {
    return "solo";
  }
  if (authorCount30d <= 4) {
    return "small";
  }
  return "team";
}

function detectActivityLevel(commitsLast30d: number): ActivityLevel {
  if (commitsLast30d >= 25) {
    return "high";
  }
  if (commitsLast30d >= 8) {
    return "moderate";
  }
  if (commitsLast30d > 0) {
    return "low";
  }
  return "none";
}

export function detectRepoMetrics(target: string, isGitRepo: boolean): RepoMetrics {
  if (!isGitRepo) {
    return { ...EMPTY_REPO_METRICS };
  }
  const root = gitRoot(target) ?? target;
  const branchOut = gitCommand(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  const branchCount = branchOut ? branchOut.split(/\r?\n/).filter(Boolean).length : 0;
  const lsFiles = gitCommand(root, ["ls-files"]);
  const trackedFiles = lsFiles ? lsFiles.split(/\r?\n/).filter(Boolean).length : 0;

  let repoSizeKb = 0;
  const countObjects = gitCommand(root, ["count-objects", "-v"]);
  if (countObjects) {
    const sizePack = countObjects.match(/^size-pack:\s*(\d+)/m);
    const sizeLoose = countObjects.match(/^size:\s*(\d+)/m);
    const packKb = sizePack?.[1] ? Math.round(parseInt(sizePack[1], 10) / 1024) : 0;
    const looseKb = sizeLoose?.[1] ? Math.round(parseInt(sizeLoose[1], 10) / 1024) : 0;
    repoSizeKb = packKb + looseKb;
  }

  const commitsLast30d = parseCount(gitCommand(root, ["rev-list", "--count", "--since=30 days ago", "HEAD"]));
  const commitsTotal = parseCount(gitCommand(root, ["rev-list", "--count", "HEAD"]));
  const authorCount30d = detectAuthorCount30d(root);
  const activityLevel = detectActivityLevel(commitsLast30d);

  let projectAgeDays = 0;
  const firstCommit = gitCommand(root, ["log", "--reverse", "--format=%aI", "-1"]);
  if (firstCommit) {
    const firstMs = Date.parse(firstCommit);
    if (Number.isFinite(firstMs)) {
      projectAgeDays = Math.max(0, Math.floor((Date.now() - firstMs) / (24 * 60 * 60 * 1000)));
    }
  }

  return {
    branchCount,
    trackedFileCount: trackedFiles,
    repoSizeKb,
    commitsLast30d,
    commitsTotal,
    projectAgeDays,
    authorCount30d,
    activityLevel,
  };
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
  if (!hasSkill || !isGitRepo) {
    return false;
  }
  const tracked = gitCommand(target, ["ls-files", "--", ".claude/skills"]);
  return Boolean(tracked?.trim());
}

const AIDLC_STATE_PATHS = [
  "aidlc-state.md",
  "docs/aidlc/aidlc-state.md",
  "aidlc-docs/aidlc-state.md",
  ".aidlc-docs/aidlc-state.md",
];

const AIDLC_DIR_MARKERS = ["docs/aidlc", "aidlc-docs", "AIDLC", ".aidlc-docs"];

const AIDLC_SKILL_NAMES = ["aidlc-tracker", "aidlc-doc-writer"];

export function detectAidlcWorkflow(target: string): boolean {
  for (const rel of AIDLC_STATE_PATHS) {
    if (fs.existsSync(path.join(target, rel))) {
      return true;
    }
  }
  for (const rel of AIDLC_DIR_MARKERS) {
    const full = path.join(target, rel);
    try {
      if (fs.existsSync(full) && fs.statSync(full).isDirectory() && fs.readdirSync(full).length > 0) {
        return true;
      }
    } catch {
      // ignore unreadable dirs
    }
  }
  for (const skill of AIDLC_SKILL_NAMES) {
    if (fs.existsSync(path.join(target, ".claude", "skills", skill, "SKILL.md"))) {
      return true;
    }
  }
  return false;
}

export function detectPendingProfileInit(target: string): boolean {
  const requestPath = path.join(target, ".claude", "learning", "profile-init-request.json");
  try {
    if (!fs.existsSync(requestPath)) {
      return false;
    }
    const raw = JSON.parse(fs.readFileSync(requestPath, "utf-8")) as { status?: string };
    return raw.status === "pending";
  } catch {
    return false;
  }
}

export function isMultiAgentGreenfield(signals: ProjectProfileSignals): boolean {
  return (
    signals.hasAidlcWorkflow ||
    signals.hasPendingProfileInit ||
    signals.aiTools.length >= 2
  );
}

function looksThrowawayByLayout(target: string, isGitRepo: boolean): boolean {
  if (!isGitRepo) {
    return true;
  }
  const base = path.basename(target);
  if (THROWAWAY_DIR_RE.test(base)) {
    return true;
  }
  const hasPackage = fs.existsSync(path.join(target, "package.json"));
  const hasReadme = fs.existsSync(path.join(target, "README.md"));
  if (!hasPackage && !hasReadme) {
    try {
      if (fs.readdirSync(target).length <= 4) {
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}

export function formatRepoEvidence(signals: ProjectProfileSignals): string {
  if (!signals.isGitRepo) {
    return "No git repository — treated as a scratch workspace.";
  }
  const branches = effectiveBranchCount(signals);
  const authors = effectiveAuthorCount30d(signals);
  const parts = [
    `${signals.trackedFileCount} tracked files`,
    `${branches} branch${branches === 1 ? "" : "es"} (${signals.branchCount} local, ${signals.remoteBranchCount} remote)`,
    `${signals.commitsTotal} commits (${signals.commitsLast30d} last 30d)`,
    `${authors} author${authors === 1 ? "" : "s"} (30d)`,
    `${signals.activityLevel} activity`,
  ];
  if (signals.repoSizeKb > 0) {
    parts.push(`~${signals.repoSizeKb} KB git objects`);
  }
  if (signals.projectAgeDays > 0) {
    parts.push(`${signals.projectAgeDays}d old`);
  }
  if (signals.hasAidlcWorkflow) {
    parts.push("AIDLC workflow");
  }
  if (signals.hasPendingProfileInit) {
    parts.push("profile-init pending");
  }
  const remoteLine = formatRemoteGitEvidence({
    remoteReachable: signals.remoteReachable,
    remoteOriginUrl: signals.remoteOriginUrl,
    remoteBranchCount: signals.remoteBranchCount,
    remoteAuthors30d: signals.remoteAuthors30d,
    upstreamAhead: signals.upstreamAhead,
    upstreamBehind: signals.upstreamBehind,
    remoteProbeSource: signals.remoteProbeSource,
  });
  const base = `Git analysis: ${parts.join(", ")}.`;
  return remoteLine ? `${base} ${remoteLine}` : base;
}

export function detectProjectProfileSignals(
  target: string,
  remoteOpts: { network?: boolean; useCache?: boolean } = { network: false, useCache: true }
): ProjectProfileSignals {
  const { remotes, isGitRepo } = detectGitRemotes(target);
  const metrics = detectRepoMetrics(target, isGitRepo);
  const remote = isGitRepo ? probeRemoteGitSignals(target, remoteOpts) : { ...EMPTY_REMOTE_SIGNALS };
  const authorEffective = Math.max(metrics.authorCount30d, remote.remoteAuthors30d);
  return {
    gitRemotes: remotes,
    teamSize: detectTeamSize(authorEffective),
    aiTools: detectAiTools(target),
    budgetPattern: detectBudgetPattern(),
    hasSharedClaudeSkills: detectSharedClaudeSkills(target, isGitRepo),
    isGitRepo,
    ...metrics,
    authorCount30d: metrics.authorCount30d,
    hasAidlcWorkflow: detectAidlcWorkflow(target),
    hasPendingProfileInit: detectPendingProfileInit(target),
    remoteReachable: remote.remoteReachable,
    remoteOriginUrl: remote.remoteOriginUrl,
    remoteBranchCount: remote.remoteBranchCount,
    remoteAuthors30d: remote.remoteAuthors30d,
    upstreamAhead: remote.upstreamAhead,
    upstreamBehind: remote.upstreamBehind,
    remoteProbeSource: remote.remoteProbeSource,
  };
}

export function isNascentRepo(signals: ProjectProfileSignals): boolean {
  return (
    signals.commitsTotal < 3 &&
    signals.trackedFileCount < 12 &&
    effectiveBranchCount(signals) <= 1 &&
    effectiveAuthorCount30d(signals) <= 1 &&
    signals.remoteBranchCount <= 1
  );
}

export function isEnterpriseRepo(signals: ProjectProfileSignals): boolean {
  return (
    signals.teamSize === "team" &&
    effectiveBranchCount(signals) >= 6 &&
    signals.trackedFileCount >= 100 &&
    signals.projectAgeDays >= 60 &&
    signals.budgetPattern === "unlimited"
  );
}

export function isTeamProductRepo(signals: ProjectProfileSignals): boolean {
  const collaborative =
    signals.teamSize !== "solo" ||
    signals.hasSharedClaudeSkills ||
    effectiveAuthorCount30d(signals) >= 2;
  const multiBranch = effectiveBranchCount(signals) >= 3;
  const remoteTeam = signals.remoteReachable && signals.remoteBranchCount >= 5;
  const substantive =
    signals.trackedFileCount >= 30 ||
    signals.commitsTotal >= 20 ||
    remoteTeam;
  const active = signals.activityLevel === "moderate" || signals.activityLevel === "high";
  return (collaborative || multiBranch || remoteTeam) && substantive && (active || collaborative || remoteTeam);
}

export function isRemoteTeamClone(signals: ProjectProfileSignals): boolean {
  return (
    signals.remoteReachable &&
    signals.remoteBranchCount >= 5 &&
    signals.commitsTotal < 20 &&
    signals.trackedFileCount < 30
  );
}

export function wantsMultiAgentSync(signals: ProjectProfileSignals): boolean {
  return (
    signals.teamSize !== "solo" ||
    effectiveBranchCount(signals) >= 3 ||
    signals.hasSharedClaudeSkills ||
    effectiveAuthorCount30d(signals) >= 2 ||
    signals.hasAidlcWorkflow ||
    signals.hasPendingProfileInit ||
    signals.aiTools.length >= 2 ||
    (signals.remoteReachable && signals.remoteBranchCount >= 3)
  );
}

export function tierForUserPlan(
  detectedType: ProjectProfileType,
  plan: UserProjectPlan
): ProjectProfileType {
  switch (plan) {
    case "accept-detected":
      return detectedType;
    case "solo-focused":
      return "solo-dev";
    case "aidlc-greenfield":
    case "multi-agent-workflow":
    case "team-product":
      return "team-multi-agent";
    case "budget-focused":
      return "budget-sensitive";
    case "enterprise-team":
      return "enterprise";
    case "quick-spike":
      return "throwaway";
    default:
      return detectedType;
  }
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
  signals: ProjectProfileSignals,
  userPlan?: UserProjectPlan
): Partial<Record<FeatureKey, boolean>> {
  switch (type) {
    case "throwaway":
      return {
        autoOptimizer: false,
        communityBenchmarks: false,
        prCostEstimate: false,
      };
    case "solo-dev":
      return {
        autoOptimizer: false,
        communityBenchmarks: false,
        prCostEstimate: false,
      };
    case "team-multi-agent":
      return {
        autoOptimizer: true,
      };
    case "budget-sensitive":
      return {
        autoOptimizer: true,
      };
    case "enterprise":
      return {
        autoOptimizer: false,
        communityBenchmarks: false,
        prCostEstimate: false,
      };
    default:
      return {};
  }
}

export function resolveProjectProfileType(
  signals: ProjectProfileSignals,
  target: string
): {
  profileType: ProjectProfileType;
  confidence: number;
  rationale: string;
} {
  const evidence = formatRepoEvidence(signals);

  if (looksThrowawayByLayout(target, signals.isGitRepo)) {
    return {
      profileType: "throwaway",
      confidence: 0.92,
      rationale: `${evidence} Scratch or non-git layout — minimal extension overhead.`,
    };
  }

  if (!signals.isGitRepo) {
    return {
      profileType: "throwaway",
      confidence: 0.9,
      rationale: `${evidence} No git repository — minimal extension overhead.`,
    };
  }

  if (signals.isGitRepo && isNascentRepo(signals)) {
    if (isMultiAgentGreenfield(signals)) {
      const reason = signals.hasAidlcWorkflow
        ? "AIDLC workflow detected"
        : signals.hasPendingProfileInit
          ? "profile-init pending"
          : "multiple AI tool folders";
      return {
        profileType: "team-multi-agent",
        confidence: signals.hasAidlcWorkflow ? 0.84 : 0.76,
        rationale: `${evidence} New project with ${reason} — full multi-agent sync from day one.`,
      };
    }
    return {
      profileType: "solo-dev",
      confidence: 0.7,
      rationale: `${evidence} New repo — solo tier by default; choose AIDLC or multi-agent in plans if you use several AI tools.`,
    };
  }

  if (isRemoteTeamClone(signals)) {
    return {
      profileType: "team-multi-agent",
      confidence: 0.84,
      rationale: `${evidence} Fresh clone of a multi-branch team repo on origin — full multi-agent sync recommended.`,
    };
  }

  if (signals.budgetPattern === "configured") {
    return {
      profileType: "budget-sensitive",
      confidence: 0.82,
      rationale: `${evidence} Economy budget mode — full cost tracking with alerts.`,
    };
  }

  if (isEnterpriseRepo(signals)) {
    return {
      profileType: "enterprise",
      confidence: 0.78,
      rationale: `${evidence} Mature team repo (many branches/files, long history) — multi-agent without ROI overhead.`,
    };
  }

  if (isTeamProductRepo(signals)) {
    const branches = effectiveBranchCount(signals);
    const authors = effectiveAuthorCount30d(signals);
    const confidence =
      signals.teamSize === "team"
        ? 0.88
        : branches >= 5 || authors >= 3 || signals.remoteBranchCount >= 8
          ? 0.85
          : 0.75;
    return {
      profileType: "team-multi-agent",
      confidence,
      rationale: `${evidence} Collaborative or multi-branch product — full sync and attribution.`,
    };
  }

  const soloConfidence =
    signals.commitsTotal < 10 && signals.trackedFileCount < 40 ? 0.8 : 0.72;
  return {
    profileType: "solo-dev",
    confidence: soloConfidence,
    rationale: `${evidence} Solo, low-intensity product — branch profiles with token-saving focus.`,
  };
}

export function buildProjectProfile(
  target: string,
  overrideType?: ProjectProfileType,
  userPlan?: UserProjectPlan,
  remoteOpts?: { network?: boolean; useCache?: boolean }
): ProjectProfileFile {
  const signals = detectProjectProfileSignals(target, remoteOpts);
  const autoResolved = resolveProjectProfileType(signals, target);
  const resolvedType = overrideType ?? autoResolved.profileType;
  const resolved = overrideType
    ? {
        profileType: overrideType,
        confidence: userPlan === "accept-detected" ? autoResolved.confidence : 1,
        rationale:
          userPlan && userPlan !== "accept-detected"
            ? `${formatRepoEvidence(signals)} Plan: ${userPlan.replace(/-/g, " ")} — ${PROFILE_TYPE_LABELS[overrideType]}.`
            : `Manual tier: ${PROFILE_TYPE_LABELS[overrideType]}. ${formatRepoEvidence(signals)}`,
      }
    : autoResolved;
  const enabledFeatures = tierFeaturePreset(resolved.profileType, signals, userPlan);
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
    userPlan,
    rationale: resolved.rationale,
  };
}

/** Probe origin via git ls-remote when choosing a tier (extension-only, no AI agent). */
export async function buildProjectProfileWithRemoteProbe(
  target: string,
  overrideType?: ProjectProfileType,
  userPlan?: UserProjectPlan
): Promise<ProjectProfileFile> {
  return buildProjectProfile(target, overrideType, userPlan, { network: true, useCache: true });
}

export function shouldRefreshProjectProfile(existing: ProjectProfileFile, built: ProjectProfileFile): boolean {
  if (existing.profileType !== built.profileType) {
    return true;
  }
  if (existing.manualOverride !== built.manualOverride) {
    return true;
  }
  if (existing.userPlan !== built.userPlan) {
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

/** Mirror workspace lockedTier setting into project-profile.json when no explicit user plan is set. */
export function syncLockedTierSettingToProfile(target: string): void {
  const existing = readProjectProfile(target);
  if (existing?.userPlan && existing.userPlan !== "accept-detected") {
    return;
  }
  const tier = lockedProjectProfileTier(target);
  if (!tier) {
    if (existing?.manualOverride) {
      writeProjectProfile(target, {
        ...existing,
        manualOverride: undefined,
        userPlan: "accept-detected",
      });
    }
    return;
  }
  const built = buildProjectProfile(target, tier, undefined, { network: false, useCache: true });
  writeProjectProfile(target, {
    ...built,
    detectedFrom: existing?.detectedFrom ?? built.detectedFrom,
    detectedAt: existing?.detectedAt ?? built.detectedAt,
    manualOverride: tier,
    userPlan: "accept-detected",
    appliedAt: new Date().toISOString(),
  });
}

export interface ProjectProfileRefreshResult {
  profile?: ProjectProfileFile;
  changed: boolean;
  /** True when profileType changed vs the previous on-disk profile. */
  tierChanged: boolean;
  isFirstDetect: boolean;
}

/** True when tier/plan/mirror mode meaningfully changed (not preset key presence noise). */
function tierMirrorSemanticsChanged(existing: ProjectProfileFile, built: ProjectProfileFile): boolean {
  if (existing.profileType !== built.profileType) {
    return true;
  }
  if ((existing.userPlan ?? "accept-detected") !== (built.userPlan ?? "accept-detected")) {
    return true;
  }
  return false;
}

function mergeProjectProfileRefresh(
  existing: ProjectProfileFile | undefined,
  built: ProjectProfileFile
): { profile: ProjectProfileFile; tierChanged: boolean } {
  const tierChanged = !existing || tierMirrorSemanticsChanged(existing, built);
  if (!existing || tierChanged) {
    return {
      profile: {
        ...built,
        userPlan: built.userPlan ?? existing?.userPlan,
        detectedFrom: built.detectedFrom ?? existing?.detectedFrom ?? built.detectedFrom,
        manualOverride: built.manualOverride ?? existing?.manualOverride,
      },
      tierChanged,
    };
  }
  return {
    profile: {
      ...built,
      detectedAt: existing.detectedAt,
      appliedAt: existing.appliedAt ?? built.appliedAt,
      userPlan: built.userPlan ?? existing.userPlan,
      manualOverride: built.manualOverride ?? existing.manualOverride,
      detectedFrom: existing.detectedFrom,
    },
    tierChanged: false,
  };
}

export function refreshProjectProfileContext(target: string | undefined): ProjectProfileRefreshResult {
  const apply = projectProfileApplyTierEnabled(target);
  if (!target) {
    setActiveProjectProfileContext(null, apply);
    return { changed: false, tierChanged: false, isFirstDetect: false };
  }
  const existing = readProjectProfile(target);
  const locked = effectiveLockedTier(existing, target);
  if (projectProfileAutoDetectEnabled(target) && !locked) {
    const built = buildProjectProfile(target);
    if (!existing || shouldRefreshProjectProfile(existing, built)) {
      const isFirstDetect = !existing;
      const { profile, tierChanged } = mergeProjectProfileRefresh(existing, built);
      writeProjectProfile(target, profile);
      setActiveProjectProfileContext(profile.enabledFeatures, apply);
      return { profile, changed: true, tierChanged, isFirstDetect };
    }
    setActiveProjectProfileContext(existing.enabledFeatures, apply);
    return { profile: existing, changed: false, tierChanged: false, isFirstDetect: false };
  }
  if (locked) {
    const builtBase = buildProjectProfile(target, locked, existing?.userPlan, {
      network: false,
      useCache: true,
    });
    const built: ProjectProfileFile = existing?.detectedFrom
      ? { ...builtBase, detectedFrom: existing.detectedFrom }
      : builtBase;
    const structuralChange =
      !existing ||
      existing.profileType !== built.profileType ||
      existing.manualOverride !== built.manualOverride ||
      existing.userPlan !== built.userPlan;
    const { profile, tierChanged } = mergeProjectProfileRefresh(existing, built);
    if (structuralChange) {
      writeProjectProfile(target, profile);
    }
    setActiveProjectProfileContext(profile.enabledFeatures, apply);
    return { profile, changed: structuralChange, tierChanged, isFirstDetect: !existing };
  }
  setActiveProjectProfileContext(existing?.enabledFeatures ?? null, apply);
  return { profile: existing, changed: false, tierChanged: false, isFirstDetect: false };
}

export function formatProjectProfileSummary(profile: ProjectProfileFile): string {
  const on = (k: FeatureKey) => profile.enabledFeatures[k] ?? DEFAULTS[k];
  const s = profile.detectedFrom;
  const lines = [
    `Profile: ${PROFILE_TYPE_LABELS[profile.profileType]} (${profile.profileType})`,
    profile.rationale,
    `Cost tracking: ${profile.costTracking}`,
    `Repo: ${s.trackedFileCount} files, ${effectiveBranchCount(s)} branches (${s.branchCount} local, ${s.remoteBranchCount} remote), ${s.commitsTotal} commits, ${s.activityLevel} activity`,
    `Team (30d): ${s.teamSize} (${effectiveAuthorCount30d(s)} authors)`,
    s.remoteOriginUrl ? `Origin: ${s.remoteOriginUrl} (${s.remoteProbeSource})` : undefined,
    profile.userPlan ? `Plan: ${profile.userPlan}` : undefined,
    `Features: autoOptimizer=${on("autoOptimizer") ? "on" : "off"}, communityBenchmarks=${on("communityBenchmarks") ? "on" : "off"}, prCostEstimate=${on("prCostEstimate") ? "on" : "off"}`,
  ].filter((l): l is string => Boolean(l));
  return lines.join("\n");
}

export function formatProjectProfileStatusBarText(profile: ProjectProfileFile): string {
  return `Project: ${PROFILE_TYPE_LABELS[profile.profileType]}`;
}

export function formatProjectProfileStatusBarTooltip(profile: ProjectProfileFile): string {
  const on = (k: FeatureKey) => profile.enabledFeatures[k] ?? DEFAULTS[k];
  const features = [
    on("autoOptimizer") ? "Auto Optimizer" : null,
    on("communityBenchmarks") ? "Community Benchmarks" : null,
    on("prCostEstimate") ? "PR Cost Estimate" : null,
  ].filter((f): f is string => Boolean(f));
  
  return `Profile: ${profile.profileType}\nCost Tracking: ${profile.costTracking}\nFeatures: ${features.length > 0 ? features.join(", ") : "None"}`;
}

export function effectiveFeatureMap(target: string): Record<string, boolean> {
  const profile = readProjectProfile(target);
  const apply = projectProfileApplyTierEnabled(target);
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

/** True when project tier/settings require mirroring to the host IDE only (solo-dev, budget-focused, …). */
export function hostOnlyMirrorModeForTarget(target: string): boolean {
  const profile = readProjectProfile(target);
  if (
    profile?.profileType === "solo-dev" ||
    profile?.profileType === "budget-sensitive" ||
    profile?.userPlan === "solo-focused" ||
    profile?.userPlan === "budget-focused"
  ) {
    return true;
  }
  return effectiveFeatureMap(target).multiAgent === false;
}
