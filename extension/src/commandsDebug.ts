import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { checkMcpHealth } from "./mcpHealth";
import { isMcpForceClaudeMdInjected, isMcpForcePermissionsActive } from "./mcpForce";
import { readTaskActiveSkills, taskSkillFocusEnabled } from "./taskSkillFocus";
import { budgetUsagePercent, readBudgetConfig } from "./budgetConfig";
import { readTodayCostUsd } from "./todayCostSnapshot";
import { listInstalledSkills } from "./usageStats";
import { invalidateDetectionCache } from "./skillOps";
import { notifyUserSuccess, notifyUserWarn } from "./userNotify";

/** Everything a debugging session previously had to cross-reference by hand across
 * task-active-skills.json, settings.local.json/.claude/settings.json, mcp-usage.jsonl,
 * and in-memory refresh-loop timers — collapsed into one file. */
export const DEBUG_STATE_DUMP_RELATIVE = path.join(".claude", "learning", "debug-state-dump.json");

export interface RefreshDebugInfo {
  lastWorkspaceStateAtIso?: string;
  msSinceLastWorkspaceState?: number;
  lastCostDisciplineLogged?: string;
}

export interface DebugCommandDeps {
  context: vscode.ExtensionContext;
  getTarget: () => string | undefined;
  log: (line: string) => void;
  getRefreshDebugInfo: () => RefreshDebugInfo;
  /** Zeroes the refresh-loop's in-memory throttle/dedup timers (lastWorkspaceStateAt,
   * lastCostDisciplineLogged, etc.) so the next refreshAll() call actually re-runs
   * everything instead of being skipped as "already done recently" or "nothing changed". */
  resetRefreshThrottles: () => void;
  refreshAll: (opts?: { workspaceState?: boolean; forceTree?: boolean }) => void;
}

export function debugStateDumpPath(target: string): string {
  return path.join(target, DEBUG_STATE_DUMP_RELATIVE);
}

export function registerDebugCommands(deps: DebugCommandDeps): vscode.Disposable[] {
  const { context, getTarget, log, getRefreshDebugInfo, resetRefreshThrottles, refreshAll } = deps;

  return [
    vscode.commands.registerCommand("claudeSkills.debugDumpState", () => {
      const target = getTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }

      const health = checkMcpHealth(target);
      const taskActive = readTaskActiveSkills(target);
      const budgetConfig = readBudgetConfig();
      const todayCostUsd = readTodayCostUsd(target);

      const dump = {
        dumpedAt: new Date().toISOString(),
        extensionVersion: (context.extension.packageJSON as { version?: string }).version,
        workspaceTarget: target,
        refresh: getRefreshDebugInfo(),
        mcpHealth: health,
        mcpForce: {
          permissionsActive: isMcpForcePermissionsActive(target),
          claudeMdInjected: isMcpForceClaudeMdInjected(target),
        },
        taskFocus: {
          enabled: taskSkillFocusEnabled(),
          activeSkills: taskActive?.activeSkills ?? [],
          ignoredSkills: taskActive?.ignoredSkills ?? [],
          generatedAt: taskActive?.generatedAt,
          proposalsGeneratedAt: taskActive?.proposalsGeneratedAt,
        },
        budget: {
          config: budgetConfig,
          todayCostUsd,
          usagePercent: budgetUsagePercent(todayCostUsd, budgetConfig),
        },
        installedSkillsCount: listInstalledSkills(target).length,
      };

      const file = debugStateDumpPath(target);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(dump, null, 2) + "\n", "utf-8");
      log(`Debug state dump written to ${DEBUG_STATE_DUMP_RELATIVE}`);
      void notifyUserSuccess(`Claude Skills: debug state dumped to ${DEBUG_STATE_DUMP_RELATIVE}`);
    }),

    vscode.commands.registerCommand("claudeSkills.debugForceFullRefresh", () => {
      const target = getTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      // Detection results are cached (skillOps.ts's DETECTION_CACHE_TTL_MS) and the
      // workspace-state refresh loop throttles itself (workspaceRefresh.ts's
      // shouldRunWorkspaceState + extension.ts's dedup fingerprints) — both made live
      // testing non-deterministic this session (waiting on natural cache expiry, or
      // reloading the whole window as a workaround). Clear all of it and re-run now.
      invalidateDetectionCache(target);
      resetRefreshThrottles();
      refreshAll({ workspaceState: true, forceTree: true });
      log("Debug: forced full refresh — detection cache and refresh-loop throttles cleared, workspace-state re-run immediately.");
      void notifyUserSuccess("Claude Skills: forced full refresh (debug).");
    }),
  ];
}
