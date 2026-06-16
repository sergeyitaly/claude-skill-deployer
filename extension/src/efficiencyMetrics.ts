import * as fs from "node:fs";
import { readEnrichedRuns } from "./usageStats";
import { summarizeSkillCostsFromRuns } from "./skillCostFromRuns";
import {
  summarizeMcpUsage,
  summarizeCrossSessionPatterns,
  writeMcpHints,
  workspaceMcpLogPath,
  McpUsageSummary,
  CrossSessionSummary,
} from "./mcpUsageLog";
import { formatCompactUsd } from "./skillCost";
import { formatTokenCount } from "./usageStats";

export type TelemetryScope = "workspace" | "global" | "hybrid";

/**
 * Returns the effective MCP log path based on scope.
 * - "global": always read from ~/.claude/learning/mcp-usage.jsonl (default).
 * - "workspace": read from <target>/.claude/mcp-usage.jsonl.
 * - "hybrid" (default): use workspace log if it exists, else fall back to global.
 */
function resolveMcpLogPath(target: string, scope: TelemetryScope): string | undefined {
  if (scope === "global") return undefined;
  const wsPath = workspaceMcpLogPath(target);
  if (scope === "workspace") return wsPath;
  // hybrid: prefer workspace log if it has data
  try {
    if (fs.existsSync(wsPath) && fs.statSync(wsPath).size > 0) return wsPath;
  } catch {
    // fall through
  }
  return undefined;
}

export interface CostPerSkillRow {
  skill: string;
  avgCostPerRun: number;
  totalRuns: number;
  totalCost: number;
}

export interface CostPerAgentRow {
  agent: string;
  totalCost: number;
  totalRuns: number;
  avgCostPerRun: number;
}

export interface CostPerSessionRow {
  sessionId: string;
  ts: string;
  totalCost: number;
  totalTokens: number;
  skillCount: number;
  skills: string[];
}

export interface EfficiencyMetrics {
  costPerSkill: CostPerSkillRow[];
  costPerAgent: CostPerAgentRow[];
  recentSessions: CostPerSessionRow[];
  mcp: McpUsageSummary;
  mcpFileTokens: number;
  crossSession: CrossSessionSummary;
}

export function computeEfficiencyMetrics(
  target: string,
  daysBack = 14,
  telemetryScope: TelemetryScope = "hybrid"
): EfficiencyMetrics {
  const cutoff = Date.now() - daysBack * 86_400_000;
  const skillSummary = summarizeSkillCostsFromRuns(target, daysBack);

  const costPerSkill: CostPerSkillRow[] = skillSummary.skills
    .filter((s) => s.runs > 0)
    .map((s) => ({
      skill: s.skill,
      avgCostPerRun: s.runs > 0 ? s.cost / s.runs : 0,
      totalRuns: s.runs,
      totalCost: s.cost,
    }))
    .sort((a, b) => b.avgCostPerRun - a.avgCostPerRun);

  const agentMap = new Map<string, { totalCost: number; totalRuns: number }>();
  for (const s of skillSummary.skills) {
    for (const [agent, row] of Object.entries(s.byAgent)) {
      if (!row) {
        continue;
      }
      const existing = agentMap.get(agent) ?? { totalCost: 0, totalRuns: 0 };
      existing.totalCost += row.cost;
      existing.totalRuns += row.runs;
      agentMap.set(agent, existing);
    }
  }
  const costPerAgent: CostPerAgentRow[] = [...agentMap.entries()]
    .map(([agent, stats]) => ({
      agent,
      totalCost: stats.totalCost,
      totalRuns: stats.totalRuns,
      avgCostPerRun: stats.totalRuns > 0 ? stats.totalCost / stats.totalRuns : 0,
    }))
    .sort((a, b) => b.totalCost - a.totalCost);

  const runs = readEnrichedRuns(target).filter(
    (r) => new Date(r.ts).getTime() >= cutoff && Boolean(r.session_id)
  );
  const sessionMap = new Map<string, CostPerSessionRow>();
  for (const run of runs) {
    if (!run.session_id) {
      continue;
    }
    const existing = sessionMap.get(run.session_id) ?? {
      sessionId: run.session_id,
      ts: run.ts,
      totalCost: 0,
      totalTokens: 0,
      skillCount: 0,
      skills: [],
    };
    existing.totalCost += run.cost ?? 0;
    existing.totalTokens += run.tokens ?? 0;
    if (run.skill && !existing.skills.includes(run.skill)) {
      existing.skills.push(run.skill);
      existing.skillCount += 1;
    }
    sessionMap.set(run.session_id, existing);
  }
  const recentSessions = [...sessionMap.values()]
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 8);

  const mcp = summarizeMcpUsage(daysBack, resolveMcpLogPath(target, telemetryScope));
  const crossSession = summarizeCrossSessionPatterns(30); // always reads global log for cross-project intelligence

  // Write auto-remediation hints file whenever there is actionable data
  if (mcp.totalCalls > 0) {
    writeMcpHints(mcp);
  }

  return {
    costPerSkill,
    costPerAgent,
    recentSessions,
    mcp,
    mcpFileTokens: mcp.totalEstimatedTokens,
    crossSession,
  };
}

// ---------------------------------------------------------------------------
// Plain-text report (for output channel)
// ---------------------------------------------------------------------------

export function formatEfficiencyReport(metrics: EfficiencyMetrics): string {
  const lines: string[] = ["\n## Efficiency metrics\n"];

  if (metrics.costPerSkill.length > 0) {
    lines.push("### Cost per skill run (avg)");
    for (const row of metrics.costPerSkill.slice(0, 8)) {
      lines.push(
        `  ${row.skill.padEnd(30)} avg ${formatCompactUsd(row.avgCostPerRun)}/run  (${row.totalRuns} run(s), ${formatCompactUsd(row.totalCost)} total)`
      );
    }
  }

  if (metrics.costPerAgent.length > 0) {
    lines.push("\n### Cost per agent");
    for (const row of metrics.costPerAgent) {
      lines.push(
        `  ${row.agent.padEnd(12)} ${formatCompactUsd(row.totalCost)} total  avg ${formatCompactUsd(row.avgCostPerRun)}/run  ${row.totalRuns} run(s)`
      );
    }
  }

  if (metrics.recentSessions.length > 0) {
    lines.push("\n### Cost per session (task)");
    for (const s of metrics.recentSessions) {
      const date = new Date(s.ts).toLocaleDateString();
      lines.push(
        `  ${s.sessionId.slice(0, 12)}… ${date}  ${formatCompactUsd(s.totalCost)}  ${formatTokenCount(s.totalTokens)} tokens  ${s.skillCount} skill(s)`
      );
    }
  }

  const m = metrics.mcp;
  if (m.totalCalls > 0) {
    const sc = m.efficiencyScore;
    lines.push(`\n### MCP efficiency: ${sc.score}% (${sc.grade})  —  ${m.totalCalls} call(s), ~${formatTokenCount(metrics.mcpFileTokens)} tokens read`);
    if (m.wasteWarnings.length > 0) {
      lines.push("  Waste (repeated reads):");
      for (const w of m.wasteWarnings) lines.push(`    ⚠ ${w.description}`);
    }
    if (m.readAfterWrite.length > 0) {
      lines.push("  Read-after-write:");
      for (const r of m.readAfterWrite) lines.push(`    ⚠ ${r.description} — ${r.path}`);
    }
    if (m.agentLoops.length > 0) {
      lines.push("  Agent loops:");
      for (const l of m.agentLoops) lines.push(`    ⚠ ${l.description} — ${l.path}`);
    }
    if (m.largeFiles.length > 0) {
      lines.push("  Large files:");
      for (const f of m.largeFiles) lines.push(`    ⚠ ${f.description}`);
    }
    if (m.noOpWrites.length > 0) {
      lines.push("  No-op writes (auto-skipped):");
      for (const n of m.noOpWrites) lines.push(`    ✓ ${n.description}`);
    }
    if (m.suggestions.length > 0) {
      lines.push("  Suggestions:");
      for (const s of m.suggestions) {
        const saving = s.estimatedSavedTokens ? `  ~${formatTokenCount(s.estimatedSavedTokens)} tokens saved` : "";
        lines.push(`    → ${s.description}${saving}`);
      }
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HTML panel for the cost dashboard
// ---------------------------------------------------------------------------

function esc(v: string): string {
  return v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function miniBar(value: number, max: number, width = 8): string {
  const len = max > 0 ? Math.max(1, Math.round((value / max) * width)) : 0;
  return "█".repeat(len) + "░".repeat(width - len);
}

function gradeColor(grade: string): string {
  return grade === "A" ? "roi-high" : grade === "B" ? "conf-high" : grade === "C" ? "conf-estimated" : "roi-low";
}

/**
 * Renders a horizontal stacked bar: useful (green) | wasted (red) | untracked (gray).
 * widthPx is the total bar width in pixels.
 */
function stackedTokenBar(useful: number, wasted: number, total: number, widthPx = 200): string {
  if (total <= 0) return "";
  const usefulPct = Math.round((useful / total) * 100);
  const wastedPct = Math.round((wasted / total) * 100);
  const untrackedPct = 100 - usefulPct - wastedPct;
  return `<div style="display:flex;width:${widthPx}px;height:10px;border-radius:3px;overflow:hidden;margin:4px 0" title="Useful: ${usefulPct}% | Wasted: ${wastedPct}% | Untracked: ${untrackedPct}%">
    <div style="flex:${usefulPct};background:var(--vscode-charts-green,#4CAF50)"></div>
    <div style="flex:${wastedPct};background:var(--vscode-charts-red,#F44336)"></div>
    <div style="flex:${untrackedPct};background:var(--vscode-editorGhostText-foreground,#666);opacity:.4"></div>
  </div>`;
}

export function formatEfficiencyPanelHtml(metrics: EfficiencyMetrics): string {
  const hasSkills = metrics.costPerSkill.length > 0;
  const hasAgents = metrics.costPerAgent.length > 0;
  const hasSessions = metrics.recentSessions.length > 0;
  const hasMcp = metrics.mcp.totalCalls > 0;

  if (!hasSkills && !hasAgents && !hasSessions && !hasMcp) {
    return "";
  }

  const parts: string[] = [];
  const m = metrics.mcp;

  // -- Efficiency score banner (only when MCP data exists) --
  let scoreBanner = "";
  if (hasMcp) {
    const sc = m.efficiencyScore;
    const totalIssues =
      m.wasteWarnings.length + m.readAfterWrite.length + m.agentLoops.length + m.largeFiles.length;
    const issueText =
      totalIssues > 0
        ? `${totalIssues} issue(s): ${[
            m.wasteWarnings.length > 0 && "repeated reads",
            m.readAfterWrite.length > 0 && "read-after-write",
            m.agentLoops.length > 0 && "agent loops",
            m.largeFiles.length > 0 && "large files",
          ]
            .filter(Boolean)
            .join(", ")}`
        : "No issues detected";
    const totalSavedTokens = m.suggestions.reduce((s, sg) => s + (sg.estimatedSavedTokens ?? 0), 0);
    const dollarSavingsText = totalSavedTokens > 0
      ? `~$${(totalSavedTokens / 1_000_000 * 3).toFixed(3)} saveable`
      : "";
    const savingsPill = dollarSavingsText
      ? `<div class="stat-pill"><b>Potential saving</b><span class="val roi-high">${esc(dollarSavingsText)}</span></div>`
      : "";
    scoreBanner = `
  <div class="stat-grid" style="margin-bottom:10px">
    <div class="stat-pill" title="Efficiency = (useful ops) / (total ops). Useful = total − redundant reads − read-after-writes − loop reads − no-op writes.">
      <b>Efficiency</b>
      <span class="val ${esc(gradeColor(sc.grade))}">${sc.score}% (${esc(sc.grade)})</span>
    </div>
    <div class="stat-pill"><b>MCP calls</b><span class="val">${m.totalCalls}</span></div>
    <div class="stat-pill"><b>Wasteful ops</b><span class="val">${sc.wastefulOps}</span></div>
    <div class="stat-pill"><b>Tokens read</b><span class="val">${esc(formatTokenCount(metrics.mcpFileTokens))}</span></div>
    ${savingsPill}
  </div>
  <p class="note" style="margin-top:0">${esc(issueText)}</p>`;
  }

  // -- Token KPI panel --
  if (hasMcp && m.totalEstimatedTokens > 0) {
    const totalMcp = m.totalEstimatedTokens;
    const wasted = m.totalWastedTokens;
    const useful = Math.max(0, totalMcp - wasted);
    const wastedPct = Math.round((wasted / totalMcp) * 100);
    const usefulPct = 100 - wastedPct;
    const wastedUsd = (wasted / 1_000_000 * 3).toFixed(3);
    const totalApiTokens = metrics.recentSessions.reduce((s, r) => s + r.totalTokens, 0);
    const apiCompareLine = totalApiTokens > 0
      ? `<div class="hint" style="margin-top:2px">MCP waste = ${Math.round((wasted / totalApiTokens) * 100)}% of total API tokens in last 14d sessions</div>`
      : "";
    parts.push(`<div class="sub-panel" style="grid-column: 1 / -1">
      <h3>Token quality · MCP reads</h3>
      <div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap">
        <div>
          ${stackedTokenBar(useful, wasted, totalMcp, 220)}
          <div style="display:flex;gap:12px;font-size:11px;margin-top:2px">
            <span><span style="color:var(--vscode-charts-green,#4CAF50)">■</span> Useful ${esc(formatTokenCount(useful))} (${usefulPct}%)</span>
            <span><span style="color:var(--vscode-charts-red,#F44336)">■</span> Wasted ${esc(formatTokenCount(wasted))} (${wastedPct}%)</span>
          </div>
          ${apiCompareLine}
        </div>
        <div class="stat-grid" style="margin:0">
          <div class="stat-pill"><b>Total MCP reads</b><span class="val">${esc(formatTokenCount(totalMcp))}</span></div>
          <div class="stat-pill"><b>Wasted</b><span class="val roi-low">${esc(formatTokenCount(wasted))}</span></div>
          <div class="stat-pill"><b>Cost of waste</b><span class="val roi-low">~$${esc(wastedUsd)}</span></div>
        </div>
      </div>
    </div>`);
  }

  // -- Cost per skill run --
  if (hasSkills) {
    const maxAvg = metrics.costPerSkill[0].avgCostPerRun;
    const rows = metrics.costPerSkill
      .slice(0, 6)
      .map(
        (r) => `<div class="skill-row">
          <div class="skill-head"><b>${esc(r.skill)}</b>
            <span class="cost">${esc(formatCompactUsd(r.avgCostPerRun))}/run</span>
            <span class="bar">${miniBar(r.avgCostPerRun, maxAvg)}</span>
          </div>
          <div class="hint">${r.totalRuns} run(s) · ${esc(formatCompactUsd(r.totalCost))} total</div>
        </div>`
      )
      .join("");
    parts.push(`<div class="sub-panel"><h3>Cost per skill run</h3>${rows}</div>`);
  }

  // -- Cost per agent --
  if (hasAgents) {
    const maxCost = metrics.costPerAgent[0].totalCost;
    const rows = metrics.costPerAgent
      .map(
        (r) => `<div class="skill-row">
          <div class="skill-head"><b>${esc(r.agent)}</b>
            <span class="cost">${esc(formatCompactUsd(r.totalCost))}</span>
            <span class="bar">${miniBar(r.totalCost, maxCost)}</span>
          </div>
          <div class="hint">${r.totalRuns} run(s) · avg ${esc(formatCompactUsd(r.avgCostPerRun))}/run</div>
        </div>`
      )
      .join("");
    parts.push(`<div class="sub-panel"><h3>Cost per agent</h3>${rows}</div>`);
  }

  // -- Cost per session (task) --
  if (hasSessions) {
    const maxCost = Math.max(...metrics.recentSessions.map((s) => s.totalCost), 0.000001);
    const rows = metrics.recentSessions
      .map((s) => {
        const date = new Date(s.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
        const skillSummary =
          s.skills.slice(0, 3).join(", ") + (s.skills.length > 3 ? ` +${s.skills.length - 3}` : "");
        return `<div class="skill-row">
          <div class="skill-head"><span class="agent-id">${esc(s.sessionId.slice(0, 8))}…</span>
            <span>${esc(date)}</span>
            <span class="cost">${esc(formatCompactUsd(s.totalCost))}</span>
            <span class="bar">${miniBar(s.totalCost, maxCost)}</span>
          </div>
          <div class="hint">${esc(formatTokenCount(s.totalTokens))} tokens${skillSummary ? ` · ${esc(skillSummary)}` : ""}</div>
        </div>`;
      })
      .join("");
    parts.push(`<div class="sub-panel"><h3>Cost per task (session)</h3>${rows}</div>`);
  }

  // -- Cost per file (MCP access) --
  if (hasMcp && m.topFiles.length > 0) {
    const maxCalls = m.topFiles[0].calls;
    const fileRows = m.topFiles
      .map(
        (f) => `<div class="skill-row">
          <div class="skill-head"><code>${esc(f.path.length > 55 ? "…" + f.path.slice(-52) : f.path)}</code>
            <span class="cost">${f.calls}×</span>
            <span class="bar">${miniBar(f.calls, maxCalls)}</span>
          </div>
          <div class="hint">~${esc(formatTokenCount(f.estimatedTokens))} tokens · avg ${f.avgDurationMs}ms</div>
        </div>`
      )
      .join("");
    parts.push(`<div class="sub-panel"><h3>Cost per file (MCP reads)</h3>${fileRows}</div>`);
  }

  // -- Warnings section --
  const warningBlocks: string[] = [];

  if (m.wasteWarnings.length > 0) {
    const rows = m.wasteWarnings
      .map(
        (w) => `<div class="skill-row warn-row">
          <div class="skill-head"><span>⚠</span> <code>${esc(w.path.length > 45 ? "…" + w.path.slice(-42) : w.path)}</code></div>
          <div class="hint">${esc(w.description)}</div>
        </div>`
      )
      .join("");
    warningBlocks.push(`<div style="margin-bottom:8px"><b>Repeated reads</b>${rows}</div>`);
  }

  if (m.agentLoops.length > 0) {
    const rows = m.agentLoops
      .map(
        (l) => `<div class="skill-row warn-row">
          <div class="skill-head"><span>🔁</span> <code>${esc(l.path.length > 45 ? "…" + l.path.slice(-42) : l.path)}</code>
            <span class="cost">~${esc(formatTokenCount(l.estimatedWastedTokens))} wasted</span>
          </div>
          <div class="hint">${esc(l.description)}</div>
        </div>`
      )
      .join("");
    warningBlocks.push(`<div style="margin-bottom:8px"><b>Agent loops</b>${rows}</div>`);
  }

  if (m.readAfterWrite.length > 0) {
    const rows = m.readAfterWrite
      .map(
        (r) => `<div class="skill-row warn-row">
          <div class="skill-head"><span>⚠</span> <code>${esc(r.path.length > 45 ? "…" + r.path.slice(-42) : r.path)}</code></div>
          <div class="hint">${esc(r.description)}</div>
        </div>`
      )
      .join("");
    warningBlocks.push(`<div style="margin-bottom:8px"><b>Read-after-write</b>${rows}</div>`);
  }

  if (m.largeFiles.length > 0) {
    const rows = m.largeFiles
      .map(
        (f) => `<div class="skill-row warn-row">
          <div class="skill-head"><span>⚠</span> <code>${esc(f.path.length > 45 ? "…" + f.path.slice(-42) : f.path)}</code>
            <span class="cost">${Math.round(f.bytes / 1024)}KB</span>
          </div>
          <div class="hint">${esc(f.suggestion)}</div>
        </div>`
      )
      .join("");
    warningBlocks.push(`<div style="margin-bottom:8px"><b>Large files</b>${rows}</div>`);
  }

  if (m.noOpWrites.length > 0) {
    const rows = m.noOpWrites
      .map(
        (n) => `<div class="skill-row">
          <div class="skill-head"><span>✓</span> <code>${esc(n.path.length > 45 ? "…" + n.path.slice(-42) : n.path)}</code></div>
          <div class="hint">${esc(n.description)}</div>
        </div>`
      )
      .join("");
    warningBlocks.push(`<div style="margin-bottom:8px"><b>No-op writes (auto-skipped)</b>${rows}</div>`);
  }

  // -- Suggestions --
  const suggRows = m.suggestions
    .map((s) => {
      const saving = s.estimatedSavedTokens
        ? ` — saves ~${esc(formatTokenCount(s.estimatedSavedTokens))} tokens`
        : "";
      return `<li>${esc(s.description)}${saving}</li>`;
    })
    .join("");

  const warningsHtml =
    warningBlocks.length > 0
      ? `<div class="sub-panel" style="grid-column: 1 / -1">
          <h3>Waste detected</h3>
          ${warningBlocks.join("")}
          ${suggRows ? `<div style="margin-top:6px"><b>Suggestions</b><ul style="margin-top:4px">${suggRows}</ul></div>` : ""}
        </div>`
      : suggRows
        ? `<div class="sub-panel" style="grid-column: 1 / -1"><h3>Suggestions</h3><ul>${suggRows}</ul></div>`
        : "";

  const cs = metrics.crossSession;
  const crossSessionHtml =
    cs.persistentHotFiles.length > 0
      ? `<div class="sub-panel" style="grid-column: 1 / -1">
          <h3>Persistently over-read files · 30d · ${cs.totalSessions} session(s)</h3>
          ${cs.persistentHotFiles
            .slice(0, 6)
            .map(
              (f) => `<div class="skill-row warn-row">
                <div class="skill-head">
                  <code>${esc(f.path.length > 50 ? "…" + f.path.slice(-47) : f.path)}</code>
                  <span class="cost">${Math.round(f.prevalence * 100)}% of sessions</span>
                </div>
                <div class="hint">${f.sessionCount}/${f.totalSessions} sessions · avg ${f.readsPerSession}× per session</div>
              </div>`
            )
            .join("")}
          <p class="note" style="margin-top:4px">These files are global hot spots — add them to mcp-agent-hints.md permanent cache rules.</p>
        </div>`
      : "";

  return `<div class="panel">
  <h2>Efficiency metrics · 14d</h2>
  ${scoreBanner}
  <div class="efficiency-grid">
    ${parts.join("\n    ")}
    ${warningsHtml}
    ${crossSessionHtml}
  </div>
  <p class="note" style="margin-top:8px">Costs from runs.jsonl hooks. MCP file-access patterns from <code>~/.claude/learning/mcp-usage.jsonl</code>. Hints written to <code>~/.claude/learning/mcp-agent-hints.md</code>. Estimates only.</p>
</div>`;
}
