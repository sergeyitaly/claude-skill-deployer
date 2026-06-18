import * as vscode from "vscode";
import { checkMcpHealth } from "./mcpHealth";
import {
  isMcpForceActive,
  revertMcpForcePermissions,
  removeMcpForceClaudeBlock,
} from "./mcpForce";
import { removeMcpForceHooks } from "./hookOps";

const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes

/**
 * Starts a periodic health check that auto-reverts MCP force mode when the
 * MCP server is no longer reachable. Prevents agents from being permanently
 * locked out of native tools after a server crash or misconfiguration.
 *
 * Returns a Disposable so the interval is cleared on extension deactivation.
 */
export function startMcpForceWatchdog(
  getTarget: () => string | undefined,
  log: (msg: string) => void,
  onReverted?: () => void
): vscode.Disposable {
  const timer = setInterval(() => {
    const target = getTarget();
    if (!target || !isMcpForceActive(target)) return;

    const health = checkMcpHealth();
    if (health.status !== "config-issue") return;

    // MCP server is broken while force mode is active — revert immediately to
    // prevent agents from being unable to read or write any files.
    try {
      revertMcpForcePermissions(target);
      removeMcpForceClaudeBlock(target);
      removeMcpForceHooks(target);
      log(
        "MCP-force watchdog: server config-issue detected — force mode auto-reverted to prevent agent deadlock."
      );
      void vscode.window.showWarningMessage(
        "Claude Skills: MCP-force mode was auto-disabled because the MCP server is no longer reachable. " +
          "Re-enable it once MCP is working again.",
        "Show Output"
      ).then((choice) => {
        if (choice === "Show Output") {
          void vscode.commands.executeCommand("claudeSkills.showOutput");
        }
      });
    } catch (err) {
      log(
        `MCP-force watchdog: revert failed — ${err instanceof Error ? err.message : String(err)}`
      );
    }

    onReverted?.();
  }, WATCHDOG_INTERVAL_MS);

  return { dispose: () => clearInterval(timer) };
}
