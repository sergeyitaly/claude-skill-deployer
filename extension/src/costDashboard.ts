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
import { assessAttributionHealth } from "./attributionHealth";
import { assessSkillCostConfidence, formatConfidenceBadge } from "./attributionConfidence";
import { buildGlobalTrustBadge, buildSkillTrustLine, formatGlobalTrustBannerHtml } from "./attributionTrust";
import { resolveAttributionStrategy, formatAttributionStrategyLine } from "./attributionStrategy";
import { enrichV2HookRunTokens } from "./v2TokenEnrichment";
import { formatBenchmarkLine } from "./communityBenchmarks";
import { isFeatureEnabled } from "./featureFlags";
import { readProjectProfile } from "./projectProfile";
import { formatProjectProfileDashboardHtml } from "./projectProfileDisplay";
import { ESTIMATE_DISCLAIMER, ESTIMATE_DISCLAIMER_SHORT, tokenCostUsd } from "./costRates";
import { formatCompactUsd } from "./skillCost";
import { computeSkillRoi, formatRoiDashboardLine, upgradeRoiConfidenceFromRuns } from "./skillRoi";
import {
  getOrComputeTeamEconomicsBundle,
  TEAM_ECONOMICS_SLOT_ID,
  TeamEconomicsCachePayload,
  tryReadValidTeamEconomicsCache,
} from "./teamEconomicsCache";
import { buildSystemModeContext } from "./systemMode";
import { CostPipelineResult, runCostPipelineSync } from "./costPipeline";
import { formatCapabilitiesSummary } from "./agentCapabilities";
import { computeEnabledAgentsCreditUsage, computePerAgentCreditUsage, AgentCreditRow } from "./agentOps";
import { computeUsageStats, formatTokenCount } from "./usageStats";
import { formatModelLabel, totalTokensForModelUsage } from "./usageCost";
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
} from "./dashboardSnapshotCache";

function escapeHtml(v: string): string {
  return v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function bar(cost: number, maxCost: number, width = 10): string {
  const len = maxCost > 0 ? Math.round((cost / maxCost) * width) : 0;
  return "\u2588".repeat(len) + "\u2591".repeat(width - len);
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
        <div class="skill-head"><span>${escapeHtml(formatModelLabel(m.model))}</span>
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
    <p class="note" style="margin-top:0">Claude: model ids from transcripts. Cursor: size-based estimate when ids are missing.</p>
    ${sections}
  </div>`;
}

function setupChecklistHtml(health: ReturnType<typeof assessAttributionHealth>): string {
  const items = [
    health.staleEqualSplit
      ? "<li>Run <b>Reset Mis-attributed Cost Data</b> (Command Palette)</li>"
      : "<li>Reset mis-attributed data — only if you see identical costs per skill</li>",
    "<li>Attribution v2 hooks auto-install for <b>Claude, Cursor, Kiro, and Copilot</b> (reload workspace if hook files are missing)</li>",
    "<li>Use the <b>self-learning</b> skill on real tasks (<code>metadata.invoked: true</code>)</li>",
    "<li>Work in any enabled agent for a few sessions, then reopen this dashboard</li>",
  ];
  return `<div class="panel"><h2>Setup checklist</h2><p class="note">Agent totals are valid. Per-skill breakdown needs:</p><ul>${items.join("")}</ul><p class="note">${escapeHtml(health.summary)}</p></div>`;
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
    function rebindDashboardActionListeners() {
      const vscode = acquireVsCodeApi();
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

/** Build main dashboard panels (excludes team economics + footer actions). */
export function buildDashboardMainBodyHtml(
  target: string,
  libraryDir: string,
  pipeline: CostPipelineResult,
  options?: { enrichTokens?: boolean }
): { mainBodyHtml: string; canApplyOptimizations: boolean } {
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
  const unattributedTokens = Object.values(built.unattributed).reduce((s, t) => s + (t ?? 0), 0);
  const unattributedCost = tokenCostUsd(unattributedTokens);
  const credit = computeEnabledAgentsCreditUsage(libraryDir, 14, target);
  const agentUsage = computePerAgentCreditUsage(libraryDir, 14, target);
  const agentCostTotal = agentUsage.reduce((s, r) => s + r.cost, 0) || credit.totalCost;
  const maxAgentCost = Math.max(...agentUsage.map((r) => r.cost), 1);
  const suggestions = showPerSkill ? generateOptimizationSuggestions(target, libraryDir, manifest) : [];
  const top = showPerSkill ? topExpensiveSkills(attribution, 5) : [];
  const totalCost = top.reduce((s, r) => s + r.cost, 0) || credit.totalCost;
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
  const archived = isFeatureEnabled("skillArchival") ? listArchivedSkills(target) : [];

  const agentRows = agentUsage
    .map((row) => {
      const pct = agentCostTotal > 0 && row.cost > 0 ? Math.round((row.cost / agentCostTotal) * 100) : 0;
      const detail = !row.transcriptTracked
        ? "Deploy only — spend not measured (no transcript roots)"
        : row.tokens === 0
          ? "No usage logged in the last 14 days"
          : `${formatTokenCount(row.tokens)} tokens · ${row.sessions} session(s)`;
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
      let roi = computeSkillRoi(row.skill, manifest, stat, row.cost);
      const v2Runs = stat ? (stat.agentRuns ? Object.values(stat.agentRuns).reduce((a, b) => (a ?? 0) + (b ?? 0), 0) : stat.runs) : 0;
      roi = upgradeRoiConfidenceFromRuns(roi, health.v2HookRuns > 0 ? v2Runs : 0);
      const conf = skillConfidence.get(row.skill);
      const trust = buildSkillTrustLine(conf, roi.roiBand);
      const hint = [
        formatRoiDashboardLine(roi, formatCompactUsd(row.cost)),
        trust.summary,
        hintForSkill(row.skill, suggestions, usageStats),
        formatSkillAgentBreakdown(row.skill, attribution),
        isFeatureEnabled("communityBenchmarks") ? formatBenchmarkLine(row.skill) : undefined,
      ]
        .filter(Boolean)
        .join(" | ");
      const confClass = conf?.level ?? "estimated";
      return `<div class="skill-row">
        <div class="skill-head"><span class="rank">${i + 1}.</span> <b>${escapeHtml(row.skill)}</b>
          <span class="roi-${roi.roiBand.toLowerCase()}">${escapeHtml(roi.roiBand)}</span>
          <span class="cost">${formatCompactUsd(row.cost)} (${pct}%)</span>
          <span class="conf-${confClass}">${escapeHtml(trust.summary)}</span>
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

  const mainBodyHtml = `
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
      ? `<div class="warn"><b>Per-skill unreliable:</b> ${equalSplitWarn}</div>`
      : unattributedTokens > 0
        ? `<div class="warn"><b>Unattributed:</b> ${formatTokenCount(unattributedTokens)} tokens (~${formatCompactUsd(unattributedCost)}). Reset mis-attributed data, then record <code>invoked: true</code> runs.</div>`
        : ""
  }

  <div class="panel">
    <h2>Overview · 14d</h2>
    <div class="stat-grid">
      <div class="stat-pill"><b>Est. spend</b><span class="val">${formatCompactUsd(credit.totalCost)}</span></div>
      <div class="stat-pill"><b>Tokens</b><span class="val">${formatTokenCount(credit.totalTokens)}</span></div>
      <div class="stat-pill"><b>Trend</b><span class="val">${escapeHtml(trendLabel)}</span></div>
      ${profile ? `<div class="stat-pill"><b>Typical / mo</b><span class="val">${formatCompactUsd(profile.typical_monthly_cost)}</span></div>` : ""}
    </div>
  </div>

  <div class="panel">
    <h2>By agent · 14d</h2>
    <p class="note" style="margin-top:0">Claude + Cursor: this workspace only. Kiro + Copilot: deploy only.</p>
    ${agentRows}
  </div>

  ${formatModelsByAgentHtml(agentUsage)}

  ${showPerSkill ? "" : setupChecklistHtml(health)}

  <div class="panel">
    <h2>Top skills</h2>
    ${
      showPerSkill
        ? topRows || "<p class=\"note\">No per-skill cost data yet.</p>"
        : "<p class=\"note\">Hidden until attribution setup completes.</p>"
    }
  </div>

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

  ${archived.length > 0 ? `<div class="panel"><h2>Archived</h2><p class="note">${archived.map(escapeHtml).join(", ")}</p></div>` : ""}`;

  return { mainBodyHtml, canApplyOptimizations };
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
  const teamSharing = isFeatureEnabled("teamCostSharing") && !staleEqualSplit;
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
  const top = showPerSkill ? topExpensiveSkills(attribution, 5) : [];
  const totalCost = top.reduce((s, r) => s + r.cost, 0) || credit.totalCost;
  const maxTop = top[0]?.cost ?? 1;
  const savings = showPerSkill
    ? crossAgentSavingsSummary(attribution)
    : { realizedUsd: 0, speculativeUsd: 0, cursorSkills: 0 };

  const lines = [
    "╔══════════════════════════════════════════════════════════════╗",
    "║  Claude Skills - Cost Intelligence Dashboard                 ║",
    "╠══════════════════════════════════════════════════════════════╣",
    "",
    `  Last 14 days: ${formatCompactUsd(credit.totalCost)} | ${formatTokenCount(credit.totalTokens)}`,
  ];

  if (staleEqualSplit && equalSplitCluster) {
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
          : "deploy only — spend not measured";
    lines.push(`    ${row.displayName} (${row.agent}): ${spend}`);
    if (row.models.length > 0) {
      for (const m of row.models) {
        lines.push(
          `      · ${formatModelLabel(m.model)}: ${formatCompactUsd(m.cost)} | ${formatTokenCount(totalTokensForModelUsage(m))} tokens`
        );
      }
    }
  }

  if (!showPerSkill) {
    lines.push("", "  Per-skill setup:", `    ${health.summary}`);
    lines.push("", "  Top expensive skills: (hidden until attribution is reliable)");
  } else {
    lines.push("", "  Top expensive skills:");
    top.forEach((row, i) => {
      const pct = totalCost > 0 ? Math.round((row.cost / totalCost) * 100) : 0;
      const hint = suggestions.find((s) => s.skill === row.skill);
      lines.push(
        `  ${i + 1}. ${row.skill.padEnd(24)} ${formatCompactUsd(row.cost).padStart(8)} (${pct}%)  ${bar(row.cost, maxTop)}`
      );
      if (hint) {
        lines.push(`     └─ ${hint.action}`);
      }
    });
    lines.push(
      "",
      "  Cross-agent savings (est.):",
      `     Measured: Cursor for ${savings.cursorSkills} skills — ${formatCompactUsd(savings.realizedUsd)}`,
      `     Speculative heuristic: ${formatCompactUsd(savings.speculativeUsd)}`
    );
  }

  lines.push("", "╚══════════════════════════════════════════════════════════════╝");
  return lines.join("\n");
}
