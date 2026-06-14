import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: (section: string) => ({
      get: <T>(key: string, defaultValue: T): T => defaultValue,
    }),
  },
}));

import {
  detectProjectProfileSignals,
  resolveProjectProfileType,
  tierFeaturePreset,
  buildProjectProfile,
  shouldRefreshProjectProfile,
  effectiveFeatureMap,
  effectiveBranchCount,
  effectiveAuthorCount30d,
  isRemoteTeamClone,
  isTeamProductRepo,
  readProjectProfile,
  refreshProjectProfileContext,
  writeProjectProfile,
  formatRepoEvidence,
  isNascentRepo,
  isMultiAgentGreenfield,
  detectAidlcWorkflow,
  tierForUserPlan,
  ProjectProfileSignals,
  ProjectProfileFile,
} from "./projectProfile";

const workspaces: string[] = [];

function baseSignals(overrides: Partial<ProjectProfileSignals> = {}): ProjectProfileSignals {
  return {
    gitRemotes: [],
    teamSize: "solo",
    aiTools: [],
    budgetPattern: "none",
    hasSharedClaudeSkills: false,
    isGitRepo: true,
    hasAidlcWorkflow: false,
    hasPendingProfileInit: false,
    branchCount: 1,
    trackedFileCount: 15,
    repoSizeKb: 100,
    commitsLast30d: 2,
    commitsTotal: 5,
    projectAgeDays: 14,
    authorCount30d: 1,
    activityLevel: "low",
    remoteReachable: false,
    remoteOriginUrl: "",
    remoteBranchCount: 0,
    remoteAuthors30d: 0,
    upstreamAhead: 0,
    upstreamBehind: 0,
    remoteProbeSource: "none",
    ...overrides,
  };
}

function makeWorkspace(name: string, files: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `projprof-${name}-`));
  workspaces.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

afterEach(() => {
  for (const ws of workspaces.splice(0)) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

describe("projectProfile tiers", () => {
  it("solo-dev preset disables multi-agent sync and attribution", () => {
    const preset = tierFeaturePreset("solo-dev", baseSignals());
    expect(preset.multiAgent).toBe(false);
    expect(preset.attributionCollector).toBe(false);
    expect(preset.branchProfiles).toBe(true);
    expect(preset.deterministicTaskProposals).toBe(true);
  });

  it("throwaway preset disables almost all features", () => {
    const preset = tierFeaturePreset("throwaway", baseSignals({ isGitRepo: false }));
    expect(preset.costIntelligence).toBe(false);
    expect(preset.sessionSkillAdaptation).toBe(false);
    expect(preset.branchProfiles).toBe(false);
  });

  it("team-multi-agent enables full stack", () => {
    const preset = tierFeaturePreset(
      "team-multi-agent",
      baseSignals({
        gitRemotes: ["git@github.com:acme/app.git"],
        teamSize: "team",
        hasSharedClaudeSkills: true,
        branchCount: 5,
        authorCount30d: 4,
      })
    );
    expect(preset.multiAgent).toBe(true);
    expect(preset.autoOptimizer).toBe(true);
    expect(preset.teamCostSharing).toBe(true);
  });

  it("budget-sensitive enables multi-agent from repo collaboration signals", () => {
    const soloRepo = baseSignals({ budgetPattern: "configured" });
    expect(tierFeaturePreset("budget-sensitive", soloRepo).multiAgent).toBe(false);

    const collaborative = baseSignals({
      budgetPattern: "configured",
      branchCount: 4,
      authorCount30d: 2,
    });
    expect(tierFeaturePreset("budget-sensitive", collaborative).multiAgent).toBe(true);
  });
});

describe("resolveProjectProfileType", () => {
  it("picks throwaway for non-git scratch dirs", () => {
    const target = makeWorkspace("scratch", { "foo.txt": "x" });
    const signals = baseSignals({ isGitRepo: false, activityLevel: "none" });
    const resolved = resolveProjectProfileType(signals, target);
    expect(resolved.profileType).toBe("throwaway");
  });

  it("picks solo-dev for nascent git repos without multi-agent signals", () => {
    const target = makeWorkspace("nascent", { "package.json": "{}", "README.md": "# x" });
    const signals = baseSignals({
      commitsTotal: 1,
      trackedFileCount: 5,
      branchCount: 1,
      commitsLast30d: 1,
      activityLevel: "low",
    });
    expect(isNascentRepo(signals)).toBe(true);
    const resolved = resolveProjectProfileType(signals, target);
    expect(resolved.profileType).toBe("solo-dev");
    expect(resolved.rationale).toContain("AIDLC");
  });

  it("picks team-multi-agent for nascent AIDLC greenfield repos", () => {
    const target = makeWorkspace("aidlc", {
      "package.json": "{}",
      "README.md": "# x",
      "docs/aidlc/aidlc-state.md": "# state\n",
    });
    expect(detectAidlcWorkflow(target)).toBe(true);
    const signals = baseSignals({
      commitsTotal: 1,
      trackedFileCount: 4,
      branchCount: 1,
      hasAidlcWorkflow: true,
    });
    const resolved = resolveProjectProfileType(signals, target);
    expect(resolved.profileType).toBe("team-multi-agent");
    expect(resolved.rationale).toContain("AIDLC");
  });

  it("picks team-multi-agent for nascent repos with multiple AI tool folders", () => {
    const target = makeWorkspace("multitool", {
      "package.json": "{}",
      "README.md": "# x",
      ".cursor/rules": "",
      ".github/copilot-instructions.md": "# copilot",
    });
    const signals = baseSignals({
      commitsTotal: 1,
      trackedFileCount: 6,
      aiTools: ["cursor", "copilot"],
    });
    expect(isMultiAgentGreenfield(signals)).toBe(true);
    const resolved = resolveProjectProfileType(signals, target);
    expect(resolved.profileType).toBe("team-multi-agent");
  });

  it("picks team-multi-agent from git activity not AI tool folders", () => {
    const signals = baseSignals({
      gitRemotes: ["https://github.com/acme/repo"],
      teamSize: "small",
      hasSharedClaudeSkills: true,
      branchCount: 4,
      trackedFileCount: 50,
      commitsTotal: 30,
      commitsLast30d: 10,
      authorCount30d: 2,
      activityLevel: "moderate",
    });
    const target = makeWorkspace("team", { "package.json": "{}", "README.md": "# team" });
    const resolved = resolveProjectProfileType(signals, target);
    expect(resolved.profileType).toBe("team-multi-agent");
    expect(resolved.rationale).toContain("Git analysis");
  });

  it("picks team-multi-agent for fresh clone of remote team repo", () => {
    const signals = baseSignals({
      commitsTotal: 2,
      trackedFileCount: 8,
      branchCount: 1,
      remoteReachable: true,
      remoteBranchCount: 12,
      remoteOriginUrl: "https://github.com/acme/monorepo.git",
      remoteProbeSource: "ls-remote",
    });
    expect(isRemoteTeamClone(signals)).toBe(true);
    const target = makeWorkspace("clone", { "package.json": "{}", "README.md": "# x" });
    const resolved = resolveProjectProfileType(signals, target);
    expect(resolved.profileType).toBe("team-multi-agent");
    expect(resolved.rationale).toContain("Fresh clone");
  });

  it("picks team-multi-agent from remote branch signals on nascent local clone", () => {
    const signals = baseSignals({
      commitsTotal: 1,
      trackedFileCount: 8,
      branchCount: 1,
      remoteReachable: true,
      remoteBranchCount: 8,
      remoteOriginUrl: "https://github.com/acme/repo.git",
      remoteProbeSource: "ls-remote",
    });
    expect(effectiveBranchCount(signals)).toBe(8);
    expect(isTeamProductRepo({ ...signals, trackedFileCount: 40, commitsTotal: 25 })).toBe(true);
  });

  it("uses effective author count from remote history", () => {
    const signals = baseSignals({ authorCount30d: 1, remoteAuthors30d: 4, remoteReachable: true });
    expect(effectiveAuthorCount30d(signals)).toBe(4);
    expect(detectTeamSizeFromSignals(signals)).toBe("small");
  });

  it("picks budget-sensitive when budget configured", () => {
    const signals = baseSignals({ budgetPattern: "configured" });
    const target = makeWorkspace("budget", { "package.json": "{}" });
    const resolved = resolveProjectProfileType(signals, target);
    expect(resolved.profileType).toBe("budget-sensitive");
  });
});

function detectTeamSizeFromSignals(signals: ProjectProfileSignals): ProjectProfileSignals["teamSize"] {
  const authors = effectiveAuthorCount30d(signals);
  if (authors <= 1) return "solo";
  if (authors <= 4) return "small";
  return "team";
}

describe("tierForUserPlan", () => {
  it("maps user plans to tiers", () => {
    expect(tierForUserPlan("solo-dev", "accept-detected")).toBe("solo-dev");
    expect(tierForUserPlan("solo-dev", "aidlc-greenfield")).toBe("team-multi-agent");
    expect(tierForUserPlan("solo-dev", "multi-agent-workflow")).toBe("team-multi-agent");
    expect(tierForUserPlan("solo-dev", "budget-focused")).toBe("budget-sensitive");
    expect(tierForUserPlan("solo-dev", "enterprise-team")).toBe("enterprise");
    expect(tierForUserPlan("team-multi-agent", "quick-spike")).toBe("throwaway");
  });
});

describe("formatRepoEvidence", () => {
  it("summarizes git metrics", () => {
    const text = formatRepoEvidence(baseSignals({ branchCount: 3, trackedFileCount: 42 }));
    expect(text).toContain("42 tracked files");
    expect(text).toContain("3 branches");
  });
});

describe("buildProjectProfile", () => {
  it("writes manual override type", () => {
    const target = makeWorkspace("manual", { "package.json": "{}", "README.md": "# x" });
    const profile = buildProjectProfile(target, "enterprise");
    expect(profile.profileType).toBe("enterprise");
    expect(profile.manualOverride).toBe("enterprise");
    expect(profile.enabledFeatures.multiAgent).toBe(true);
    expect(profile.enabledFeatures.attributionCollector).toBe(false);
  });
});

describe("refreshProjectProfileContext", () => {
  it("preserves detectedAt when signals refresh but tier is unchanged", () => {
    const target = makeWorkspace("refresh-preserve", { "package.json": "{}", "README.md": "# x" });
    const first = buildProjectProfile(target);
    const detectedAt = "2020-01-01T00:00:00.000Z";
    writeProjectProfile(target, { ...first, detectedAt, userPlan: "accept-detected" });
    const result = refreshProjectProfileContext(target);
    expect(result.changed).toBe(true);
    expect(result.tierChanged).toBe(false);
    const onDisk = readProjectProfile(target);
    expect(onDisk?.detectedAt).toBe(detectedAt);
    expect(onDisk?.userPlan).toBe("accept-detected");
  });
});

describe("shouldRefreshProjectProfile", () => {
  it("skips rewrite when profile is fresh and unchanged", () => {
    const signals = baseSignals();
    const built = {
      version: 1 as const,
      profileType: "solo-dev" as const,
      detectedFrom: signals,
      enabledFeatures: { multiAgent: false },
      costTracking: "minimal" as const,
      confidence: 0.75,
      detectedAt: new Date().toISOString(),
      rationale: "solo",
    };
    expect(shouldRefreshProjectProfile(built, built)).toBe(false);
  });

  it("refreshes when user plan changes", () => {
    const signals = baseSignals();
    const existing: ProjectProfileFile = {
      version: 1,
      profileType: "solo-dev",
      detectedFrom: signals,
      enabledFeatures: {},
      costTracking: "minimal",
      confidence: 0.75,
      detectedAt: new Date().toISOString(),
      userPlan: "accept-detected",
      rationale: "solo",
    };
    const built: ProjectProfileFile = {
      ...existing,
      userPlan: "multi-agent-workflow",
      profileType: "team-multi-agent",
    };
    expect(shouldRefreshProjectProfile(existing, built)).toBe(true);
  });
});

describe("effectiveFeatureMap", () => {
  it("reads throwaway tier from project-profile.json on disk", () => {
    const target = makeWorkspace("effmap", { "package.json": "{}" });
    writeProjectProfile(target, buildProjectProfile(target, "throwaway"));
    const map = effectiveFeatureMap(target);
    expect(map.sessionSkillAdaptation).toBe(false);
    expect(map.costIntelligence).toBe(false);
  });
});
