import * as fs from "node:fs";
import * as vscode from "vscode";
import { checkMcpHealth } from "./mcpHealth";
import { getCliMcpServerStatus } from "./mcpCli";
import {
  summarizeMcpUsage,
  workspaceMcpLogPath,
  computeCliKpi,
  readMcpUsageLog,
} from "./mcpUsageLog";
import { computeHaceMetrics, HaceMetrics } from "./haceMetrics";

// ---------------------------------------------------------------------------
// Module-level state — initialised once from extension.ts activate()
// ---------------------------------------------------------------------------

let _mcpHealthStatusBarItem: vscode.StatusBarItem | undefined;
let _mcpKpiStatusBarItem: vscode.StatusBarItem | undefined;
let _mcpCliStatusBarItem: vscode.StatusBarItem | undefined;

let lastMcpBarRefreshMs = 0;
const MCP_BAR_REFRESH_INTERVAL_MS = 2000;

let _haceCache: HaceMetrics | null = null;
let _haceCacheTarget = "";
let _haceCacheMs = 0;
const HACE_CACHE_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initMcpStatusBars(
  health: vscode.StatusBarItem,
  kpi: vscode.StatusBarItem,
  cli: vscode.StatusBarItem,
): void {
  _mcpHealthStatusBarItem = health;
  _mcpKpiStatusBarItem = kpi;
  _mcpCliStatusBarItem = cli;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Hybrid log path: prefer workspace-scoped log when it has data, otherwise
 * fall back to undefined so readMcpUsageLog uses the global log
 * (~/.claude/learning/mcp-usage.jsonl).  Matches the dashboard's "hybrid" mode.
 */
function resolveLogPath(workspaceTarget: string | undefined): string | undefined {
  if (!workspaceTarget) return undefined;
  const wsPath = workspaceMcpLogPath(workspaceTarget);
  try {
    if (fs.existsSync(wsPath) && fs.statSync(wsPath).size > 0) return wsPath;
  } catch {
    // fall through to global
  }
  return undefined;
}

function getCachedHace(target: string, cliSuccessRate: number): HaceMetrics {
  const now = Date.now();
  if (_haceCache && _haceCacheTarget === target && now - _haceCacheMs < HACE_CACHE_TTL_MS) {
    return _haceCache;
  }
  _haceCache = computeHaceMetrics(target, cliSuccessRate, 14);
  _haceCacheTarget = target;
  _haceCacheMs = now;
  return _haceCache;
}

// ---------------------------------------------------------------------------
// Public refresh functions
// ---------------------------------------------------------------------------

/**
 * Refresh MCP health and KPI status bars.
 * Throttled to MCP_BAR_REFRESH_INTERVAL_MS.
 */
export function refreshMcpStatusBars(workspaceTarget?: string): void {
  if (!_mcpHealthStatusBarItem || !_mcpKpiStatusBarItem) return;

  const now = Date.now();
  if (now - lastMcpBarRefreshMs < MCP_BAR_REFRESH_INTERVAL_MS) return;
  lastMcpBarRefreshMs = now;

  // ── Health bar ────────────────────────────────────────────────────────────
  const health = checkMcpHealth();
  const agentCount = health.configuredAgents.length;
  const agentLabel = agentCount > 0 ? ` · ${agentCount} agents` : "";

  if (health.status === "ready") {
    _mcpHealthStatusBarItem.text = `$(plug) MCP Connected`;
    _mcpHealthStatusBarItem.tooltip =
      `MCP filesystem server active.\nAgents: ${health.configuredAgents.join(", ")}\nLast activity: ${health.lastActivityTime ?? "unknown"}\nCalls (24h): ${health.mcpCallsLast24h}\n\nClick for details.`;
    _mcpHealthStatusBarItem.backgroundColor = undefined;
  } else if (health.status === "no-activity") {
    _mcpHealthStatusBarItem.text = `$(plug) MCP${agentLabel}`;
    _mcpHealthStatusBarItem.tooltip =
      `MCP filesystem server configured for: ${health.configuredAgents.join(", ") || "none"}.\n\nActivity is logged when an agent calls a filesystem tool (read_file, list_directory, etc.).\nChatting with Claude does not trigger filesystem MCP calls directly.\n\nClick for details.`;
    _mcpHealthStatusBarItem.backgroundColor = undefined;
  } else {
    _mcpHealthStatusBarItem.text = `$(warning) MCP: setup needed`;
    _mcpHealthStatusBarItem.tooltip =
      `MCP server is not ready.\n${health.errors.join("\n")}\n\nClick to diagnose.`;
    _mcpHealthStatusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  }
  _mcpHealthStatusBarItem.command = "claudeSkills.showMcpHealth";
  _mcpHealthStatusBarItem.show();

  // ── KPI bar ───────────────────────────────────────────────────────────────
  // Hybrid log path: workspace log if non-empty, otherwise global log.
  const logPath = resolveLogPath(workspaceTarget);
  const summary = summarizeMcpUsage(1, logPath);
  const { score, grade, notEnoughData } = summary.efficiencyScore;
  const calls = summary.totalCalls;

  // HACE is derived from session transcripts independently of MCP call count.
  let haceSection = "";
  if (workspaceTarget) {
    try {
      const cliEntries = readMcpUsageLog(logPath);
      const kpi2 = computeCliKpi(cliEntries, 14);
      const h = getCachedHace(workspaceTarget, kpi2.overallSuccessRate);
      if (!h.noData) {
        haceSection =
          `\n\n-- HACE · Human-AI Collaboration --\n` +
          `Score: ${h.haceScore}/100 · ${h.grade}\n` +
          `  Prompt Clarity  ${h.promptClarityScore}%  (thinking rate: ${Math.round(h.thinkingRate * 100)}%)\n` +
          `  Task Velocity   ${h.taskVelocityScore}%  (${h.turnsPerMinute.toFixed(1)} turns/min)\n` +
          `  Accuracy        ${h.accuracyScore}%  (correction rate: ${Math.round(h.correctionRate * 100)}%)\n` +
          `  CLI Efficiency  ${h.cliEfficiencyScore}%\n` +
          `  Avg response    ${h.avgResponseSecs.toFixed(1)}s`;
      }
    } catch { /* non-fatal */ }
  }

  if (calls === 0) {
    _mcpKpiStatusBarItem.text = `$(pulse) Agent KPI: ready`;
    _mcpKpiStatusBarItem.tooltip =
      `No filesystem MCP tool calls in the last 24h. KPIs appear after a Claude CLI, Cursor, or Kiro session makes file operations.${haceSection}\n\nClick for the MCP health report.`;
  } else if (notEnoughData) {
    _mcpKpiStatusBarItem.text = `$(pulse) Agent KPI: ${calls} call(s)`;
    _mcpKpiStatusBarItem.tooltip =
      `AI Agent KPI (last 24h)\n` +
      `Not enough data — need 5 or more ops to score (${calls} so far).\n\n` +
      `KPI grade appears once enough filesystem tool calls are recorded.${haceSection}\n\nClick for the MCP health report.`;
  } else {
    const wastedLabel =
      summary.totalWastedTokens > 0
        ? ` · ${(summary.totalWastedTokens / 1000).toFixed(1)}k wasted`
        : "";
    _mcpKpiStatusBarItem.text = `$(pulse) KPI: ${grade} · ${calls} calls`;
    _mcpKpiStatusBarItem.tooltip =
      `AI Agent KPI (last 24h)\n` +
      `Efficiency: ${score}% (grade ${grade})\n` +
      `MCP calls: ${calls}${wastedLabel}\n` +
      (summary.suggestions.length > 0 ? `\nTop hint: ${summary.suggestions[0].description}` : "") +
      haceSection +
      `\n\nClick for full MCP health report.`;
  }
  _mcpKpiStatusBarItem.command = "claudeSkills.showMcpHealth";
  _mcpKpiStatusBarItem.show();
}

/**
 * Refresh CLI MCP server status bar.
 */
export function refreshCliMcpStatusBar(): void {
  if (!_mcpCliStatusBarItem) return;
  const status = getCliMcpServerStatus();
  if (status.enabled) {
    const agentLabel = status.activeAgents.length > 0 ? ` · ${status.activeAgents.join(", ")}` : "";
    _mcpCliStatusBarItem.text = `$(terminal-cmd) CLI MCP${agentLabel}`;
    _mcpCliStatusBarItem.tooltip =
      `CLI MCP server active for: ${status.activeAgents.join(", ")}.\n` +
      `Supported CLIs: az, aws, git, kubectl, helm, terraform, gcloud, docker, gh, dotnet, node, npm.\n\n` +
      `Click to disable.`;
    _mcpCliStatusBarItem.command = "claudeSkills.disableCliMcpServer";
    _mcpCliStatusBarItem.backgroundColor = undefined;
  } else {
    _mcpCliStatusBarItem.text = `$(warning) CLI MCP: setup needed`;
    _mcpCliStatusBarItem.tooltip =
      `CLI MCP server is not configured.\n` +
      `Enables agents to run: az, aws, git, kubectl, helm, terraform, gcloud, docker, gh, dotnet, node, npm.\n\n` +
      `Click to enable.`;
    _mcpCliStatusBarItem.command = "claudeSkills.enableCliMcpServer";
    _mcpCliStatusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  }
  _mcpCliStatusBarItem.show();
}

/** Force an immediate refresh on the next call (useful after extension activation). */
export function resetMcpStatusBarRefreshThrottle(): void {
  lastMcpBarRefreshMs = 0;
}
