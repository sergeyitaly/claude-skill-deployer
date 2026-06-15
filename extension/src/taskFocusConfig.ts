import * as vscode from "vscode";

export interface TaskFocusLimits {
  enabled: boolean;
  maxActiveSkills: number;
  minProposals: number;
}

/** Cap active task skills (default 12) — required platform skills count toward the cap. */
export function readTaskFocusLimits(): TaskFocusLimits {
  const cfg = vscode.workspace.getConfiguration("claudeSkills.taskFocus");
  const rawMax = cfg.get<number>("maxActiveSkills", 12);
  const maxActiveSkills = Math.max(4, Math.min(30, rawMax));
  return {
    enabled: cfg.get<boolean>("enabled", true),
    maxActiveSkills,
    minProposals: Math.max(1, cfg.get<number>("minProposals", 8)),
  };
}

export interface CapActiveSkillsOptions {
  maxActiveSkills: number;
  /** Always included first (e.g. profile-init required skills). */
  requiredSkills?: string[];
  confidenceBySkill?: Map<string, number>;
}

/** Keep required skills, then highest-confidence candidates up to maxActiveSkills. */
export function capActiveSkills(
  candidates: string[],
  opts: CapActiveSkillsOptions
): { active: string[]; dropped: string[]; capped: boolean } {
  const required = [...new Set((opts.requiredSkills ?? []).filter(Boolean))];
  const requiredSet = new Set(required);
  const seen = new Set<string>();
  const active: string[] = [];

  for (const name of required) {
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    active.push(name);
  }

  const optional = [...new Set(candidates.filter((n) => n && !requiredSet.has(n)))];
  optional.sort((a, b) => {
    const confA = opts.confidenceBySkill?.get(a) ?? 0;
    const confB = opts.confidenceBySkill?.get(b) ?? 0;
    return confB - confA || a.localeCompare(b);
  });

  for (const name of optional) {
    if (active.length >= opts.maxActiveSkills) {
      break;
    }
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    active.push(name);
  }

  const activeSet = new Set(active);
  const dropped = [...new Set(candidates)].filter((n) => !activeSet.has(n));
  return {
    active,
    dropped,
    capped: dropped.length > 0 || active.length < candidates.length,
  };
}
