import * as vscode from "vscode";
import { saveBranchProfile } from "./branchProfiles";
import { maybeSaveHostAgentSetWithBranchProfile } from "./agentSkillProfiles";
import {
  agentMirrorsNeedSync,
  buildWorkspaceSyncFingerprint,
  missingAgentMirrorSkills,
  shouldSyncWorkspaceToAll,
  syncWorkspaceSkillsToAllAgents,
  syncWorkspaceSkillsToAllAgentsAsync,
  wouldSkipAgentMirrorSync,
} from "./agentOps";
import {
  areAttributionHooksConfigured,
  costControlHooksActive,
  HookInstallStatus,
  installAttributionHooks,
  installCostControlHooks,
  installOfficialSkillsSessionHook,
  refreshAttributionHookScripts,
  refreshCostControlHookScripts,
} from "./hookOps";
import { measureSync, recordPerf } from "./perfTelemetry";
import { flashSyncDone, hideSyncStatus, showSyncing } from "./syncFeedback";
import { runWhenIdle } from "./userInteraction";
import { workspaceUsesOfficialSkillUpdater } from "./officialSkillsSync";
import { lintAgentMirrorsOnSync, lintOnSync } from "./skillLint";
import { listInstalledSkills } from "./usageStats";
import { createAdaptiveSyncQueue } from "./workspaceSyncQueue";
import { rapidToggleWouldBeNoOp } from "./syncPredict";

export interface WorkspaceSkillSyncResult {
  agentPathsUpdated: number;
  hooksStatus?: HookInstallStatus | "refreshed";
  /** True when agent mirror pass was skipped (fingerprint unchanged). */
  skipped?: boolean;
}

export interface WorkspaceSkillSyncOptions {
  forceAgentSync?: boolean;
  saveBranchProfile?: boolean;
  /** Faster debounce when the user toggled a skill or ran an explicit command. */
  userTriggered?: boolean;
  /** Agent-diff: sync only these skills (omit for full workspace mirror). */
  skillNames?: string[];
  onComplete?: () => void;
  /** Show status-bar / tree syncing affordances (default true for user actions). */
  showFeedback?: boolean;
}

let syncQueue: ReturnType<typeof createAdaptiveSyncQueue> | undefined;
let pendingInternal:
  | {
      extensionPath: string;
      target: string;
      libraryDir: string;
      log: (line: string) => void;
      forceAgentSync: boolean;
      saveBranchProfile: boolean;
      userTriggered: boolean;
      showFeedback: boolean;
      skillNames: Set<string>;
      onComplete: Array<() => void>;
    }
  | undefined;

function syncHooksOnSkillChangeEnabled(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.agents").get<boolean>("syncHooksOnSkillChange", true);
}

/** When true (default), install Attribution v2 hooks on activate and workspace setup. */
export function autoInstallAttributionHooksEnabled(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.agents").get<boolean>("autoInstallAttributionHooks", true);
}

/** Idempotent: register PostToolUse skill-invoke hook for per-skill cost attribution. */
export function ensureAttributionHooksActive(
  extensionPath: string,
  target: string,
  log: (line: string) => void
): HookInstallStatus | undefined {
  if (!autoInstallAttributionHooksEnabled()) {
    return undefined;
  }
  const status = installAttributionHooks(extensionPath, target);
  if (status === "installed" || status === "updated") {
    log(`Attribution v2 hooks ${status} (claude/cursor/kiro/copilot as enabled).`);
  }
  return status;
}

/** Idempotent: auto-install session-size and budget hooks when not yet active. */
export function ensureCostControlHooksActive(
  extensionPath: string,
  target: string,
  log: (line: string) => void
): HookInstallStatus | undefined {
  if (costControlHooksActive(target)) {
    return undefined;
  }
  const status = installCostControlHooks(extensionPath, target);
  if (status === "installed" || status === "updated") {
    log(`Cost control hooks ${status} (session-size + budget warnings enabled).`);
  }
  return status;
}

function tryEarlyNoOp(pending: NonNullable<typeof pendingInternal>): boolean {
  const skillNames = [...pending.skillNames];
  if (pending.forceAgentSync) {
    return false;
  }
  if (skillNames.length > 0 && rapidToggleWouldBeNoOp(pending.target)) {
    recordPerf("sync-rapid-toggle-noop", 0, { skills: skillNames.length });
    for (const cb of pending.onComplete) {
      try {
        cb();
      } catch {
        // non-fatal
      }
    }
    return true;
  }
  if (
    skillNames.length === 0 &&
    wouldSkipAgentMirrorSync(pending.libraryDir, pending.target, { force: pending.forceAgentSync })
  ) {
    recordPerf("sync-short-circuit", 0);
    for (const cb of pending.onComplete) {
      try {
        cb();
      } catch {
        // non-fatal
      }
    }
    return true;
  }
  return false;
}

function runPendingWork(pending: NonNullable<typeof pendingInternal>): void {
  if (tryEarlyNoOp(pending)) {
    return;
  }
  const skillNames = [...pending.skillNames];
  const showFeedback = pending.showFeedback;
  if (showFeedback && skillNames.length > 0) {
    showSyncing(skillNames);
  }

  void propagateWorkspaceSkillChangeInternalAsync(
    pending.extensionPath,
    pending.target,
    pending.libraryDir,
    pending.log,
    {
      forceAgentSync: pending.forceAgentSync,
      saveBranchProfile: pending.saveBranchProfile,
      skillNames,
      showFeedback,
    }
  ).then((result) => {
    if (showFeedback) {
      if (result.skipped) {
        hideSyncStatus();
      } else {
        flashSyncDone(result.agentPathsUpdated);
      }
    }
    recordPerf("workspace-sync-total", result.elapsedMs ?? 0, {
      changed: result.agentPathsUpdated,
      skipped: result.skipped ?? false,
      skills: skillNames.length,
    });
    for (const cb of pending.onComplete) {
      try {
        cb();
      } catch {
        // non-fatal
      }
    }
  });
}

function ensureSyncQueue(): ReturnType<typeof createAdaptiveSyncQueue> {
  if (!syncQueue) {
    syncQueue = createAdaptiveSyncQueue(() => {
      if (!pendingInternal) {
        return;
      }
      const pending = pendingInternal;
      pendingInternal = undefined;
      if (pending.userTriggered) {
        runPendingWork(pending);
      } else {
        runWhenIdle(() => runPendingWork(pending));
      }
    });
  }
  return syncQueue;
}

function mergePending(
  extensionPath: string,
  target: string,
  libraryDir: string,
  log: (line: string) => void,
  opts?: WorkspaceSkillSyncOptions
): void {
  const showFeedback = opts?.showFeedback ?? !!opts?.userTriggered;
  if (!pendingInternal) {
    pendingInternal = {
      extensionPath,
      target,
      libraryDir,
      log,
      forceAgentSync: !!opts?.forceAgentSync,
      saveBranchProfile: opts?.saveBranchProfile !== false,
      userTriggered: !!opts?.userTriggered,
      showFeedback,
      skillNames: new Set(opts?.skillNames ?? []),
      onComplete: opts?.onComplete ? [opts.onComplete] : [],
    };
    return;
  }
  pendingInternal.forceAgentSync = pendingInternal.forceAgentSync || !!opts?.forceAgentSync;
  pendingInternal.saveBranchProfile = pendingInternal.saveBranchProfile && opts?.saveBranchProfile !== false;
  pendingInternal.userTriggered = pendingInternal.userTriggered || !!opts?.userTriggered;
  pendingInternal.showFeedback = pendingInternal.showFeedback || showFeedback;
  for (const name of opts?.skillNames ?? []) {
    pendingInternal.skillNames.add(name);
  }
  if (opts?.onComplete) {
    pendingInternal.onComplete.push(opts.onComplete);
  }
}

/** Flush debounced workspace sync (for tests). */
export function flushDebouncedWorkspaceSkillSync(): WorkspaceSkillSyncResult | undefined {
  if (!pendingInternal) {
    return undefined;
  }
  const pending = pendingInternal;
  pendingInternal = undefined;
  const result = propagateWorkspaceSkillChangeInternal(
    pending.extensionPath,
    pending.target,
    pending.libraryDir,
    pending.log,
    {
      forceAgentSync: pending.forceAgentSync,
      saveBranchProfile: pending.saveBranchProfile,
      skillNames: [...pending.skillNames],
    }
  );
  for (const cb of pending.onComplete) {
    try {
      cb();
    } catch {
      // non-fatal
    }
  }
  return result;
}

/** Coalesced multi-agent sync — use for file watchers and rapid toggles. */
export function queueWorkspaceSync(
  extensionPath: string,
  target: string | undefined,
  libraryDir: string,
  log: (line: string) => void,
  opts?: WorkspaceSkillSyncOptions
): WorkspaceSkillSyncResult {
  return propagateWorkspaceSkillChange(extensionPath, target, libraryDir, log, opts);
}

/** After .claude/skills changes: mirror to other agents and refresh/install hooks when appropriate. */
export function propagateWorkspaceSkillChange(
  extensionPath: string,
  target: string | undefined,
  libraryDir: string,
  log: (line: string) => void,
  opts?: WorkspaceSkillSyncOptions
): WorkspaceSkillSyncResult {
  if (!target) {
    return { agentPathsUpdated: 0 };
  }
  if (opts?.forceAgentSync) {
    pendingInternal = undefined;
    const result = propagateWorkspaceSkillChangeInternal(extensionPath, target, libraryDir, log, opts);
    opts.onComplete?.();
    return result;
  }
  mergePending(extensionPath, target, libraryDir, log, opts);
  ensureSyncQueue().enqueue({ userTriggered: pendingInternal?.userTriggered });
  return { agentPathsUpdated: 0 };
}

type InternalSyncResult = WorkspaceSkillSyncResult & { elapsedMs?: number };

function runHooksAndLint(
  extensionPath: string,
  target: string,
  libraryDir: string,
  log: (line: string) => void,
  opts?: WorkspaceSkillSyncOptions
): InternalSyncResult {
  const result: InternalSyncResult = { agentPathsUpdated: 0 };

  if (opts?.saveBranchProfile !== false) {
    saveBranchProfile(target, libraryDir);
    maybeSaveHostAgentSetWithBranchProfile(target);
  }

  if (
    vscode.workspace.getConfiguration("claudeSkills").get<boolean>("officialSkillsCheckOnSession", true) &&
    workspaceUsesOfficialSkillUpdater(target)
  ) {
    const officialStatus = installOfficialSkillsSessionHook(extensionPath, target);
    if (officialStatus === "installed" || officialStatus === "updated") {
      result.hooksStatus = officialStatus;
      log(`Official skills SessionStart hook ${officialStatus}.`);
    }
  }

  const attrStatus = ensureAttributionHooksActive(extensionPath, target, log);
  if (attrStatus === "installed" || attrStatus === "updated") {
    result.hooksStatus = attrStatus;
  }

  const costStatus = ensureCostControlHooksActive(extensionPath, target, log);
  if (costStatus === "installed" || costStatus === "updated") {
    result.hooksStatus = result.hooksStatus ?? costStatus;
  }

  if (syncHooksOnSkillChangeEnabled() && listInstalledSkills(target).length > 0) {
    if (costControlHooksActive(target)) {
      refreshCostControlHookScripts(extensionPath, target);
      if (!result.hooksStatus) {
        result.hooksStatus = "refreshed";
      }
      log("Cost control hook scripts refreshed across Claude, Cursor, Kiro, and Copilot paths.");
    } else if (areAttributionHooksConfigured(target, extensionPath)) {
      refreshAttributionHookScripts(extensionPath, target);
    }
  }

  lintOnSync(target, log);
  return result;
}

async function propagateWorkspaceSkillChangeInternalAsync(
  extensionPath: string,
  target: string,
  libraryDir: string,
  log: (line: string) => void,
  opts?: WorkspaceSkillSyncOptions
): Promise<InternalSyncResult> {
  const t0 = performance.now();
  const result = runHooksAndLint(extensionPath, target, libraryDir, log, opts);
  const catchUpMirrors = agentMirrorsNeedSync(target, libraryDir);
  const partialSkills = (opts?.skillNames?.length ?? 0) > 0;
  const shouldSyncAgents =
    shouldSyncWorkspaceToAll() && (catchUpMirrors || opts?.forceAgentSync || partialSkills);

  if (shouldSyncAgents) {
    const fpBefore = buildWorkspaceSyncFingerprint(target);
    const tAgent = performance.now();
    const synced = await syncWorkspaceSkillsToAllAgentsAsync(libraryDir, target, {
      force: opts?.forceAgentSync,
      skillNames: opts?.skillNames,
    });
    recordPerf("agent-sync-async", performance.now() - tAgent, { skills: opts?.skillNames?.length ?? 0 });
    const changed = synced.filter((r) => r.status === "installed" || r.status === "written");
    result.agentPathsUpdated = changed.length;
    result.skipped = synced.length === 0 && !catchUpMirrors && !opts?.forceAgentSync;
    if (changed.length > 0) {
      log(`Propagated workspace skills to ${changed.length} other agent path(s) (cursor/kiro/copilot).`);
    } else if (result.skipped) {
      recordPerf("agent-sync-noop", performance.now() - t0, { fingerprint: fpBefore.slice(0, 8) });
    }
    if (catchUpMirrors) {
      for (const gap of missingAgentMirrorSkills(target, libraryDir)) {
        log(`SKILL lint: catch-up sync for ${gap.agent} — missing ${gap.missing.length} mirror(s).`);
      }
    }
  } else if (catchUpMirrors && !shouldSyncWorkspaceToAll(libraryDir)) {
    log("Agent mirror catch-up skipped — enable claudeSkills.agents.syncWorkspaceToAll (host IDE only on solo-dev tier).");
  }

  lintAgentMirrorsOnSync(target, libraryDir, log);
  result.elapsedMs = performance.now() - t0;
  return result;
}

/** Synchronous path for force-sync and tests. */
function propagateWorkspaceSkillChangeInternal(
  extensionPath: string,
  target: string,
  libraryDir: string,
  log: (line: string) => void,
  opts?: WorkspaceSkillSyncOptions
): WorkspaceSkillSyncResult {
  return measureSync("workspace-sync-sync", () => {
    const result = runHooksAndLint(extensionPath, target, libraryDir, log, opts);
    const catchUpMirrors = agentMirrorsNeedSync(target, libraryDir);
    const partialSkills = (opts?.skillNames?.length ?? 0) > 0;
    const shouldSyncAgents =
      shouldSyncWorkspaceToAll() && (catchUpMirrors || opts?.forceAgentSync || partialSkills);

    if (shouldSyncAgents) {
      const synced = syncWorkspaceSkillsToAllAgents(libraryDir, target, {
        force: opts?.forceAgentSync,
        skillNames: opts?.skillNames,
      });
      const changed = synced.filter((r) => r.status === "installed" || r.status === "written");
      result.agentPathsUpdated = changed.length;
      result.skipped = synced.length === 0 && !catchUpMirrors && !opts?.forceAgentSync;
      if (changed.length > 0) {
        log(`Propagated workspace skills to ${changed.length} other agent path(s) (cursor/kiro/copilot).`);
      }
      if (catchUpMirrors) {
        for (const gap of missingAgentMirrorSkills(target, libraryDir)) {
          log(`SKILL lint: catch-up sync for ${gap.agent} — missing ${gap.missing.length} mirror(s).`);
        }
      }
    } else if (catchUpMirrors && !shouldSyncWorkspaceToAll(libraryDir)) {
      log("Agent mirror catch-up skipped — enable claudeSkills.agents.syncWorkspaceToAll (host IDE only on solo-dev tier).");
    }

    lintAgentMirrorsOnSync(target, libraryDir, log);
    return result;
  });
}

/** Test helper — reset debounce queue state. */
export function resetWorkspaceSyncQueueForTests(): void {
  syncQueue = undefined;
  pendingInternal = undefined;
}
