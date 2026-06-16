import * as vscode from "vscode";
import { summarizeMcpUsage, writeMcpHints, McpUsageSummary } from "./mcpUsageLog";
import { formatTokenCount } from "./usageStats";

// ---------------------------------------------------------------------------
// Severity thresholds
// ---------------------------------------------------------------------------

const MIN_TOKENS_TO_ALERT = 1_000;
const CRITICAL_EFFICIENCY = 40;
const WARNING_EFFICIENCY = 60;
const CRITICAL_WASTE_TOKENS = 5_000;

// ---------------------------------------------------------------------------
// Deduplication
// Keyed by "kpi-{severity}|{issueType}|{sessionId-or-date}" so:
// - different issue types in the same session each fire once
// - the same issue in the same session fires only once
// ---------------------------------------------------------------------------

const alertedKeys = new Set<string>();

function dedupeKey(severity: string, issueType: string, sessionId?: string): string {
  const bucket = sessionId ?? new Date().toISOString().slice(0, 10);
  return `kpi-${severity}|${issueType}|${bucket}`;
}

// ---------------------------------------------------------------------------
// Issue classification
// ---------------------------------------------------------------------------

type IssueType = "loop" | "high-waste" | "low-efficiency";

function classifyIssues(mcp: McpUsageSummary): IssueType[] {
  const types: IssueType[] = [];
  if (mcp.agentLoops.length > 0 && mcp.totalWastedTokens > CRITICAL_WASTE_TOKENS) {
    types.push("loop");
  }
  if (mcp.totalWastedTokens > CRITICAL_WASTE_TOKENS && !types.includes("loop")) {
    types.push("high-waste");
  }
  if (mcp.efficiencyScore.score < WARNING_EFFICIENCY) {
    types.push("low-efficiency");
  }
  return types;
}

// ---------------------------------------------------------------------------
// Alert payload
// ---------------------------------------------------------------------------

export type KpiAlertSeverity = "critical" | "warning" | "none";

export interface KpiAlertPayload {
  severity: KpiAlertSeverity;
  issueTypes: IssueType[];
  message: string;
}

export function buildKpiAlertPayload(mcp: McpUsageSummary): KpiAlertPayload {
  if (mcp.totalEstimatedTokens < MIN_TOKENS_TO_ALERT) {
    return { severity: "none", issueTypes: [], message: "" };
  }

  const score = mcp.efficiencyScore.score;
  const issueTypes = classifyIssues(mcp);

  if (issueTypes.length === 0) {
    return { severity: "none", issueTypes: [], message: "" };
  }

  const isCritical = score < CRITICAL_EFFICIENCY || issueTypes.includes("loop");
  const severity: KpiAlertSeverity = isCritical ? "critical" : "warning";

  const issueSummary: string[] = [];
  if (issueTypes.includes("loop")) issueSummary.push(`${mcp.agentLoops.length} agent loop(s)`);
  if (issueTypes.includes("high-waste")) issueSummary.push(`${formatTokenCount(mcp.totalWastedTokens)} tokens wasted`);
  if (issueTypes.includes("low-efficiency")) issueSummary.push(`efficiency ${score}% (${mcp.efficiencyScore.grade})`);

  const wastedUsd = (mcp.totalWastedTokens / 1_000_000 * 3).toFixed(3);
  const prefix = isCritical ? "⚠ AI Efficiency Critical" : "AI Efficiency Low";
  const message = `${prefix} — ${issueSummary.join(", ")}. ~$${wastedUsd} avoidable.`;

  return { severity, issueTypes, message };
}

// ---------------------------------------------------------------------------
// Show alert per issue type (prevents collapsing different problems into one)
// ---------------------------------------------------------------------------

export function maybeShowKpiAlert(
  mcp: McpUsageSummary,
  onViewDetails: () => void,
  onAutoOptimize: (mcp: McpUsageSummary) => void
): void {
  const payload = buildKpiAlertPayload(mcp);
  if (payload.severity === "none") return;

  // Fire at most once per issue type per session (falls back to date if no session ID).
  const unfiredTypes = payload.issueTypes.filter((t) => {
    const key = dedupeKey(payload.severity, t, mcp.latestSessionId);
    if (alertedKeys.has(key)) return false;
    alertedKeys.add(key);
    return true;
  });

  if (unfiredTypes.length === 0) return;

  const showFn =
    payload.severity === "critical"
      ? vscode.window.showWarningMessage
      : vscode.window.showInformationMessage;

  void showFn(payload.message, "View Details", "Auto-optimize", "Dismiss").then((pick) => {
    if (pick === "View Details") onViewDetails();
    else if (pick === "Auto-optimize") onAutoOptimize(mcp);
  });
}

// ---------------------------------------------------------------------------
// Auto-optimize: inject hints directly without requiring a panel open
// ---------------------------------------------------------------------------

export function runAutoOptimize(mcp: McpUsageSummary): void {
  try {
    writeMcpHints(mcp);
    const hotCount = mcp.wasteWarnings.length + mcp.agentLoops.length;
    const msg =
      hotCount > 0
        ? `Claude Skills: MCP hints updated — ${hotCount} issue(s) documented in mcp-agent-hints.md. Agents will read this at next session start.`
        : "Claude Skills: MCP optimization hints refreshed.";
    void vscode.window.showInformationMessage(msg);
  } catch {
    void vscode.window.showWarningMessage("Claude Skills: could not write MCP hints file.");
  }
}

// ---------------------------------------------------------------------------
// Convenience: evaluate and alert from a refresh cycle
// ---------------------------------------------------------------------------

export function checkAndShowKpiAlert(
  onViewDetails: () => void
): void {
  try {
    const mcp = summarizeMcpUsage(1); // last 24 h — recent activity only
    maybeShowKpiAlert(mcp, onViewDetails, runAutoOptimize);
  } catch {
    // non-fatal — never crash the extension over a telemetry alert
  }
}
