import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SkillAttributionMap } from "./costAttribution";
import { tierForSkill } from "./skillCost";
import { detectRelevantSkills, loadManifest, Manifest } from "./skillOps";
import { SkillUsageStat } from "./usageStats";

export interface ProjectCostProfile {
  typical_monthly_cost: number;
  expensive_skills: string[];
  cheap_alternatives: Record<string, string>;
  cost_per_debug_session?: number;
  updatedAt: string;
}

export interface CostProfilesStore {
  version: 1;
  profiles: Record<string, ProjectCostProfile>;
}

export const COST_PROFILES_PATH = path.join(os.homedir(), ".claude", "learning", "cost-profiles.json");

const PROFILE_HINTS: Record<string, string> = {
  "terraform-plan-review": "Use terraform validate locally before plan-review to reduce tokens by ~60%",
  "adx-schema-check": "Run schema diff against committed definitions only",
  "azure-rbac-diagnostics": "Collect exact error text before invoking — avoids broad permission scans",
};

function readStore(): CostProfilesStore {
  if (!fs.existsSync(COST_PROFILES_PATH)) {
    return { version: 1, profiles: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(COST_PROFILES_PATH, "utf-8")) as CostProfilesStore;
  } catch {
    return { version: 1, profiles: {} };
  }
}

function writeStore(store: CostProfilesStore): void {
  fs.mkdirSync(path.dirname(COST_PROFILES_PATH), { recursive: true });
  fs.writeFileSync(COST_PROFILES_PATH, JSON.stringify(store, null, 2) + "\n", "utf-8");
}

function profileKeyForTarget(target: string, manifest: Manifest): string {
  const detected = detectRelevantSkills(target, manifest);
  const names = Object.keys(detected).sort();
  if (names.length === 0) {
    return `generic-${crypto.createHash("sha1").update(target).digest("hex").slice(0, 8)}`;
  }
  const tags: string[] = [];
  if (names.some((n) => n.includes("terraform"))) {
    tags.push("terraform");
  }
  if (names.some((n) => n.startsWith("azure-"))) {
    tags.push("azure");
  }
  if (names.some((n) => n.includes("gitlab") || n.includes("ci-"))) {
    tags.push("ci");
  }
  if (names.some((n) => n.includes("adx") || n.includes("kusto"))) {
    tags.push("adx");
  }
  return tags.length > 0 ? `${tags.join("-")}-project` : `stack-${names.slice(0, 3).join("-")}`;
}

export function updateCostProfileFromAttribution(
  target: string,
  libraryDir: string,
  attribution: SkillAttributionMap,
  usageStats: SkillUsageStat[]
): ProjectCostProfile {
  const manifest = loadManifest(libraryDir);
  const key = profileKeyForTarget(target, manifest);
  const store = readStore();

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

  const monthly = Object.values(attribution).reduce(
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

  store.profiles[key] = profile;
  writeStore(store);
  return profile;
}

export function getProfileTip(target: string, libraryDir: string, skill: string): string | undefined {
  const manifest = loadManifest(libraryDir);
  const key = profileKeyForTarget(target, manifest);
  const store = readStore();
  return store.profiles[key]?.cheap_alternatives[skill] ?? PROFILE_HINTS[skill];
}

export function loadCostProfile(target: string, libraryDir: string): ProjectCostProfile | null {
  const manifest = loadManifest(libraryDir);
  const key = profileKeyForTarget(target, manifest);
  return readStore().profiles[key] ?? null;
}
