import * as vscode from "vscode";
import { autoMigrateProxyIfActive, revertMcpOptimizer } from "./mcpAutoOptimizer";
import { applyMcpAutoFixesForTarget } from "./mcpAutoFix";
import { clearMcpLogs, workspaceMcpLogPath, summarizeMcpUsage } from "./mcpUsageLog";
import {
  enableOfficialFilesystemServer,
  disableOfficialFilesystemServer,
  refreshFilesystemAllowedDirs,
} from "./mcpOfficial";
import {
  enableOfficialCliServer,
  disableOfficialCliServer,
  getCliMcpServerStatus,
  refreshCliConfig,
} from "./mcpCli";
import {
  installCliLoopGuardHook,
  removeCliLoopGuardHook,
  installDirCacheGuardHook,
  removeDirCacheGuardHook,
  installOfficialSkillsSessionHook,
  removeMcpForceHooks,
  installMcpForceHook,
  installMcpGateHook,
} from "./hookOps";
import {
  checkOfficialSkillUpdates,
  formatOfficialSkillsSessionContext,
  resolveSkillsLibraryDir,
} from "./officialSkillsSync";
import { checkMcpHealth } from "./mcpHealth";
import {
  enableMcpForcePermissions,
  injectMcpForceClaude,
  isMcpForceActive,
  revertMcpForcePermissions,
  removeMcpForceClaudeBlock,
} from "./mcpForce";
import { notifyUserSuccess, notifyUserWarn, notifySuggestion } from "./userNotify";
import { recordError } from "./analytics";
import { ExtensionSharedContext } from "./extensionSharedContext";

export function registerMcpCommands(shared: ExtensionSharedContext): void {
  const { context, log, getWorkspaceTarget, maybeRevealOutputPanel, revealOutputPanel,
    provider, refreshMcpStatusBars, refreshCliMcpStatusBar } = shared;

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSkills.disableMcpOptimizer", () => {
      maybeRevealOutputPanel();
      revertMcpOptimizer(context, log);
    }),

    vscode.commands.registerCommand("claudeSkills.clearMcpLogs", async () => {
      const answer = await vscode.window.showWarningMessage(
        "Clear all local MCP server logs? This removes mcp-usage.jsonl and mcp-agent-hints.md and cannot be undone.",
        { modal: true },
        "Clear"
      );
      if (answer !== "Clear") return;
      const ws = getWorkspaceTarget();
      const wsLog = ws ? workspaceMcpLogPath(ws) : undefined;
      const result = clearMcpLogs(wsLog);
      const cleared: string[] = [];
      if (result.clearedGlobal) cleared.push("global log");
      if (result.clearedWorkspace) cleared.push("workspace log");
      if (result.clearedHints) cleared.push("hints");
      void notifyUserSuccess(
        cleared.length > 0
          ? `Claude Skills: cleared MCP ${cleared.join(", ")}.`
          : "Claude Skills: no MCP log files found to clear."
      );
    }),

    vscode.commands.registerCommand("claudeSkills.applyMcpAutoFixes", async () => {
      const target = getWorkspaceTarget();
      if (!target) { void notifyUserWarn("Claude Skills: open a workspace folder first."); return; }
      const result = applyMcpAutoFixesForTarget(target);
      if (result.totalFixed === 0) {
        void notifyUserWarn("Claude Skills: no actionable efficiency issues found — nothing to fix.");
        return;
      }
      void notifyUserSuccess(
        `Claude Skills: ${result.totalFixed} permanent hint rule(s) written to mcp-agent-hints.md — agents will respect them at next session start.`
      );
    }),

    vscode.commands.registerCommand("claudeSkills.enableOfficialFilesystemServer", async () => {
      maybeRevealOutputPanel();
      const workspaceDirs = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      const result = await enableOfficialFilesystemServer(context.extensionPath, workspaceDirs, log, () => {
        provider.refreshMcpServerStatus();
      });
      if (result.enabled.length > 0) {
        log(`Enabled filesystem MCP server for: ${result.enabled.join(", ")}.`);
      }
      for (const error of result.errors) {
        log(`Filesystem MCP server error for ${error.agentId}: ${error.message}`);
      }
    }),

    vscode.commands.registerCommand("claudeSkills.disableOfficialFilesystemServer", async () => {
      maybeRevealOutputPanel();
      await disableOfficialFilesystemServer(log, () => {
        provider.refreshMcpServerStatus();
      });
    }),

    vscode.commands.registerCommand("claudeSkills.enableCliMcpServer", async () => {
      maybeRevealOutputPanel();
      const workspaceDirs = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      const result = await enableOfficialCliServer(context.extensionPath, workspaceDirs, log, () => {
        provider.refreshMcpServerStatus();
        refreshCliMcpStatusBar();
      });
      if (result.enabled.length > 0) {
        log(`Enabled CLI MCP server for: ${result.enabled.join(", ")}.`);
      }
      for (const error of result.errors) {
        log(`CLI MCP server error for ${error.agentId}: ${error.message}`);
      }
      refreshCliMcpStatusBar();
    }),

    vscode.commands.registerCommand("claudeSkills.disableCliMcpServer", async () => {
      maybeRevealOutputPanel();
      await disableOfficialCliServer(log, () => {
        provider.refreshMcpServerStatus();
        refreshCliMcpStatusBar();
      });
      refreshCliMcpStatusBar();
    }),

    vscode.commands.registerCommand("claudeSkills.enableCliLoopGuard", () => {
      const target = getWorkspaceTarget();
      if (!target) { void vscode.window.showWarningMessage("Claude Skills: No workspace folder open."); return; }
      const status = installCliLoopGuardHook(target);
      const msg = status === "already-configured"
        ? "CLI loop-guard hook already active."
        : "CLI loop-guard hook installed — Claude will receive corrective hints on CLI failures.";
      log(`CLI loop-guard: ${status}`);
      void vscode.window.showInformationMessage(`Claude Skills: ${msg}`);
    }),

    vscode.commands.registerCommand("claudeSkills.disableCliLoopGuard", () => {
      const target = getWorkspaceTarget();
      if (!target) { void vscode.window.showWarningMessage("Claude Skills: No workspace folder open."); return; }
      const removed = removeCliLoopGuardHook(target);
      log(`CLI loop-guard: ${removed ? "removed" : "was not configured"}`);
      void vscode.window.showInformationMessage(`Claude Skills: CLI loop-guard hook ${removed ? "removed" : "was not active"}.`);
    }),

    vscode.commands.registerCommand("claudeSkills.enableDirCacheGuard", () => {
      const target = getWorkspaceTarget();
      if (!target) { void vscode.window.showWarningMessage("Claude Skills: No workspace folder open."); return; }
      const status = installDirCacheGuardHook(target);
      const msg = status === "already-configured"
        ? "Dir cache guard already active."
        : "Dir cache guard installed — redundant list_directory calls will be blocked automatically.";
      log(`Dir cache guard: ${status}`);
      void vscode.window.showInformationMessage(`Claude Skills: ${msg}`);
    }),

    vscode.commands.registerCommand("claudeSkills.disableDirCacheGuard", () => {
      const target = getWorkspaceTarget();
      if (!target) { void vscode.window.showWarningMessage("Claude Skills: No workspace folder open."); return; }
      const removed = removeDirCacheGuardHook(target);
      log(`Dir cache guard: ${removed ? "removed" : "was not configured"}`);
      void vscode.window.showInformationMessage(`Claude Skills: Dir cache guard ${removed ? "removed" : "was not active"}.`);
    }),

    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const workspaceDirs = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      refreshFilesystemAllowedDirs(workspaceDirs, log);
      refreshCliConfig(workspaceDirs, log);
    }),

    vscode.commands.registerCommand("claudeSkills.installOfficialSkillsSessionHook", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      try {
        const status = installOfficialSkillsSessionHook(context.extensionPath, target);
        maybeRevealOutputPanel();
        log(`\n=== Official skills SessionStart hook -> ${target} ===`);
        log(status);
        void notifyUserSuccess(`Claude Skills: official skills session hook ${status}.`);
      } catch (err) {
        recordError();
        vscode.window.showWarningMessage(`Claude Skills: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("claudeSkills.checkOfficialSkillUpdates", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const libraryDir = resolveSkillsLibraryDir(target);
      if (!libraryDir) {
        vscode.window.showWarningMessage(
          "Claude Skills: no skills_library/ found in this workspace (official updater targets the library folder)."
        );
        return;
      }
      try {
        const result = await checkOfficialSkillUpdates(libraryDir);
        maybeRevealOutputPanel();
        log(`\n=== Official Anthropic skills check -> ${libraryDir} ===`);
        if (result.checkError) {
          log(result.checkError);
          vscode.window.showWarningMessage(`Claude Skills: ${result.checkError}`);
          return;
        }
        if (result.unchanged) {
          log(`Up to date (HEAD ${result.remoteSha?.slice(0, 12) ?? "unknown"}).`);
          void notifyUserSuccess("Claude Skills: official Anthropic skills are up to date.");
          return;
        }
        const sessionContext = formatOfficialSkillsSessionContext(result);
        log(sessionContext);
        log("\nIn Claude Code, ask the agent to follow skill-official-updater to pull selected skills.");
        installOfficialSkillsSessionHook(context.extensionPath, target);
        void notifySuggestion(
          "Official skill updates available — see output. Ask Claude Code to run skill-official-updater.",
          ["Open Output"],
          { log }
        ).then((sel) => {
          if (sel === "Open Output") {
            revealOutputPanel();
          }
        });
      } catch (err) {
        recordError();
        vscode.window.showWarningMessage(`Claude Skills: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("claudeSkills.showMcpHealth", () => {
      const health = checkMcpHealth();
      const cliStatus = getCliMcpServerStatus();
      const target = getWorkspaceTarget();
      const logPath = target ? workspaceMcpLogPath(target) : undefined;
      const summary = summarizeMcpUsage(1, logPath);
      const { score, grade, totalOps, wastefulOps, notEnoughData } = summary.efficiencyScore;

      const connIcon = health.status === "ready" ? "✓" : health.status === "no-activity" ? "~" : "✗";
      const lines: string[] = [
        `── Filesystem MCP Server ──`,
        `Status:       ${health.status === "ready" ? "Connected" : health.status === "no-activity" ? "Idle (no activity 24h)" : "Setup needed"}  ${connIcon}`,
        `Config:       ${health.configValid ? "✓ valid" : "✗ invalid"}`,
        `Server script:${health.serverExists ? "✓ found" : "✗ missing"}`,
        `Calls (24h):  ${health.mcpCallsLast24h}`,
      ];
      if (health.lastActivityTime) {
        lines.push(`Last activity: ${health.lastActivityTime}`);
      }
      if (health.configuredAgents.length > 0) {
        lines.push(`Agents:       ${health.configuredAgents.join(", ")}`);
      }
      if (health.errors.length > 0) {
        lines.push("", "Issues:", ...health.errors.map((e) => `  - ${e}`));
      }

      lines.push(``, `── CLI MCP Server ──`);
      if (cliStatus.enabled) {
        lines.push(
          `Status:       Connected  ✓`,
          `Agents:       ${cliStatus.activeAgents.join(", ")}`,
          `CLIs:         az, aws, git, kubectl, helm, terraform, gcloud, docker, gh, dotnet, node, npm`,
        );
      } else {
        lines.push(
          `Status:       Setup needed  ✗`,
          `Action:       Run "Enable CLI MCP Server" from the command palette`,
        );
      }

      if (summary.totalCalls > 0) {
        lines.push(``, `── Agent KPI (last 24h) ──`);
        if (notEnoughData) {
          lines.push(`Not enough data (${totalOps} ops — need 5+ to score)`);
        } else {
          lines.push(
            `Efficiency:   ${score}% (grade ${grade})`,
            `Total ops:    ${totalOps}  Wasteful: ${wastefulOps}`,
            `Wasted tokens:~${summary.totalWastedTokens.toLocaleString()}`,
          );
          if (summary.suggestions.length > 0) {
            lines.push(``, `Top suggestion:`, `  ${summary.suggestions[0].description}`);
          }
        }
      }
      vscode.window.showInformationMessage(lines.join("\n"), { modal: true }, "Show Output").then((choice) => {
        if (choice === "Show Output") {
          revealOutputPanel();
        }
      });
    }),

    vscode.commands.registerCommand("claudeSkills.enableMcpForce", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const permResult = enableMcpForcePermissions(target);
      if (!permResult.ok) {
        void vscode.window.showErrorMessage(`Claude Skills MCP-Force: ${permResult.reason}`);
        return;
      }
      const injectResult = injectMcpForceClaude(target);
      if (!injectResult.ok) {
        void vscode.window.showErrorMessage(`Claude Skills MCP-Force: ${injectResult.reason}`);
        return;
      }
      installMcpForceHook(target);
      installMcpGateHook(target);
      log("MCP-force mode enabled: permissions.deny set, CLAUDE.md updated, hooks installed.");
      void vscode.window.showInformationMessage(
        "Claude Skills: MCP-force mode enabled. Native file tools blocked; agents must use mcp__filesystem__* tools."
      );
    }),

    vscode.commands.registerCommand("claudeSkills.disableMcpForce", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      if (!isMcpForceActive(target)) {
        void vscode.window.showInformationMessage("Claude Skills: MCP-force mode is not active.");
        return;
      }
      revertMcpForcePermissions(target);
      removeMcpForceClaudeBlock(target);
      removeMcpForceHooks(target);
      log("MCP-force mode disabled: permissions restored, CLAUDE.md block removed, hooks removed.");
      void vscode.window.showInformationMessage(
        "Claude Skills: MCP-force mode disabled. Native file tools restored."
      );
    }),

    vscode.commands.registerCommand("claudeSkills.refreshMcpStatus", () => {
      refreshMcpStatusBars();
      refreshCliMcpStatusBar();
    })
  );
}
