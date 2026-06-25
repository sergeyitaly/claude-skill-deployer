/**
 * Context Advisor — Phases 2, 8, 9
 *
 *   Phase 2  — evaluateCompactAdvisor()   triggers /compact recommendation
 *   Phase 8  — buildCoachingMessages()    prioritised savings-first coaching
 *              formatEfficiencyCoachHtml() — rendered coaching panel
 *   Phase 9  — Advisor ROI: followRate, estimatedTokensSaved via Phase 9 functions in contextEfficiency.ts
 *
 * Critical constraint: never auto-executes any command — only surfaces recommendations.
 */
import * as path from "node:path";
import {
  ContextEfficiencyAnalysis,
  AdvisorROI,
  COMPACT_TOKEN_THRESHOLD,
  COMPACT_WASTE_THRESHOLD,
  COMPACT_REPEATED_THRESHOLD,
} from "./contextEfficiency";

// ── Phase 2: Compact Advisor ──────────────────────────────────────────────────

export interface CompactAdvisorResult {
  /** Whether to surface the advisor UI. */
  shouldShow: boolean;
  /** Comma-separated trigger reasons. */
  triggerReason: string;
  /** Estimated context reduction, expressed as a percentage range floor. */
  estimatedSavingsPct: number;
  /** Estimated raw token savings (for advisor-log entry). */
  estimatedTokensSaved: number;
  /** Primary recommended command. */
  primaryAction: "/compact";
  /** Secondary quick-wins (caching, directory reuse). */
  secondaryActions: string[];
}

export function evaluateCompactAdvisor(analysis: ContextEfficiencyAnalysis): CompactAdvisorResult {
  const { efficiency, repeatedReads, hotFiles, directoryScanWaste, pressure } = analysis;
  const triggers: string[] = [];
  let estimatedTokensSaved = 0;

  if (efficiency.totalTokens > COMPACT_TOKEN_THRESHOLD) {
    triggers.push(`context ~${Math.round(efficiency.totalTokens / 1_000)}k MCP tokens`);
    estimatedTokensSaved += Math.round(efficiency.totalTokens * 0.25);
  }
  if (efficiency.wastedTokens > COMPACT_WASTE_THRESHOLD) {
    triggers.push(`~${Math.round(efficiency.wastedTokens / 1_000)}k wasted tokens`);
    estimatedTokensSaved += efficiency.wastedTokens;
  }
  const heavyRepeats = repeatedReads.filter(r => r.reads >= COMPACT_REPEATED_THRESHOLD);
  if (heavyRepeats.length > 0) {
    const waste = heavyRepeats.reduce((s, r) => s + r.estimatedWasteTokens, 0);
    triggers.push(`${heavyRepeats.length} file(s) read ${COMPACT_REPEATED_THRESHOLD}+ times`);
    estimatedTokensSaved += waste;
  }
  if (pressure.level === "critical" || pressure.level === "high") {
    if (!triggers.length) triggers.push(`context pressure ${pressure.level}`);
  }

  const secondaryActions: string[] = [];
  if (hotFiles.length > 0) {
    secondaryActions.push(`Cache ${path.basename(hotFiles[0].path)} (${hotFiles[0].reads}× reads)`);
  }
  if (directoryScanWaste.length > 0) {
    secondaryActions.push(`Reuse cached dir listing for ${path.basename(directoryScanWaste[0].path)}`);
  }

  const savingsPct = efficiency.totalTokens > 0
    ? Math.min(30, Math.max(15, Math.round((estimatedTokensSaved / efficiency.totalTokens) * 100)))
    : 15;

  return {
    shouldShow: triggers.length > 0,
    triggerReason: triggers.join(" · "),
    estimatedSavingsPct: savingsPct,
    estimatedTokensSaved,
    primaryAction: "/compact",
    secondaryActions,
  };
}

// ── Phase 8: Efficiency Coach ──────────────────────────────────────────────────

export type CoachPriority = "critical" | "high" | "medium";
export type CoachCategory = "compact" | "hot-file" | "repeated-read" | "dir-scan" | "general";

export interface CoachingMessage {
  priority: CoachPriority;
  category: CoachCategory;
  message: string;
  estimatedSavingsTokens: number;
  action?: string;
}

/**
 * Builds prioritised coaching messages, highest estimated savings first.
 * Each message gives one concrete, actionable piece of advice.
 */
export function buildCoachingMessages(analysis: ContextEfficiencyAnalysis): CoachingMessage[] {
  const { hotFiles, repeatedReads, directoryScanWaste, efficiency } = analysis;
  const messages: CoachingMessage[] = [];

  // Hot files — largest savings first
  for (const f of hotFiles.slice(0, 3)) {
    if (f.wastedTokens < 20_000) continue;
    const name = path.basename(f.path);
    messages.push({
      priority: f.wastedTokens > 200_000 ? "critical" : "high",
      category: "hot-file",
      message: `${name} read ${f.reads}×, generating ~${fmt(f.wastedTokens)} wasted tokens.`,
      estimatedSavingsTokens: f.wastedTokens,
      action: `Use search_in_file to target specific sections of ${name} instead of loading it in full`,
    });
  }

  // Repeated reads within the window
  for (const r of repeatedReads.slice(0, 2)) {
    if (r.estimatedWasteTokens < 10_000) continue;
    messages.push({
      priority: r.reads >= 8 ? "critical" : "high",
      category: "repeated-read",
      message: `${path.basename(r.path)} read ${r.reads}× in ${r.windowMinutes} min — ~${fmt(r.estimatedWasteTokens)} wasted.`,
      estimatedSavingsTokens: r.estimatedWasteTokens,
      action: r.recommendation,
    });
  }

  // Compact advice for large context
  if (efficiency.totalTokens > COMPACT_TOKEN_THRESHOLD) {
    messages.push({
      priority: efficiency.totalTokens > 300_000 ? "critical" : "high",
      category: "compact",
      message: `Session has ~${fmt(efficiency.totalTokens)} MCP tokens. Run /compact before switching tasks to free 15–30% context.`,
      estimatedSavingsTokens: Math.round(efficiency.totalTokens * 0.20),
      action: "/compact",
    });
  }

  // Directory scan waste
  if (directoryScanWaste.length > 0) {
    const totalWaste = directoryScanWaste.reduce((s, d) => s + d.estimatedWasteTokens, 0);
    if (totalWaste > 5_000) {
      const top = directoryScanWaste[0];
      messages.push({
        priority: "medium",
        category: "dir-scan",
        message: `${directoryScanWaste.length} directory path(s) scanned repeatedly (up to ${top.scans}×, ~${fmt(totalWaste)} tokens).`,
        estimatedSavingsTokens: totalWaste,
        action: `Reuse cached directory listing — directory-cache.json was updated`,
      });
    }
  }

  // Fallback general message
  if (messages.length === 0 && efficiency.score < 60) {
    messages.push({
      priority: "medium",
      category: "general",
      message: `Context Efficiency is ${efficiency.score}% (target: 80%). Reduce repeated reads and run /compact between task switches.`,
      estimatedSavingsTokens: efficiency.potentialSavings,
    });
  }

  return messages.sort((a, b) => {
    const ord = { critical: 0, high: 1, medium: 2 } as const;
    return (ord[a.priority] - ord[b.priority]) || (b.estimatedSavingsTokens - a.estimatedSavingsTokens);
  });
}

// ── HTML rendering ────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmt(n: number): string {
  return n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n);
}

const PRIORITY_COLOR: Record<CoachPriority, string> = {
  critical: "var(--vscode-charts-red,#F44336)",
  high:     "var(--vscode-charts-yellow,#FFC107)",
  medium:   "var(--vscode-descriptionForeground)",
};

/** Renders the Efficiency Coach panel HTML (Phase 8). */
export function formatEfficiencyCoachHtml(messages: CoachingMessage[]): string {
  if (messages.length === 0) {
    return `<p class="note" style="color:var(--vscode-charts-green,#4CAF50)">No efficiency actions needed — context pressure is low.</p>`;
  }
  return messages.map(m =>
    `<div class="skill-row" style="margin-bottom:8px;padding:6px 8px;border-left:3px solid ${PRIORITY_COLOR[m.priority]}">
  <div class="skill-head">
    <span style="color:${PRIORITY_COLOR[m.priority]};font-size:10px;text-transform:uppercase">${m.priority}</span>
    <span class="cost roi-low" style="margin-left:6px">~${fmt(m.estimatedSavingsTokens)}</span>
  </div>
  <div style="font-size:12px;margin-top:3px">${esc(m.message)}</div>
  ${m.action
    ? `<div class="hint" style="margin-top:3px">→ ${m.action.startsWith("/") ? `<code>${esc(m.action)}</code>` : esc(m.action)}</div>`
    : ""}
</div>`
  ).join("");
}

/** Renders the Compact Advisor banner (Phase 2). */
export function formatCompactAdvisorHtml(
  advisor: CompactAdvisorResult,
  roi: AdvisorROI
): string {
  if (!advisor.shouldShow) return "";

  const roiLine = roi.shown > 0
    ? `<p class="note" style="margin-top:6px">Advisor history: followed ${roi.followed}/${roi.shown} · ~${fmt(roi.estimatedTokensSaved)} tokens saved total</p>`
    : "";

  return `<div class="panel" style="margin-top:6px;border-left:4px solid var(--vscode-charts-yellow,#FFC107)">
  <h2 style="margin-top:0">⚠ Context Pressure ${advisor.triggerReason ? `— ${esc(advisor.triggerReason)}` : "High"}</h2>
  <div class="stat-grid" style="margin-bottom:8px">
    <div class="stat-pill">
      <b>Estimated savings</b>
      <span class="val roi-high">${advisor.estimatedSavingsPct}–30%</span>
    </div>
    <div class="stat-pill">
      <b>Tokens freed</b>
      <span class="val">~${fmt(advisor.estimatedTokensSaved)}</span>
    </div>
  </div>
  <div style="font-size:12px;margin-bottom:8px">
    <b>Recommended:</b> <code>${advisor.primaryAction}</code>
    ${advisor.secondaryActions.length > 0
      ? `<span class="hint" style="margin-left:6px">· ${advisor.secondaryActions.map(esc).join(" · ")}</span>`
      : ""}
  </div>
  <div style="display:flex;gap:8px">
    <button onclick="vscode.postMessage({command:'followCompactAdvice'})"
      style="background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:4px 14px;cursor:pointer;border-radius:3px;font-size:11px">
      Run /compact now
    </button>
    <button onclick="vscode.postMessage({command:'dismissCompactAdvice'})"
      style="background:var(--vscode-button-secondaryBackground,#3a3d41);color:var(--vscode-button-secondaryForeground,#ccc);border:none;padding:4px 14px;cursor:pointer;border-radius:3px;font-size:11px">
      Dismiss
    </button>
  </div>
  ${roiLine}
</div>`;
}
