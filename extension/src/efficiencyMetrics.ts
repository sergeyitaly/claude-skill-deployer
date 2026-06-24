import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readEnrichedRuns } from "./usageStats";
import { readCachedEnrichedRuns } from "./runsStore";
import { summarizeSkillCostsFromRuns } from "./skillCostFromRuns";

// Hints are written at most once every 30 s to avoid redundant file I/O when the
// dashboard is opened repeatedly in quick succession (e.g. during a task).
const HINTS_WRITE_MIN_INTERVAL_MS = 30_000;
let lastHintsWriteMs = 0;
import {
  summarizeMcpUsage,
  summarizeCrossSessionPatterns,
  writeMcpHints,
  appendCliPatternHints,
  analyzeCliPatterns,
  readMcpUsageLog,
  workspaceMcpLogPath,
  computeCliKpi,
  McpUsageSummary,
  CrossSessionSummary,
  CliKpi,
  GRADE_THRESHOLDS,
} from "./mcpUsageLog";
import { formatCompactUsd } from "./skillCost";
import { formatTokenCount } from "./usageStats";
import { encodeWorkspacePath } from "./workspaceTranscripts";

// ---------------------------------------------------------------------------
// HACE — Human-AI Collaboration Efficiency (moved from haceMetrics.ts)
// ---------------------------------------------------------------------------

export interface HaceTurn {
  humanTs:      number;
  responseTs:   number;
  responseSecs: number;
  promptChars:  number;
  outputTokens: number;
  hasThinking:  boolean;
  isCorrection: boolean;
}

export interface HaceMetrics {
  noData:                 boolean;
  sessions:               number;
  totalTurns:             number;
  avgResponseSecs:        number;
  thinkingRate:           number;
  correctionRate:         number;
  turnsPerMinute:         number;
  promptClarityScore:     number;
  taskVelocityScore:      number;
  accuracyScore:          number;
  cliEfficiencyScore:     number;
  /** HACE 2.0: average session duration in minutes (time-to-resolution proxy). */
  avgSessionMinutes:      number;
  /** HACE 2.0: % of sessions with ≥1 skill invocation. */
  skillAugmentedPct:      number;
  /** HACE 2.0: skill leverage score (0–100). */
  skillLeverageScore:     number;
  /** HACE 2.0: resolution velocity score (0–100) derived from avg TTR vs 30-min target. */
  resolutionVelocityScore: number;
  haceScore:              number;
  grade:                  string;
}

interface RawEntry {
  type?:       string;
  timestamp?:  string;
  uuid?:       string;
  requestId?:  string;
  message?: {
    role?:    string;
    content?: Array<{ type: string; text?: string; thinking?: string }>;
    usage?:   { output_tokens?: number };
  };
}

function sessionFilesForWorkspace(target: string, cutoffMs: number): string[] {
  const root = path.join(os.homedir(), ".claude", "projects");
  const encoded = encodeWorkspacePath(target).toLowerCase();
  const projectDir = path.join(root, encoded);
  try {
    return fs.readdirSync(projectDir)
      .filter(f => f.endsWith(".jsonl"))
      .map(f => path.join(projectDir, f))
      .filter(f => { try { return fs.statSync(f).mtimeMs >= cutoffMs; } catch { return false; } });
  } catch {
    try {
      const dirs = fs.readdirSync(root, { withFileTypes: true });
      const match = dirs.find(d => d.isDirectory() && d.name.toLowerCase() === encoded);
      if (!match) return [];
      const pd = path.join(root, match.name);
      return fs.readdirSync(pd)
        .filter(f => f.endsWith(".jsonl"))
        .map(f => path.join(pd, f))
        .filter(f => { try { return fs.statSync(f).mtimeMs >= cutoffMs; } catch { return false; } });
    } catch { return []; }
  }
}

const CORRECTION_MAX_CHARS  = 80;
const CORRECTION_MIN_TOKENS = 250;
const MAX_RESPONSE_SECS     = 300;
const VELOCITY_TARGET       = 2.0;

function parseSessionFile(filePath: string): HaceTurn[] {
  let lines: string[];
  try { lines = fs.readFileSync(filePath, "utf-8").split("\n"); }
  catch { return []; }
  const turns: HaceTurn[] = [];
  let humanTs = 0, promptChars = 0, responseTs = 0, outputTokens = 0, hasThinking = false;
  const seenReqIds = new Set<string>();
  let prevOutputTokens = 0;
  function commitTurn() {
    if (humanTs === 0 || responseTs === 0) return;
    const secs = Math.min((responseTs - humanTs) / 1000, MAX_RESPONSE_SECS);
    if (secs < 0) return;
    const isCorrection = promptChars < CORRECTION_MAX_CHARS && prevOutputTokens > CORRECTION_MIN_TOKENS;
    turns.push({ humanTs, responseTs, responseSecs: secs, promptChars, outputTokens, hasThinking, isCorrection });
    prevOutputTokens = outputTokens;
    humanTs = 0; promptChars = 0; responseTs = 0; outputTokens = 0; hasThinking = false;
    seenReqIds.clear();
  }
  for (const raw of lines) {
    if (!raw.trim()) continue;
    let e: RawEntry;
    try { e = JSON.parse(raw) as RawEntry; } catch { continue; }
    const ts = e.timestamp ? Date.parse(e.timestamp) : 0;
    if (!ts) continue;
    if (e.type === "user" && e.message?.role === "user") {
      const content = e.message.content ?? [];
      if (!content.some(c => c.type === "tool_result")) {
        const chars = content.reduce((n, c) => n + (c.text?.length ?? 0), 0);
        if (chars > 0) { commitTurn(); humanTs = ts; promptChars = chars; }
      }
    }
    if (e.type === "assistant" && e.message?.role === "assistant" && humanTs > 0) {
      if (responseTs === 0) responseTs = ts;
      const reqId = e.requestId ?? e.uuid ?? "";
      if (!seenReqIds.has(reqId)) {
        seenReqIds.add(reqId);
        const usage = e.message.usage;
        if (usage?.output_tokens) outputTokens = Math.max(outputTokens, usage.output_tokens);
      }
      if (!hasThinking && e.message.content?.some(c => c.type === "thinking")) hasThinking = true;
    }
  }
  commitTurn();
  return turns;
}

function haceClamp(v: number): number { return Math.max(0, Math.min(100, Math.round(v))); }
function haceGrade(score: number): string {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

export function computeHaceMetrics(
  target: string,
  cliSuccessRate: number,
  daysBack = 14,
): HaceMetrics {
  const cutoffMs = Date.now() - daysBack * 86_400_000;
  const files = sessionFilesForWorkspace(target, cutoffMs);
  const allTurns: HaceTurn[] = [];
  const sessionDurations: number[] = [];
  for (const f of files) {
    const turns = parseSessionFile(f);
    if (turns.length === 0) continue;
    allTurns.push(...turns);
    const first = turns[0].humanTs;
    const last  = turns[turns.length - 1].responseTs;
    if (last > first) sessionDurations.push((last - first) / 60_000);
  }
  const TARGET_TTR_MIN = 30; // target time-to-resolution in minutes

  if (allTurns.length === 0) {
    return { noData: true, sessions: 0, totalTurns: 0, avgResponseSecs: 0, thinkingRate: 0,
      correctionRate: 0, turnsPerMinute: 0, promptClarityScore: 0, taskVelocityScore: 0,
      accuracyScore: 0, cliEfficiencyScore: haceClamp(cliSuccessRate),
      avgSessionMinutes: 0, skillAugmentedPct: 0, skillLeverageScore: 0,
      resolutionVelocityScore: 0, haceScore: 0, grade: "—" };
  }

  const n = allTurns.length;
  const thinkingTurns   = allTurns.filter(t => t.hasThinking).length;
  const correctionTurns = allTurns.filter(t => t.isCorrection).length;
  const totalResponseSec = allTurns.reduce((s, t) => s + t.responseSecs, 0);
  const totalDurMin     = sessionDurations.reduce((s, d) => s + d, 0);
  const thinkingRate    = thinkingTurns / n;
  const correctionRate  = correctionTurns / n;
  const avgResponseSecs = totalResponseSec / n;
  const turnsPerMinute  = totalDurMin > 0 ? n / totalDurMin : 0;
  const avgSessionMinutes = sessionDurations.length > 0 ? totalDurMin / sessionDurations.length : 0;

  // HACE 2.0: Skill Leverage — check how many sessions had skill invocations.
  let skillAugmentedSessions = 0;
  let totalSkillInvocations = 0;
  try {
    const runs = readCachedEnrichedRuns(target);
    const sessionIds = new Set(files.map(f => path.basename(f, ".jsonl")));
    const skillSessionIds = new Set(runs.filter(r => r.metadata?.invoked).map(r => r.session_id));
    totalSkillInvocations = runs.filter(r => r.metadata?.invoked).length;
    for (const sid of sessionIds) { if (skillSessionIds.has(sid)) skillAugmentedSessions++; }
  } catch { /* non-fatal — degrade gracefully */ }
  const skillAugmentedPct  = files.length > 0 ? Math.round((skillAugmentedSessions / files.length) * 100) : 0;
  const skillLeverageScore = haceClamp(Math.min(totalSkillInvocations / Math.max(n, 1) * 10, 1) * 100);

  const promptClarityScore    = haceClamp((1 - thinkingRate) * 100);
  const taskVelocityScore     = haceClamp(Math.min(turnsPerMinute / VELOCITY_TARGET, 1) * 100);
  const accuracyScore         = haceClamp((1 - correctionRate) * 100);
  const cliEfficiencyScore    = haceClamp(cliSuccessRate);
  const resolutionVelocityScore = avgSessionMinutes > 0
    ? haceClamp(Math.max(0, 1 - avgSessionMinutes / TARGET_TTR_MIN) * 100)
    : 0;

  // HACE 2.0 composite: 25% clarity + 20% velocity + 20% accuracy + 15% CLI + 10% resolution + 10% skill leverage
  const haceScore = haceClamp(
    0.25 * promptClarityScore    +
    0.20 * taskVelocityScore     +
    0.20 * accuracyScore         +
    0.15 * cliEfficiencyScore    +
    0.10 * resolutionVelocityScore +
    0.10 * skillLeverageScore
  );

  // Persist session record for trend analysis.
  appendHaceSession(target, {
    haceScore, avgSessionMinutes, skillAugmentedPct,
    promptClarityScore, taskVelocityScore, accuracyScore,
    cliEfficiencyScore, resolutionVelocityScore, skillLeverageScore,
    sessions: files.length, turns: n, corrections: correctionTurns,
  });

  return { noData: false, sessions: files.length, totalTurns: n, avgResponseSecs, thinkingRate,
    correctionRate, turnsPerMinute, promptClarityScore, taskVelocityScore, accuracyScore,
    cliEfficiencyScore, avgSessionMinutes, skillAugmentedPct, skillLeverageScore,
    resolutionVelocityScore, haceScore, grade: haceGrade(haceScore) };
}

// ── HACE session persistence ──────────────────────────────────────────────────

function appendHaceSession(target: string, record: Record<string, number | string>): void {
  const file = path.join(target, ".claude", "learning", "hace-sessions.jsonl");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n", "utf-8");
  } catch { /* non-fatal */ }
}

function workspaceMcpLog(target: string): string {
  return workspaceMcpLogPath(target);
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
  /** CLI KPI: success rate, retries, duration percentiles across all CLI MCP calls. */
  cliKpi: CliKpi;
  /** Human-AI Collaboration Efficiency score derived from session transcripts. */
  hace: HaceMetrics;
}

export function computeEfficiencyMetrics(
  target: string,
  daysBack = 14
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

  const wsLogPath = workspaceMcpLog(target);
  const mcp = summarizeMcpUsage(daysBack, wsLogPath);
  const crossSession = summarizeCrossSessionPatterns(30, wsLogPath);

  // Write auto-remediation hints at most once per 30 s — avoids redundant file I/O
  // when the dashboard is opened repeatedly or on every cost-pipeline tick.
  // Read log entries once for both CLI KPI and hint writing.  The logCache in
  // readMcpUsageLog makes the second call a no-op when summarizeMcpUsage already
  const allEntries = mcp.totalCalls > 0 ? readMcpUsageLog(wsLogPath) : [];

  // Pre-filter to the same daysBack window used by summarizeMcpUsage so
  // computeCliKpi can skip its own date-parse pass (daysBack: 0 = no re-filter).
  const cutoffMs = Date.now() - daysBack * 86_400_000;
  const windowEntries = allEntries.filter((e) => Date.parse(e.ts) >= cutoffMs);
  const cliKpi = computeCliKpi(windowEntries, 0);

  if (mcp.totalCalls > 0) {
    const now = Date.now();
    if (now - lastHintsWriteMs >= HINTS_WRITE_MIN_INTERVAL_MS) {
      lastHintsWriteMs = now;
      writeMcpHints(mcp);
      appendCliPatternHints(analyzeCliPatterns(allEntries));
    }
  }

  let hace: HaceMetrics;
  try {
    hace = computeHaceMetrics(target, cliKpi.overallSuccessRate, daysBack);
  } catch {
    hace = { noData: true, sessions: 0, totalTurns: 0, avgResponseSecs: 0, thinkingRate: 0, correctionRate: 0, turnsPerMinute: 0, promptClarityScore: 0, taskVelocityScore: 0, accuracyScore: 0, cliEfficiencyScore: 0, avgSessionMinutes: 0, skillAugmentedPct: 0, skillLeverageScore: 0, resolutionVelocityScore: 0, haceScore: 0, grade: "—" };
  }

  return {
    costPerSkill,
    costPerAgent,
    recentSessions,
    mcp,
    mcpFileTokens: mcp.totalEstimatedTokens,
    crossSession,
    cliKpi,
    hace,
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
    if (m.excessiveScans.length > 0) {
      lines.push("  Excessive directory scans:");
      for (const sc of m.excessiveScans) lines.push(`    ⚠ ${sc.description} — ${sc.path}`);
    }
    if (m.suggestions.length > 0) {
      lines.push("  Suggestions:");
      for (const s of m.suggestions) {
        const saving = s.estimatedSavedTokens ? `  ~${formatTokenCount(s.estimatedSavedTokens)} tokens saved` : "";
        lines.push(`    → ${s.description}${saving}`);
      }
    }
  }

  const cli = metrics.cliKpi;
  if (cli.totalCalls > 0) {
    const nd = cli.notEnoughData ? " (not enough data yet)" : "";
    lines.push(`\n### CLI KPI: ${cli.overallSuccessRate}% success (${cli.grade})${nd}  —  ${cli.totalCalls} call(s)`);
    if (cli.totalFailures > 0) {
      const recLine = cli.overallRecoveryRate !== null
        ? `  Recovery Rate: ${cli.overallRecoveryRate}%  (${cli.totalRecoveries}/${cli.totalFailures} failures self-corrected)`
        : "";
      lines.push(`  Failures: ${cli.totalFailures}  Retries: ${cli.totalRetries}  Timeouts: ${cli.totalTimedOut}`);
      if (recLine) lines.push(recLine);
    }
    for (const c of cli.byCli) {
      const flags: string[] = [];
      if (c.failureCount > 0) flags.push(`${c.failureCount} fail`);
      if (c.recoveryRate !== null) flags.push(`🔄 ${c.recoveryRate}% recovery`);
      if (c.retryCount > 0) flags.push(`${c.retryCount} retry`);
      if (c.timedOutCount > 0) flags.push(`${c.timedOutCount} timeout`);
      const dur = c.totalCalls >= 3 ? `  P50 ${c.durationP50}ms / P95 ${c.durationP95}ms` : "";
      lines.push(`  ${c.cli.padEnd(14)} ${String(c.successRate).padStart(3)}%  ${c.totalCalls} call(s)${flags.length ? "  (" + flags.join(", ") + ")" : ""}${dur}`);
    }
    if (cli.mostFailingCli) lines.push(`  Most failing: ${cli.mostFailingCli} — check credentials, connectivity, allow-list`);
  }

  const h = metrics.hace;
  if (!h.noData) {
    lines.push(`\n### Session Efficiency (HACE 2.0): ${h.haceScore}/100 (${h.grade})  —  ${h.totalTurns} turn(s) across ${h.sessions} session(s)`);
    lines.push(`  Prompt Clarity       ${h.promptClarityScore}%  (thinking rate: ${Math.round(h.thinkingRate * 100)}%)`);
    lines.push(`  Task Velocity        ${h.taskVelocityScore}%  (${h.turnsPerMinute.toFixed(1)} turns/min)`);
    lines.push(`  Accuracy             ${h.accuracyScore}%  (correction rate: ${Math.round(h.correctionRate * 100)}%)`);
    lines.push(`  CLI Efficiency       ${h.cliEfficiencyScore}%`);
    lines.push(`  Resolution Velocity  ${h.resolutionVelocityScore}%  (avg TTR ${h.avgSessionMinutes.toFixed(0)} min, target 30)`);
    lines.push(`  Skill Leverage       ${h.skillLeverageScore}%  (${h.skillAugmentedPct}% sessions skill-augmented)`);
    lines.push(`  Avg response         ${h.avgResponseSecs.toFixed(1)}s`);
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

function buildMcpWarningBlocks(m: McpUsageSummary): string[] {
  const shortPath = (p: string, max: number) => p.length > max ? "…" + p.slice(-(max - 3)) : p;
  const blocks: string[] = [];

  if (m.wasteWarnings.length > 0) {
    const rows = m.wasteWarnings.map((w) =>
      `<div class="skill-row warn-row"><div class="skill-head"><span>⚠</span> <code>${esc(shortPath(w.path, 45))}</code></div><div class="hint">${esc(w.description)}</div></div>`
    ).join("");
    blocks.push(`<div style="margin-bottom:8px"><b>Repeated reads</b>${rows}</div>`);
  }
  if (m.agentLoops.length > 0) {
    const rows = m.agentLoops.map((l) =>
      `<div class="skill-row warn-row"><div class="skill-head"><span>🔁</span> <code>${esc(shortPath(l.path, 45))}</code><span class="cost">~${esc(formatTokenCount(l.estimatedWastedTokens))} wasted</span></div><div class="hint">${esc(l.description)}</div></div>`
    ).join("");
    blocks.push(`<div style="margin-bottom:8px"><b>Agent loops</b>${rows}</div>`);
  }
  if (m.readAfterWrite.length > 0) {
    const rows = m.readAfterWrite.map((r) =>
      `<div class="skill-row warn-row"><div class="skill-head"><span>⚠</span> <code>${esc(shortPath(r.path, 45))}</code></div><div class="hint">${esc(r.description)}</div></div>`
    ).join("");
    blocks.push(`<div style="margin-bottom:8px"><b>Read-after-write</b>${rows}</div>`);
  }
  if (m.largeFiles.length > 0) {
    const rows = m.largeFiles.map((f) =>
      `<div class="skill-row warn-row"><div class="skill-head"><span>⚠</span> <code>${esc(shortPath(f.path, 45))}</code><span class="cost">${Math.round(f.bytes / 1024)}KB</span></div><div class="hint">${esc(f.suggestion)}</div></div>`
    ).join("");
    blocks.push(`<div style="margin-bottom:8px"><b>Large files</b>${rows}</div>`);
  }
  if (m.excessiveScans.length > 0) {
    const rows = m.excessiveScans.map((sc) =>
      `<div class="skill-row warn-row"><div class="skill-head"><span>⚠</span> <code>${esc(shortPath(sc.path, 45))}</code><span class="cost">${sc.scans}× scanned</span></div><div class="hint">${esc(sc.description)}</div></div>`
    ).join("");
    blocks.push(`<div style="margin-bottom:8px"><b>Excessive directory scans</b>${rows}</div>`);
  }
  return blocks;
}

function buildMcpSuccessBlocks(m: McpUsageSummary): string[] {
  const shortPath = (p: string, max: number) => p.length > max ? "…" + p.slice(-(max - 3)) : p;
  const blocks: string[] = [];
  if (m.noOpWrites.length > 0) {
    const rows = m.noOpWrites.map((n) =>
      `<div class="skill-row"><div class="skill-head"><span>✓</span> <code>${esc(shortPath(n.path, 45))}</code></div><div class="hint">${esc(n.description)}</div></div>`
    ).join("");
    blocks.push(`<div style="margin-bottom:8px">${rows}</div>`);
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// CLI KPI panel
// ---------------------------------------------------------------------------

function buildHacePanelHtml(h: HaceMetrics): string {
  if (h.noData) {
    return `<div class="sub-panel" style="grid-column: 1 / -1">
    <h3>Session Efficiency (HACE 2.0)</h3>
    <p class="note">No parseable session turns yet — HACE analyses <code>~/.claude/projects/</code> transcripts and activates after the first session with actual user prompts. CLI Efficiency (${h.cliEfficiencyScore}%) is already tracked.</p>
    <div class="stat-grid">
      <div class="stat-pill"><b>CLI Efficiency</b><span class="val ${h.cliEfficiencyScore >= 80 ? "roi-high" : h.cliEfficiencyScore >= 60 ? "conf-estimated" : "roi-low"}">${h.cliEfficiencyScore}%</span></div>
      <div class="stat-pill"><b>Prompt Clarity</b><span class="val">—</span></div>
      <div class="stat-pill"><b>Task Velocity</b><span class="val">—</span></div>
      <div class="stat-pill"><b>Accuracy Rate</b><span class="val">—</span></div>
      <div class="stat-pill"><b>Skill Leverage</b><span class="val">—</span></div>
    </div>
  </div>`;
  }

  const gradeClass = h.haceScore >= 85 ? "roi-high"
    : h.haceScore >= 70 ? "conf-high"
    : h.haceScore >= 55 ? "conf-estimated"
    : "roi-low";

  function componentRow(label: string, score: number, detail: string): string {
    return `<div class="skill-row">
      <div class="skill-head">
        <span>${esc(label)}</span>
        <span class="cost ${score >= 70 ? "roi-high" : score >= 50 ? "conf-estimated" : "roi-low"}">${score}%</span>
        <span class="bar">${miniBar(score, 100)}</span>
      </div>
      <div class="hint">${esc(detail)}</div>
    </div>`;
  }

  const rows = [
    componentRow("Prompt Clarity",      h.promptClarityScore,
      `${Math.round(h.thinkingRate * 100)}% of turns triggered extended thinking — lower = clearer prompts`),
    componentRow("Task Velocity",       h.taskVelocityScore,
      `${h.turnsPerMinute.toFixed(1)} turns/min — target ≥ 2.0`),
    componentRow("Accuracy Rate",       h.accuracyScore,
      `${Math.round(h.correctionRate * 100)}% correction turns (short re-prompts after long responses)`),
    componentRow("CLI Efficiency",      h.cliEfficiencyScore,
      "CLI exit-code success rate from terminal-watch telemetry"),
    componentRow("Resolution Velocity", h.resolutionVelocityScore,
      `avg session ${h.avgSessionMinutes.toFixed(0)} min — target ≤ 30 min`),
    componentRow("Skill Leverage",      h.skillLeverageScore,
      `${h.skillAugmentedPct}% of sessions used ≥1 skill${h.skillLeverageScore < 20 ? " ← LOW" : ""}`),
  ].join("\n");

  const ttrPill = h.avgSessionMinutes > 0
    ? `<span class="stat-pill" title="Avg session duration (time-to-resolution proxy)">TTR ${h.avgSessionMinutes.toFixed(0)} min</span>`
    : "";
  const skillPill = `<span class="stat-pill ${h.skillAugmentedPct >= 25 ? "conf-high" : "roi-low"}" title="${h.skillAugmentedPct}% of sessions had ≥1 skill invocation">${h.skillAugmentedPct}% skill-augmented</span>`;

  return `<div class="sub-panel" style="grid-column: 1 / -1">
    <h3>Session Efficiency (HACE 2.0)</h3>
    <div style="margin-bottom:6px">
      <span class="stat-pill ${gradeClass}" title="Composite: 25% clarity · 20% velocity · 20% accuracy · 15% CLI · 10% TTR · 10% skill leverage">${h.haceScore}/100 · ${h.grade}</span>
      <span class="stat-pill conf-estimated" title="Sessions analysed">${h.sessions} session${h.sessions !== 1 ? "s" : ""}</span>
      <span class="stat-pill conf-estimated" title="Total conversation turns">${h.totalTurns} turn${h.totalTurns !== 1 ? "s" : ""}</span>
      <span class="stat-pill" title="Average wall-clock seconds from user message to first assistant token">avg ${h.avgResponseSecs.toFixed(1)}s response</span>
      ${ttrPill}
      ${skillPill}
    </div>
    ${rows}
    <p class="note" style="margin-top:4px">Derived from session transcripts in <code>~/.claude/projects/</code>. Prompt Clarity: fewer thinking blocks = clearer prompts. Accuracy: short follow-ups after long responses signal corrections. Skill Leverage: sessions where you invoked a skill.</p>
  </div>`;
}

function buildCliKpiPanelHtml(kpi: CliKpi): string {
  if (kpi.totalCalls === 0) return "";

  const gradeClass = gradeColor(kpi.grade);
  const gradeLabel = kpi.notEnoughData
    ? `${kpi.overallSuccessRate}% (${kpi.grade}) — not enough data yet`
    : `${kpi.overallSuccessRate}% (${kpi.grade})`;

  const recoveryPill = kpi.totalFailures > 0 && kpi.overallRecoveryRate !== null
    ? `<span class="stat-pill ${kpi.overallRecoveryRate >= 75 ? "roi-high" : kpi.overallRecoveryRate >= 50 ? "conf-estimated" : "roi-low"}" title="% of failures where the agent corrected itself within 30s — a positive signal">🔄 ${kpi.overallRecoveryRate}% recovery</span>`
    : "";

  const summaryPills = [
    `<span class="stat-pill" title="Total CLI invocations">${kpi.totalCalls} call${kpi.totalCalls !== 1 ? "s" : ""}</span>`,
    kpi.totalFailures > 0
      ? `<span class="stat-pill roi-low" title="Calls that exited non-zero">⚠ ${kpi.totalFailures} failure${kpi.totalFailures !== 1 ? "s" : ""}</span>`
      : `<span class="stat-pill roi-high" title="No failures recorded">✅ 0 failures</span>`,
    recoveryPill,
    kpi.totalRetries > 0
      ? `<span class="stat-pill conf-estimated" title="Calls made within 30s of a failure in the same session">${kpi.totalRetries} retr${kpi.totalRetries !== 1 ? "ies" : "y"}</span>`
      : "",
    kpi.totalTimedOut > 0
      ? `<span class="stat-pill roi-low" title="Commands killed by timeout">${kpi.totalTimedOut} timeout${kpi.totalTimedOut !== 1 ? "s" : ""}</span>`
      : "",
  ].filter(Boolean).join(" ");

  const maxCalls = Math.max(...kpi.byCli.map((c) => c.totalCalls), 1);
  const rows = kpi.byCli.map((c) => {
    const rateClass = c.successRate >= GRADE_THRESHOLDS.A ? "roi-high"
      : c.successRate >= GRADE_THRESHOLDS.B ? "conf-high"
      : c.successRate >= GRADE_THRESHOLDS.C ? "conf-estimated"
      : "roi-low";
    const retryNote = c.retryCount > 0 ? ` · ${c.retryCount} retr${c.retryCount !== 1 ? "ies" : "y"}` : "";
    const recoveryNote = c.recoveryRate !== null
      ? ` · 🔄 ${c.recoveryRate}% recovery`
      : "";
    const timeoutNote = c.timedOutCount > 0 ? ` · ${c.timedOutCount} timeout${c.timedOutCount !== 1 ? "s" : ""}` : "";
    const durNote = c.totalCalls >= 3
      ? ` · P50 ${c.durationP50 < 1000 ? `${c.durationP50}ms` : `${(c.durationP50 / 1000).toFixed(1)}s`} / P95 ${c.durationP95 < 1000 ? `${c.durationP95}ms` : `${(c.durationP95 / 1000).toFixed(1)}s`}`
      : "";
    return `<div class="skill-row">
      <div class="skill-head">
        <code>${esc(c.cli)}</code>
        <span class="cost ${rateClass}">${c.successRate}%</span>
        <span class="bar">${miniBar(c.totalCalls, maxCalls)}</span>
      </div>
      <div class="hint">${c.totalCalls} call${c.totalCalls !== 1 ? "s" : ""}${retryNote}${recoveryNote}${timeoutNote}${durNote}</div>
    </div>`;
  }).join("");

  return `<div class="sub-panel" style="grid-column: 1 / -1">
    <h3>CLI efficiency · ${kpi.totalCalls} call${kpi.totalCalls !== 1 ? "s" : ""}</h3>
    <div style="margin-bottom:6px">
      <span class="stat-pill ${gradeClass}" title="CLI success rate (exitCode === 0)">${gradeLabel}</span>
      ${summaryPills}
    </div>
    ${rows}
    ${kpi.mostFailingCli ? `<p class="note" style="margin-top:4px">Most failures: <code>${esc(kpi.mostFailingCli)}</code> — check credentials, connectivity, and allow-list.</p>` : ""}
  </div>`;
}

function buildScoreBannerHtml(m: McpUsageSummary, mcpFileTokens: number): string {
  const sc = m.efficiencyScore;
  const issueLabels = [
    m.wasteWarnings.length > 0 && "repeated reads",
    m.readAfterWrite.length > 0 && "read-after-write",
    m.agentLoops.length > 0 && "agent loops",
    m.largeFiles.length > 0 && "large files",
    m.excessiveScans.length > 0 && "excessive scans",
  ].filter(Boolean);
  const issueText = issueLabels.length > 0
    ? `${issueLabels.length} issue(s): ${issueLabels.join(", ")}`
    : "No issues detected";
  const totalSavedTokens = m.suggestions.reduce((s, sg) => s + (sg.estimatedSavedTokens ?? 0), 0);
  const savingsPill = totalSavedTokens > 0
    ? `<div class="stat-pill"><b>Potential saving</b><span class="val roi-high">~$${(totalSavedTokens / 1_000_000 * 3).toFixed(3)} saveable</span></div>`
    : "";
  return `
  <div class="stat-grid" style="margin-bottom:10px">
    <div class="stat-pill" title="MCP Ops Efficiency = (useful ops) / (total ops). Useful = total − redundant reads − read-after-writes − loop reads − no-op writes.">
      <b>MCP Ops Efficiency</b>
      <span class="val ${esc(gradeColor(sc.grade))}">${sc.score}% (${esc(sc.grade)})</span>
    </div>
    <div class="stat-pill"><b>MCP calls</b><span class="val">${m.totalCalls}</span></div>
    <div class="stat-pill"><b>Wasteful ops</b><span class="val">${sc.wastefulOps}</span></div>
    <div class="stat-pill"><b>Tokens read</b><span class="val">${esc(formatTokenCount(mcpFileTokens))}</span></div>
    ${savingsPill}
  </div>
  <p class="note" style="margin-top:0">${esc(issueText)}</p>`;
}

function buildTokenKpiPanelHtml(m: McpUsageSummary, totalApiTokens: number): string {
  const totalMcp = m.totalEstimatedTokens;
  const wasted = m.totalWastedTokens;
  const useful = Math.max(0, totalMcp - wasted);
  const wastedPct = Math.round((wasted / totalMcp) * 100);
  const wastedUsd = (wasted / 1_000_000 * 3).toFixed(3);
  const apiCompareLine = totalApiTokens > 0
    ? `<div class="hint" style="margin-top:2px">MCP waste = ${Math.round((wasted / totalApiTokens) * 100)}% of total API tokens in last 14d sessions</div>`
    : "";
  return `<div class="sub-panel" style="grid-column: 1 / -1">
    <h3>Token quality · MCP reads</h3>
    <div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap">
      <div>
        ${stackedTokenBar(useful, wasted, totalMcp, 220)}
        <div style="display:flex;gap:12px;font-size:11px;margin-top:2px">
          <span><span style="color:var(--vscode-charts-green,#4CAF50)">■</span> Useful ${esc(formatTokenCount(useful))} (${100 - wastedPct}%)</span>
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
  </div>`;
}

function buildCostPanelsHtml(metrics: EfficiencyMetrics, m: McpUsageSummary): string[] {
  const panels: string[] = [];
  if (metrics.costPerSkill.length > 0) {
    const maxAvg = metrics.costPerSkill[0].avgCostPerRun;
    const rows = metrics.costPerSkill.slice(0, 6).map((r) =>
      `<div class="skill-row"><div class="skill-head"><b>${esc(r.skill)}</b><span class="cost">${esc(formatCompactUsd(r.avgCostPerRun))}/run</span><span class="bar">${miniBar(r.avgCostPerRun, maxAvg)}</span></div><div class="hint">${r.totalRuns} run(s) · ${esc(formatCompactUsd(r.totalCost))} total</div></div>`
    ).join("");
    panels.push(`<div class="sub-panel"><h3>Cost per skill run</h3>${rows}</div>`);
  }
  if (metrics.costPerAgent.length > 0) {
    const maxCost = metrics.costPerAgent[0].totalCost;
    const rows = metrics.costPerAgent.map((r) =>
      `<div class="skill-row"><div class="skill-head"><b>${esc(r.agent)}</b><span class="cost">${esc(formatCompactUsd(r.totalCost))}</span><span class="bar">${miniBar(r.totalCost, maxCost)}</span></div><div class="hint">${r.totalRuns} run(s) · avg ${esc(formatCompactUsd(r.avgCostPerRun))}/run</div></div>`
    ).join("");
    panels.push(`<div class="sub-panel"><h3>Cost per agent</h3>${rows}</div>`);
  }
  if (metrics.recentSessions.length > 0) {
    const maxCost = Math.max(...metrics.recentSessions.map((s) => s.totalCost), 0.000001);
    const rows = metrics.recentSessions.map((s) => {
      const date = new Date(s.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      const skillSummary = s.skills.slice(0, 3).join(", ") + (s.skills.length > 3 ? ` +${s.skills.length - 3}` : "");
      const skillSuffix = skillSummary ? " · " + esc(skillSummary) : "";
      return `<div class="skill-row"><div class="skill-head"><span class="agent-id">${esc(s.sessionId.slice(0, 8))}…</span><span>${esc(date)}</span><span class="cost">${esc(formatCompactUsd(s.totalCost))}</span><span class="bar">${miniBar(s.totalCost, maxCost)}</span></div><div class="hint">${esc(formatTokenCount(s.totalTokens))} tokens${skillSuffix}</div></div>`;
    }).join("");
    panels.push(`<div class="sub-panel"><h3>Cost per task (session)</h3>${rows}</div>`);
  }
  if (m.topFiles.length > 0) {
    const maxCalls = m.topFiles[0].calls;
    const rows = m.topFiles.map((f) =>
      `<div class="skill-row"><div class="skill-head"><code>${esc(f.path.length > 55 ? "…" + f.path.slice(-52) : f.path)}</code><span class="cost">${f.calls}×</span><span class="bar">${miniBar(f.calls, maxCalls)}</span></div><div class="hint">~${esc(formatTokenCount(f.estimatedTokens))} tokens · avg ${f.avgDurationMs}ms</div></div>`
    ).join("");
    panels.push(`<div class="sub-panel"><h3>Cost per file (MCP reads)</h3>${rows}</div>`);
  }
  return panels;
}

export function formatEfficiencyPanelHtml(metrics: EfficiencyMetrics): string {
  const hasMcp = metrics.mcp.totalCalls > 0;
  if (!metrics.costPerSkill.length && !metrics.costPerAgent.length && !metrics.recentSessions.length && !hasMcp && metrics.hace.noData) {
    return "";
  }

  const m = metrics.mcp;
  const cs = metrics.crossSession;
  const scoreBanner = hasMcp ? buildScoreBannerHtml(m, metrics.mcpFileTokens) : "";
  const totalApiTokens = metrics.recentSessions.reduce((s, r) => s + r.totalTokens, 0);

  // Show the auto-fix button only when there are fixable issues worth persisting.
  const hasFixableIssues = hasMcp && (
    m.wasteWarnings.length > 0 ||
    m.excessiveScans.length > 0 ||
    m.largeFiles.length > 0 ||
    cs.persistentHotFiles.length > 0 ||
    cs.persistentNoOpWrites.length > 0
  );

  const parts: string[] = [];
  if (hasMcp && m.totalEstimatedTokens > 0) {
    parts.push(buildTokenKpiPanelHtml(m, totalApiTokens));
  }
  parts.push(...buildCostPanelsHtml(metrics, m));

  // -- Warnings section --
  const warningBlocks = buildMcpWarningBlocks(m);
  const successBlocks = buildMcpSuccessBlocks(m);

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

  const successHtml =
    successBlocks.length > 0
      ? `<div class="sub-panel" style="grid-column: 1 / -1">
          <h3>Auto-optimized</h3>
          ${successBlocks.join("")}
        </div>`
      : "";

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
          <p class="note" style="margin-top:4px">These files are global hot spots — click <b>Apply auto-fixes</b> to add permanent cache rules.</p>
        </div>`
      : "";

  const noOpWritesHtml =
    cs.persistentNoOpWrites.length > 0
      ? `<div class="sub-panel" style="grid-column: 1 / -1">
          <h3>Persistent no-op writes · 30d · ${cs.totalSessions} session(s)</h3>
          ${cs.persistentNoOpWrites
            .slice(0, 6)
            .map(
              (f) => `<div class="skill-row warn-row">
                <div class="skill-head">
                  <code>${esc(f.path.length > 50 ? "…" + f.path.slice(-47) : f.path)}</code>
                  <span class="cost">${Math.round(f.prevalence * 100)}% of sessions</span>
                </div>
                <div class="hint">${f.sessionCount}/${f.totalSessions} sessions · avg ${f.skipsPerSession}× skipped per session — agent rewrites identical content</div>
              </div>`
            )
            .join("")}
          <p class="note" style="margin-top:4px">Agent is rewriting these files with unchanged content — click <b>Apply auto-fixes</b> to add permanent cache rules.</p>
        </div>`
      : "";

  const cliKpiHtml  = buildCliKpiPanelHtml(metrics.cliKpi);
  const haceHtml    = buildHacePanelHtml(metrics.hace);

  return `<div class="panel">
  <h2>Efficiency metrics · 14d</h2>
  ${scoreBanner}
  <div class="efficiency-grid">
    ${parts.join("\n    ")}
    ${warningsHtml}
    ${successHtml}
    ${crossSessionHtml}
    ${noOpWritesHtml}
    ${cliKpiHtml}
    ${haceHtml}
  </div>
  <p class="note" style="margin-top:8px">Costs from runs.jsonl hooks. MCP file-access patterns from <code>~/.claude/learning/mcp-usage.jsonl</code>. Hints written to <code>~/.claude/learning/mcp-agent-hints.md</code>. Estimates only.</p>
  <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
    ${hasFixableIssues ? `<button id="btn-apply-mcp-autofixes" class="action-btn" title="Write permanent cache rules to mcp-agent-hints.md for all detected hot files and directories — agents will respect them at next session start">Apply auto-fixes to hints</button>` : ""}
    <button id="btn-clear-mcp-logs" class="action-btn secondary">Clear MCP Logs</button>
  </div>
</div>`;
}

