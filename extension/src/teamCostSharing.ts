import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { SkillAttributionMap } from "./costAttribution";
import { isFeatureEnabled } from "./featureFlags";

export interface SkillAuthorAttribution {
  skill: string;
  author: string;
  authorEmail?: string;
  committedAt?: string;
  monthlyCost: number;
  line: string;
}

function gitBlameAuthor(target: string, relPath: string): { author: string; email?: string; date?: string } | null {
  const full = path.join(target, relPath);
  if (!fs.existsSync(full)) {
    return null;
  }
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%an|%ae|%aI", "--", relPath], {
      cwd: target,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const [author, email, date] = out.split("|");
    if (!author) {
      return null;
    }
    return { author, email, date };
  } catch {
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

export function attributeCostToAuthors(
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
    const rel = path.join(".claude", "skills", skill, "SKILL.md").replace(/\\/g, "/");
    const blame = gitBlameAuthor(target, rel);
    const monthly = skillMonthlyCost(skill, attribution);
    if (monthly <= 0 && !blame) {
      continue;
    }
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

function formatAge(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000));
  if (days < 30) {
    return `${days}d ago`;
  }
  const months = Math.floor(days / 30);
  return months === 1 ? "1 month ago" : `${months} months ago`;
}
