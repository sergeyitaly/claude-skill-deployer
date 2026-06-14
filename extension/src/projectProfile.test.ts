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
  writeProjectProfile,
  ProjectProfileSignals,
  ProjectProfileFile,
} from "./projectProfile";

const workspaces: string[] = [];

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
    const signals: ProjectProfileSignals = {
      gitRemotes: [],
      teamSize: "solo",
      aiTools: ["claude"],
      budgetPattern: "none",
      hasSharedClaudeSkills: false,
      isGitRepo: true,
    };
    const preset = tierFeaturePreset("solo-dev", signals);
    expect(preset.multiAgent).toBe(false);
    expect(preset.attributionCollector).toBe(false);
    expect(preset.branchProfiles).toBe(true);
    expect(preset.deterministicTaskProposals).toBe(true);
  });

  it("throwaway preset disables almost all features", () => {
    const signals: ProjectProfileSignals = {
      gitRemotes: [],
      teamSize: "solo",
      aiTools: ["claude"],
      budgetPattern: "none",
      hasSharedClaudeSkills: false,
      isGitRepo: false,
    };
    const preset = tierFeaturePreset("throwaway", signals);
    expect(preset.costIntelligence).toBe(false);
    expect(preset.sessionSkillAdaptation).toBe(false);
    expect(preset.branchProfiles).toBe(false);
  });

  it("team-multi-agent enables full stack", () => {
    const signals: ProjectProfileSignals = {
      gitRemotes: ["git@github.com:acme/app.git"],
      teamSize: "team",
      aiTools: ["claude", "cursor", "copilot"],
      budgetPattern: "none",
      hasSharedClaudeSkills: true,
      isGitRepo: true,
    };
    const preset = tierFeaturePreset("team-multi-agent", signals);
    expect(preset.multiAgent).toBe(true);
    expect(preset.autoOptimizer).toBe(true);
    expect(preset.teamCostSharing).toBe(true);
  });

  it("budget-sensitive enables multi-agent only when multiple tools detected", () => {
    const soloTools: ProjectProfileSignals = {
      gitRemotes: [],
      teamSize: "solo",
      aiTools: ["claude"],
      budgetPattern: "configured",
      hasSharedClaudeSkills: false,
      isGitRepo: true,
    };
    expect(tierFeaturePreset("budget-sensitive", soloTools).multiAgent).toBe(false);

    const multi: ProjectProfileSignals = { ...soloTools, aiTools: ["claude", "cursor"] };
    expect(tierFeaturePreset("budget-sensitive", multi).multiAgent).toBe(true);
  });
});

describe("resolveProjectProfileType", () => {
  it("picks throwaway for non-git scratch dirs", () => {
    const target = makeWorkspace("scratch", { "foo.txt": "x" });
    const signals: ProjectProfileSignals = {
      gitRemotes: [],
      teamSize: "solo",
      aiTools: ["claude"],
      budgetPattern: "none",
      hasSharedClaudeSkills: false,
      isGitRepo: false,
    };
    const resolved = resolveProjectProfileType(signals, target);
    expect(resolved.profileType).toBe("throwaway");
  });

  it("picks team-multi-agent when multiple tools and team signals", () => {
    const signals: ProjectProfileSignals = {
      gitRemotes: ["https://github.com/acme/repo"],
      teamSize: "small",
      aiTools: ["claude", "cursor"],
      budgetPattern: "none",
      hasSharedClaudeSkills: true,
      isGitRepo: true,
    };
    const target = makeWorkspace("team", { "package.json": "{}", "README.md": "# team" });
    const resolved = resolveProjectProfileType(signals, target);
    expect(resolved.profileType).toBe("team-multi-agent");
  });

  it("picks budget-sensitive when budget configured", () => {
    const signals: ProjectProfileSignals = {
      gitRemotes: [],
      teamSize: "solo",
      aiTools: ["claude"],
      budgetPattern: "configured",
      hasSharedClaudeSkills: false,
      isGitRepo: true,
    };
    const target = makeWorkspace("budget", { "package.json": "{}" });
    const resolved = resolveProjectProfileType(signals, target);
    expect(resolved.profileType).toBe("budget-sensitive");
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

describe("shouldRefreshProjectProfile", () => {
  it("skips rewrite when profile is fresh and unchanged", () => {
    const signals: ProjectProfileSignals = {
      gitRemotes: [],
      teamSize: "solo",
      aiTools: ["claude"],
      budgetPattern: "none",
      hasSharedClaudeSkills: false,
      isGitRepo: true,
    };
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

  it("refreshes when manual override cleared", () => {
    const signals: ProjectProfileSignals = {
      gitRemotes: [],
      teamSize: "solo",
      aiTools: ["claude"],
      budgetPattern: "none",
      hasSharedClaudeSkills: false,
      isGitRepo: true,
    };
    const existing: ProjectProfileFile = {
      version: 1,
      profileType: "enterprise",
      detectedFrom: signals,
      enabledFeatures: {},
      costTracking: "minimal",
      confidence: 1,
      detectedAt: new Date().toISOString(),
      manualOverride: "enterprise",
      rationale: "locked",
    };
    const built: ProjectProfileFile = {
      ...existing,
      profileType: "solo-dev",
      manualOverride: undefined,
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
