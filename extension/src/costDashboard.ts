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
import { calculateTrend } from "./costPredictor";
import { loadCostProfile } from "./costProfiles";
import { attributeCostToAuthors } from "./teamCostSharing";
import { listArchivedSkills } from "./skillArchival";
import { assessAttributionHealth } from "./attributionHealth";
import { enrichV2HookRunTokens } from "./v2TokenEnrichment";
import { formatBenchmarkLine } from "./communityBenchmarks";
import { isFeatureEnabled } from "./featureFlags";
import { ESTIMATE_DISCLAIMER, ESTIMATE_DISCLAIMER_SHORT, tokenCostUsd } from "./costRates";
import { formatCompactUsd } from "./skillCost";
import { computeEnabledAgentsCreditUsage, computePerAgentCreditUsage } from "./agentOps";
import { computeUsageStats, formatTokenCount } from "./usageStats";
import { loadManifest } from "./skillOps";

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

function setupChecklistHtml(health: ReturnType<typeof assessAttributionHealth>): string {
  const items = [
    health.staleEqualSplit
      ? "<li>Run <b>Reset Mis-attributed Cost Data</b> (Command Palette)</li>"
      : "<li>Reset mis-attributed data — only if you see identical costs per skill</li>",
    "<li>Run <b>Enable Attribution Hooks (v2)</b> — logs each Skill tool invoke to runs.jsonl</li>",
    "<li>Use the <b>self-learning</b> skill on real tasks (<code>metadata.invoked: true</code>)</li>",
    "<li>Work in Claude Code or Cursor for a few sessions, then reopen this dashboard</li>",
  ];
  return `<div class="panel"><h2>Per-skill data setup</h2><p>Agent totals above are valid. Per-skill breakdown needs clean attribution:</p><ul>${items.join("")}</ul><p class="note">${escapeHtml(health.summary)}</p></div>`;
}

export function formatCostDashboardHtml(target: string, libraryDir: string, scriptNonce?: string): string {
  const nonce = scriptNonce ?? "";
  const cspMeta = nonce
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">`
    : "";
  enrichV2HookRunTokens(target, libraryDir);
  const manifest = loadManifest(libraryDir);
  const built = buildCostAttribution(target, libraryDir);
  const health = assessAttributionHealth(target, libraryDir);
  const { attribution, staleEqualSplit, equalSplitCluster } = resolveDisplayAttribution(built, target);
  const unattributedTokens = Object.values(built.unattributed).reduce((s, t) => s + (t ?? 0), 0);
  const unattributedCost = tokenCostUsd(unattributedTokens);
  const credit = computeEnabledAgentsCreditUsage(libraryDir, 14, target);
  const agentUsage = computePerAgentCreditUsage(libraryDir, 14, target);
  const agentCostTotal = agentUsage.reduce((s, r) => s + r.cost, 0) || credit.totalCost;
  const maxAgentCost = Math.max(...agentUsage.map((r) => r.cost), 1);
  const showPerSkill = health.reliable;
  const suggestions = showPerSkill ? generateOptimizationSuggestions(target, libraryDir, manifest) : [];
  const top = showPerSkill ? topExpensiveSkills(attribution, 5) : [];
  const totalCost = top.reduce((s, r) => s + r.cost, 0) || credit.totalCost;
  const maxTop = top[0]?.cost ?? 1;
  const savings = showPerSkill
    ? crossAgentSavingsSummary(attribution)
    : { realizedUsd: 0, speculativeUsd: 0, cursorSkills: 0 };
  const trend = calculateTrend();
  const profile = showPerSkill ? loadCostProfile(target, libraryDir) : undefined;
  const usageStats = computeUsageStats(target, manifest);
  const teamLines =
    staleEqualSplit || !isFeatureEnabled("teamCostSharing")
      ? []
      : attributeCostToAuthors(target, attribution);
  const archived = isFeatureEnabled("skillArchival") ? listArchivedSkills(target) : [];
  const equalSplitWarn = equalSplitCluster ? formatEqualSplitWarning(equalSplitCluster, true) : null;

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
          <span class="cost">${row.cost > 0 ? `${formatCompactUsd(row.cost)}${pct ? ` (${pct}%)` : ""}` : "—"}</span>
          ${row.cost > 0 ? `<span class="bar">${bar(row.cost, maxAgentCost)}</span>` : ""}</div>
        <div class="hint">${escapeHtml(detail)}</div>
      </div>`;
    })
    .join("");

  const topRows = top
    .map((row, i) => {
      const pct = totalCost > 0 ? Math.round((row.cost / totalCost) * 100) : 0;
      const hint = [
        hintForSkill(row.skill, suggestions, usageStats),
        isFeatureEnabled("communityBenchmarks") ? formatBenchmarkLine(row.skill) : undefined,
      ]
        .filter(Boolean)
        .join(" | ");
      return `<div class="skill-row">
        <div class="skill-head"><span class="rank">${i + 1}.</span> <b>${escapeHtml(row.skill)}</b>
          <span class="cost">${formatCompactUsd(row.cost)} (${pct}%)</span>
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
        `<button class="secondary apply-one" data-skill="${escapeHtml(s.skill)}" data-type="${escapeHtml(s.type)}" onclick="applyOne(this.dataset.skill,this.dataset.type)">Apply</button></li>`
    )
    .join("");

  const trendLabel =
    trend.direction === "up"
      ? `Up ${trend.percentage}% vs prior week`
      : trend.direction === "down"
        ? `Down ${Math.abs(trend.percentage)}% vs prior week`
        : "Stable week-over-week";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${cspMeta}
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px 20px; max-width: 900px; }
  h1 { font-size: 1.25em; margin: 0 0 4px; }
  .subtitle { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-bottom: 16px; }
  .panel { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 14px 16px; margin-bottom: 14px; }
  .panel h2 { font-size: 0.95em; margin: 0 0 10px; }
  .summary-line { font-size: 1.05em; margin-bottom: 8px; }
  .skill-row { margin-bottom: 10px; font-size: 0.9em; }
  .skill-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .rank { color: var(--vscode-descriptionForeground); min-width: 1.5em; }
  .cost { margin-left: auto; white-space: nowrap; }
  .bar { font-family: monospace; letter-spacing: 1px; color: var(--vscode-textLink-foreground); }
  .hint { margin-left: 2em; color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  ul { margin: 0; padding-left: 18px; font-size: 0.9em; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 0.9em; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .metric { display: inline-block; margin-right: 16px; }
  .note { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin-top: 10px; }
  .warn { background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); border-radius: 6px; padding: 10px 12px; margin-bottom: 14px; font-size: 0.9em; }
  .agent-id { color: var(--vscode-descriptionForeground); font-size: 0.85em; font-weight: normal; }
  .estimate-banner { background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 6px; padding: 10px 12px; margin-bottom: 14px; font-size: 0.85em; }
  .opt-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 6px; }
  .apply-one { padding: 2px 10px; font-size: 0.8em; }
</style>
</head>
<body>
  <h1>Claude Skills — Cost Intelligence</h1>
  <div class="subtitle">Workspace: <code>${escapeHtml(target)}</code> · <b>${ESTIMATE_DISCLAIMER_SHORT}</b></div>
  <div class="estimate-banner">${escapeHtml(ESTIMATE_DISCLAIMER)} Per-skill costs use model-aware rates when transcript model ids are available; otherwise a Sonnet-like blended default.</div>

  ${
    equalSplitWarn
      ? `<div class="warn"><b>Per-skill costs unreliable:</b> ${equalSplitWarn}</div>`
      : unattributedTokens > 0
        ? `<div class="warn"><b>Attribution warning:</b> ${formatTokenCount(unattributedTokens)} tokens (~${formatCompactUsd(unattributedCost)}) could not be assigned to a specific invoked skill. Run <b>Reset Mis-attributed Cost Data</b>, then use self-learning to record runs with <code>invoked: true</code>.</div>`
        : ""
  }

  <div class="panel">
    <div class="summary-line">
      <span class="metric"><b>Est. last 14 days (this workspace):</b> ${formatCompactUsd(credit.totalCost)} | ${formatTokenCount(credit.totalTokens)} tokens</span>
    </div>
    <div class="metric"><b>Trend:</b> ${escapeHtml(trendLabel)}</div>
    ${profile ? `<div class="metric"><b>Profile:</b> ~${formatCompactUsd(profile.typical_monthly_cost)}/mo typical <span class="agent-id">(from skill attribution — may be inflated)</span></div>` : ""}
  </div>

  <div class="panel">
    <h2>Usage by AI agent (last 14 days)</h2>
    <p class="note" style="margin-top:0"><b>Claude + Cursor:</b> spend from session transcripts for <i>this workspace folder only</i> (not all projects on your machine). <b>Kiro + Copilot:</b> deploy only. Not an API invoice.</p>
    ${agentRows}
  </div>

  ${showPerSkill ? "" : setupChecklistHtml(health)}

  <div class="panel">
    <h2>Top expensive skills (est.)</h2>
    ${
      showPerSkill
        ? topRows || "<p>No per-skill cost data yet.</p>"
        : "<p>Hidden until attribution setup is complete (see checklist above). Agent totals remain valid.</p>"
    }
  </div>

  ${
    showPerSkill
      ? `<div class="panel">
    <h2>Cross-agent savings (est.)</h2>
    <p>Measured: Cursor used for ${savings.cursorSkills} skill(s) — est. ~${formatCompactUsd(savings.realizedUsd)} saved vs Claude</p>
    <p class="note">Speculative (heuristic, not measured): ~${formatCompactUsd(savings.speculativeUsd)} if more skills moved to Cursor</p>
  </div>`
      : ""
  }

  <div class="panel">
    <h2>Optimization opportunities</h2>
    <ul>${
      showPerSkill
        ? optRows || "<li>No suggestions yet — collect more runs/transcript data.</li>"
        : "<li>Complete the per-skill setup checklist above before applying disable/switch suggestions.</li>"
    }</ul>
  </div>

  ${teamLines.length > 0 ? `<div class="panel"><h2>Team skill attribution</h2><ul>${teamLines.map((t) => `<li><b>${escapeHtml(t.skill)}</b>: ${escapeHtml(t.line)}</li>`).join("")}</ul></div>` : ""}

  ${archived.length > 0 ? `<div class="panel"><h2>Archived skills</h2><p>${archived.map(escapeHtml).join(", ")} — use <b>Restore Archived Skill</b> command.</p></div>` : ""}

  <div class="actions">
    <button onclick="applyOpts()" ${showPerSkill ? "" : "disabled title=\"Complete attribution setup first\""}>Apply optimizations</button>
    <button class="secondary" onclick="exportReport()">Export report</button>
    <button class="secondary" onclick="openBudget()">Configure budget</button>
  </div>
  <div class="note">Estimates from transcripts and runs.jsonl — not an actual API bill.</div>

  <script${nonce ? ` nonce="${nonce}"` : ""}>
    const vscode = acquireVsCodeApi();
    function applyOpts() { vscode.postMessage({ command: "applyOptimizations" }); }
    function applyOne(skill, type) { vscode.postMessage({ command: "applySuggestion", skill, type }); }
    function exportReport() { vscode.postMessage({ command: "exportReport" }); }
    function openBudget() { vscode.postMessage({ command: "openBudget" }); }
  </script>
</body>
</html>`;
}

export function formatCostDashboardText(target: string, libraryDir: string): string {
  const manifest = loadManifest(libraryDir);
  const built = buildCostAttribution(target, libraryDir);
  const health = assessAttributionHealth(target, libraryDir);
  const { attribution, staleEqualSplit, equalSplitCluster } = resolveDisplayAttribution(built, target);
  const credit = computeEnabledAgentsCreditUsage(libraryDir, 14, target);
  const agentUsage = computePerAgentCreditUsage(libraryDir, 14, target);
  const showPerSkill = health.reliable;
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
