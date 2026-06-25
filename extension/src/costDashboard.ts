import * as vscode from "vscode";
import { AgentId } from "./agentOps";
import {
  buildCostAttribution,
  formatEqualSplitWarning,
  resolveDisplayAttribution,
  SkillAttributionMap,
} from "./costAttribution";
import {
  crossAgentSavingsSummary,
  generateOptimizationSuggestions,
  OptimizationSuggestion,
  topExpensiveSkills,
} from "./costOptimizer";
import { calculateTrend, formatTrendLabel } from "./costPredictor";
import { loadCostProfile } from "./costProfiles";
import { listArchivedSkills } from "./skillArchival";
import { assessAttributionHealth } from "./attributionQuality";
import { assessSkillCostConfidence, formatConfidenceBadge } from "./attributionQuality";
import { buildGlobalTrustBadge, buildSkillTrustLine, formatGlobalTrustBannerHtml } from "./attributionQuality";
import { resolveAttributionStrategy, formatAttributionStrategyLine } from "./attributionQuality";
import { enrichV2HookRunTokens } from "./v2TokenEnrichment";

import { readProjectProfile } from "./projectProfile";
import { formatProjectProfileDashboardHtml } from "./projectProfile";
import { ESTIMATE_DISCLAIMER, ESTIMATE_DISCLAIMER_SHORT, tokenCostUsd } from "./costRates";
import { formatCompactUsd } from "./skillCost";
import {
  formatSkillCostAgentBreakdown,
  summarizeSkillCostsFromRuns,
  topSkillsFromRuns,
} from "./skillCostFromRuns";
import { computeEfficiencyMetrics, formatEfficiencyPanelHtml } from "./efficiencyMetrics";
import { computeHaceMetrics, formatHacePanelHtml } from "./haceMetrics";
import { computeApiScore } from "./agentPerformanceIndex";
import { buildLearningTimeline, formatLearningTimelineHtml } from "./learningTimeline";
import { readAdaptationLog, formatAdaptationTimelineHtml } from "./adaptationLog";
import { computeProposalFunnel, formatProposalFunnelHtml } from "./proposalOutcome";
import { computeHookHealthSummary, formatHookHealthHtml } from "./hookHealth";
import { getOrComputeRepoAffinity } from "./repoAffinity";
import { resolveAdaptations } from "./adaptationEffectiveness";
import { computeAdoptionMetrics, formatAdoptionDashboardHtml, formatAdoptionCoachHtml, formatSkillHealthCard } from "./adoptionIntelligence";
import { getSkillEvolution } from "./skillEnrichment";
import { formatEnrichmentSummaryHtml } from "./skillEnrichmentProposal";
import { analyzeContextEfficiency, computeAdvisorROI } from "./contextEfficiency";
import { evaluateCompactAdvisor, buildCoachingMessages, formatEfficiencyCoachHtml, formatCompactAdvisorHtml } from "./contextAdvisor";
import { isFeatureAvailable } from "./featureMode";
import { formatPromptIntelligencePanelHtml } from "./promptIntelligence";
import { buildCoachingReport, formatCoachingReportHtml } from "./haceCoaching";
import { formatTemplateLibraryHtml } from "./promptTemplates";
import { formatLearningLoopHtml } from "./coachingLearning";
import { readCachedEnrichedRuns } from "./runsStore";
import * as fs from "node:fs";
import * as path from "node:path";
import { computeSkillRoi, formatRoiDashboardLine, upgradeRoiConfidenceFromRuns } from "./skillRoi";
import {
  getOrComputeTeamEconomicsBundle,
  TEAM_ECONOMICS_SLOT_ID,
  TeamEconomicsCachePayload,
  tryReadValidTeamEconomicsCache,
} from "./dashboardPrecompute";
import { buildSystemModeContext } from "./attributionQuality";
import { CostPipelineResult, runCostPipelineSync } from "./costPipeline";
import { formatCapabilitiesSummary } from "./agentCapabilities";
import { computeEnabledAgentsCreditUsage, computePerAgentCreditUsage, AgentCreditRow } from "./agentOps";
import { computeUsageStats, formatTokenCount } from "./usageStats";
import { formatModelLabel, spendPrefixForCreditSummary, totalTokensForModelUsage } from "./usageCost";
import { computeGeneralApiSpend } from "./costAttribution";
import { getWorkspaceHookStatus } from "./hookOps";
import {
  formatHookStatusPanelHtml,
} from "./workspaceHookStatus";
import { wrapDashboardHtml } from "./dashboardStyles";
import { loadManifest } from "./skillOps";
import {
  buildDashboardSnapshotFingerprint,
  DASHBOARD_MAIN_SLOT_ID,
  DashboardSnapshotPayload,
  tryReadValidDashboardSnapshot,
  writeDashboardSnapshot,
} from "./dashboardPrecompute";

function escapeHtml(v: string): string {
  return v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function bar(cost: number, maxCost: number, width = 10): string {
  const len = maxCost > 0 ? Math.round((cost / maxCost) * width) : 0;
  return "█".repeat(len) + "░".repeat(width - len);
}

function hintForSkill(skill: string, suggestions: OptimizationSuggestion[], usageStats: ReturnType<typeof computeUsageStats>): string {
  const switchS = suggestions.find((s) => s.skill === skill && s.type === "switch_agent");
  if (switchS) {
    return `Switch to ${switchS.to} saves ~$${(switchS.savings ?? 0).toFixed(2)}/run`;
  }
  const unused = suggestions.find((s) => s.skill === skill && s.type === "unused");
  if (unused) {
    return `No usage in 7+ days — consider disabling`;
  }
  const stat = usageStats.find((s) => s.name === skill);
  if (stat && stat.runs >= 3 && stat.daysSinceLastUse !== null && stat.daysSinceLastUse <= 2) {
    return `Used ${stat.runs}x recently`;
  }
  return "";
}

function formatSkillAgentBreakdown(skill: string, attribution: SkillAttributionMap): string {
  const entry = attribution[skill];
  if (!entry) {
    return "";
  }
  const parts = (["claude", "cursor", "kiro", "copilot"] as const)
    .filter((agent) => {
      const row = entry[agent];
      return row && (row.cost > 0 || row.tokens > 0);
    })
    .map((agent) => `${agent}: ${formatCompactUsd(entry[agent]!.cost)}`);
  return parts.length > 0 ? `By agent: ${parts.join(", ")}` : "";
}

function formatModelsByAgentHtml(agentUsage: AgentCreditRow[]): string {
  const tracked = agentUsage.filter((row) => row.transcriptTracked);
  if (tracked.length === 0) {
    return "";
  }

  const sections = tracked
    .map((row) => {
      if (row.models.length === 0) {
        return `<div class="skill-row"><div class="skill-head"><b>${escapeHtml(row.displayName)}</b> <span class="agent-id">(${escapeHtml(row.agent)})</span></div><div class="hint">No model ids in transcripts for this window.</div></div>`;
      }
      const modelLines = row.models
        .map((m) => {
          const tokens = totalTokensForModelUsage(m);
          const pct = row.tokens > 0 ? Math.round((tokens / row.tokens) * 100) : 0;
          return `<div class="skill-row">
        <div class="skill-head"><span>${escapeHtml(formatModelLabel(m.model, m.costBasis))}</span>
          <span class="cost">${formatCompactUsd(m.cost)}${pct ? ` (${pct}%)` : ""} · ${formatTokenCount(tokens)} tokens</span>
          ${tokens > 0 ? `<span class="bar">${bar(m.cost, row.cost)}</span>` : ""}</div>
      </div>`;
        })
        .join("");
      return `<div class="agent-block">
    <div class="subhead">${escapeHtml(row.displayName)} <span class="agent-id">(${escapeHtml(row.agent)})</span></div>
    ${modelLines}
  </div>`;
    })
    .join("");

  return `<div class="panel">
    <h2>Models by agent · 14d</h2>
    <p class="note" style="margin-top:0">Claude transcripts include API usage lines. Cursor agent transcripts usually do not — <b>cursor-agent (size est.)</b> is a character-count proxy for the full session. <b>Skill invokes (API)</b> rows come from attribution hooks in <code>runs.jsonl</code> and reflect measured per-invoke cost.</p>
    ${sections}
  </div>`;
}

function setupChecklistHtml(
  health: ReturnType<typeof assessAttributionHealth>,
  hookStatus: ReturnType<typeof getWorkspaceHookStatus>
): string {
  const gap = hookStatus.claudeVscodeGap;
  const items = [
    health.staleEqualSplit
      ? "<li>Run <b>Reset Mis-attributed Cost Data</b> (Command Palette)</li>"
      : "<li>Reset mis-attributed data — only if you see identical costs per skill</li>",
    "<li>Attribution v2 hooks auto-install for <b>Claude, Cursor, Kiro, and Copilot</b> (reload workspace if hook files are missing)</li>",
    gap?.detected
      ? "<li><b>Claude VS Code:</b> PostToolUse hooks often do not fire — run <b>Enable Attribution Hooks (v2)</b> for the PreToolUse workaround, or use <b>Claude Code CLI</b> for full per-invoke API costs</li>"
      : gap?.mitigated
        ? "<li><b>Claude VS Code:</b> PreToolUse workaround active — prefer CLI when you need API usage breakdown per skill invoke</li>"
        : "",
    "<li>Use the <b>self-learning</b> skill on real tasks (<code>metadata.invoked: true</code>)</li>",
    "<li>Work in any enabled agent for a few sessions, then reopen this dashboard</li>",
  ].filter(Boolean);
  return `<div class="panel"><h2>Setup checklist</h2><p class="note">Agent totals are valid. Per-skill breakdown needs:</p><ul>${items.join("")}</ul><p class="note">${escapeHtml(health.summary)}</p></div>`;
}

// ---------------------------------------------------------------------------
// Executive Summary
// ---------------------------------------------------------------------------

function buildExecutiveSummaryHtml(
  target: string,
  apiScore: ReturnType<typeof computeApiScore>,
  attrConfidence: number,
  roiBand: string,
  netRoi: number,
  todayCost: number,
  skillSpend = 0,
  sessionSpend = 0,
  hasProposalData = false
): string {
  const pct = Math.round(attrConfidence * 100);
  const scoreClass = apiScore.score >= 65 ? "roi-high" : apiScore.score >= 35 ? "roi-medium" : "roi-low";
  const attrClass  = pct >= 80 ? "roi-high" : pct >= 50 ? "roi-medium" : "roi-low";
  const utilizationPct = sessionSpend > 0 ? (skillSpend / sessionSpend * 100) : 0;
  const utilizationStr = utilizationPct < 0.1 ? "<0.1%" : `${utilizationPct.toFixed(1)}%`;
  const utilizationClass = utilizationPct >= 10 ? "roi-high" : utilizationPct >= 2 ? "roi-medium" : "roi-low";

  // Top action: derive from lowest sub-score
  const bd = apiScore.breakdown;
  let topAction = "Run attribution reset → +20 API pts";
  // When hooks are installed but no invocations recorded yet, guide user toward actual skill use
  // rather than suggesting a reset (which would be a no-op with no data).
  if ((bd.learningRate ?? 100) < 5 && (bd.precision ?? 100) < 5 && (bd.attribution ?? 100) >= 30) {
    topAction = "Invoke skills in agent sessions → learning loop begins";
  } else if ((bd.attribution ?? 100) < 50) {
    topAction = "Reset attribution → +20 API pts";
  } else if ((bd.precision ?? 100) < 40) {
    topAction = "Stop-word proposals reduced → precision improving";
  } else if ((bd.learningRate ?? 100) < 30) {
    topAction = "Invoke more skills to boost learning rate";
  } else if ((bd.skillEfficiency ?? 100) < 30) {
    topAction = "Archive unused skills → raise ROI score";
  }

  return `<div class="panel" style="background:var(--vscode-editor-inactiveSelectionBackground,rgba(0,0,0,.04));border-left:3px solid var(--vscode-focusBorder,#007acc)">
  <h2 style="margin-top:0">Executive Summary</h2>
  <div class="stat-grid">
    <div class="stat-pill" title="Agent Quality Index — composite 0-100 score">
      <b>Agent Quality Index</b>
      <span class="val ${scoreClass}">${apiScore.score} (${apiScore.grade})</span>
    </div>
    <div class="stat-pill" title="Cost Tracking Accuracy — per-skill attribution confidence">
      <b>Cost Tracking</b>
      <span class="val ${attrClass}">${pct}%</span>
    </div>
    <div class="stat-pill" title="Recommendation accuracy — skills proposed vs actually used">
      <b>Recommendation</b>
      <span class="val">${hasProposalData ? `${bd.precision ?? 0}%` : "Awaiting data"}</span>
    </div>
    <div class="stat-pill" title="Skill spend ÷ session spend — what % of AI cost is skill-augmented" style="${utilizationPct < 1 ? "border-color:var(--vscode-charts-red,#F44336)" : ""}">
      <b>Skill Utilization</b>
      <span class="val ${utilizationClass}">${utilizationStr}</span>
    </div>
    <div class="stat-pill" title="Skill ROI vs spend">
      <b>ROI</b>
      <span class="val roi-${roiBand.toLowerCase()}">${netRoi}x ${roiBand}</span>
    </div>
    <div class="stat-pill" title="Approximate AI spend today">
      <b>Today</b>
      <span class="val">${todayCost > 0 ? formatCompactUsd(todayCost) : "—"}</span>
    </div>
    <div class="stat-pill" title="Highest-impact improvement available">
      <b>Top Action</b>
      <span class="val" style="font-size:10px">${escapeHtml(topAction)}</span>
    </div>
  </div>
</div>`;
}

// ---------------------------------------------------------------------------
// Prediction Intelligence
// ---------------------------------------------------------------------------

function buildPredictionIntelligenceHtml(
  target: string,
  manifest: ReturnType<typeof loadManifest>
): string {
  let proposals: { name: string; confidence: number }[] = [];
  try {
    const pf = path.join(target, ".claude", "learning", "task-skill-proposals.json");
    proposals = (JSON.parse(fs.readFileSync(pf, "utf-8")) as { proposals?: typeof proposals }).proposals ?? [];
  } catch { /* no proposals yet */ }

  const runs = readCachedEnrichedRuns(target);
  const usedSkills = new Map<string, number>();
  for (const r of runs) usedSkills.set(r.skill, (usedSkills.get(r.skill) ?? 0) + 1);

  const proposedNames = new Set(proposals.map((p) => p.name));
  let hits = 0;
  for (const name of usedSkills.keys()) if (proposedNames.has(name)) hits++;
  const precision = proposedNames.size > 0 ? Math.round((hits / proposedNames.size) * 100) : 0;
  const recall    = usedSkills.size > 0     ? Math.round((hits / usedSkills.size) * 100)    : 0;
  const f1 = precision + recall > 0 ? Math.round((2 * precision * recall) / (precision + recall)) : 0;

  const overPredicted = proposals
    .filter((p) => !usedSkills.has(p.name))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);

  const accurateRows = [...usedSkills.entries()]
    .filter(([name]) => proposedNames.has(name))
    .map(([name, uses]) => ({ name, uses, proposed: proposals.filter((p) => p.name === name).length }))
    .slice(0, 3);

  const overRows = overPredicted.map((p) => `<tr>
    <td><b>${escapeHtml(p.name)}</b></td><td>${p.confidence}%</td><td>—</td><td class="roi-low">0%</td>
  </tr>`).join("");

  const accRows = accurateRows.map((r) => `<tr>
    <td><b>${escapeHtml(r.name)}</b></td><td>—</td><td>${r.uses}</td>
    <td class="roi-high">${r.proposed > 0 ? Math.round((r.uses / r.proposed) * 100) : 100}%</td>
  </tr>`).join("");

  return `<div class="stat-grid" style="margin-bottom:10px">
  <div class="stat-pill"><b>Precision</b><span class="val">${precision}%</span></div>
  <div class="stat-pill"><b>Recall</b><span class="val">${recall}%</span></div>
  <div class="stat-pill"><b>F1</b><span class="val">${f1}%</span></div>
  <div class="stat-pill"><b>Goal</b><span class="val">F1 ≥ 65%</span></div>
</div>
${accRows ? `<p class="note" style="margin:4px 0 2px"><b>Most accurate</b></p>
<table style="width:100%;font-size:12px;border-collapse:collapse">
  <tr><th style="text-align:left">Skill</th><th>Conf</th><th>Uses</th><th>Prec</th></tr>
  ${accRows}
</table>` : ""}
${overRows ? `<p class="note" style="margin:8px 0 2px"><b>Over-predicted (0 uses)</b></p>
<table style="width:100%;font-size:12px;border-collapse:collapse">
  <tr><th style="text-align:left">Skill</th><th>Conf</th><th>Uses</th><th>Prec</th></tr>
  ${overRows}
</table>
<p class="note" style="margin-top:4px">Catch-all glob cap (v1.0.84) reduces false positives going forward.</p>` : ""}`;
}

// ---------------------------------------------------------------------------
// Governance Panel
// ---------------------------------------------------------------------------

function buildGovernancePanelHtml(target: string): string {
  const runsFile = path.join(target, ".claude", "learning", "runs.jsonl");
  const mcpFile  = path.join(target, ".claude", "mcp-usage.jsonl");
  const trustFile = path.join(target, ".claude", "learning", "attribution-trust.json");

  let runsSize = 0, mcpSize = 0, attrPct = 0, runCount = 0;
  try { const s = fs.statSync(runsFile); runsSize = s.size; } catch { /* */ }
  try { const s = fs.statSync(mcpFile); mcpSize = s.size; } catch { /* */ }
  try {
    const t = JSON.parse(fs.readFileSync(trustFile, "utf-8")) as { scorePct?: number };
    attrPct = Math.round(t.scorePct ?? 0);
  } catch { /* */ }
  try {
    runCount = fs.readFileSync(runsFile, "utf-8").split("\n").filter(Boolean).length;
  } catch { /* */ }

  const kb = (b: number) => b >= 1024 ? `${(b / 1024).toFixed(0)} KB` : `${b} B`;

  const checks = [
    { ok: true,  label: "Telemetry is local-only (no cloud egress)" },
    { ok: true,  label: "No prompt content stored in runs.jsonl" },
    { ok: attrPct >= 80, label: `Attribution confidence ≥80% (current: ${attrPct}%)` },
    { ok: false, label: "Skill provenance (author + signedAt) not configured" },
    { ok: false, label: "Audit export not scheduled" },
  ];

  const checkItems = checks.map((c) =>
    `<li>${c.ok ? "☑" : "☐"} ${escapeHtml(c.label)}</li>`
  ).join("");

  return `<div class="stat-grid" style="margin-bottom:8px">
  <div class="stat-pill"><b>runs.jsonl</b><span class="val">${runCount} records · ${kb(runsSize)}</span></div>
  <div class="stat-pill"><b>mcp-usage.jsonl</b><span class="val">${kb(mcpSize)}</span></div>
  <div class="stat-pill"><b>Attribution</b><span class="val ${attrPct >= 80 ? "roi-high" : "roi-low"}">${attrPct}%</span></div>
  <div class="stat-pill"><b>Provenance</b><span class="val roi-low">Not configured</span></div>
</div>
<p class="note" style="margin:4px 0 2px"><b>Compliance checklist</b></p>
<ul style="font-size:12px;margin:4px 0">${checkItems}</ul>`;
}

export interface CostDashboardOptions {
  /** When false, render a loading slot and inject team panels asynchronously. Default true. */
  includeTeamEconomics?: boolean;
  /** Precomputed team bundle (disk cache or background job). */
  teamBundle?: TeamEconomicsCachePayload;
  /** Hot path: read pre-rendered dashboard body from disk — no sync attribution/transcript work. */
  fastPhase?: boolean;
}

export function teamEconomicsLoadingSlotHtml(): string {
  return `<div id="${TEAM_ECONOMICS_SLOT_ID}" class="panel"><h2>Team economics</h2><p class="note">Loading ROI and skill-owner data…</p></div>`;
}

export function formatTeamEconomicsPanelsHtml(
  bundle: TeamEconomicsCachePayload,
  showPerSkill: boolean
): string {
  if (!showPerSkill) {
    return "";
  }
  const { teamEconomics, skillAuthors } = bundle;
  const parts: string[] = [];

  parts.push(`<div class="panel">
    <h2>ROI estimate</h2>
    <div class="stat-grid">
      <div class="stat-pill"><b>Time saved</b><span class="val">~${teamEconomics.estimatedMinutesSaved} min</span></div>
      <div class="stat-pill"><b>Value</b><span class="val">${formatCompactUsd(teamEconomics.estimatedValueUsd)}</span></div>
      <div class="stat-pill"><b>Net ROI</b><span class="val roi-${teamEconomics.netRoiBand.toLowerCase()}">${teamEconomics.netRoiBand} (${teamEconomics.netRoi}x)</span></div>
    </div>
    <p class="note">Heuristic tiers — not measured productivity.</p>
  </div>`);

  if (teamEconomics.byRepo.length > 0) {
    parts.push(`<div class="panel">
    <h2>By repo</h2>
    <ul>${teamEconomics.byRepo.slice(0, 8).map((r) => `<li><b>${escapeHtml(r.repoPath)}</b> ${formatCompactUsd(r.costUsd)} · ${r.runs} runs · ${r.skills.length} skills</li>`).join("")}</ul>
  </div>`);
  }

  if (teamEconomics.bySkillOwner.length > 0) {
    parts.push(`<div class="panel">
    <h2>By skill owner</h2>
    <p class="note" style="margin-top:0">Git author of SKILL.md — not who invoked the agent.</p>
    <ul>${teamEconomics.bySkillOwner.slice(0, 8).map((o) => `<li><b>${escapeHtml(o.author)}</b> ${formatCompactUsd(o.costUsd)} · ${o.skills.length} skills</li>`).join("")}</ul>
  </div>`);
  }

  if (skillAuthors.length > 0) {
    parts.push(
      `<div class="panel"><h2>Team attribution</h2><ul>${skillAuthors.map((t) => `<li><b>${escapeHtml(t.skill)}</b>: ${escapeHtml(t.line)}</li>`).join("")}</ul></div>`
    );
  }

  if (parts.length === 0) {
    return "";
  }
  return `<div id="${TEAM_ECONOMICS_SLOT_ID}">${parts.join("\n  ")}</div>`;
}

function teamEconomicsListenerScript(nonce: string): string {
  return `
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (!msg || msg.command !== "teamEconomicsHtml") {
        return;
      }
      const slot = document.getElementById("${TEAM_ECONOMICS_SLOT_ID}");
      if (!slot) {
        return;
      }
      if (!msg.html) {
        slot.remove();
        return;
      }
      slot.outerHTML = msg.html;
    });`;
}

export function dashboardMainLoadingSlotHtml(): string {
  return `<div id="${DASHBOARD_MAIN_SLOT_ID}" class="panel"><h2>Cost intelligence</h2><p class="note">Loading spend, agents, and optimizations…</p></div>`;
}

function dashboardActionsFooterHtml(canApplyOptimizations: boolean): string {
  return `<div class="actions">
    <button type="button" id="btn-apply-opts" ${canApplyOptimizations ? "" : "disabled title=\"Paused in safe/degraded mode\""}>Apply optimizations</button>
    <button type="button" class="secondary" id="btn-export-report">Export report</button>
    <button type="button" class="secondary" id="btn-open-budget">Configure budget</button>
  </div>
  <div class="note">${escapeHtml(ESTIMATE_DISCLAIMER)}</div>`;
}

function dashboardInjectionListenerScript(): string {
  return `
    const vscode = acquireVsCodeApi();
    function rebindDashboardActionListeners() {
      document.getElementById("btn-apply-opts")?.addEventListener("click", () => {
        vscode.postMessage({ command: "applyOptimizations" });
      });
      document.getElementById("btn-export-report")?.addEventListener("click", () => {
        vscode.postMessage({ command: "exportReport" });
      });
      document.getElementById("btn-open-budget")?.addEventListener("click", () => {
        vscode.postMessage({ command: "openBudget" });
      });
      document.querySelectorAll(".apply-one").forEach((btn) => {
        btn.addEventListener("click", () => {
          const el = btn;
          vscode.postMessage({
            command: "applySuggestion",
            skill: el.getAttribute("data-skill"),
            type: el.getAttribute("data-type"),
          });
        });
      });
      document.getElementById("btn-clear-mcp-logs")?.addEventListener("click", () => {
        vscode.postMessage({ command: "clearMcpLogs" });
      });
      document.getElementById("btn-apply-mcp-autofixes")?.addEventListener("click", () => {
        vscode.postMessage({ command: "applyMcpAutoFixes" });
      });
      document.getElementById("btn-export-telemetry")?.addEventListener("click", () => {
        vscode.postMessage({ command: "exportTelemetry" });
      });
    }
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (!msg || msg.command !== "dashboardMainHtml") {
        return;
      }
      const slot = document.getElementById("${DASHBOARD_MAIN_SLOT_ID}");
      if (!slot) {
        return;
      }
      if (!msg.html) {
        return;
      }
      slot.innerHTML = msg.html;
      rebindDashboardActionListeners();
    });
    rebindDashboardActionListeners();`;
}

function wrapCostDashboardDocument(
  target: string,
  nonce: string,
  body: string,
  includeInjectionListeners: boolean
): string {
  return wrapDashboardHtml({
    title: "Cost Intelligence",
    headerHtml: `<div class="subtitle">Workspace: <code>${escapeHtml(target)}</code> · ${escapeHtml(ESTIMATE_DISCLAIMER_SHORT)}</div>`,
    nonce,
    body,
    scriptHtml: `
  <script${nonce ? ` nonce="${nonce}"` : ""}>
    ${teamEconomicsListenerScript(nonce)}
    ${includeInjectionListeners ? dashboardInjectionListenerScript() : ""}
  </script>`,
  });
}

// ── Context Efficiency Intelligence panel ─────────────────────────────────────

function fmt(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n);
}

/**
 * Compact Context Efficiency summary card for the main dashboard.
 * Full detail is in the dedicated Context Efficiency webview panel.
 */
export function formatContextEfficiencyPanelHtml(target: string): string {
  let analysis;
  try { analysis = analyzeContextEfficiency(target, 24); } catch { return ""; }
  const { efficiency, pressure, hotFiles, compactOpportunities } = analysis;
  if (efficiency.totalTokens === 0) return "";

  const advisor = evaluateCompactAdvisor(analysis);
  // No onclick in the main dashboard (CSP nonce model) — render a plain warning note instead
  // of the interactive Compact Advisor banner. Full interactive panel is in the webview.
  const advisorBanner = advisor.shouldShow
    ? `<p class="note" style="color:var(--vscode-charts-yellow,#FFC107);margin-bottom:6px">⚠ Context pressure ${advisor.triggerReason ? `— ${advisor.triggerReason}` : "high"} · run <code>/compact</code> or open Context Efficiency panel for details.</p>`
    : "";
  const coachHtml = formatEfficiencyCoachHtml(buildCoachingMessages(analysis).slice(0, 2));

  const scoreColor = efficiency.score >= 80 ? "roi-high"
    : efficiency.score >= 60 ? "roi-medium" : "roi-low";
  const pressureColor = { low: "roi-high", medium: "roi-medium", high: "roi-low", critical: "roi-low" }[pressure.level];
  const topWaste = hotFiles[0];

  return `<div class="panel" style="margin-top:6px;border-left:3px solid var(--vscode-charts-blue,#2196F3)">
  <h2 style="margin-top:0">Context Efficiency</h2>
  ${advisorBanner}
  <div class="stat-grid" style="margin-bottom:8px">
    <div class="stat-pill" title="Useful tokens / total tokens × 100. Target: ≥80">
      <b>Efficiency Score</b>
      <span class="val ${scoreColor}">${efficiency.score}/100 (${efficiency.grade})</span>
    </div>
    <div class="stat-pill" title="Real-time context pressure level">
      <b>Context Pressure</b>
      <span class="val ${pressureColor}">${pressure.level}</span>
    </div>
    <div class="stat-pill">
      <b>Potential Savings</b>
      <span class="val roi-high">~${fmt(efficiency.potentialSavings)}</span>
    </div>
    <div class="stat-pill" title="Compact, caching, or read-reduction opportunities">
      <b>Compact Opportunities</b>
      <span class="val ${compactOpportunities > 0 ? "roi-medium" : "roi-high"}">${compactOpportunities}</span>
    </div>
  </div>
  ${topWaste ? `<div class="hint" style="margin-bottom:6px">Largest waste source: <code>${topWaste.path.split(/[/\\]/).pop()}</code> (~${fmt(topWaste.wastedTokens)} tokens, ${topWaste.reads}× reads)</div>` : ""}
  <details style="margin-top:4px">
    <summary style="cursor:pointer;font-size:12px;font-weight:600">Efficiency Coach</summary>
    <div style="margin-top:6px">${coachHtml}</div>
  </details>
  <p class="note" style="margin-top:6px">24h window · <a href="command:claudeSkills.showContextEfficiency" style="color:var(--vscode-textLink-foreground)">Open full panel</a></p>
</div>`;
}

// ── Phase 8: Skill Evolution panel ───────────────────────────────────────────

function escHtmlDash(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Renders the "Skill Evolution" panel showing the most improved skills.
 * Returns an empty string when no quality improvements are recorded yet.
 */
export function formatSkillEvolutionHtml(target: string, skillNames: string[]): string {
  const evolution = getSkillEvolution(target, skillNames);
  if (evolution.length === 0) return "";

  const rows = evolution.map(e => {
    const deltaStr = `+${e.qualityDelta}`;
    const patternNote = e.topPattern ? ` · New proven pattern: ${escHtmlDash(e.topPattern)}` : "";
    return `<div class="skill-row">
  <div class="skill-head">
    <b>${escHtmlDash(e.skill)}</b>
    <span class="cost roi-high">${deltaStr} quality</span>
    <span class="cost">${e.qualityScore}/100</span>
  </div>
  <div class="hint">${patternNote}</div>
</div>`;
  }).join("");

  const enrichSummary = formatEnrichmentSummaryHtml(target);

  return `<div class="panel" style="margin-top:6px;border-left:3px solid var(--vscode-charts-green,#4CAF50)">
  <h2 style="margin-top:0">Skill Evolution${enrichSummary ? ` <span style="font-size:11px;font-weight:400">${enrichSummary}</span>` : ""}</h2>
  <p class="note" style="margin-bottom:8px">Most improved skills · quality = usage + success + reuse + time saved + knowledge growth</p>
  ${rows}
</div>`;
}

/** Build main dashboard panels (excludes team economics + footer actions). */
export function buildDashboardMainBodyHtml(
  target: string,
  libraryDir: string,
  pipeline: CostPipelineResult,
  options?: { enrichTokens?: boolean }
): DashboardSnapshotPayload {
  if (options?.enrichTokens !== false) {
    enrichV2HookRunTokens(target, libraryDir);
  }
  const manifest = loadManifest(libraryDir);
  const systemState = pipeline.state;
  const built = buildCostAttribution(target, libraryDir);
  const health = assessAttributionHealth(target, libraryDir);
  const modeCtx = buildSystemModeContext(health, target, pipeline.cycle);
  const showPerSkill = modeCtx.canShowPerSkillCosts;
  const canApplyOptimizations = modeCtx.canApplyOptimizations;
  const { attribution, staleEqualSplit, equalSplitCluster } = resolveDisplayAttribution(built, target);
  const generalApi = computeGeneralApiSpend(target, libraryDir, 14);
  const credit = computeEnabledAgentsCreditUsage(libraryDir, 14, target);
  const agentUsage = computePerAgentCreditUsage(libraryDir, 14, target);
  const agentCostTotal = agentUsage.reduce((s, r) => s + r.cost, 0) || credit.totalCost;
  const maxAgentCost = Math.max(...agentUsage.map((r) => r.cost), 1);
  const suggestions = showPerSkill ? generateOptimizationSuggestions(target, libraryDir, manifest) : [];
  const skillCostSummary = summarizeSkillCostsFromRuns(target, 14);
  const useRunsForTopSkills = skillCostSummary.includedRuns > 0;
  const showTopSkills = useRunsForTopSkills || showPerSkill;
  const top = useRunsForTopSkills
    ? topSkillsFromRuns(target, 5, 14)
    : showPerSkill
      ? topExpensiveSkills(attribution, 5)
      : [];
  const skillCostByName = new Map(skillCostSummary.skills.map((s) => [s.skill, s]));
  const totalCost =
    (useRunsForTopSkills ? skillCostSummary.totalCost : top.reduce((s, r) => s + r.cost, 0)) ||
    credit.totalCost;
  const maxTop = top[0]?.cost ?? 1;
  const savings = showPerSkill
    ? crossAgentSavingsSummary(attribution)
    : { realizedUsd: 0, speculativeUsd: 0, cursorSkills: 0 };
  const trend = calculateTrend(target, libraryDir);
  const profile = showPerSkill ? loadCostProfile(target, libraryDir) : undefined;
  const usageStats = computeUsageStats(target, manifest);
  const usageMap = new Map(usageStats.map((s) => [s.name, s]));
  const hookStatus = getWorkspaceHookStatus(target, libraryDir);
  const attrStrategy = resolveAttributionStrategy(target, libraryDir);
  const skillConfidence = assessSkillCostConfidence(target, attribution, {
    usesV2HookRuns: health.v2HookRuns > 0,
    staleEqualSplit,
    transcriptSkills: built.transcriptSkills,
  });

  const attrByAgent = new Map(
    hookStatus.attribution.agents.filter((a) => a.applicable).map((a) => [a.agent, a.configured])
  );
  const equalSplitWarn = equalSplitCluster ? formatEqualSplitWarning(equalSplitCluster, true) : null;
  const archived = listArchivedSkills(target);
  const efficiencyMetrics = computeEfficiencyMetrics(target, 14);
  const apiScore = computeApiScore(target, manifest);

  const agentRows = agentUsage
    .map((row) => {
      const pct = agentCostTotal > 0 && row.cost > 0 ? Math.round((row.cost / agentCostTotal) * 100) : 0;
      const detail = !row.transcriptTracked
        ? "Hook-only — enable attribution hooks for measured Kiro/Copilot spend"
        : row.tokens === 0
          ? "No usage logged in the last 14 days"
          : `${formatTokenCount(row.tokens)} tokens · ${row.sessions > 0 ? `${row.sessions} session(s)` : "hook-measured"}`;
      return `<div class="skill-row">
        <div class="skill-head"><b>${escapeHtml(row.displayName)}</b> <span class="agent-id">(${escapeHtml(row.agent)})</span>
          ${attrByAgent.has(row.agent as AgentId) ? `<span class="hook-badge ${attrByAgent.get(row.agent as AgentId) ? "hook-on" : "hook-off"}">attr ${attrByAgent.get(row.agent as AgentId) ? "on" : "off"}</span>` : ""}
          <span class="cost">${row.cost > 0 ? `${formatCompactUsd(row.cost)}${pct ? ` (${pct}%)` : ""}` : "—"}</span>
          ${row.cost > 0 ? `<span class="bar">${bar(row.cost, maxAgentCost)}</span>` : ""}</div>
        <div class="hint">${escapeHtml(detail)}</div>
      </div>`;
    })
    .join("");

  const topRows = top
    .map((row, i) => {
      const pct = totalCost > 0 ? Math.round((row.cost / totalCost) * 100) : 0;
      const stat = usageMap.get(row.skill);
      let roi = computeSkillRoi(row.skill, manifest, stat, useRunsForTopSkills ? row.cost : undefined);
      const hookRuns = stat?.measuredRuns ?? (stat ? (stat.agentRuns ? Object.values(stat.agentRuns).reduce((a, b) => (a ?? 0) + (b ?? 0), 0) : stat.runs) : 0);
      roi = upgradeRoiConfidenceFromRuns(roi, hookRuns);
      const conf = skillConfidence.get(row.skill);
      const skillRow = skillCostByName.get(row.skill);
      const apiPriced = Boolean(useRunsForTopSkills && skillRow && skillRow.usageBreakdownRuns > 0);
      const reconciledPriced = Boolean(useRunsForTopSkills && skillRow && !apiPriced && skillRow.reconciledRuns > 0);
      const trust = buildSkillTrustLine(conf, roi.roiBand);
      const trustLabel = apiPriced ? "API-priced (hooks)" : reconciledPriced ? "Actual (Cursor billing)" : trust.summary;
      const agentBreakdown =
        useRunsForTopSkills && skillRow
          ? formatSkillCostAgentBreakdown(skillRow)
          : formatSkillAgentBreakdown(row.skill, attribution);
      const pricingNote =
        useRunsForTopSkills && skillRow && skillRow.usageBreakdownRuns > 0
          ? "API-priced"
          : reconciledPriced
            ? "Actual (Cursor billing)"
            : useRunsForTopSkills
              ? "hook-measured"
              : undefined;
      const hint = [
        formatRoiDashboardLine(roi, formatCompactUsd(row.cost)),
        trust.summary,
        pricingNote,
        hintForSkill(row.skill, suggestions, usageStats),
        agentBreakdown,
      ]
        .filter(Boolean)
        .join(" | ");
      const confClass = apiPriced || reconciledPriced ? "high" : conf?.level ?? "estimated";
      return `<div class="skill-row">
        <div class="skill-head"><span class="rank">${i + 1}.</span> <b>${escapeHtml(row.skill)}</b>
          <span class="roi-${roi.roiBand.toLowerCase()}">${escapeHtml(roi.roiBand)}</span>
          <span class="cost">${formatCompactUsd(row.cost)} (${pct}%)</span>
          <span class="conf-${confClass}">${escapeHtml(trustLabel)}</span>
          <span class="bar">${bar(row.cost, maxTop)}</span></div>
        ${hint ? `<div class="hint">${escapeHtml(hint)}</div>` : ""}
      </div>`;
    })
    .join("");

  const optRows = suggestions
    .slice(0, 6)
    .map(
      (s) =>
        `<li class="opt-row"><span><b>${escapeHtml(s.skill)}</b> — ${escapeHtml(s.action)}</span>` +
        (canApplyOptimizations
          ? `<button type="button" class="secondary apply-one" data-skill="${escapeHtml(s.skill)}" data-type="${escapeHtml(s.type)}">Apply</button>`
          : `<span class="note">read-only</span>`) +
        `</li>`
    )
    .join("");

  const trendLabel = formatTrendLabel(trend);

  const globalTrust = buildGlobalTrustBadge(health, hookStatus);
  const sessionSpendPrefix = spendPrefixForCreditSummary(credit);
  const sessionSpendLabel =
    sessionSpendPrefix === "API"
      ? "Session spend"
      : sessionSpendPrefix === "Mixed"
        ? "Session spend (mixed)"
        : "Est. spend";

  // ── Today's cost (for executive summary) ──────────────────────────────────
  const todayCredit = computeEnabledAgentsCreditUsage(libraryDir, 1, target);
  const todayCost   = todayCredit.totalCost;

  // ── Team economics (for executive summary ROI) ─────────────────────────────
  let execRoiBand = "MEDIUM", execNetRoi = 0;
  try {
    const teamCacheFile = path.join(target, ".claude", "learning", "team-economics-cache.json");
    const tc = JSON.parse(fs.readFileSync(teamCacheFile, "utf-8")) as { teamEconomics?: { netRoiBand?: string; netRoi?: number } };
    execRoiBand = tc.teamEconomics?.netRoiBand ?? "MEDIUM";
    execNetRoi  = tc.teamEconomics?.netRoi ?? 0;
  } catch { /* */ }

  // GAP 5: resolve any adaptations that are ≥7 days old
  resolveAdaptations(target, {
    apiScore: apiScore.score,
    attribution: Math.round(systemState.attribution.confidence * 100),
    skillCount: Object.keys(manifest.skills).length,
    precision: apiScore.breakdown.precision,
  });

  // ── Learning timeline ──────────────────────────────────────────────────────
  const timelineEvents = buildLearningTimeline(target, 30);
  const adaptationEvents = readAdaptationLog(target);
  // GAP 1: recommendation funnel; GAP 2: hook health; GAP 3: repo affinity
  const proposalFunnel = isFeatureAvailable("recommendation.funnel") ? computeProposalFunnel(target, 30) : null;
  const adoptionMetrics = computeAdoptionMetrics(target);
  const hookHealth = isFeatureAvailable("hook.health") ? computeHookHealthSummary(target) : null;
  const repoAffinity = isFeatureAvailable("repo.affinity") ? getOrComputeRepoAffinity(target) : null;

  // ── Prediction ─────────────────────────────────────────────────────────────
  const predictionHtml = isFeatureAvailable("prediction") ? buildPredictionIntelligenceHtml(target, manifest) : "";

  // ── Governance ─────────────────────────────────────────────────────────────
  const governanceHtml = isFeatureAvailable("governance") ? buildGovernancePanelHtml(target) : "";

  const mainBodyHtml = `
  ${buildExecutiveSummaryHtml(target, apiScore, systemState.attribution.confidence, execRoiBand, execNetRoi, todayCost, skillCostSummary.totalCost, credit.totalCost, proposalFunnel?.hasData ?? false)}

  ${formatGlobalTrustBannerHtml(globalTrust)} · ${escapeHtml(formatAttributionStrategyLine(attrStrategy))}

  ${modeCtx.banner ? `<div class="warn"><b>${escapeHtml(systemState.systemMode)}</b> — ${escapeHtml(modeCtx.banner)}</div>` : ""}

  ${formatHookStatusPanelHtml(hookStatus)}

  ${(() => {
    const projectProfile = readProjectProfile(target);
    return projectProfile ? formatProjectProfileDashboardHtml(projectProfile) : "";
  })()}

  <div class="panel">
    <h2>System</h2>
    <div class="stat-grid">
      <div class="stat-pill"><b>Mode</b><span class="val">${escapeHtml(systemState.systemMode)}</span></div>
      <div class="stat-pill"><b>Profile</b><span class="val">${escapeHtml(systemState.profileInit)}</span></div>
      <div class="stat-pill"><b>Attribution</b><span class="val">${escapeHtml(systemState.attribution.status)} ${Math.round(systemState.attribution.confidence * 100)}%</span></div>
      <div class="stat-pill"><b>Hooks</b><span class="val">${systemState.hooks.allConfigured ? "all on" : systemState.hooks.installed ? "partial" : "off"}</span></div>
      <div class="stat-pill"><b>Pipeline</b><span class="val">${pipeline.fresh ? "fresh" : "stale"}${pipeline.circuitOpen ? " · circuit" : ""}</span></div>
    </div>
    <p class="note">${escapeHtml(formatCapabilitiesSummary(systemState.capabilities))}</p>
    ${pipeline.trace ? `<p class="note">Trace collect/index/analyze: ${pipeline.trace.collectMs ?? "—"}/${pipeline.trace.indexMs ?? "—"}/${pipeline.trace.analyzeMs ?? "—"} ms · total ${pipeline.trace.totalMs ?? "—"} ms · confidence ${Math.round(health.confidenceScore * 100)}% <span class="conf-${health.confidenceLevel}">${escapeHtml(formatConfidenceBadge(health.confidenceLevel))}</span>${pipeline.trace.errors.length > 0 ? ` · ${escapeHtml(pipeline.trace.errors.map((e) => `${e.phase}: ${e.message}`).join("; "))}` : ""}</p>` : `<p class="note">Pipeline confidence ${Math.round(health.confidenceScore * 100)}% · <span class="conf-${health.confidenceLevel}">${escapeHtml(formatConfidenceBadge(health.confidenceLevel))}</span></p>`}
  </div>

  ${
    equalSplitWarn
      ? `<div class="warn"><b>Per-skill unreliable:</b> ${equalSplitWarn}${
          useRunsForTopSkills ? " Top skills below use hook-measured costs instead." : ""
        }</div>`
      : generalApi.legacyUnattributedTokens > 0 && generalApi.legacyUnattributedTokens > generalApi.totalTokens
        ? `<div class="warn"><b>Legacy unattributed bucket:</b> ${formatTokenCount(generalApi.legacyUnattributedTokens)} tokens from pre-1.0.49 collector. Run <b>Reset Mis-attributed Cost Data</b> to clear; <b>General API</b> below uses the new session-residual model.</div>`
        : ""
  }

  ${
    generalApi.totalTokens > 0
      ? `<div class="panel" style="margin-top:0">
    <h2>General API · 14d</h2>
    <p class="note" style="margin-top:0">Base-model / non-skill session work: transcript totals minus hook-measured skill invokes. Includes agents answering from built-in knowledge without reading a listed skill file.</p>
    <div class="stat-grid">
      <div class="stat-pill"><b>General API</b><span class="val">${formatCompactUsd(generalApi.totalCost)}</span></div>
      <div class="stat-pill"><b>Tokens</b><span class="val">${formatTokenCount(generalApi.totalTokens)}</span></div>
      <div class="stat-pill"><b>Sessions</b><span class="val">${generalApi.sessionCount}</span></div>
      ${
        useRunsForTopSkills
          ? `<div class="stat-pill"><b>Skill spend</b><span class="val">${formatCompactUsd(skillCostSummary.totalCost)}</span></div>`
          : ""
      }
    </div>
  </div>`
      : useRunsForTopSkills
        ? `<p class="note" style="margin-top:0">Skill spend: ${skillCostSummary.includedRuns} hook/self-learning run(s) at published API rates (excludes ${skillCostSummary.excludedCollectorRuns} attribution-collector row(s)).</p>`
        : ""
  }

  <div class="panel">
    <h2>Overview · 14d</h2>
    <div class="stat-grid">
      <div class="stat-pill"><b>${escapeHtml(sessionSpendLabel)}</b><span class="val">${formatCompactUsd(credit.totalCost)}</span></div>
      ${
        useRunsForTopSkills
          ? `<div class="stat-pill"><b>Skill spend</b><span class="val">${formatCompactUsd(skillCostSummary.totalCost)}</span></div>`
          : ""
      }
      ${
        generalApi.totalTokens > 0
          ? `<div class="stat-pill"><b>General API</b><span class="val">${formatCompactUsd(generalApi.totalCost)}</span></div>`
          : ""
      }
      <div class="stat-pill"><b>Tokens</b><span class="val">${formatTokenCount(credit.totalTokens)}</span></div>
      <div class="stat-pill"><b>Trend</b><span class="val">${escapeHtml(trendLabel)}</span></div>
      ${profile ? `<div class="stat-pill"><b>Typical / mo</b><span class="val">${formatCompactUsd(profile.typical_monthly_cost)}</span></div>` : ""}
    </div>
    ${
      useRunsForTopSkills && generalApi.totalTokens === 0
        ? `<p class="note" style="margin-top:8px">Skill spend: ${skillCostSummary.includedRuns} hook/self-learning run(s) at published API rates (excludes ${skillCostSummary.excludedCollectorRuns} attribution-collector row(s)).</p>`
        : useRunsForTopSkills && generalApi.totalTokens > 0
          ? `<p class="note" style="margin-top:8px">Skill spend (hooks) vs General API (non-skill) shown above. Residual = session transcript minus hook invokes.</p>`
          : ""
    }
  </div>

  <div class="panel">
    <h2>By agent · 14d</h2>
    <p class="note" style="margin-top:0">Claude + Cursor: transcript-based (this workspace). Kiro + Copilot: hook-measured from <code>runs.jsonl</code> (enable attribution hooks for Kiro cost data).</p>
    ${agentRows}
  </div>

  ${formatModelsByAgentHtml(agentUsage)}

  ${showPerSkill ? "" : setupChecklistHtml(health, hookStatus)}

  <div class="panel">
    <h2>Top skills${useRunsForTopSkills ? " · measured" : ""}</h2>
    ${
      useRunsForTopSkills
        ? `<p class="note" style="margin-top:0">Costs from skill-invoke hooks and self-learning runs — input/output/cache at published API rates.</p>`
        : ""
    }
    ${
      showTopSkills
        ? topRows || "<p class=\"note\">No per-skill cost data yet.</p>"
        : "<p class=\"note\">Hidden until attribution setup completes.</p>"
    }
  </div>

  <div class="panel">
  <h2>Agent Quality Index</h2>
  <div class="stat-grid" style="margin-bottom:10px">
    <div class="stat-pill" title="Composite AI agent quality score (0–100): Recommendation Accuracy · Cost Tracking Accuracy · Skill ROI · Learning · Completion · Correction">
      <b>Agent Quality Index</b>
      <span class="val roi-${apiScore.score >= 65 ? "high" : apiScore.score >= 35 ? "medium" : "low"}">${apiScore.score}/100 (${apiScore.grade})</span>
    </div>
    <div class="stat-pill" title="How often proposed skills were actually used"><b>Recommendation Accuracy</b><span class="val">${apiScore.breakdown.precision}%</span></div>
    <div class="stat-pill" title="Per-skill cost attribution confidence"><b>Cost Tracking Accuracy</b><span class="val">${apiScore.breakdown.attribution}%</span></div>
    <div class="stat-pill" title="Skill ROI vs session spend"><b>Skill ROI</b><span class="val">${apiScore.breakdown.skillEfficiency}%</span></div>
    <div class="stat-pill"><b>Learning</b><span class="val">${apiScore.breakdown.learningRate}%</span></div>
    <div class="stat-pill"><b>Completion</b><span class="val">${apiScore.breakdown.taskCompletion}%</span></div>
    <div class="stat-pill"><b>Correction</b><span class="val">${apiScore.breakdown.humanCorrection}%</span></div>
  </div>
  <p class="note">Weights: Rec. Accuracy 25% · Cost Tracking 20% · Skill ROI 15% · Learning 15% · Completion 15% · Correction 10%. Target: ≥65 (B).</p>
</div>

  ${(() => {
    // Skill Utilization Ratio panel
    const sessionSpend = credit.totalCost;
    const skillSpend   = skillCostSummary.totalCost;
    const utilizationPct = sessionSpend > 0 ? (skillSpend / sessionSpend * 100) : 0;
    const utilizationStr = utilizationPct < 0.1 ? "<0.1%" : `${utilizationPct.toFixed(2)}%`;
    const utilizationClass = utilizationPct >= 10 ? "roi-high" : utilizationPct >= 2 ? "roi-medium" : "roi-low";
    const barWidth = Math.max(0.5, Math.min(100, utilizationPct));

    // Zero-Skill Session Alert
    const zeroSkillSessions = efficiencyMetrics.recentSessions.filter(s => s.skillCount === 0 && s.totalCost >= 1.0);
    const zeroSkillHtml = zeroSkillSessions.length > 0
      ? `<div class="panel" style="border-left:3px solid var(--vscode-charts-red,#F44336)">
    <h2 style="margin-top:0">Zero-Skill Session Alert</h2>
    <p class="note" style="color:var(--vscode-charts-red,#F44336);margin-bottom:6px">${zeroSkillSessions.length} session(s) cost &gt;$1.00 with zero skill invocations in the last 14 days.</p>
    ${zeroSkillSessions.slice(0, 5).map(s => {
      const date = new Date(s.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      return `<div class="skill-row warn-row"><div class="skill-head"><span>${escapeHtml(s.sessionId.slice(0, 8))}…</span><span>${escapeHtml(date)}</span><span class="cost roi-low">${formatCompactUsd(s.totalCost)}</span></div><div class="hint">No skill assistance — general API only</div></div>`;
    }).join("")}
    <p class="note" style="margin-top:6px">Invoke a skill with <code>/skill-name</code> to get skill-augmented responses and unlock ROI tracking.</p>
  </div>`
      : "";

    return `<div class="panel">
    <h2>Skill Utilization Ratio · 14d</h2>
    <div class="stat-grid" style="margin-bottom:10px">
      <div class="stat-pill" title="Skill spend ÷ total session spend">
        <b>Skill Utilization</b>
        <span class="val ${escapeHtml(utilizationClass)}" style="font-size:18px;font-weight:700">${escapeHtml(utilizationStr)}</span>
      </div>
      <div class="stat-pill"><b>Skill spend</b><span class="val">${formatCompactUsd(skillSpend)}</span></div>
      <div class="stat-pill"><b>Session spend</b><span class="val">${formatCompactUsd(sessionSpend)}</span></div>
    </div>
    <div style="display:flex;height:12px;border-radius:4px;overflow:hidden;background:var(--vscode-editorGhostText-foreground,#555);opacity:.7;margin-bottom:4px">
      <div style="flex:${barWidth};background:var(--vscode-charts-green,#4CAF50);max-width:100%"></div>
    </div>
    <p class="note" style="margin-top:2px">${utilizationPct < 1 ? "⚠ Less than 1% of AI spend is skill-augmented. Invoke skills to unlock ROI tracking." : utilizationPct < 5 ? "Low skill leverage — consider invoking skills more frequently." : "Good skill leverage."}</p>
  </div>
  ${zeroSkillHtml}`;
  })()}

  ${formatEfficiencyPanelHtml(efficiencyMetrics)}

  ${(() => {
    const hace = efficiencyMetrics.hace;
    if (hace.noData) return "";
    const coachReport = buildCoachingReport(target, {
      haceScore: hace.haceScore,
      grade: hace.grade,
      promptClarityScore: hace.promptClarityScore,
      taskVelocityScore: hace.taskVelocityScore,
      accuracyScore: hace.accuracyScore,
      resolutionVelocityScore: hace.resolutionVelocityScore,
      skillLeverageScore: hace.skillLeverageScore,
      cliEfficiencyScore: hace.cliEfficiencyScore,
    });
    return formatCoachingReportHtml(coachReport);
  })()}

  ${
    showPerSkill
      ? `<div class="panel">
    <h2>Cross-agent savings</h2>
    <p class="note" style="margin-top:0">Cursor: ${savings.cursorSkills} skill(s) · ~${formatCompactUsd(savings.realizedUsd)} saved vs Claude · speculative ~${formatCompactUsd(savings.speculativeUsd)}</p>
  </div>`
      : ""
  }

  <div class="panel">
    <h2>Optimizations</h2>
    <ul>${
      showPerSkill
        ? optRows || "<li class=\"note\">No suggestions yet.</li>"
        : "<li class=\"note\">Complete per-skill setup first.</li>"
    }</ul>
  </div>

  ${archived.length > 0 ? `<div class="panel"><h2>Archived</h2><p class="note">${archived.map(escapeHtml).join(", ")}</p></div>` : ""}

  <details open>
    <summary style="cursor:pointer;font-weight:600;padding:6px 0;font-size:13px;list-style:none">
      &#9654; Learning <span class="note" style="font-weight:normal">(${timelineEvents.filter(e => e.type === "invoked").length} invocations recorded)</span>
    </summary>
    <div class="panel" style="margin-top:6px">
      ${formatLearningTimelineHtml(timelineEvents)}
    </div>
    ${proposalFunnel ? `<div class="panel" style="margin-top:6px">
      <h2 style="margin-top:0">Recommendation Funnel · 30d</h2>
      ${formatProposalFunnelHtml(proposalFunnel)}
    </div>` : ""}
    ${hookHealth ? `<div class="panel" style="margin-top:6px">
      <h2 style="margin-top:0">Hook Health · Today</h2>
      ${formatHookHealthHtml(hookHealth)}
    </div>` : ""}
    ${repoAffinity && Object.keys(repoAffinity.skillBoosts).length > 0 ? `<div class="panel" style="margin-top:6px">
      <h2 style="margin-top:0">Repository Affinity</h2>
      <p class="note" style="margin-top:0">Tech-stack signals detected in this repo — applied as proposal confidence boosts.</p>
      ${Object.entries(repoAffinity.skillBoosts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([sk, pts]) =>
        `<div class="skill-row"><div class="skill-head"><b>${escapeHtml(sk)}</b><span class="conf-high">+${pts} pts</span></div></div>`
      ).join("")}
    </div>` : ""}
    <div class="panel" style="margin-top:6px">
      <h2 style="margin-top:0">Adaptation Timeline</h2>
      ${formatAdaptationTimelineHtml(adaptationEvents)}
    </div>
    ${formatContextEfficiencyPanelHtml(target)}
    ${formatSkillHealthCard(target)}
    ${formatSkillEvolutionHtml(target, Object.keys(manifest.skills))}
    ${formatAdoptionCoachHtml(target)}
    ${formatAdoptionDashboardHtml(adoptionMetrics)}
    ${formatPromptIntelligencePanelHtml(target, 14)}
    ${formatLearningLoopHtml(target)}
  </details>

  <details>
    <summary style="cursor:pointer;font-weight:600;padding:6px 0;font-size:13px;list-style:none">
      &#9654; Prompt Template Library
    </summary>
    ${formatTemplateLibraryHtml()}
  </details>

  ${predictionHtml ? `<details>
    <summary style="cursor:pointer;font-weight:600;padding:6px 0;font-size:13px;list-style:none">
      &#9654; Prediction Intelligence
    </summary>
    <div class="panel" style="margin-top:6px">
      ${predictionHtml}
    </div>
  </details>` : ""}

  <details>
    <summary style="cursor:pointer;font-weight:600;padding:6px 0;font-size:13px;list-style:none">
      &#9654; Telemetry &amp; Export
    </summary>
    <div class="panel" style="margin-top:6px">
      ${governanceHtml}
      <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
        <button id="btn-export-telemetry" class="action-btn" title="Export skill telemetry to CSV">Export Telemetry CSV</button>
        <button id="btn-apply-mcp-autofixes" class="action-btn" title="Write permanent cache rules for hot files and directories to mcp-agent-hints.md">Apply auto-fixes to hints</button>
        <button id="btn-clear-mcp-logs" class="action-btn secondary">Clear MCP Logs</button>
      </div>
    </div>
  </details>`;

  return { mainBodyHtml, canApplyOptimizations, apiScore };
}

export function buildAndCacheDashboardSnapshot(
  target: string,
  libraryDir: string,
  pipeline: CostPipelineResult
): DashboardSnapshotPayload {
  const built = buildDashboardMainBodyHtml(target, libraryDir, pipeline);
  writeDashboardSnapshot(target, buildDashboardSnapshotFingerprint(target, pipeline), built);
  return built;
}

export function getOrBuildDashboardMainBody(
  target: string,
  libraryDir: string,
  pipeline: CostPipelineResult
): DashboardSnapshotPayload {
  const hit = tryReadValidDashboardSnapshot(target, pipeline);
  if (hit) {
    return hit;
  }
  return buildAndCacheDashboardSnapshot(target, libraryDir, pipeline);
}

function resolveTeamEconomicsPanels(
  target: string,
  libraryDir: string,
  manifest: ReturnType<typeof loadManifest>,
  attribution: SkillAttributionMap,
  showPerSkill: boolean,
  staleEqualSplit: boolean,
  options?: CostDashboardOptions
): string {
  const teamSharing = !staleEqualSplit;
  if (!showPerSkill || !teamSharing) {
    return "";
  }
  if (options?.includeTeamEconomics === false) {
    return teamEconomicsLoadingSlotHtml();
  }
  const bundle =
    options?.teamBundle ??
    tryReadValidTeamEconomicsCache(target) ??
    getOrComputeTeamEconomicsBundle(target, libraryDir, manifest, attribution);
  return formatTeamEconomicsPanelsHtml(bundle, showPerSkill);
}

function formatCostDashboardHtmlFast(
  target: string,
  libraryDir: string,
  nonce: string,
  pipeline: CostPipelineResult,
  options?: CostDashboardOptions
): string {
  const snap = tryReadValidDashboardSnapshot(target, pipeline);
  const mainContent = snap?.mainBodyHtml ?? dashboardMainLoadingSlotHtml();
  const canApply = snap?.canApplyOptimizations ?? true;
  const teamSlot =
    options?.includeTeamEconomics === false
      ? teamEconomicsLoadingSlotHtml()
      : "";
  const body = `${mainContent}\n  ${teamSlot}\n  ${dashboardActionsFooterHtml(canApply)}`;
  return wrapCostDashboardDocument(target, nonce, body, true);
}

function formatCostDashboardHtmlFull(
  target: string,
  libraryDir: string,
  nonce: string,
  pipelineResult: CostPipelineResult | undefined,
  options?: CostDashboardOptions
): string {
  const pipeline = pipelineResult ?? runCostPipelineSync(target, libraryDir);
  const built = buildDashboardMainBodyHtml(target, libraryDir, pipeline);
  writeDashboardSnapshot(target, buildDashboardSnapshotFingerprint(target, pipeline), built);
  const manifest = loadManifest(libraryDir);
  const { attribution, staleEqualSplit } = resolveDisplayAttribution(
    buildCostAttribution(target, libraryDir),
    target
  );
  const health = assessAttributionHealth(target, libraryDir);
  const modeCtx = buildSystemModeContext(health, target, pipeline.cycle);
  const teamPanels = resolveTeamEconomicsPanels(
    target,
    libraryDir,
    manifest,
    attribution,
    modeCtx.canShowPerSkillCosts,
    staleEqualSplit,
    options
  );
  const body = `${built.mainBodyHtml}\n  ${teamPanels}\n  ${dashboardActionsFooterHtml(built.canApplyOptimizations)}`;
  return wrapCostDashboardDocument(target, nonce, body, true);
}

export function formatCostDashboardHtml(
  target: string,
  libraryDir: string,
  scriptNonce?: string,
  pipelineResult?: CostPipelineResult,
  options?: CostDashboardOptions
): string {
  const nonce = scriptNonce ?? "";
  const pipeline = pipelineResult ?? runCostPipelineSync(target, libraryDir);
  if (options?.fastPhase) {
    return formatCostDashboardHtmlFast(target, libraryDir, nonce, pipeline, options);
  }
  return formatCostDashboardHtmlFull(target, libraryDir, nonce, pipelineResult, options);
}

export function formatCostDashboardText(target: string, libraryDir: string): string {
  const manifest = loadManifest(libraryDir);
  const pipeline = runCostPipelineSync(target, libraryDir);
  const built = buildCostAttribution(target, libraryDir);
  const health = assessAttributionHealth(target, libraryDir);
  const modeCtx = buildSystemModeContext(health, target, pipeline.cycle);
  const { attribution, staleEqualSplit, equalSplitCluster } = resolveDisplayAttribution(built, target);
  const credit = computeEnabledAgentsCreditUsage(libraryDir, 14, target);
  const agentUsage = computePerAgentCreditUsage(libraryDir, 14, target);
  const showPerSkill = modeCtx.canShowPerSkillCosts;
  const suggestions = showPerSkill ? generateOptimizationSuggestions(target, libraryDir, manifest) : [];
  const skillCostSummary = summarizeSkillCostsFromRuns(target, 14);
  const useRunsForTopSkills = skillCostSummary.includedRuns > 0;
  const generalApi = computeGeneralApiSpend(target, libraryDir, 14);
  const showTopSkills = useRunsForTopSkills || showPerSkill;
  const top = useRunsForTopSkills
    ? topSkillsFromRuns(target, 5, 14)
    : showPerSkill
      ? topExpensiveSkills(attribution, 5)
      : [];
  const totalCost =
    (useRunsForTopSkills ? skillCostSummary.totalCost : top.reduce((s, r) => s + r.cost, 0)) ||
    credit.totalCost;
  const maxTop = top[0]?.cost ?? 1;
  const savings = showPerSkill
    ? crossAgentSavingsSummary(attribution)
    : { realizedUsd: 0, speculativeUsd: 0, cursorSkills: 0 };

  const sessionSpendPrefix = spendPrefixForCreditSummary(credit);
  const sessionSpendLabel =
    sessionSpendPrefix === "API"
      ? "Session spend (API)"
      : sessionSpendPrefix === "Mixed"
        ? "Session spend (mixed)"
        : "Est. spend";

  const lines = [
    "â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—",
    "â•‘  Claude Skills - Cost Intelligence Dashboard                 â•‘",
    "â• â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•£",
    "",
    `  Last 14 days (${sessionSpendLabel.toLowerCase()}): ${formatCompactUsd(credit.totalCost)} | ${formatTokenCount(credit.totalTokens)}`,
  ];

  if (useRunsForTopSkills) {
    lines.push(
      `  Skill spend (hooks/API): ${formatCompactUsd(skillCostSummary.totalCost)} | ${skillCostSummary.includedRuns} run(s)`
    );
  }
  if (generalApi.totalTokens > 0) {
    lines.push(
      `  General API (non-skill): ${formatCompactUsd(generalApi.totalCost)} | ${formatTokenCount(generalApi.totalTokens)} | ${generalApi.sessionCount} session(s)`
    );
  }

  if (staleEqualSplit && equalSplitCluster && !useRunsForTopSkills) {
    lines.push(
      "",
      "  *** PER-SKILL COSTS UNRELIABLE ***",
      `  ${formatEqualSplitWarning(equalSplitCluster)}`,
      "  Agent totals below are still valid (from session transcripts)."
    );
  }

  lines.push("", "  Usage by AI agent (last 14 days, transcript estimate):");

  for (const row of agentUsage) {
    const spend =
      row.cost > 0
        ? `${formatCompactUsd(row.cost)} | ${formatTokenCount(row.tokens)} | ${row.sessions} sessions`
        : row.transcriptTracked
          ? "no usage logged"
          : "deploy only — spend not measured (enable attribution hooks)";
    lines.push(`    ${row.displayName} (${row.agent}): ${spend}`);
    if (row.models.length > 0) {
      for (const m of row.models) {
        lines.push(
          `      · ${formatModelLabel(m.model, m.costBasis)}: ${formatCompactUsd(m.cost)} | ${formatTokenCount(totalTokensForModelUsage(m))} tokens`
        );
      }
    }
  }

  if (!showTopSkills) {
    lines.push("", "  Per-skill setup:", `    ${health.summary}`);
    lines.push("", "  Top expensive skills: (hidden until attribution is reliable)");
  } else {
    lines.push(
      "",
      useRunsForTopSkills
        ? "  Top skills (measured from hooks/API):"
        : "  Top expensive skills:"
    );
    top.forEach((row, i) => {
      const pct = totalCost > 0 ? Math.round((row.cost / totalCost) * 100) : 0;
      const hint = suggestions.find((s) => s.skill === row.skill);
      lines.push(
        `  ${i + 1}. ${row.skill.padEnd(24)} ${formatCompactUsd(row.cost).padStart(8)} (${pct}%)  ${bar(row.cost, maxTop)}`
      );
      if (hint) {
        lines.push(`     â””â”€ ${hint.action}`);
      }
    });
    lines.push(
      "",
      "  Cross-agent savings (est.):",
      `     Measured: Cursor for ${savings.cursorSkills} skills — ${formatCompactUsd(savings.realizedUsd)}`,
      `     Speculative heuristic: ${formatCompactUsd(savings.speculativeUsd)}`
    );
  }

  lines.push("", "â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•");
  return lines.join("\n");
}
