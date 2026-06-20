import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { enabledAgents, loadAgentsManifest } from "./agentOps";
import { propagateCostDisciplineToAgents } from "./agentMirrorSync";
import { readJsonFile, writeJsonAtomic } from "./fileWriteCoordination";
import { bootstrapWorkspaceForHostAgent } from "./hostAgentBootstrap";
import { readCachedEnrichedRuns } from "./runsStore";
import { isV2HookRun } from "./runsStore";
import {
  applyTaskSkillFocus,
  readTaskActiveSkills,
  taskSkillFocusEnabled,
} from "./taskSkillFocus";
import { readTaskSkillProposals } from "./taskSkillProposals";
import { claudeParser, cursorParser, listTranscriptFiles, parseActiveSkills } from "./transcriptParsers";
import { transcriptFileMatchesWorkspace } from "./workspaceTranscripts";

export const TASK_SKILL_UNDERUSE_STATE_REL = path.join(".claude", "learning", "task-skill-underuse-state.json");

const MIN_TOOL_USES = 5;
const DEFAULT_COOLDOWN_MINUTES = 60;
const DEFAULT_MAX_PROMOTE = 3;
const DEFAULT_MIN_CONFIDENCE = 70;

export interface TaskSkillUnderuseSettings {
  enabled: boolean;
  cooldownMinutes: number;
  maxPromote: number;
  minProposalConfidence: number;
  notifyUser: boolean;
}

export interface TaskSkillUnderuseState {
  version: 1;
  lastPromotedAt?: string;
  lastPromotedSkills?: string[];
  lastReason?: string;
}

export interface TaskSkillUnderuseResult {
  evaluated: boolean;
  promoted: boolean;
  promotedSkills: string[];
  reason: string;
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export function readTaskSkillUnderuseSettings(): TaskSkillUnderuseSettings {
  const cfg = vscode.workspace.getConfiguration("claudeSkills.skillFeedback");
  const enabled = cfg.get<boolean>("taskSkillUnderusePromote", true);
  let cooldownMinutes = cfg.get<number>("taskSkillUnderuseCooldownMinutes", DEFAULT_COOLDOWN_MINUTES);
  let maxPromote = cfg.get<number>("taskSkillUnderuseMaxPromote", DEFAULT_MAX_PROMOTE);
  let minProposalConfidence = cfg.get<number>("taskSkillUnderuseMinConfidence", DEFAULT_MIN_CONFIDENCE);
  const notifyUser = cfg.get<boolean>("taskSkillUnderuseNotifyUser", true);

  if (!Number.isFinite(cooldownMinutes)) {
    cooldownMinutes = DEFAULT_COOLDOWN_MINUTES;
  }
  if (!Number.isFinite(maxPromote)) {
    maxPromote = DEFAULT_MAX_PROMOTE;
  }
  if (!Number.isFinite(minProposalConfidence)) {
    minProposalConfidence = DEFAULT_MIN_CONFIDENCE;
  }

  return {
    enabled,
    cooldownMinutes: Math.max(15, Math.round(cooldownMinutes)),
    maxPromote: Math.max(1, Math.round(maxPromote)),
    minProposalConfidence: Math.min(100, Math.max(50, Math.round(minProposalConfidence))),
    notifyUser,
  };
}

export function underuseStatePath(target: string): string {
  return path.join(target, TASK_SKILL_UNDERUSE_STATE_REL);
}

export function readTaskSkillUnderuseState(target: string): TaskSkillUnderuseState | null {
  const parsed = readJsonFile<TaskSkillUnderuseState>(underuseStatePath(target));
  return parsed?.version === 1 ? parsed : null;
}

function writeTaskSkillUnderuseState(target: string, data: TaskSkillUnderuseState): void {
  writeJsonAtomic(underuseStatePath(target), data);
}

function sinceMs(iso?: string): number {
  if (!iso) {
    return 0;
  }
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

function collectInvokedSkills(target: string, sinceIso: string): Set<string> {
  const since = sinceMs(sinceIso);
  const skills = new Set<string>();

  for (const run of readCachedEnrichedRuns(target)) {
    if (!isV2HookRun(run)) {
      continue;
    }
    if (sinceMs(run.ts) < since) {
      continue;
    }
    if (run.skill) {
      skills.add(run.skill.toLowerCase());
    }
  }

  return skills;
}

function countRecentToolUses(target: string, libraryDir: string, sinceIso: string): number {
  const since = sinceMs(sinceIso);
  let total = 0;
  const manifest = loadAgentsManifest(libraryDir);

  for (const agentId of enabledAgents(libraryDir)) {
    const def = manifest.agents[agentId];
    if (!def?.supportsUsageTranscripts) {
      continue;
    }
    const parser = agentId === "claude" ? claudeParser : agentId === "cursor" ? cursorParser : null;
    if (!parser) {
      continue;
    }
    for (const root of def.transcriptRoots) {
      const expanded = expandHome(root);
      for (const file of listTranscriptFiles(expanded)) {
        if (!transcriptFileMatchesWorkspace(file, target)) {
          continue;
        }
        let mtime = 0;
        try {
          mtime = fs.statSync(file).mtimeMs;
        } catch {
          continue;
        }
        if (mtime < since) {
          continue;
        }
        let content = "";
        try {
          content = fs.readFileSync(file, "utf-8");
        } catch {
          continue;
        }
        for (const line of content.split("\n")) {
          if (line.includes('"type":"tool_use"') || line.includes('"type": "tool_use"')) {
            total += 1;
          }
        }
        void parseActiveSkills(content);
      }
    }
  }

  return total;
}

function pickSkillsToPromote(
  target: string,
  activeSkills: string[],
  ignoredSkills: string[],
  maxPromote: number,
  minConfidence: number
): string[] {
  const proposals = readTaskSkillProposals(target);
  if (!proposals?.proposals.length) {
    return [];
  }

  const activeSet = new Set(activeSkills.map((s) => s.toLowerCase()));
  const ignoredSet = new Set(ignoredSkills.map((s) => s.toLowerCase()));
  const candidates: { name: string; confidence: number }[] = [];

  for (const proposal of proposals.proposals) {
    const name = proposal.name?.toLowerCase();
    if (!name || activeSet.has(name) || !ignoredSet.has(name)) {
      continue;
    }
    if (proposal.confidence < minConfidence) {
      continue;
    }
    candidates.push({ name, confidence: proposal.confidence });
  }

  candidates.sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));
  return candidates.slice(0, maxPromote).map((c) => c.name);
}

/**
 * When task focus is on but no active skill was invoked during a busy session,
 * promote high-confidence ignored skills from task proposals back into the active set.
 */
export function maybePromoteIgnoredSkillsOnUnderuse(
  target: string,
  libraryDir: string,
  settings = readTaskSkillUnderuseSettings()
): TaskSkillUnderuseResult {
  const empty: TaskSkillUnderuseResult = {
    evaluated: false,
    promoted: false,
    promotedSkills: [],
    reason: "disabled",
  };

  if (!settings.enabled || !taskSkillFocusEnabled()) {
    return empty;
  }

  const focus = readTaskActiveSkills(target);
  if (!focus?.activeSkills.length || !focus.ignoredSkills.length) {
    return { ...empty, evaluated: true, reason: "no task focus state" };
  }

  const state = readTaskSkillUnderuseState(target);
  const cooldownMs = settings.cooldownMinutes * 60 * 1000;
  if (state?.lastPromotedAt) {
    const elapsed = Date.now() - sinceMs(state.lastPromotedAt);
    if (elapsed >= 0 && elapsed < cooldownMs) {
      return { ...empty, evaluated: true, reason: "cooldown active" };
    }
  }

  const windowStart = state?.lastPromotedAt ?? focus.generatedAt;
  const invoked = collectInvokedSkills(target, windowStart);
  const activeUsed = focus.activeSkills.some((s) => invoked.has(s.toLowerCase()));
  if (activeUsed) {
    return { ...empty, evaluated: true, reason: "active skills already invoked" };
  }

  const toolUses = countRecentToolUses(target, libraryDir, windowStart);
  if (toolUses < MIN_TOOL_USES) {
    return { ...empty, evaluated: true, reason: "insufficient session tool activity" };
  }

  const toPromote = pickSkillsToPromote(
    target,
    focus.activeSkills,
    focus.ignoredSkills,
    settings.maxPromote,
    settings.minProposalConfidence
  );
  if (toPromote.length === 0) {
    return { ...empty, evaluated: true, reason: "no ignored proposals meet confidence threshold" };
  }

  const expanded = [...new Set([...focus.activeSkills, ...toPromote])];
  applyTaskSkillFocus(target, expanded, focus.source, focus.proposalsGeneratedAt);
  bootstrapWorkspaceForHostAgent(libraryDir, target);
  propagateCostDisciplineToAgents(libraryDir, target);

  const reason = `Zero active-skill invokes after ${toolUses} tool use(s) — promoted ${toPromote.join(", ")} from ignored set`;
  writeTaskSkillUnderuseState(target, {
    version: 1,
    lastPromotedAt: new Date().toISOString(),
    lastPromotedSkills: toPromote,
    lastReason: reason,
  });

  if (settings.notifyUser) {
    void vscode.window
      .showInformationMessage(
        `Claude Skills: expanded task focus — added ${toPromote.join(", ")} (no active skills were used).`
      )
      .then(undefined, () => undefined);
  }

  return {
    evaluated: true,
    promoted: true,
    promotedSkills: toPromote,
    reason,
  };
}
