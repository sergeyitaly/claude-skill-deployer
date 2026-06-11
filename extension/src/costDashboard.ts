import { AgentId } from "./agentOps";
import { buildCostAttribution, SkillAttributionMap } from "./costAttribution";
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
import { formatBenchmarkLine } from "./communityBenchmarks";
import { isFeatureEnabled } from "./featureFlags";
import { formatCompactUsd } from "./skillCost";
import { computeEnabledAgentsCreditUsage } from "./agentOps";
import { computeUsageStats, formatTokenCount } from "./usageStats";
import { loadManifest } from "./skillOps";

function mergeAttribution(skills: SkillAttributionMap, transcriptSkills: SkillAttributionMap): SkillAttributionMap {
  const out: SkillAttributionMap = { ...skills };
  for (const [skill, agents] of Object.entries(transcriptSkills)) {
    const existing = out[skill] ?? {};
    for (const [agent, stats] of Object.entries(agents)) {
      const bucket = existing[agent as AgentId] ?? { tokens: 0, cost: 0, sessions: 0 };
      bucket.tokens += stats.tokens;
      bucket.cost += stats.cost;
      bucket.sessions += stats.sessions;
      existing[agent as AgentId] = bucket;
    }
    out[skill] = existing;
  }
  return out;
}

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

export function formatCostDashboardHtml(target: string, libraryDir: string): string {
  const manifest = loadManifest(libraryDir);
  const built = buildCostAttribution(target, libraryDir);
  const attribution = mergeAttribution(built.skills, built.transcriptSkills);
  const unattributedTokens = Object.values(built.unattributed).reduce((s, t) => s + (t ?? 0), 0);
  const unattributedCost = (unattributedTokens / 1_000_000) * 9;
  const credit = computeEnabledAgentsCreditUsage(libraryDir, 14);
  const suggestions = generateOptimizationSuggestions(target, libraryDir, manifest);
  const top = topExpensiveSkills(attribution, 5);
  const totalCost = top.reduce((s, r) => s + r.cost, 0) || credit.totalCost;
  const maxTop = top[0]?.cost ?? 1;
  const savings = crossAgentSavingsSummary(attribution);
  const trend = calculateTrend();
  const profile = loadCostProfile(target, libraryDir);
  const usageStats = computeUsageStats(target, manifest);
  const teamLines = isFeatureEnabled("teamCostSharing")
    ? attributeCostToAuthors(target, attribution)
    : [];
  const archived = isFeatureEnabled("skillArchival") ? listArchivedSkills(target) : [];

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
    .map((s) => `<li><b>${escapeHtml(s.skill)}</b> — ${escapeHtml(s.action)}</li>`)
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
</style>
</head>
<body>
  <h1>Claude Skills — Cost Intelligence</h1>
  <div class="subtitle">Workspace: <code>${escapeHtml(target)}</code></div>

  ${
    unattributedTokens > 0
      ? `<div class="warn"><b>Attribution warning:</b> ${formatTokenCount(unattributedTokens)} tokens (~${formatCompactUsd(unattributedCost)}) could not be assigned to a specific invoked skill. Run <b>Reset Mis-attributed Cost Data</b> if you see equal splits across many skills, then use self-learning to record runs with <code>invoked: true</code>.</div>`
      : ""
  }

  <div class="panel">
    <div class="summary-line">
      <span class="metric"><b>Last 14 days:</b> ${formatCompactUsd(credit.totalCost)} | ${formatTokenCount(credit.totalTokens)} tokens</span>
    </div>
    <div class="metric"><b>Trend:</b> ${escapeHtml(trendLabel)}</div>
    ${profile ? `<div class="metric"><b>Profile:</b> ~${formatCompactUsd(profile.typical_monthly_cost)}/mo typical</div>` : ""}
  </div>

  <div class="panel">
    <h2>Top expensive skills</h2>
    ${topRows || "<p>No per-skill cost data yet.</p>"}
  </div>

  <div class="panel">
    <h2>Cross-agent savings</h2>
    <p>Using Cursor for ${savings.cursorSkills} skill(s) saved ~${formatCompactUsd(savings.realizedUsd)}</p>
    <p>Potential additional savings: ~${formatCompactUsd(savings.potentialUsd)}</p>
  </div>

  <div class="panel">
    <h2>Optimization opportunities</h2>
    <ul>${optRows || "<li>No suggestions yet — collect more runs/transcript data.</li>"}</ul>
  </div>

  ${teamLines.length > 0 ? `<div class="panel"><h2>Team skill attribution</h2><ul>${teamLines.map((t) => `<li><b>${escapeHtml(t.skill)}</b>: ${escapeHtml(t.line)}</li>`).join("")}</ul></div>` : ""}

  ${archived.length > 0 ? `<div class="panel"><h2>Archived skills</h2><p>${archived.map(escapeHtml).join(", ")} — use <b>Restore Archived Skill</b> command.</p></div>` : ""}

  <div class="actions">
    <button onclick="applyOpts()">Apply optimizations</button>
    <button class="secondary" onclick="exportReport()">Export report</button>
    <button class="secondary" onclick="openBudget()">Configure budget</button>
  </div>
  <div class="note">Estimates from transcripts and runs.jsonl — not an actual API bill.</div>

  <script>
    const vscode = acquireVsCodeApi();
    function applyOpts() { vscode.postMessage({ command: "applyOptimizations" }); }
    function exportReport() { vscode.postMessage({ command: "exportReport" }); }
    function openBudget() { vscode.postMessage({ command: "openBudget" }); }
  </script>
</body>
</html>`;
}

export function formatCostDashboardText(target: string, libraryDir: string): string {
  const manifest = loadManifest(libraryDir);
  const built = buildCostAttribution(target, libraryDir);
  const attribution = mergeAttribution(built.skills, built.transcriptSkills);
  const credit = computeEnabledAgentsCreditUsage(libraryDir, 14);
  const suggestions = generateOptimizationSuggestions(target, libraryDir, manifest);
  const top = topExpensiveSkills(attribution, 5);
  const totalCost = top.reduce((s, r) => s + r.cost, 0) || credit.totalCost;
  const maxTop = top[0]?.cost ?? 1;
  const savings = crossAgentSavingsSummary(attribution);

  const lines = [
    "╔══════════════════════════════════════════════════════════════╗",
    "║  Claude Skills - Cost Intelligence Dashboard                 ║",
    "╠══════════════════════════════════════════════════════════════╣",
    "",
    `  Last 14 days: ${formatCompactUsd(credit.totalCost)} | ${formatTokenCount(credit.totalTokens)}`,
    "",
    "  Top expensive skills:",
  ];

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
    "  Cross-agent savings:",
    `     Using Cursor for ${savings.cursorSkills} skills saved ${formatCompactUsd(savings.realizedUsd)}`,
    `     Potential additional savings: ${formatCompactUsd(savings.potentialUsd)}`,
    "",
    "╚══════════════════════════════════════════════════════════════╝"
  );
  return lines.join("\n");
}
