import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { SkillAttributionMap } from "./costAttribution";
import { isFeatureEnabled } from "./featureFlags";
import { invalidateTeamEconomicsCache } from "./teamEconomicsCache";
import { invalidateDashboardSnapshot } from "./dashboardSnapshotCache";

export interface SkillAuthorAttribution {
  skill: string;
  author: string;
  authorEmail?: string;
  committedAt?: string;
  monthlyCost: number;
  line: string;
}

interface BlameCacheEntry {
  mtimeMs: number;
  author: string | null;
  email?: string;
  date?: string;
}

const blameCache = new Map<string, BlameCacheEntry>();

function blameCacheKey(target: string, relPath: string): string {
  return `${path.normalize(target)}|${relPath}`;
}

export function invalidateAuthorAttributionCache(target?: string): void {
  if (!target) {
    blameCache.clear();
    invalidateTeamEconomicsCache();
    invalidateDashboardSnapshot();
    return;
  }
  const prefix = `${path.normalize(target)}|`;
  for (const key of [...blameCache.keys()]) {
    if (key.startsWith(prefix)) {
      blameCache.delete(key);
    }
  }
  invalidateTeamEconomicsCache(target);
  invalidateDashboardSnapshot(target);
}

/** Test/diagnostic — entries in the git-author blame cache. */
export function blameCacheSize(): number {
  return blameCache.size;
}

function gitBlameAuthor(target: string, relPath: string): { author: string; email?: string; date?: string } | null {
  const full = path.join(target, relPath);
  if (!fs.existsSync(full)) {
    return null;
  }
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(full).mtimeMs;
  } catch {
    return null;
  }
  const cacheKey = blameCacheKey(target, relPath);
  const hit = blameCache.get(cacheKey);
  if (hit && hit.mtimeMs === mtimeMs) {
    if (!hit.author) {
      return null;
    }
    return { author: hit.author, email: hit.email, date: hit.date };
  }
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%an|%ae|%aI", "--", relPath], {
      cwd: target,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const [author, email, date] = out.split("|");
    if (!author) {
      blameCache.set(cacheKey, { mtimeMs, author: null });
      return null;
    }
    blameCache.set(cacheKey, { mtimeMs, author, email, date });
    return { author, email, date };
  } catch {
    blameCache.set(cacheKey, { mtimeMs, author: null });
    return null;
  }
}

function skillMonthlyCost(skill: string, attribution: SkillAttributionMap): number {
  const agents = attribution[skill];
  if (!agents) {
    return 0;
  }
  const total = Object.values(agents).reduce((s, a) => s + (a?.cost ?? 0), 0);
  return total * 2;
}

/** Git-based author lines for skills with attributed monthly cost (uncached). */
export function computeAuthorAttribution(
  target: string,
  attribution: SkillAttributionMap
): SkillAuthorAttribution[] {
  if (!isFeatureEnabled("teamCostSharing")) {
    return [];
  }

  const results: SkillAuthorAttribution[] = [];
  const skillsDir = path.join(target, ".claude", "skills");
  if (!fs.existsSync(skillsDir)) {
    return [];
  }

  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skill = entry.name;
    const monthly = skillMonthlyCost(skill, attribution);
    if (monthly <= 0) {
      continue;
    }
    const rel = path.join(".claude", "skills", skill, "SKILL.md").replace(/\\/g, "/");
    const blame = gitBlameAuthor(target, rel);
    const author = blame?.author ?? "unknown";
    const when = blame?.date ? formatAge(blame.date) : "unknown date";
    results.push({
      skill,
      author,
      authorEmail: blame?.email,
      committedAt: blame?.date,
      monthlyCost: monthly,
      line: `$${monthly.toFixed(2)}/mo | added by ${author} (${when})`,
    });
  }

  return results.sort((a, b) => b.monthlyCost - a.monthlyCost);
}

/** @deprecated Prefer getOrComputeTeamEconomicsBundle — uncached git attribution. */
export function attributeCostToAuthors(
  target: string,
  attribution: SkillAttributionMap
): SkillAuthorAttribution[] {
  return computeAuthorAttribution(target, attribution);
}

function formatAge(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000));
  if (days < 30) {
    return `${days}d ago`;
  }
  const months = Math.floor(days / 30);
  return months === 1 ? "1 month ago" : `${months} months ago`;
}
