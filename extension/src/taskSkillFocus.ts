import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { propagateCostDisciplineToAgents } from "./agentMirrorSync";
import { bootstrapWorkspaceForHostAgent } from "./hostAgentBootstrap";
import { readJsonFile, writeJsonAtomic } from "./fileWriteCoordination";
import { mergeProfileInitSkills, profileInitRequiredSkills } from "./profileInit";
import { setSkillOverride, readSkillOverrides, settingsLocalPath } from "./skillOps";
import { readTaskSkillProposals, resolveProposalSkillNames } from "./taskSkillProposals";
import { listInstalledSkills } from "./usageStats";
import { capActiveSkills, readTaskFocusLimits } from "./taskFocusConfig";
import { emergencyDisabledSkillNames } from "./emergencyCutoff";
import { budgetDisabledSkillNames } from "./budgetOps";

export const TASK_ACTIVE_SKILLS_REL = path.join(".claude", "learning", "task-active-skills.json");
const TASK_FOCUS_MIGRATION_LOG_REL = path.join(".claude", "learning", "task-focus-migration.jsonl");

/** Durable, co-located-with-the-overrides ledger of skills task-focus (or the branch-
 * profile reconciliation it drives) has set to "off" — lives in settings.local.json
 * itself (mirrors budgetOps.ts's BUDGET_META_KEY pattern) rather than only in
 * task-active-skills.json, because that file can be reset/edited independently of the
 * overrides it describes (that drift is exactly how overrides survive forever even
 * though ignoredSkills reads back empty). */
const TASK_FOCUS_META_KEY = "claudeSkillsTaskFocus";

interface TaskFocusMeta {
  disabledByTaskFocus?: string[];
  /** Set once the one-time legacy-override reclaim has run for this workspace, so it
   * never re-examines unattributed overrides again (anything unattributed after this
   * point is presumed to be a real, intentional user override). */
  legacyMigrationDone?: boolean;
  /**
   * Skills the user explicitly re-enabled after task-focus disabled them. applyTaskSkillFocus()
   * recomputes its full sweep from scratch on every call (see the comment above its
   * `disabledByTaskFocus` write) with no memory of its own between calls — a manual re-enable
   * would otherwise get silently swept back to "off" on the very next re-apply (proposals
   * regenerating, or the installed set drifting), which can happen within seconds of the user's
   * action. Mirrors budgetOps.ts's BudgetMeta.userReenabledSkills, same underlying problem in a
   * different subsystem. Cleared only by an explicit re-disable, not by time.
   */
  userReenabledSkills?: string[];
}

interface LocalSettingsWithTaskFocusMeta {
  skillOverrides?: Record<string, string>;
  [key: string]: unknown;
}

function readRawLocalSettings(target: string): LocalSettingsWithTaskFocusMeta {
  const file = settingsLocalPath(target);
  if (!fs.existsSync(file)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as LocalSettingsWithTaskFocusMeta;
  } catch {
    return {};
  }
}

function writeRawLocalSettings(target: string, settings: LocalSettingsWithTaskFocusMeta): void {
  const file = settingsLocalPath(target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

function readTaskFocusMeta(target: string): TaskFocusMeta {
  const raw = readRawLocalSettings(target)[TASK_FOCUS_META_KEY];
  return raw && typeof raw === "object" ? (raw as TaskFocusMeta) : {};
}

function writeTaskFocusMeta(target: string, meta: TaskFocusMeta): void {
  const settings = readRawLocalSettings(target);
  if (!meta.disabledByTaskFocus?.length && !meta.legacyMigrationDone && !meta.userReenabledSkills?.length) {
    delete settings[TASK_FOCUS_META_KEY];
  } else {
    settings[TASK_FOCUS_META_KEY] = meta;
  }
  writeRawLocalSettings(target, settings);
}

/** Used when the user manually re-enables a skill (claudeSkills.enableSkillLocally) — records
 *  it so applyTaskSkillFocus()'s next full re-sweep won't silently disable it again. See
 *  TaskFocusMeta.userReenabledSkills. Mirrors budgetOps.ts's clearBudgetTrackingForSkill(). */
export function clearTaskFocusTrackingForSkill(target: string, skillName: string): void {
  const meta = readTaskFocusMeta(target);
  if (meta.userReenabledSkills?.includes(skillName)) {
    return;
  }
  writeTaskFocusMeta(target, {
    ...meta,
    userReenabledSkills: [...(meta.userReenabledSkills ?? []), skillName].sort((a, b) => a.localeCompare(b)),
  });
}

/** Merge skill names into the durable task-focus ledger without touching skillOverrides
 * itself — used by callers (e.g. sessionSkillApply.ts) that force-disable skills via
 * applyBranchProfile's disableUndesired sweep, a second writer that has no ledger access
 * of its own. */
export function recordTaskFocusDisabled(target: string, skillNames: string[]): void {
  if (skillNames.length === 0) {
    return;
  }
  const meta = readTaskFocusMeta(target);
  const merged = new Set([...(meta.disabledByTaskFocus ?? []), ...skillNames]);
  writeTaskFocusMeta(target, { ...meta, disabledByTaskFocus: [...merged].sort((a, b) => a.localeCompare(b)) });
}

export interface TaskActiveSkillsFile {
  version: 1;
  generatedAt: string;
  proposalsGeneratedAt?: string;
  source: "task-skill-proposals" | "session-apply" | "manual";
  activeSkills: string[];
  /** Installed skills set to skillOverrides off for this task (still on disk). */
  ignoredSkills: string[];
}

/** Master switch: claudeSkills.taskFocus.enabled (default on). When off, installed
 * skills are never auto-disabled via skillOverrides based on task-skill-proposals. */
export function taskSkillFocusEnabled(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.taskFocus").get<boolean>("enabled", true);
}

export function taskActiveSkillsPath(target: string): string {
  return path.join(target, TASK_ACTIVE_SKILLS_REL);
}

export function readTaskActiveSkills(target: string): TaskActiveSkillsFile | null {
  const parsed = readJsonFile<TaskActiveSkillsFile>(taskActiveSkillsPath(target));
  if (parsed?.version !== 1 || !Array.isArray(parsed.activeSkills)) {
    return null;
  }
  return parsed;
}

export function writeTaskActiveSkills(target: string, data: TaskActiveSkillsFile): void {
  writeJsonAtomic(taskActiveSkillsPath(target), data);
}

/** Personal ignore list: skillOverrides off for installed skills outside the task set. */
export function applyTaskSkillFocus(
  target: string,
  activeSkillNames: string[],
  source: TaskActiveSkillsFile["source"],
  proposalsGeneratedAt?: string
): { activeSkills: string[]; ignoredSkills: string[]; overridesApplied: number } {
  const limits = readTaskFocusLimits();
  const required = profileInitRequiredSkills();
  let cappedNames = activeSkillNames;
  if (limits.enabled) {
    const { active } = capActiveSkills(activeSkillNames, {
      maxActiveSkills: limits.maxActiveSkills,
      requiredSkills: required,
    });
    cappedNames = active;
  }
  const activeSkills = mergeProfileInitSkills([...new Set(cappedNames.filter(Boolean))]);
  const activeSet = new Set(activeSkills);
  const installed = listInstalledSkills(target);
  const overrides = readSkillOverrides(target);
  const ignoredSkills: string[] = [];
  let overridesApplied = 0;
  const priorMeta = readTaskFocusMeta(target);
  const userReenabled = new Set(priorMeta.userReenabledSkills ?? []);
  // Skills the LAST sweep disabled — used below to detect an implicit re-enable (any way
  // the override got cleared since then: the enableSkillLocally command, a direct edit to
  // settings.local.json, another tool). userReenabledSkills only catches the command path;
  // this catches every other path too, without needing to know how the clear happened.
  const previouslyIgnored = new Set(priorMeta.disabledByTaskFocus ?? []);
  const newlyReclaimed: string[] = [];

  for (const name of installed) {
    if (activeSet.has(name)) {
      if (overrides[name] === "off") {
        setSkillOverride(target, name, undefined);
        overridesApplied++;
      }
      continue;
    }
    // User explicitly re-enabled this after a prior task-focus sweep disabled it (see
    // TaskFocusMeta.userReenabledSkills) — leave it alone even though it's outside the
    // active set, rather than silently re-disabling it on this recompute.
    if (userReenabled.has(name)) {
      continue;
    }
    // Implicit re-enable: the last sweep disabled this skill, but its override isn't "off"
    // anymore — something cleared it since then, by whatever means. Respect that instead of
    // re-disabling it on this pass, and promote it to the durable ledger so it stays
    // protected on every future sweep too, not just this one.
    if (previouslyIgnored.has(name) && overrides[name] !== "off") {
      newlyReclaimed.push(name);
      continue;
    }
    if (overrides[name] !== "off") {
      setSkillOverride(target, name, "off");
      ignoredSkills.push(name);
      overridesApplied++;
    } else {
      ignoredSkills.push(name);
    }
  }

  const sortedIgnored = [...ignoredSkills].sort((a, b) => a.localeCompare(b));

  writeTaskActiveSkills(target, {
    version: 1,
    generatedAt: new Date().toISOString(),
    proposalsGeneratedAt,
    source,
    activeSkills,
    ignoredSkills: sortedIgnored,
  });

  // Ledger reflects exactly what this run just computed as "outside the active set" —
  // this call recomputes the whole picture every time, so replace rather than merge.
  // userReenabledSkills grows with anything reclaimed above (implicitly or via the command)
  // so it stays protected on every future sweep, not just this one.
  const meta = readTaskFocusMeta(target);
  const mergedUserReenabled = newlyReclaimed.length
    ? [...new Set([...(meta.userReenabledSkills ?? []), ...newlyReclaimed])].sort((a, b) => a.localeCompare(b))
    : meta.userReenabledSkills;
  writeTaskFocusMeta(target, {
    ...meta,
    disabledByTaskFocus: sortedIgnored.length ? sortedIgnored : undefined,
    userReenabledSkills: mergedUserReenabled?.length ? mergedUserReenabled : undefined,
  });

  return { activeSkills, ignoredSkills, overridesApplied };
}

/** Re-apply focus from current task-skill-proposals.json when stale or missing. */
export function applyTaskSkillFocusFromProposals(
  libraryDir: string,
  target: string
): { applied: boolean; focus?: ReturnType<typeof applyTaskSkillFocus> } {
  if (!taskSkillFocusEnabled()) {
    // Release any skillOverrides a prior (enabled) session forced off, so flipping the
    // switch off actually restores access instead of leaving stale "off" entries behind.
    clearTaskSkillFocus(target);
    // Ledger-based clearing above only reaches overrides this feature already knows
    // about. A workspace that predates the ledger (or the fix to it) can have "off"
    // overrides with no record anywhere — this one-time sweep reclaims those too.
    reclaimOrphanedTaskFocusOverrides(target);
    return { applied: false };
  }
  const proposals = readTaskSkillProposals(target);
  if (!proposals?.proposals.length) {
    return { applied: false };
  }
  const state = readTaskActiveSkills(target);
  // A skill can land in .claude/skills through a path this function never sees directly
  // (e.g. "Install Relevant Skills for Workspace", a manual copy) between two identical
  // proposals files. Gating solely on proposals.generatedAt would leave it permanently
  // un-swept — neither active nor ignored — since re-applying the *same* proposals looks
  // like a no-op otherwise. Re-apply whenever the installed set has drifted from what the
  // last sweep actually accounted for, even if the proposals themselves are unchanged.
  const installedDrifted = !!state && listInstalledSkills(target).some(
    (name) => !state.activeSkills.includes(name) && !state.ignoredSkills.includes(name)
  );
  if (state?.proposalsGeneratedAt === proposals.generatedAt && !installedDrifted) {
    return { applied: false };
  }
  const names = resolveProposalSkillNames(proposals).filter(Boolean);
  const focus = applyTaskSkillFocus(target, names, "task-skill-proposals", proposals.generatedAt);
  bootstrapWorkspaceForHostAgent(libraryDir, target);
  propagateCostDisciplineToAgents(libraryDir, target);
  return { applied: true, focus };
}

/** Clear task-focus overrides that this feature applied. Consults both
 * task-active-skills.json's ignoredSkills (may be stale/reset independently of the
 * overrides it describes) and the durable settings.local.json ledger (survives that
 * reset) — either one recording a name is enough to reclaim it. */
export function clearTaskSkillFocus(target: string): number {
  const state = readTaskActiveSkills(target);
  const meta = readTaskFocusMeta(target);
  const namesToClear = new Set([...(state?.ignoredSkills ?? []), ...(meta.disabledByTaskFocus ?? [])]);
  if (namesToClear.size === 0) {
    return 0;
  }
  let cleared = 0;
  const overrides = readSkillOverrides(target);
  for (const name of namesToClear) {
    if (overrides[name] === "off") {
      setSkillOverride(target, name, undefined);
      cleared++;
    }
  }
  if (state) {
    writeJsonAtomic(taskActiveSkillsPath(target), {
      ...state,
      generatedAt: new Date().toISOString(),
      activeSkills: [],
      ignoredSkills: [],
    });
  }
  writeTaskFocusMeta(target, { ...meta, disabledByTaskFocus: undefined });
  return cleared;
}

/** One-time reclaim of "off" overrides with no recorded reason anywhere (pre-dating the
 * ledger above, or written by a code path — e.g. applyBranchProfile's disableUndesired
 * sweep before it fed the ledger — that never recorded one). Runs only while task focus
 * is off, only once per workspace, and only for overrides not already explained by
 * another subsystem (emergency cutoff, budget/economy). Everything it reclaims is logged
 * to task-focus-migration.jsonl for auditability, and legacyMigrationDone permanently
 * closes the window afterward — an override left "off" with no ledger entry after this
 * has run is assumed to be a real, intentional user choice and is never touched again. */
export function reclaimOrphanedTaskFocusOverrides(target: string): { reclaimed: string[] } {
  const meta = readTaskFocusMeta(target);
  if (meta.legacyMigrationDone) {
    return { reclaimed: [] };
  }

  const overrides = readSkillOverrides(target);
  const ledgered = new Set(meta.disabledByTaskFocus ?? []);
  const protectedNames = new Set([...emergencyDisabledSkillNames(target), ...budgetDisabledSkillNames(target)]);

  const reclaimed = Object.entries(overrides)
    .filter(([name, value]) => value === "off" && !ledgered.has(name) && !protectedNames.has(name))
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));

  for (const name of reclaimed) {
    setSkillOverride(target, name, undefined);
  }

  // Verify the clears actually persisted before permanently closing the one-time retry
  // window. Confirmed live (2026-07-15 investigation): a real workspace logged "reclaimed"
  // for 16 skills here, then an unrelated writer (applyBranchProfile()'s unconditional
  // profile-override reapply — see branchProfiles.ts) put them straight back to "off"
  // minutes later. legacyMigrationDone was already permanently set by this function in the
  // same run, so nothing ever got another chance to reclaim them. If verification fails,
  // legacyMigrationDone is left unset so a future call retries.
  const verifyOverrides = readSkillOverrides(target);
  const stillOff = reclaimed.filter((name) => verifyOverrides[name] === "off");
  const persisted = stillOff.length === 0;

  writeTaskFocusMeta(target, persisted ? { ...meta, legacyMigrationDone: true } : meta);

  if (reclaimed.length > 0) {
    const logPath = path.join(target, TASK_FOCUS_MIGRATION_LOG_REL);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(
      logPath,
      JSON.stringify({
        ts: new Date().toISOString(),
        reclaimed,
        persisted,
        ...(persisted ? {} : { stillOff }),
        reason: "orphaned-task-focus-override — no ledger entry, not emergency/budget-disabled",
      }) + "\n",
      "utf-8"
    );
  }

  return { reclaimed: persisted ? reclaimed : reclaimed.filter((name) => !stillOff.includes(name)) };
}
