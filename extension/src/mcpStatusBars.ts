import * as vscode from "vscode";
import { checkMcpHealth } from "./mcpHealth";
import { getCliMcpServerStatus } from "./mcpCli";
import { summarizeMcpUsage, workspaceMcpLogPath } from "./mcpUsageLog";

export interface McpStatusBarItems {
  mcpHealthStatusBarItem: vscode.StatusBarItem;
  mcpKpiStatusBarItem: vscode.StatusBarItem;
  mcpCliStatusBarItem: vscode.StatusBarItem;
}

let lastMcpBarRefreshMs = 0;
const MCP_BAR_REFRESH_INTERVAL_MS = 2000;

/**
 * Refresh MCP health and KPI status bars with throttling to prevent excessive updates.
 * Requires both mcpHealthStatusBarItem and mcpKpiStatusBarItem to be initialized.
 */
export function refreshMcpStatusBars(
  mcpHealthStatusBarItem: vscode.StatusBarItem,
  mcpKpiStatusBarItem: vscode.StatusBarItem,
  workspaceTarget?: string
): void {
  const now = Date.now();
  if (now - lastMcpBarRefreshMs < MCP_BAR_REFRESH_INTERVAL_MS) return;
  lastMcpBarRefreshMs = now;

  const health = checkMcpHealth();
  const agentCount = health.configuredAgents.length;
  const agentLabel = agentCount > 0 ? ` · ${agentCount} agents` : "";

  // Update health status bar
  if (health.status === "ready") {
    mcpHealthStatusBarItem.text = `$(plug) MCP Connected`;
    mcpHealthStatusBarItem.tooltip =
      `MCP filesystem server active.\nAgents: ${health.configuredAgents.join(", ")}\nLast activity: ${health.lastActivityTime ?? "unknown"}\nCalls (24h): ${health.mcpCallsLast24h}\n\nClick for details.`;
    mcpHealthStatusBarItem.backgroundColor = undefined;
  } else if (health.status === "no-activity") {
    mcpHealthStatusBarItem.text = `$(plug) MCP${agentLabel}`;
    mcpHealthStatusBarItem.tooltip =
      `MCP filesystem server configured for: ${health.configuredAgents.join(", ") || "none"}.\n\nActivity is logged when an agent calls a filesystem tool (read_file, list_directory, etc.).\nChatting with Claude does not trigger filesystem MCP calls directly.\n\nClick for details.`;
    mcpHealthStatusBarItem.backgroundColor = undefined;
  } else {
    mcpHealthStatusBarItem.text = `$(warning) MCP: setup needed`;
    mcpHealthStatusBarItem.tooltip =
      `MCP server is not ready.\n${health.errors.join("\n")}\n\nClick to diagnose.`;
    mcpHealthStatusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  }
  mcpHealthStatusBarItem.command = "claudeSkills.showMcpHealth";
  mcpHealthStatusBarItem.show();

  // Update KPI status bar
  const logPath = workspaceTarget ? workspaceMcpLogPath(workspaceTarget) : undefined;
  const summary = summarizeMcpUsage(1, logPath);
  const { score, grade, notEnoughData } = summary.efficiencyScore;
  const calls = summary.totalCalls;

  if (calls === 0) {
    mcpKpiStatusBarItem.text = `$(pulse) Agent KPI: ready`;
    mcpKpiStatusBarItem.tooltip = `No filesystem MCP tool calls in the last 24h. KPIs appear after a Claude CLI, Cursor, or Kiro session makes file operations.\n\nClick for the MCP health report.`;
  } else if (notEnoughData) {
    mcpKpiStatusBarItem.text = `$(pulse) Agent KPI: ${calls} call(s)`;
    mcpKpiStatusBarItem.tooltip =
      `AI Agent KPI (last 24h)\n` +
      `Not enough data — need ${5} or more ops to score (${calls} so far).\n\n` +
      `KPI grade appears once enough filesystem tool calls are recorded.\n\nClick for the MCP health report.`;
  } else {
    const wastedLabel = summary.totalWastedTokens > 0 ? ` · ${(summary.totalWastedTokens / 1000).toFixed(1)}k wasted` : "";
    mcpKpiStatusBarItem.text = `$(pulse) KPI: ${grade} · ${calls} calls`;
    mcpKpiStatusBarItem.tooltip =
      `AI Agent KPI (last 24h)\n` +
      `Efficiency: ${score}% (grade ${grade})\n` +
      `MCP calls: ${calls}${wastedLabel}\n` +
      (summary.suggestions.length > 0 ? `\nTop hint: ${summary.suggestions[0].description}` : "") +
      `\n\nClick for full MCP health report.`;
  }
  mcpKpiStatusBarItem.command = "claudeSkills.showMcpHealth";
  mcpKpiStatusBarItem.show();
}

/**
 * Refresh CLI MCP server status bar.
 * Updates the status bar to show whether CLI MCP server is enabled and configured.
 */
export function refreshCliMcpStatusBar(mcpCliStatusBarItem: vscode.StatusBarItem): void {
  const status = getCliMcpServerStatus();
  if (status.enabled) {
    const agentLabel = status.activeAgents.length > 0 ? ` · ${status.activeAgents.join(", ")}` : "";
    mcpCliStatusBarItem.text = `$(terminal-cmd) CLI MCP${agentLabel}`;
    mcpCliStatusBarItem.tooltip =
      `CLI MCP server active for: ${status.activeAgents.join(", ")}.\n` +
      `Supported CLIs: az, aws, git, kubectl, helm, terraform, gcloud, docker, gh, dotnet, node, npm.\n\n` +
      `Click to disable.`;
    mcpCliStatusBarItem.command = "claudeSkills.disableCliMcpServer";
    mcpCliStatusBarItem.backgroundColor = undefined;
  } else {
    mcpCliStatusBarItem.text = `$(warning) CLI MCP: setup needed`;
    mcpCliStatusBarItem.tooltip =
      `CLI MCP server is not configured.\n` +
      `Enables agents to run: az, aws, git, kubectl, helm, terraform, gcloud, docker, gh, dotnet, node, npm.\n\n` +
      `Click to enable.`;
    mcpCliStatusBarItem.command = "claudeSkills.enableCliMcpServer";
    mcpCliStatusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  }
  mcpCliStatusBarItem.show();
}

/**
 * Reset the MCP status bar refresh throttle.
 * Call this after extension activation or when debugging to force an immediate refresh.
 */
export function resetMcpStatusBarRefreshThrottle(): void {
  lastMcpBarRefreshMs = 0;
}
