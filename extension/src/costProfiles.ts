import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SkillAttributionMap } from "./costAttribution";
import { tierForSkill } from "./skillCost";
import { loadManifest } from "./skillOps";
import { SkillUsageStat } from "./usageStats";

export interface ProjectCostProfile {
  typical_monthly_cost: number;
  expensive_skills: string[];
  cheap_alternatives: Record<string, string>;
  cost_per_debug_session?: number;
  updatedAt: string;
}

/** @deprecated Global store — migrate to per-workspace cost-profile.json */
export const LEGACY_COST_PROFILES_PATH = path.join(os.homedir(), ".claude", "learning", "cost-profiles.json");

/** @deprecated Use costProfilePath(target) */
export const COST_PROFILES_PATH = LEGACY_COST_PROFILES_PATH;

export function costProfilePath(target: string): string {
  return path.join(target, ".claude", "learning", "cost-profile.json");
}

const PROFILE_HINTS: Record<string, string> = {
  "terraform-plan-review": "Use terraform validate locally before plan-review to reduce tokens by ~60%",
  "adx-schema-check": "Run schema diff against committed definitions only",
  "azure-rbac-diagnostics": "Collect exact error text before invoking — avoids broad permission scans",
};

function migrateLegacyProfile(target: string): boolean {
  const wsPath = costProfilePath(target);
  if (fs.existsSync(wsPath) || !fs.existsSync(LEGACY_COST_PROFILES_PATH)) {
    return false;
  }
  try {
    const store = JSON.parse(fs.readFileSync(LEGACY_COST_PROFILES_PATH, "utf-8")) as {
      profiles?: Record<string, ProjectCostProfile>;
    };
    const profiles = store.profiles ?? {};
    const first = Object.values(profiles)[0];
    if (!first) {
      return false;
    }
    fs.mkdirSync(path.dirname(wsPath), { recursive: true });
    fs.writeFileSync(wsPath, JSON.stringify(first, null, 2) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

function readProfile(target: string): ProjectCostProfile | null {
  migrateLegacyProfile(target);
  const file = costProfilePath(target);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as ProjectCostProfile;
  } catch {
    return null;
  }
}

function writeProfile(target: string, profile: ProjectCostProfile): void {
  const file = costProfilePath(target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(profile, null, 2) + "\n", "utf-8");
}

export function updateCostProfileFromAttribution(
  target: string,
  libraryDir: string,
  attribution: SkillAttributionMap,
  usageStats: SkillUsageStat[]
): ProjectCostProfile {
  const manifest = loadManifest(libraryDir);

  const expensive = Object.entries(attribution)
    .map(([skill, agents]) => ({
      skill,
      cost: Object.values(agents).reduce((s, a) => s + (a?.cost ?? 0), 0),
      tier: tierForSkill(manifest.skills[skill]?.cost_estimate),
    }))
    .filter((r) => r.cost > 0)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 8)
    .map((r) => r.skill);

  const monthly =
    Object.values(attribution).reduce(
      (sum, agents) => sum + Object.values(agents).reduce((s, a) => s + (a?.cost ?? 0), 0),
      0
    ) * 2;

  const debugRuns = usageStats.filter((s) => s.runs > 0 && s.name.includes("debug"));
  const debugCost =
    debugRuns.length > 0
      ? debugRuns.reduce((s, r) => s + (r.totalTokens ?? 0), 0) / 1_000_000 / debugRuns.length
      : undefined;

  const cheap_alternatives: Record<string, string> = {};
  for (const skill of expensive) {
    if (PROFILE_HINTS[skill]) {
      cheap_alternatives[skill] = PROFILE_HINTS[skill];
    }
  }

  const profile: ProjectCostProfile = {
    typical_monthly_cost: Math.round(monthly * 100) / 100,
    expensive_skills: expensive,
    cheap_alternatives,
    cost_per_debug_session: debugCost,
    updatedAt: new Date().toISOString(),
  };

  writeProfile(target, profile);
  return profile;
}

export function getProfileTip(_target: string, _libraryDir: string, skill: string): string | undefined {
  const profile = readProfile(_target);
  return profile?.cheap_alternatives[skill] ?? PROFILE_HINTS[skill];
}

export function loadCostProfile(target: string, _libraryDir: string): ProjectCostProfile | null {
  return readProfile(target);
}
