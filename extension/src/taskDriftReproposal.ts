import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { enabledAgents, loadAgentsManifest } from "./agentOps";
import { Manifest } from "./skillOps";
import { writeJsonAtomic, readJsonFile } from "./fileWriteCoordination";
import { isFeatureEnabled } from "./featureFlags";
import { readCachedEnrichedRuns } from "./learningStateIndex";
import { isV2HookRun } from "./runRecording";
import { applyTaskSkillFocusFromProposals } from "./taskSkillFocus";
import {
  computeTaskSkillProposals,
  computeTaskSkillSetOptions,
  filterProposalsByMinConfidence,
  rankAllTaskSkillProposals,
  readTaskSkillProposals,
  TaskSkillProposal,
  TaskSkillProposalsFile,
  writeTaskSkillProposals,
} from "./taskSkillProposals";
import { readTaskFocusLimits, taskSkillSetApprovalEnabled } from "./taskFocusConfig";
import { claudeParser, cursorParser, listTranscriptFiles } from "./transcriptParsers";
import { transcriptFileMatchesWorkspace } from "./workspaceTranscripts";

export const SESSION_WATCH_REL = path.join(".claude", "learning", "session-watch.json");
export const TASK_DRIFT_STATE_REL = path.join(".claude", "learning", "task-drift-reproposal.json");
export const TASK_DRIFT_PROMPT_REL = path.join(".claude", "learning", "task-drift-prompt.json");

export type SessionSizeLevel = "ok" | "warn" | "critical";
export type DriftTrigger = "off_profile" | "session_size";

const LEVEL_RANK: Record<SessionSizeLevel, number> = { ok: 0, warn: 1, critical: 2 };
const WARN_BYTES = 4 * 1024 * 1024;
const CRITICAL_BYTES = 10 * 1024 * 1024;

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function levelForBytes(bytes: number): SessionSizeLevel {
  if (bytes >= CRITICAL_BYTES) {
    return "critical";
  }
  if (bytes >= WARN_BYTES) {
    return "warn";
  }
  return "ok";
}

function maxSessionLevel(a: SessionSizeLevel, b: SessionSizeLevel): SessionSizeLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

export interface TaskDriftSettings {
  enabled: boolean;
  minOffProfileInvokes: number;
  sessionSizeLevel: "warn" | "critical";
  cooldownMinutes: number;
  notifyUser: boolean;
}

export interface TaskDriftStateFile {
  version: 1;
  lastReproposalAt?: string;
  lastTriggers?: DriftTrigger[];
  lastOffProfileSkills?: string[];
  lastSessionLevel?: SessionSizeLevel;
  reproposalCount?: number;
}

export interface TaskDriftPromptFile {
  version: 1;
  updatedAt: string;
  shouldInject: boolean;
  deliveredAt?: string;
  triggers: DriftTrigger[];
  message: string;
  activeSkills: string[];
  offProfileSkills: string[];
}

export interface TaskDriftEvaluation {
  shouldRepropose: boolean;
  triggers: DriftTrigger[];
  offProfileSkills: string[];
  offProfileInvokeCount: number;
  sessionLevel: SessionSizeLevel;
  reason: string;
}

export interface TaskDriftResult {
  evaluated: boolean;
  reproposed: boolean;
  triggers: DriftTrigger[];
  evaluation?: TaskDriftEvaluation;
  file?: TaskSkillProposalsFile;
}

export function readTaskDriftSettings(): TaskDriftSettings {
  const cfg = vscode.workspace.getConfiguration("claudeSkills.skillFeedback");
  const enabled = isFeatureEnabled("taskDriftReproposal");
  let minOffProfileInvokes = cfg.get<number>("taskDriftMinOffProfileInvokes", 2);
  let cooldownMinutes = cfg.get<number>("taskDriftCooldownMinutes", 30);
  const sessionSizeLevel = cfg.get<"warn" | "critical">("taskDriftSessionSizeLevel", "warn");
  const notifyUser = cfg.get<boolean>("taskDriftNotifyUser", true);

  if (!Number.isFinite(minOffProfileInvokes)) {
    minOffProfileInvokes = 2;
  }
  if (!Number.isFinite(cooldownMinutes)) {
    cooldownMinutes = 30;
  }

  return {
    enabled,
    minOffProfileInvokes: Math.max(1, Math.round(minOffProfileInvokes)),
    sessionSizeLevel: sessionSizeLevel === "critical" ? "critical" : "warn",
    cooldownMinutes: Math.max(5, Math.round(cooldownMinutes)),
    notifyUser,
  };
}

export function taskDriftStatePath(target: string): string {
  return path.join(target, TASK_DRIFT_STATE_REL);
}

export function taskDriftPromptPath(target: string): string {
  return path.join(target, TASK_DRIFT_PROMPT_REL);
}

export function readTaskDriftState(target: string): TaskDriftStateFile | null {
  const parsed = readJsonFile<TaskDriftStateFile>(taskDriftStatePath(target));
  if (parsed?.version !== 1) {
    return null;
  }
  return parsed;
}

export function writeTaskDriftState(target: string, data: TaskDriftStateFile): void {
  writeJsonAtomic(taskDriftStatePath(target), data);
}

export function readTaskDriftPrompt(target: string): TaskDriftPromptFile | null {
  const parsed = readJsonFile<TaskDriftPromptFile>(taskDriftPromptPath(target));
  if (parsed?.version !== 1) {
    return null;
  }
  return parsed;
}

function readSessionWatchLevels(target: string, libraryDir?: string): SessionSizeLevel {
  let max: SessionSizeLevel = "ok";
  const file = path.join(target, SESSION_WATCH_REL);
  if (fs.existsSync(file)) {
    try {
      const state = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, string>;
      for (const level of Object.values(state)) {
        if (level === "critical") {
          return "critical";
        }
        if (level === "warn") {
          max = "warn";
        }
      }
    } catch {
      // fall through
    }
  }

  if (!libraryDir || !fs.existsSync(path.join(libraryDir, "agents.json"))) {
    return max;
  }

  try {
    const manifest = loadAgentsManifest(libraryDir);
    for (const agentId of enabledAgents(libraryDir)) {
      const def = manifest.agents[agentId];
      if (!def?.transcriptRoots?.length) {
        continue;
      }
      const parser = agentId === "claude" ? claudeParser : agentId === "cursor" ? cursorParser : null;
      if (!parser) {
        continue;
      }
      for (const root of def.transcriptRoots) {
        const expanded = expandHome(root);
        for (const transcriptFile of listTranscriptFiles(expanded)) {
          if (!transcriptFileMatchesWorkspace(transcriptFile, target)) {
            continue;
          }
          try {
            const size = fs.statSync(transcriptFile).size;
            max = maxSessionLevel(max, levelForBytes(size));
          } catch {
            // ignore unreadable transcript
          }
        }
      }
    }
  } catch {
    // non-fatal when agents manifest unavailable
  }

  return max;
}

function sinceMs(iso?: string): number {
  if (!iso) {
    return 0;
  }
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

function collectOffProfileInvokes(
  target: string,
  sinceIso?: string
): { skills: string[]; count: number } {
  const since = sinceMs(sinceIso);
  const skillCounts = new Map<string, number>();
  let count = 0;

  for (const run of readCachedEnrichedRuns(target)) {
    if (!isV2HookRun(run)) {
      continue;
    }
    if (run.metadata?.not_in_active_profile !== true) {
      continue;
    }
    if (sinceMs(run.ts) < since) {
      continue;
    }
    count += 1;
    skillCounts.set(run.skill, (skillCounts.get(run.skill) ?? 0) + 1);
  }

  const skills = [...skillCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);

  return { skills, count };
}

export function evaluateTaskDrift(
  target: string,
  settings = readTaskDriftSettings(),
  libraryDir?: string
): TaskDriftEvaluation {
  const empty: TaskDriftEvaluation = {
    shouldRepropose: false,
    triggers: [],
    offProfileSkills: [],
    offProfileInvokeCount: 0,
    sessionLevel: "ok",
    reason: "disabled",
  };

  if (!settings.enabled) {
    return { ...empty, reason: "task drift re-proposal disabled" };
  }

  const state = readTaskDriftState(target);
  const cooldownMs = settings.cooldownMinutes * 60 * 1000;
  if (state?.lastReproposalAt) {
    const elapsed = Date.now() - sinceMs(state.lastReproposalAt);
    if (elapsed >= 0 && elapsed < cooldownMs) {
      return { ...empty, reason: "cooldown active" };
    }
  }

  const proposals = readTaskSkillProposals(target);
  if (!proposals?.proposals.length) {
    return { ...empty, reason: "no task proposals yet" };
  }

  const windowStart = state?.lastReproposalAt ?? proposals.generatedAt;
  const offProfile = collectOffProfileInvokes(target, windowStart);
  const sessionLevel = readSessionWatchLevels(target, libraryDir);
  const triggers: DriftTrigger[] = [];

  if (offProfile.count >= settings.minOffProfileInvokes) {
    triggers.push("off_profile");
  }
  if (LEVEL_RANK[sessionLevel] >= LEVEL_RANK[settings.sessionSizeLevel]) {
    triggers.push("session_size");
  }

  if (triggers.length === 0) {
    return {
      shouldRepropose: false,
      triggers: [],
      offProfileSkills: offProfile.skills,
      offProfileInvokeCount: offProfile.count,
      sessionLevel,
      reason: "no drift triggers",
    };
  }

  const parts: string[] = [];
  if (triggers.includes("off_profile")) {
    parts.push(
      `${offProfile.count} skill invoke(s) outside task focus (${offProfile.skills.slice(0, 5).join(", ")})`
    );
  }
  if (triggers.includes("session_size")) {
    parts.push(`session transcript at ${sessionLevel} size`);
  }

  return {
    shouldRepropose: true,
    triggers,
    offProfileSkills: offProfile.skills,
    offProfileInvokeCount: offProfile.count,
    sessionLevel,
    reason: parts.join("; "),
  };
}

function boostOffProfileSkills(
  proposals: TaskSkillProposal[],
  offProfileSkills: string[],
  installed: Set<string>
): TaskSkillProposal[] {
  const byName = new Map(proposals.map((p) => [p.name, { ...p }]));
  for (const name of offProfileSkills) {
    const existing = byName.get(name);
    if (existing) {
      existing.confidence = Math.min(100, Math.max(existing.confidence, 88));
      existing.reason = `Agent used this skill outside task focus — include in refreshed set; ${existing.reason}`;
      byName.set(name, existing);
      continue;
    }
    byName.set(name, {
      name,
      reason: "Agent invoked this skill outside the active task set — task scope likely drifted",
      confidence: 85,
      installed: installed.has(name),
    });
  }
  return [...byName.values()]
    .sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name))
    .slice(0, 12);
}

export function refreshProposalsForDrift(
  target: string,
  manifest: Manifest,
  evaluation: TaskDriftEvaluation
): { refreshed: boolean; file?: TaskSkillProposalsFile } {
  const existing = readTaskSkillProposals(target);
  const basePrompt = [
    existing?.promptExcerpt ?? existing?.taskSummary ?? "Current workspace task",
    evaluation.offProfileSkills.length
      ? `Skills used outside task focus: ${evaluation.offProfileSkills.join(", ")}`
      : "",
    evaluation.triggers.includes("session_size")
      ? `Long session (${evaluation.sessionLevel}) — tighten skill set to task-relevant only`
      : "",
  ]
    .filter(Boolean)
    .join(". ");

  const computed = computeTaskSkillProposals(target, manifest, basePrompt);
  const installed = new Set(
    computed.filter((p) => p.installed).map((p) => p.name)
  );
  const limits = readTaskFocusLimits();
  const merged = filterProposalsByMinConfidence(
    boostOffProfileSkills(computed, evaluation.offProfileSkills, installed),
    limits.minProposalConfidence
  );

  if (merged.length === 0) {
    return { refreshed: false };
  }

  const allRanked = rankAllTaskSkillProposals(target, manifest, basePrompt);
  const boostedRanked = boostOffProfileSkills(allRanked, evaluation.offProfileSkills, installed);
  const options = taskSkillSetApprovalEnabled()
    ? computeTaskSkillSetOptions(boostedRanked, limits)
    : undefined;

  const triggerLabel = evaluation.triggers.join("+");
  const data: TaskSkillProposalsFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    taskSummary: `Task drift refresh (${triggerLabel})`,
    promptExcerpt: basePrompt.slice(0, 240),
    proposals: merged,
    options,
    approvalStatus: taskSkillSetApprovalEnabled() ? "pending" : "approved",
    selectedOptionId: taskSkillSetApprovalEnabled() ? undefined : options?.[0]?.id,
  };
  writeTaskSkillProposals(target, data);
  return { refreshed: true, file: data };
}

export function buildTaskDriftPromptMessage(
  evaluation: TaskDriftEvaluation,
  activeSkills: string[]
): string {
  const lines = [
    "[Claude Skills] Task scope drift detected — skill set refreshed by the extension.",
    `Triggers: ${evaluation.triggers.join(", ")} (${evaluation.reason}).`,
  ];
  if (evaluation.offProfileSkills.length) {
    lines.push(
      `Agent used skills outside task focus: ${evaluation.offProfileSkills.slice(0, 8).join(", ")}. They are now in the active set.`
    );
  }
  if (evaluation.triggers.includes("session_size")) {
    lines.push(
      "Session transcript is large — prefer /compact, load only active skills, and avoid re-reading ignored SKILL.md files."
    );
  }
  lines.push(`Active skills: ${activeSkills.slice(0, 12).join(", ")}.`);
  lines.push(
    "Refine .claude/learning/task-skill-proposals.json only if the user's goal changed; otherwise follow the refreshed set."
  );
  return lines.join(" ");
}

export function syncTaskDriftPrompt(
  target: string,
  evaluation: TaskDriftEvaluation,
  activeSkills: string[]
): TaskDriftPromptFile {
  const payload: TaskDriftPromptFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    shouldInject: true,
    triggers: evaluation.triggers,
    message: buildTaskDriftPromptMessage(evaluation, activeSkills),
    activeSkills,
    offProfileSkills: evaluation.offProfileSkills,
  };
  writeJsonAtomic(taskDriftPromptPath(target), payload);
  return payload;
}

/** Evaluate drift, refresh proposals, re-apply focus, and queue hook inject. */
export function processTaskDriftReproposal(
  target: string,
  libraryDir: string,
  manifest: Manifest
): TaskDriftResult {
  const settings = readTaskDriftSettings();
  if (!settings.enabled) {
    return { evaluated: false, reproposed: false, triggers: [] };
  }

  const evaluation = evaluateTaskDrift(target, settings, libraryDir);
  if (!evaluation.shouldRepropose) {
    return { evaluated: true, reproposed: false, triggers: [], evaluation };
  }

  const refresh = refreshProposalsForDrift(target, manifest, evaluation);
  if (!refresh.refreshed || !refresh.file) {
    return { evaluated: true, reproposed: false, triggers: evaluation.triggers, evaluation };
  }

  const focus = applyTaskSkillFocusFromProposals(libraryDir, target);
  const activeSkills = focus.focus?.activeSkills ?? refresh.file.proposals.map((p) => p.name);

  syncTaskDriftPrompt(target, evaluation, activeSkills);

  const prev = readTaskDriftState(target);
  writeTaskDriftState(target, {
    version: 1,
    lastReproposalAt: refresh.file.generatedAt,
    lastTriggers: evaluation.triggers,
    lastOffProfileSkills: evaluation.offProfileSkills,
    lastSessionLevel: evaluation.sessionLevel,
    reproposalCount: (prev?.reproposalCount ?? 0) + 1,
  });

  return {
    evaluated: true,
    reproposed: true,
    triggers: evaluation.triggers,
    evaluation,
    file: refresh.file,
  };
}

export function clearTaskDriftPromptInject(target: string): void {
  const existing = readTaskDriftPrompt(target);
  if (!existing) {
    return;
  }
  writeJsonAtomic(taskDriftPromptPath(target), {
    ...existing,
    shouldInject: false,
    deliveredAt: new Date().toISOString(),
  });
}
