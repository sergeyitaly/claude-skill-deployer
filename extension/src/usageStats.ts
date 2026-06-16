import * as fs from "node:fs";
import * as path from "node:path";
import { SkillAttributionMap } from "./costAttribution";
import { detectRelevantSkills, Manifest } from "./skillOps";
import { CreditUsageSummary, creditUsageCostLabel, formatModelLabel, modelCostCellLabel } from "./usageCost";
import { EnrichedRunRecord, isUsageBreakdownRun, isUsageRunRecord, normalizeRunRecord, RunAgent } from "./runRecording";
import { readCachedEnrichedRuns } from "./learningStateIndex";
import { WorkspaceHookStatus } from "./hookOps";
import { formatHookStatusBannerHtml } from "./workspaceHookStatus";
import { formatConfidenceBadge, SkillCostConfidence, WorkspaceConfidence } from "./attributionConfidence";
import { buildGlobalTrustBadge, buildSkillTrustLine, formatGlobalTrustBannerHtml, formatSkillTrustHtml, GlobalTrustBadge } from "./attributionTrust";
import { DASHBOARD_USAGE_EXTRA_STYLES, wrapDashboardHtml } from "./dashboardStyles";
import { computeSkillInefficiencyStats, SkillInefficiencyStat } from "./skillFeedback";
import { resolveTaskSkillProposals, TaskSkillProposal, readTaskSkillProposals } from "./taskSkillProposals";
import { formatOutdatedSkillsLines, SkillVersionStatus } from "./skillLifecycle";
import { computeSkillRoi } from "./skillRoi";

export type { RunAgent, SkillInefficiencyStat, TaskSkillProposal };

export interface RunRecord {
  ts: string;
  timestamp?: string;
  skill: string;
  action: string;
  rc: number;
  duration?: number;
  error?: string;
  hint?: string;
  note?: string;
  tokens?: number;
  cost?: number;
  success?: boolean;
  session_id?: string;
  project?: string;
  branch?: string | null;
  metadata?: Record<string, unknown>;
  /** Optional — which agent ran this skill (defaults to claude in attribution). */
  agent?: RunAgent;
}

export type UsageRating = "active" | "needs-attention" | "low-usage" | "unused";

export interface SkillUsageStat {
  name: string;
  runs: number;
  successCount: number;
  failureCount: number;
  successRate: number | null;
  avgDuration: number | null;
  lastUsed: string | null;
  daysSinceLastUse: number | null;
  totalTokens: number | null;
  /** Runs per agent when recorded in runs.jsonl. */
  agentRuns?: Partial<Record<RunAgent, number>>;
  /** Token totals per agent from runs.jsonl rows. */
  agentTokens?: Partial<Record<RunAgent, number>>;
  rating: UsageRating;
  /** Sum of normalized `cost` from runs.jsonl hook/self-learning rows. */
  totalCost?: number | null;
  /** Average cost per run when totalCost is known. */
  avgCostUsd?: number | null;
  /** Runs priced from API usage breakdown (input/output/cache). */
  measuredRuns?: number;
}

export interface SuggestedSkill {
  name: string;
  description: string;
  matchedGlobs: string[];
}

const LEARNING_DIR_RELATIVE = path.join(".claude", "learning");
const RUNS_LOG_RELATIVE = path.join(LEARNING_DIR_RELATIVE, "runs.jsonl");

/** Ensures <target>/.claude/learning exists so the self-learning skill has a
 * place to write run records. Returns true if the directory was created. */
export function ensureLearningDir(target: string): boolean {
  const dir = path.join(target, LEARNING_DIR_RELATIVE);
  if (fs.existsSync(dir)) {
    return false;
  }
  fs.mkdirSync(dir, { recursive: true });
  return true;
}

/** Reads and parses .claude/learning/runs.jsonl (written by the self-learning
 * skill). Malformed lines are skipped. Returns [] if the file doesn't exist. */
export function readRunRecords(target: string): RunRecord[] {
  return readEnrichedRuns(target).map((r) => ({
    ts: r.ts,
    timestamp: r.timestamp,
    skill: r.skill,
    action: r.action,
    rc: r.rc,
    duration: r.duration,
    error: r.error,
    hint: r.hint,
    note: r.note,
    tokens: r.tokens,
    cost: r.cost,
    success: r.success,
    session_id: r.session_id,
    project: r.project,
    branch: r.branch ?? undefined,
    metadata: r.metadata,
    agent: r.agent,
  }));
}

/** Normalized runs with attribution fields (agent, session_id, cost, etc.). */
export function readEnrichedRuns(target: string): EnrichedRunRecord[] {
  return readCachedEnrichedRuns(target);
}

/** Names of skills installed in <target>/.claude/skills/. */
export function listInstalledSkills(target: string): string[] {
  const dir = path.join(target, ".claude", "skills");
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
}

function rate(stat: Omit<SkillUsageStat, "rating">): SkillUsageStat {
  let rating: UsageRating;

  if (stat.runs === 0) {
    rating = "unused";
  } else if (stat.runs >= 3 && (stat.successRate ?? 100) < 60) {
    rating = "needs-attention";
  } else if (stat.runs >= 2 && stat.daysSinceLastUse !== null && stat.daysSinceLastUse <= 30) {
    rating = "active";
  } else {
    rating = "low-usage";
  }

  return { ...stat, rating };
}

function lastUsedInfo(recs: RunRecord[], now: number): { lastUsed: string | null; daysSinceLastUse: number | null } {
  let lastUsed: string | null = null;
  for (const r of recs) {
    if (!lastUsed || new Date(r.ts).getTime() > new Date(lastUsed).getTime()) {
      lastUsed = r.ts;
    }
  }
  const daysSinceLastUse = lastUsed ? Math.floor((now - new Date(lastUsed).getTime()) / (1000 * 60 * 60 * 24)) : null;
  return { lastUsed, daysSinceLastUse };
}

function statForSkill(name: string, recs: RunRecord[], now: number): SkillUsageStat {
  const runs = recs.length;
  const successCount = recs.filter((r) => r.rc === 0).length;
  const failureCount = runs - successCount;
  const successRate = runs > 0 ? (successCount / runs) * 100 : null;

  const durations = recs.map((r) => r.duration).filter((d): d is number => typeof d === "number");
  const avgDuration = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null;

  const tokenVals = recs.map((r) => r.tokens).filter((t): t is number => typeof t === "number");
  const totalTokens = tokenVals.length > 0 ? tokenVals.reduce((a, b) => a + b, 0) : null;

  let totalCost = 0;
  let costRows = 0;
  let measuredRuns = 0;
  for (const rec of recs) {
    if (typeof rec.cost === "number" && rec.cost > 0) {
      totalCost += rec.cost;
      costRows += 1;
    }
    if (isUsageBreakdownRun(rec)) {
      measuredRuns += 1;
    }
  }

  const agentRuns: Partial<Record<RunAgent, number>> = {};
  const agentTokens: Partial<Record<RunAgent, number>> = {};
  for (const rec of recs) {
    const agent = rec.agent ?? "claude";
    agentRuns[agent] = (agentRuns[agent] ?? 0) + 1;
    if (typeof rec.tokens === "number") {
      agentTokens[agent] = (agentTokens[agent] ?? 0) + rec.tokens;
    }
  }

  const { lastUsed, daysSinceLastUse } = lastUsedInfo(recs, now);

  return rate({
    name,
    runs,
    successCount,
    failureCount,
    successRate,
    avgDuration,
    lastUsed,
    daysSinceLastUse,
    totalTokens,
    totalCost: costRows > 0 ? totalCost : null,
    avgCostUsd: costRows > 0 && runs > 0 ? totalCost / runs : null,
    measuredRuns: measuredRuns > 0 ? measuredRuns : undefined,
    agentRuns: Object.keys(agentRuns).length > 0 ? agentRuns : undefined,
    agentTokens: Object.keys(agentTokens).length > 0 ? agentTokens : undefined,
  });
}

/** Aggregates .claude/learning/runs.jsonl entries per known skill (manifest
 * keys), plus any installed skill with zero matching records ("unused"). */
export function computeUsageStats(target: string, manifest: Manifest): SkillUsageStat[] {
  const records = readRunRecords(target).filter(isUsageRunRecord);
  const installed = new Set(listInstalledSkills(target));
  const knownSkills = new Set(Object.keys(manifest.skills));

  const byName = new Map<string, RunRecord[]>();
  for (const rec of records) {
    if (!knownSkills.has(rec.skill)) {
      continue;
    }
    const list = byName.get(rec.skill) ?? [];
    list.push(rec);
    byName.set(rec.skill, list);
  }

  const names = new Set<string>([...installed, ...byName.keys()]);
  const now = Date.now();

  const stats = [...names].map((name) => statForSkill(name, byName.get(name) ?? [], now));
  stats.sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));
  return stats;
}

function formatAgentCell(
  agentRuns: Partial<Record<RunAgent, number>> | undefined,
  agentTokens: Partial<Record<RunAgent, number>> | undefined,
  agent: RunAgent
): string {
  const runs = agentRuns?.[agent];
  const tokens = agentTokens?.[agent];
  if (!runs && !(typeof tokens === "number" && tokens > 0)) {
    return "-";
  }
  if (typeof runs === "number" && runs > 0 && typeof tokens === "number" && tokens > 0) {
    return `${runs} (${formatTokenCount(tokens)})`;
  }
  if (typeof runs === "number" && runs > 0) {
    return `${runs}`;
  }
  return formatTokenCount(tokens ?? null);
}

/** Compact per-agent breakdown for tables, e.g. "Cursor IDE:2, Claude Code:1". */
export function formatAgentBreakdown(
  agentRuns?: Partial<Record<RunAgent, number>>,
  agentTokens?: Partial<Record<RunAgent, number>>
): string {
  const agents = agentsWithRecordedRuns(agentRuns);
  const tokenAgents = agentTokens
    ? RUN_AGENT_ORDER.filter((agent) => (agentTokens[agent] ?? 0) > 0)
    : [];
  const merged = [...new Set([...agents, ...tokenAgents])].sort(
    (a, b) => RUN_AGENT_ORDER.indexOf(a) - RUN_AGENT_ORDER.indexOf(b)
  );
  if (merged.length === 0) {
    return "-";
  }
  return merged
    .map((agent) => `${runAgentLabel(agent)}:${formatAgentCell(agentRuns, agentTokens, agent)}`)
    .join(", ");
}

function tokensForSkillInAttribution(skill: string, attribution: SkillAttributionMap): number {
  const entry = attribution[skill];
  if (!entry) {
    return 0;
  }
  return Object.values(entry).reduce((sum, a) => sum + (a?.tokens ?? 0), 0);
}

export const RUN_AGENT_ORDER: RunAgent[] = ["claude", "cursor", "kiro", "copilot"];

const RUN_AGENT_LABELS: Record<RunAgent, string> = {
  claude: "Claude Code",
  cursor: "Cursor IDE",
  kiro: "Kiro IDE",
  copilot: "VS Code (Copilot)",
};

export function runAgentLabel(agent: RunAgent): string {
  return RUN_AGENT_LABELS[agent] ?? agent;
}

export interface AgentUsageTotals {
  agent: RunAgent;
  runs: number;
  skillCount: number;
  tokens: number;
}

export interface MultiAgentSkillUsage {
  name: string;
  totalRuns: number;
  agentRuns: Partial<Record<RunAgent, number>>;
  agentTokens?: Partial<Record<RunAgent, number>>;
  agents: RunAgent[];
}

export interface CrossAgentUsageSummary {
  byAgent: AgentUsageTotals[];
  multiAgentSkills: MultiAgentSkillUsage[];
  activeAgents: RunAgent[];
}

function agentsWithRecordedRuns(agentRuns?: Partial<Record<RunAgent, number>>): RunAgent[] {
  if (!agentRuns) {
    return [];
  }
  return RUN_AGENT_ORDER.filter((agent) => (agentRuns[agent] ?? 0) > 0);
}

function agentsWithUsage(
  agentRuns?: Partial<Record<RunAgent, number>>,
  agentTokens?: Partial<Record<RunAgent, number>>
): RunAgent[] {
  return RUN_AGENT_ORDER.filter(
    (agent) => (agentRuns?.[agent] ?? 0) > 0 || (agentTokens?.[agent] ?? 0) > 0
  );
}

function invocationCountForAgent(
  agent: RunAgent,
  agentRuns?: Partial<Record<RunAgent, number>>,
  agentTokens?: Partial<Record<RunAgent, number>>
): number {
  const runs = agentRuns?.[agent];
  if (typeof runs === "number" && runs > 0) {
    return runs;
  }
  return (agentTokens?.[agent] ?? 0) > 0 ? 1 : 0;
}

/** Totals per agent and skills invoked by more than one agent on the same workspace. */
export function computeCrossAgentUsage(stats: SkillUsageStat[]): CrossAgentUsageSummary {
  const byAgentMap = new Map<RunAgent, { runs: number; skills: Set<string>; tokens: number }>();
  for (const agent of RUN_AGENT_ORDER) {
    byAgentMap.set(agent, { runs: 0, skills: new Set(), tokens: 0 });
  }

  const multiAgentSkills: MultiAgentSkillUsage[] = [];

  for (const stat of stats) {
    if (stat.runs === 0) {
      continue;
    }
    const agents = agentsWithUsage(stat.agentRuns, stat.agentTokens);
    if (agents.length === 0) {
      continue;
    }
    for (const agent of agents) {
      const bucket = byAgentMap.get(agent)!;
      const runs = invocationCountForAgent(agent, stat.agentRuns, stat.agentTokens);
      bucket.runs += runs;
      bucket.skills.add(stat.name);
      bucket.tokens += stat.agentTokens?.[agent] ?? 0;
    }
    if (agents.length >= 2) {
      multiAgentSkills.push({
        name: stat.name,
        totalRuns: stat.runs,
        agentRuns: stat.agentRuns ?? {},
        agentTokens: stat.agentTokens,
        agents,
      });
    }
  }

  multiAgentSkills.sort(
    (a, b) => b.agents.length - a.agents.length || b.totalRuns - a.totalRuns || a.name.localeCompare(b.name)
  );

  const byAgent = RUN_AGENT_ORDER.map((agent) => {
    const bucket = byAgentMap.get(agent)!;
    return { agent, runs: bucket.runs, skillCount: bucket.skills.size, tokens: bucket.tokens };
  }).filter((row) => row.runs > 0 || row.tokens > 0);

  return { byAgent, multiAgentSkills, activeAgents: byAgent.map((row) => row.agent) };
}

function mergeAgentBreakdownFromAttribution(
  stat: SkillUsageStat,
  attribution: SkillAttributionMap
): Pick<SkillUsageStat, "agentRuns" | "agentTokens"> {
  const entry = attribution[stat.name];
  if (!entry) {
    return { agentRuns: stat.agentRuns, agentTokens: stat.agentTokens };
  }

  const agentRuns: Partial<Record<RunAgent, number>> = { ...(stat.agentRuns ?? {}) };
  const agentTokens: Partial<Record<RunAgent, number>> = { ...(stat.agentTokens ?? {}) };

  for (const [agentId, data] of Object.entries(entry)) {
    if (!data) {
      continue;
    }
    const agent = agentId as RunAgent;
    if (typeof data.tokens === "number" && data.tokens > 0 && !agentTokens[agent]) {
      agentTokens[agent] = data.tokens;
    }
    if (!agentRuns[agent]) {
      if (typeof data.sessions === "number" && data.sessions > 0) {
        agentRuns[agent] = data.sessions;
      } else if (typeof data.tokens === "number" && data.tokens > 0) {
        agentRuns[agent] = 1;
      }
    }
  }

  return {
    agentRuns: Object.keys(agentRuns).length > 0 ? agentRuns : undefined,
    agentTokens: Object.keys(agentTokens).length > 0 ? agentTokens : undefined,
  };
}

/** Fill per-skill token totals and per-agent breakdown from cost attribution when runs.jsonl rows lack them. */
export function enrichUsageStatsWithAttribution(
  stats: SkillUsageStat[],
  attribution: SkillAttributionMap
): SkillUsageStat[] {
  return stats.map((s) => {
    if (s.runs === 0) {
      return s;
    }
    const fromRuns = s.totalTokens ?? 0;
    const fromAttribution = tokensForSkillInAttribution(s.name, attribution);
    const totalTokens = fromRuns > 0 ? fromRuns : fromAttribution > 0 ? fromAttribution : null;
    const agentBreakdown = mergeAgentBreakdownFromAttribution(s, attribution);
    const changed =
      totalTokens !== s.totalTokens ||
      agentBreakdown.agentRuns !== s.agentRuns ||
      agentBreakdown.agentTokens !== s.agentTokens;
    return changed ? { ...s, totalTokens, ...agentBreakdown } : s;
  });
}

/** Skills relevant to this workspace (by manifest detect_globs) that aren't
 * installed in <target>/.claude/skills yet - candidates that could help. */
export function computeSuggestedSkills(target: string, manifest: Manifest): SuggestedSkill[] {
  const detected = detectRelevantSkills(target, manifest);
  const installed = new Set(listInstalledSkills(target));
  return Object.entries(detected)
    .filter(([name]) => !installed.has(name))
    .map(([name, matchedGlobs]) => ({
      name,
      description: manifest.skills[name].description,
      matchedGlobs,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function formatRecency(days: number | null): string {
  if (days === null) {
    return "-";
  }
  if (days === 0) {
    return "today";
  }
  return days === 1 ? "1d ago" : `${days}d ago`;
}

/** Compact token count, e.g. 1234 -> "1.2k", 1500000 -> "1.5M". */
export function formatTokenCount(n: number | null): string {
  if (n === null) {
    return "-";
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }
  return `${n}`;
}

function formatCost(usd: number): string {
  if (usd < 0.01 && usd > 0) {
    return "<$0.01";
  }
  return `$${usd.toFixed(2)}`;
}

const RATING_LABEL: Record<UsageRating, string> = {
  active: "Active",
  "needs-attention": "Needs attention",
  "low-usage": "Low usage",
  unused: "Unused",
};

function tallyRatings(stats: SkillUsageStat[]): Record<UsageRating, number> {
  const counts: Record<UsageRating, number> = { active: 0, "needs-attention": 0, "low-usage": 0, unused: 0 };
  for (const s of stats) {
    counts[s.rating]++;
  }
  return counts;
}

function summaryLine(stats: SkillUsageStat[], suggested: SuggestedSkill[], counts: Record<UsageRating, number>): string {
  const parts: string[] = [];
  if (stats.length > 0) {
    parts.push(
      `${stats.length} installed (${counts.active} active, ${counts["low-usage"]} low-usage, ${counts.unused} unused, ${counts["needs-attention"]} needs attention)`
    );
  }
  if (suggested.length > 0) {
    parts.push(`${suggested.length} suggested`);
  }
  return parts.join(" - ");
}

function inefficiencyLines(stats: SkillInefficiencyStat[]): string[] {
  if (stats.length === 0) {
    return [];
  }
  const lines = ["## Inefficient skills (user feedback)", ""];
  for (const s of stats) {
    lines.push(
      `- **${s.name}**: ${s.inefficiencyPct}% inefficiency (${s.negativeCount} negative reaction(s)) — ${s.updateSuggestion}`
    );
  }
  lines.push("");
  return lines;
}

function taskProposalLines(proposals: TaskSkillProposal[]): string[] {
  if (proposals.length === 0) {
    return [];
  }
  const lines = ["## Proposed for current task", ""];
  for (const p of proposals.slice(0, 8)) {
    const installed = p.installed ? "installed" : "not installed";
    lines.push(`- **${p.name}** (${p.confidence}% · ${installed}) — ${p.reason}`);
  }
  lines.push("");
  lines.push("_Local-only: proposals are not committed or shared with teammates._");
  lines.push("");
  return lines;
}

function misusedLines(stats: SkillUsageStat[]): string[] {
  const misused = stats.filter((s) => s.rating === "needs-attention");
  if (misused.length === 0) {
    return [];
  }
  const lines = ["## Misused (failing often)", ""];
  for (const s of misused) {
    lines.push(
      `- **${s.name}**: ${Math.round(s.successRate ?? 0)}% success over ${s.runs} runs - check \`.claude/learning/patterns.md\` for recurring errors.`
    );
  }
  lines.push("");
  return lines;
}

function suggestedLines(suggested: SuggestedSkill[]): string[] {
  if (suggested.length === 0) {
    return [];
  }
  const lines = ["## Could help with this workspace", ""];
  for (const s of suggested) {
    lines.push(`- **${s.name}** - ${s.description} (matches ${s.matchedGlobs.join(", ")})`);
  }
  lines.push("");
  return lines;
}

function removalLines(stats: SkillUsageStat[]): string[] {
  const removal = stats.filter((s) => s.rating === "unused" || s.rating === "low-usage");
  if (removal.length === 0) {
    return [];
  }
  const lines = ["## Removal candidates", ""];
  for (const s of removal) {
    const detail = s.runs === 0 ? "never used" : `${s.runs} run(s), last used ${formatRecency(s.daysSinceLastUse)}`;
    lines.push(`- ${s.name} - ${detail}`);
  }
  lines.push(
    "",
    "Delete `.claude/skills/<name>/` if no longer needed, or ask the `skill-usage-insights` skill for a fuller analysis.",
    ""
  );
  return lines;
}

function outdatedLines(statuses: SkillVersionStatus[]): string[] {
  return formatOutdatedSkillsLines(statuses);
}

function htmlOutdatedSection(statuses: SkillVersionStatus[]): string {
  const outdated = statuses.filter((s) => s.outdated);
  const deprecated = statuses.filter((s) => s.deprecated);
  if (outdated.length === 0 && deprecated.length === 0) {
    return "";
  }
  const items = outdated
    .map(
      (s) =>
        `<li><b>${escapeHtml(s.name)}</b> <span class="badge outdated">${escapeHtml(s.installedVersion)} → ${escapeHtml(s.catalogVersion)}</span>${s.changelog ? ` — ${escapeHtml(s.changelog)}` : ""}</li>`
    )
    .join("\n");
  const depItems = deprecated
    .map((s) => `<li><b>${escapeHtml(s.name)}</b> <span class="badge needs-attention">deprecated</span></li>`)
    .join("\n");
  const upgradeNote =
    outdated.length > 0
      ? `<div class="note">Run <b>Claude Skills: Upgrade Outdated Skills</b> to reinstall from the library.</div>`
      : "";
  return `<div class="panel"><h2>Skill lifecycle</h2>${outdated.length ? `<ul>${items}</ul>` : ""}${deprecated.length ? `<h3 class="subhead">Deprecated</h3><ul>${depItems}</ul>` : ""}${upgradeNote}</div>`;
}

/** Short markdown bullets for weekly report and other summaries. */
export function formatCrossAgentUsageBrief(stats: SkillUsageStat[]): string[] {
  const cross = computeCrossAgentUsage(stats);
  if (cross.byAgent.length === 0) {
    return [];
  }

  const lines = [
    "### Skill invocations by agent (hooks)",
    "",
    ...cross.byAgent.map(
      (row) =>
        `- **${runAgentLabel(row.agent)}**: ${row.runs} invocation(s), ${row.skillCount} distinct skill(s), ${formatTokenCount(row.tokens)} tokens`
    ),
  ];

  if (cross.multiAgentSkills.length > 0) {
    lines.push("", "**Same skill across multiple agents:**");
    for (const skill of cross.multiAgentSkills.slice(0, 8)) {
      const parts = cross.activeAgents
        .map((agent) => {
          const cell = formatAgentCell(skill.agentRuns, skill.agentTokens, agent);
          return cell === "-" ? null : `${runAgentLabel(agent)} ${cell}`;
        })
        .filter((part): part is string => part !== null);
      lines.push(`- **${skill.name}**: ${parts.join(", ")}`);
    }
  }

  lines.push("");
  return lines;
}

function crossAgentUsageLines(stats: SkillUsageStat[]): string[] {
  const cross = computeCrossAgentUsage(stats);
  if (cross.byAgent.length === 0) {
    return [
      "## Skill usage by agent",
      "",
      "No per-agent skill invocations recorded yet. Install **skill-invoke** hooks for Claude Code, Cursor, Kiro, and Copilot so the same task across IDEs is tracked separately in `runs.jsonl`.",
      "",
    ];
  }

  const lines = [
    "## Skill usage by agent",
    "",
    "Totals when you work on one task with Claude Code, Cursor, Kiro, or Copilot.",
    "",
    "| Agent | Invocations | Distinct skills | Tokens |",
    "|---|---:|---:|---:|",
  ];
  for (const row of cross.byAgent) {
    lines.push(
      `| ${runAgentLabel(row.agent)} | ${row.runs} | ${row.skillCount} | ${formatTokenCount(row.tokens)} |`
    );
  }

  if (cross.multiAgentSkills.length > 0) {
    lines.push("", "### Same skill across multiple agents", "");
    const agentCols = cross.activeAgents;
    lines.push(`| Skill | Total runs | ${agentCols.map(runAgentLabel).join(" | ")} |`);
    lines.push(`|---|---:|${agentCols.map(() => "---:").join("|")}|`);
    for (const skill of cross.multiAgentSkills) {
      const cells = agentCols.map((agent) => formatAgentCell(skill.agentRuns, skill.agentTokens, agent));
      lines.push(`| ${skill.name} | ${skill.totalRuns} | ${cells.join(" | ")} |`);
    }
  } else if (cross.byAgent.length > 1) {
    lines.push("", "No single skill has been invoked by more than one agent yet in this workspace.");
  }

  lines.push(
    "",
    "Per-agent columns use `runs.jsonl` (skill-invoke hooks). Token cells may include cost-attribution data when hook rows lack tokens.",
    ""
  );
  return lines;
}

function htmlCrossAgentSection(stats: SkillUsageStat[]): string {
  const cross = computeCrossAgentUsage(stats);
  if (cross.byAgent.length === 0) {
    return `<div class="panel"><h2>Skill usage by agent</h2><p class="note">No per-agent invocations yet. Install skill-invoke hooks for Claude Code, Cursor, Kiro, and Copilot so the same task across IDEs is tracked separately.</p></div>`;
  }

  const agentPills = cross.byAgent
    .map(
      (row) =>
        `<div class="stat-pill"><b>${escapeHtml(runAgentLabel(row.agent))}</b><span class="val">${row.runs} run(s) · ${row.skillCount} skill(s) · ${formatTokenCount(row.tokens)} tok</span></div>`
    )
    .join("\n");

  let matrix = "";
  if (cross.multiAgentSkills.length > 0) {
    const head = cross.activeAgents
      .map((agent) => `<th>${escapeHtml(runAgentLabel(agent))}</th>`)
      .join("");
    const body = cross.multiAgentSkills
      .map((skill) => {
        const cells = cross.activeAgents
          .map(
            (agent) =>
              `<td class="num">${escapeHtml(formatAgentCell(skill.agentRuns, skill.agentTokens, agent))}</td>`
          )
          .join("");
        return `<tr><td>${escapeHtml(skill.name)}</td><td class="num">${skill.totalRuns}</td>${cells}</tr>`;
      })
      .join("\n");
    matrix = `<h3 class="subhead">Same skill across multiple agents</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Skill</th><th>Total runs</th>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
  } else if (cross.byAgent.length > 1) {
    matrix = `<p class="note">No single skill has been invoked by more than one agent yet.</p>`;
  }

  return `<div class="panel">
    <h2>Skill usage by agent</h2>
    <p class="note" style="margin-top:0">Track the same workspace task across Claude Code, Cursor, Kiro, and Copilot.</p>
    <div class="stat-grid">${agentPills}</div>
    ${matrix}
    <div class="note">Counts from skill-invoke hooks in <code>runs.jsonl</code>; tokens may include attribution when hooks omit them.</div>
  </div>`;
}

function formatSkillAvgCost(stat: SkillUsageStat): string {
  if (!stat.avgCostUsd || stat.avgCostUsd <= 0) {
    return "-";
  }
  const basis = (stat.measuredRuns ?? 0) > 0 ? "API" : "logged";
  return `${formatCost(stat.avgCostUsd)}/run (${basis})`;
}

function detailTableLines(stats: SkillUsageStat[], confidence?: Map<string, SkillCostConfidence>): string[] {
  if (stats.length === 0) {
    return [];
  }
  const lines = [
    "## Per-skill detail",
    "",
    "| Skill | Runs | Success | Cost/run | Tokens | By agent | Last used | Rating | Trust |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const s of stats) {
    const successPct = s.successRate === null ? "-" : `${Math.round(s.successRate)}%`;
    const conf = confidence?.get(s.name);
    const trust = buildSkillTrustLine(conf);
    lines.push(
      `| ${s.name} | ${s.runs} | ${successPct} | ${formatSkillAvgCost(s)} | ${formatTokenCount(s.totalTokens)} | ${formatAgentBreakdown(s.agentRuns, s.agentTokens)} | ${formatRecency(s.daysSinceLastUse)} | ${RATING_LABEL[s.rating]} | ${trust.summary} |`
    );
  }
  return lines;
}

function tokenSum(usage: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number }): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
}

function creditUsageScopeLabel(creditUsage: CreditUsageSummary): string {
  return creditUsage.workspaceScoped ? "this workspace" : "all projects";
}

function creditUsageLines(creditUsage: CreditUsageSummary): string[] {
  const lines = [
    `## Claude Credits Usage (last ${creditUsage.daysBack} days, ${creditUsageScopeLabel(creditUsage)})`,
    "",
  ];

  if (creditUsage.totalTokens === 0) {
    lines.push("No recorded Claude Code activity in this window.", "");
    return lines;
  }

  lines.push(
    `${formatTokenCount(creditUsage.totalTokens)} tokens, ${creditUsageCostLabel(creditUsage).toLowerCase()} ~${formatCost(creditUsage.totalCost)}, across ${creditUsage.sessionCount} session(s).`,
    "",
    "| Model | Input | Output | Cache write | Cache read | Tokens | Cost | Basis |",
    "|---|---|---|---|---|---|---|---|"
  );
  for (const m of creditUsage.byModel) {
    lines.push(
      `| ${formatModelLabel(m.model, m.costBasis)} | ${formatTokenCount(m.inputTokens)} | ${formatTokenCount(m.outputTokens)} | ${formatTokenCount(m.cacheCreationTokens)} | ${formatTokenCount(m.cacheReadTokens)} | ${formatTokenCount(tokenSum(m))} | ${formatCost(m.cost)} | ${modelCostCellLabel(m.costBasis)} |`
    );
  }

  lines.push("", "| Date | Tokens | Cost |", "|---|---|---|");
  for (const d of creditUsage.byDay) {
    lines.push(`| ${d.date} | ${formatTokenCount(tokenSum(d))} | ${formatCost(d.cost)} |`);
  }

  lines.push(
    "",
    "Per-model cost uses published API rates on transcript usage (input/output/cache). Rows marked Est. use size-based fallback. Not an actual bill (Pro/Max are flat-rate).",
    ""
  );
  return lines;
}

export function formatUsageReport(
  stats: SkillUsageStat[],
  suggested: SuggestedSkill[],
  target: string,
  creditUsage: CreditUsageSummary,
  opts?: {
    skillConfidence?: Map<string, SkillCostConfidence>;
    workspaceConfidence?: WorkspaceConfidence;
    inefficiency?: SkillInefficiencyStat[];
    taskProposals?: TaskSkillProposal[];
    versionStatuses?: SkillVersionStatus[];
    globalTrust?: GlobalTrustBadge;
    manifest?: Manifest;
  }
): string {
  if (stats.length === 0 && suggested.length === 0) {
    return [
      "# Claude Skills Usage Report",
      "",
      `Workspace: \`${target}\``,
      "",
      ...creditUsageLines(creditUsage),
      "No installed skills, no recorded skill runs, and no relevant skills detected for this workspace.",
    ].join("\n");
  }

  const counts = tallyRatings(stats);
  const trustBanner =
    opts?.globalTrust != null
      ? `${opts.globalTrust.label} (${opts.globalTrust.scorePct}%). ${opts.globalTrust.detail}`
      : opts?.workspaceConfidence != null
        ? `Attribution confidence: ${Math.round(opts.workspaceConfidence.score * 100)}% (${formatConfidenceBadge(opts.workspaceConfidence.level)}). ${opts.workspaceConfidence.summary}`
        : "";
  return [
    "# Claude Skills Usage Report",
    "",
    `Workspace: \`${target}\``,
    "",
    trustBanner ? `${trustBanner}\n` : "",
    summaryLine(stats, suggested, counts),
    "",
    ...creditUsageLines(creditUsage),
    ...crossAgentUsageLines(stats),
    ...outdatedLines(opts?.versionStatuses ?? []),
    ...inefficiencyLines(opts?.inefficiency ?? []),
    ...taskProposalLines(opts?.taskProposals ?? []),
    ...misusedLines(stats),
    ...suggestedLines(suggested),
    ...removalLines(stats),
    ...detailTableLines(stats, opts?.skillConfidence),
  ].join("\n");
}

const RATING_CLASS: Record<UsageRating, string> = {
  active: "active",
  "needs-attention": "needs-attention",
  "low-usage": "low-usage",
  unused: "unused",
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function htmlCards(counts: Record<UsageRating, number>, suggestedCount: number): string {
  const cards = (
    [
      ["active", "Active"],
      ["low-usage", "Low usage"],
      ["unused", "Unused"],
      ["needs-attention", "Needs attention"],
    ] as [UsageRating, string][]
  ).map(([key, label]) => `<div class="card ${key}"><div class="count">${counts[key]}</div><div class="label">${label}</div></div>`);

  if (suggestedCount > 0) {
    cards.push(`<div class="card suggested"><div class="count">${suggestedCount}</div><div class="label">Suggested</div></div>`);
  }
  return cards.join("\n");
}

function htmlInefficiencySection(stats: SkillInefficiencyStat[]): string {
  if (stats.length === 0) {
    return "";
  }
  const items = stats
    .map((s) => {
      const heatClass = s.heatLevel > 0 ? `heat-${s.heatLevel}` : "";
      return `<li class="inefficiency-row ${heatClass}">
        <div class="inefficiency-head">
          <b>${escapeHtml(s.name)}</b>
          <span class="inefficiency-pct">${s.inefficiencyPct}%</span>
        </div>
        <div class="inefficiency-bar-wrap"><div class="inefficiency-bar ${heatClass}" style="width:${s.inefficiencyPct}%"></div></div>
        <div class="hint">${s.negativeCount} negative reaction(s) · ${escapeHtml(s.updateSuggestion)}</div>
      </li>`;
    })
    .join("\n");
  return `<div class="panel inefficiency-panel"><h2>Inefficient skills (user feedback)</h2><ul class="inefficiency-list">${items}</ul><div class="note">Deeper red = more negative feedback. Update SKILL.md or review <code>skill-feedback.jsonl</code>.</div></div>`;
}

function htmlTaskProposalsSection(
  target: string,
  proposals: TaskSkillProposal[],
  taskSummary?: string
): string {
  if (proposals.length === 0) {
    return "";
  }
  const file = readTaskSkillProposals(target);
  const summary = taskSummary ? `<p class="muted task-summary">${escapeHtml(taskSummary)}</p>` : "";
  const items = proposals
    .slice(0, 8)
    .map(
      (p) =>
        `<li><b>${escapeHtml(p.name)}</b> <span class="badge task-conf">${p.confidence}%</span> ${p.installed ? '<span class="badge active">installed</span>' : '<span class="badge low-usage">install</span>'} — ${escapeHtml(p.reason)}</li>`
    )
    .join("\n");
  let approvalNote = "";
  if (file?.approvalStatus === "pending" && file.options?.length) {
    const optionLines = file.options
      .map(
        (o) =>
          `<li><b>${escapeHtml(o.label)}</b> (${o.skills.length} skills) — ${escapeHtml(o.description)}</li>`
      )
      .join("\n");
    approvalNote = `<div class="note">Waiting for approval — run <b>Claude Skills: Choose Task Skill Set</b>.</div><ul>${optionLines}</ul>`;
  } else if (file?.selectedOptionId && file.options?.length) {
    const picked = file.options.find((o) => o.id === file.selectedOptionId);
    if (picked) {
      approvalNote = `<div class="note">Active set: <b>${escapeHtml(picked.label)}</b> (${picked.skills.length} skills).</div>`;
    }
  }
  return `<div class="panel"><h2>Proposed for current task</h2>${summary}${approvalNote}<ul>${items}</ul><div class="note">From <code>task-skill-proposals.json</code> — regenerate via <code>skill-feedback-adaptation</code> when the task changes. Local-only: not committed or shared with teammates.</div></div>`;
}

function htmlMisusedSection(stats: SkillUsageStat[]): string {
  const misused = stats.filter((s) => s.rating === "needs-attention");
  if (misused.length === 0) {
    return "";
  }
  const items = misused
    .map(
      (s) =>
        `<li><b>${escapeHtml(s.name)}</b>: ${Math.round(s.successRate ?? 0)}% success over ${s.runs} runs - check <code>.claude/learning/patterns.md</code> for recurring errors.</li>`
    )
    .join("\n");
  return `<div class="panel"><h2>Misused</h2><ul>${items}</ul></div>`;
}

function htmlSuggestedSection(suggested: SuggestedSkill[]): string {
  if (suggested.length === 0) {
    return "";
  }
  const items = suggested
    .map(
      (s) =>
        `<li><b>${escapeHtml(s.name)}</b> - ${escapeHtml(s.description)} <span class="muted">(matches ${escapeHtml(s.matchedGlobs.join(", "))})</span></li>`
    )
    .join("\n");
  return `<div class="panel"><h2>Suggested</h2><ul>${items}</ul></div>`;
}

function htmlRemovalSection(stats: SkillUsageStat[]): string {
  const removal = stats.filter((s) => s.rating === "unused" || s.rating === "low-usage");
  if (removal.length === 0) {
    return "";
  }
  const items = removal
    .map((s) => {
      const detail = s.runs === 0 ? "never used" : `${s.runs} run(s), last used ${formatRecency(s.daysSinceLastUse)}`;
      return `<li><b>${escapeHtml(s.name)}</b> - ${detail}</li>`;
    })
    .join("\n");
  return `<div class="panel"><h2>Removal candidates</h2><ul>${items}</ul><div class="note">Delete <code>.claude/skills/&lt;name&gt;/</code> or use <code>skill-usage-insights</code>.</div></div>`;
}

function htmlDetailTable(
  stats: SkillUsageStat[],
  confidence?: Map<string, SkillCostConfidence>,
  inefficiency?: Map<string, SkillInefficiencyStat>,
  manifest?: Manifest
): string {
  if (stats.length === 0) {
    return "";
  }
  const rows = stats
    .map((s) => {
      const successPct = s.successRate === null ? "-" : `${Math.round(s.successRate)}%`;
      const conf = confidence?.get(s.name);
      const roi = manifest ? computeSkillRoi(s.name, manifest, s) : undefined;
      const trust = buildSkillTrustLine(conf, roi?.roiBand);
      const trustHtml = formatSkillTrustHtml(trust);
      const costCell = formatSkillAvgCost(s);
      const ineff = inefficiency?.get(s.name);
      const ineffCell =
        ineff && ineff.negativeCount > 0
          ? `<span class="badge inefficiency heat-${ineff.heatLevel}">${ineff.inefficiencyPct}%</span>`
          : `<span class="muted">-</span>`;
      return `<tr>
          <td>${escapeHtml(s.name)}</td>
          <td class="num">${s.runs}</td>
          <td class="num">${successPct}</td>
          <td class="num">${escapeHtml(costCell)}</td>
          <td class="num">${formatTokenCount(s.totalTokens)}</td>
          <td class="num">${ineffCell}</td>
          <td class="muted">${escapeHtml(formatAgentBreakdown(s.agentRuns, s.agentTokens))}</td>
          <td>${formatRecency(s.daysSinceLastUse)}</td>
          <td><span class="badge ${RATING_CLASS[s.rating]}">${RATING_LABEL[s.rating]}</span></td>
          <td class="trust-cell">${trustHtml}</td>
        </tr>`;
    })
    .join("\n");
  const rowsTable = `<table>
      <thead><tr><th>Skill</th><th>Runs</th><th>Success</th><th>Cost/run</th><th>Tokens</th><th>Feedback</th><th>By agent</th><th>Last used</th><th>Rating</th><th>ROI / Trust</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  return `<div class="panel">
    <h2>Skills detail</h2>
    <p class="note">Cost/run from hook invocations at published API rates when usage metadata is present; catalog-tier skills without runs show no cost here. Session spend is under Credits above.</p>
    <div class="table-wrap">${rowsTable}</div>
  </div>`;
}

function htmlCreditUsageSection(creditUsage: CreditUsageSummary): string {
  const title = `Credits · ${creditUsage.daysBack}d · ${creditUsageScopeLabel(creditUsage)}`;
  if (creditUsage.totalTokens === 0) {
    return `<div class="panel"><h2>${title}</h2><p class="note">No recorded activity in this window.</p></div>`;
  }

  const modelRows = creditUsage.byModel
    .map(
      (m) => `<tr>
          <td>${escapeHtml(formatModelLabel(m.model, m.costBasis))}</td>
          <td class="num">${formatTokenCount(m.inputTokens)}</td>
          <td class="num">${formatTokenCount(m.outputTokens)}</td>
          <td class="num">${formatTokenCount(m.cacheCreationTokens)}</td>
          <td class="num">${formatTokenCount(m.cacheReadTokens)}</td>
          <td class="num">${formatTokenCount(tokenSum(m))}</td>
          <td class="num">${formatCost(m.cost)}</td>
          <td class="num">${modelCostCellLabel(m.costBasis)}</td>
        </tr>`
    )
    .join("\n");

  const dayRows = creditUsage.byDay
    .map(
      (d) => `<tr>
          <td>${d.date}</td>
          <td class="num">${formatTokenCount(tokenSum(d))}</td>
          <td class="num">${formatCost(d.cost)}</td>
        </tr>`
    )
    .join("\n");

  return `<div class="panel">
    <h2>${title}</h2>
    <div class="stat-grid">
      <div class="stat-pill"><b>Tokens</b><span class="val">${formatTokenCount(creditUsage.totalTokens)}</span></div>
      <div class="stat-pill"><b>${escapeHtml(creditUsageCostLabel(creditUsage))}</b><span class="val">${formatCost(creditUsage.totalCost)}</span></div>
      <div class="stat-pill"><b>Sessions</b><span class="val">${creditUsage.sessionCount}</span></div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Model</th><th>In</th><th>Out</th><th>Cache W</th><th>Cache R</th><th>Total</th><th>Cost</th><th>Basis</th></tr></thead>
      <tbody>${modelRows}</tbody>
    </table></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Tokens</th><th>Cost</th></tr></thead>
      <tbody>${dayRows}</tbody>
    </table></div>
    <div class="note">Per-model cost from transcript usage at published API rates. Basis: API = usage breakdown, Est. = size fallback. Not an actual bill.</div>
  </div>`;
}

/** Renders the usage report as a styled HTML page for a webview panel. */
export function formatUsageReportHtml(
  stats: SkillUsageStat[],
  suggested: SuggestedSkill[],
  target: string,
  creditUsage: CreditUsageSummary,
  hookStatus?: WorkspaceHookStatus,
  opts?: {
    skillConfidence?: Map<string, SkillCostConfidence>;
    workspaceConfidence?: WorkspaceConfidence;
    inefficiency?: SkillInefficiencyStat[];
    taskProposals?: TaskSkillProposal[];
    taskSummary?: string;
    versionStatuses?: SkillVersionStatus[];
    globalTrust?: GlobalTrustBadge;
    manifest?: Manifest;
  }
): string {
  const counts = tallyRatings(stats);
  const inefficiency = opts?.inefficiency ?? [];
  const inefficiencyMap = new Map(inefficiency.map((s) => [s.name, s]));
  const inefficiencyCard =
    inefficiency.length > 0
      ? `<div class="card inefficient"><div class="count">${inefficiency.length}</div><div class="label">Inefficient</div></div>`
      : "";
  const outdatedCount = (opts?.versionStatuses ?? []).filter((s) => s.outdated).length;
  const outdatedCard =
    outdatedCount > 0
      ? `<div class="card outdated"><div class="count">${outdatedCount}</div><div class="label">Outdated</div></div>`
      : "";
  const confBanner = opts?.globalTrust
    ? formatGlobalTrustBannerHtml(opts.globalTrust)
    : opts?.workspaceConfidence != null
      ? `<div class="estimate-banner"><b>Trust</b> ${escapeHtml(opts.workspaceConfidence.summary)} <span class="conf-${opts.workspaceConfidence.level}">(${Math.round(opts.workspaceConfidence.score * 100)}% · ${escapeHtml(formatConfidenceBadge(opts.workspaceConfidence.level))})</span></div>`
      : "";

  let body: string;
  if (stats.length === 0 && suggested.length === 0 && inefficiency.length === 0) {
    body = [
      htmlCreditUsageSection(creditUsage),
      "<p>No installed skills, no recorded skill runs, and no relevant skills detected for this workspace.</p>",
    ].join("\n");
  } else {
    body = [
      htmlCreditUsageSection(creditUsage),
      htmlCrossAgentSection(stats),
      htmlInefficiencySection(inefficiency),
      htmlOutdatedSection(opts?.versionStatuses ?? []),
      htmlTaskProposalsSection(target, opts?.taskProposals ?? [], opts?.taskSummary),
      htmlMisusedSection(stats),
      htmlSuggestedSection(suggested),
      htmlRemovalSection(stats),
      htmlDetailTable(stats, opts?.skillConfidence, inefficiencyMap, opts?.manifest),
    ]
      .filter((s) => s.length > 0)
      .join("\n");
  }

  const summaryCards = htmlCards(counts, suggested.length) + inefficiencyCard + outdatedCard;

  return wrapDashboardHtml({
    title: "Usage Report",
    headerHtml: `${confBanner}<div class="meta">Workspace: <code>${escapeHtml(target)}</code></div>${hookStatus ? formatHookStatusBannerHtml(hookStatus) : ""}<div class="summary">${summaryCards}</div>`,
    extraStyles: DASHBOARD_USAGE_EXTRA_STYLES,
    body,
  });
}
