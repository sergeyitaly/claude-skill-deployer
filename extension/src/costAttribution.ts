import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentId, loadAgentsManifest } from "./agentOps";
import { computeCreditUsageFromRoots } from "./usageCost";
import { tokenCostUsd } from "./costRates";
import { countV2HookRuns } from "./runRecording";
import { readRunRecords, RunRecord } from "./usageStats";

export interface AgentAttribution {
  tokens: number;
  cost: number;
  sessions: number;
}

export type SkillAttributionMap = Record<string, Partial<Record<AgentId, AgentAttribution>>>;

/** @deprecated Global store — migrate to per-workspace via migrateLegacyCostAttribution(). */
export const LEGACY_COST_ATTRIBUTION_PATH = path.join(os.homedir(), ".claude", "learning", "cost-attribution.json");

/** @deprecated Use costAttributionPath(target) */
export const COST_ATTRIBUTION_PATH = LEGACY_COST_ATTRIBUTION_PATH;

export function costAttributionPath(target: string): string {
  return path.join(target, ".claude", "learning", "cost-attribution.json");
}

/** Copy legacy global attribution into the workspace when it belongs to this project. */
export function migrateLegacyCostAttribution(target: string): boolean {
  const wsPath = costAttributionPath(target);
  if (fs.existsSync(wsPath)) {
    return false;
  }
  if (!fs.existsSync(LEGACY_COST_ATTRIBUTION_PATH)) {
    return false;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(LEGACY_COST_ATTRIBUTION_PATH, "utf-8")) as { workspacePath?: string };
    const legacyWs = raw.workspacePath;
    if (legacyWs && path.resolve(legacyWs) !== path.resolve(target)) {
      return false;
    }
    fs.mkdirSync(path.dirname(wsPath), { recursive: true });
    fs.copyFileSync(LEGACY_COST_ATTRIBUTION_PATH, wsPath);
    return true;
  } catch {
    return false;
  }
}

function readStoredAttributionFile(filePath: string): {
  transcriptSkills: SkillAttributionMap;
  base_context: BaseContextAttribution;
  unattributed: UnattributedAttribution;
} | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const stored = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
      transcriptSkills?: SkillAttributionMap;
      skills?: SkillAttributionMap;
      base_context?: BaseContextAttribution;
      unattributed?: UnattributedAttribution;
    };
    return {
      transcriptSkills: stored.transcriptSkills ?? stored.skills ?? {},
      base_context: stored.base_context ?? {},
      unattributed: stored.unattributed ?? {},
    };
  } catch {
    return null;
  }
}

function emptyAgent(): AgentAttribution {
  return { tokens: 0, cost: 0, sessions: 0 };
}

function addAgent(target: AgentAttribution, tokens: number, cost: number, sessions = 1): void {
  target.tokens += tokens;
  target.cost += cost;
  target.sessions += sessions;
}

/** Per-skill attribution from runs.jsonl (agent defaults to claude; optional record.agent). */
function attributionFromRuns(records: RunRecord[]): SkillAttributionMap {
  const map: SkillAttributionMap = {};
  for (const rec of records) {
    if (!rec.tokens || rec.tokens <= 0) {
      continue;
    }
    const agent = (rec.agent ?? "claude") as AgentId;
    const cost = tokenCostUsd(rec.tokens, (rec as RunRecord & { model?: string }).model);
    const skillMap = map[rec.skill] ?? {};
    const bucket = skillMap[agent] ?? emptyAgent();
    addAgent(bucket, rec.tokens, cost);
    skillMap[agent] = bucket;
    map[rec.skill] = skillMap;
  }
  return map;
}

/** Agent-level totals from session transcripts (no per-skill split). */
function agentTotalsFromTranscripts(libraryDir: string): Partial<Record<AgentId, AgentAttribution>> {
  const agents = loadAgentsManifest(libraryDir).agents;
  const totals: Partial<Record<AgentId, AgentAttribution>> = {};
  for (const [id, def] of Object.entries(agents)) {
    if (!def.supportsUsageTranscripts || def.transcriptRoots.length === 0) {
      continue;
    }
    const summary = computeCreditUsageFromRoots(def.transcriptRoots, 14);
    if (summary.totalTokens === 0) {
      continue;
    }
    totals[id as AgentId] = {
      tokens: summary.totalTokens,
      cost: summary.totalCost,
      sessions: summary.sessionCount,
    };
  }
  return totals;
}

export type BaseContextAttribution = Partial<Record<AgentId, number>>;
export type UnattributedAttribution = Partial<Record<AgentId, number>>;

export function buildCostAttribution(target: string, libraryDir: string): {
  skills: SkillAttributionMap;
  transcriptSkills: SkillAttributionMap;
  base_context: BaseContextAttribution;
  unattributed: UnattributedAttribution;
  agentTotals: Partial<Record<AgentId, AgentAttribution>>;
} {
  const records = readRunRecords(target);
  const fromRuns = attributionFromRuns(records);
  let transcriptSkills: SkillAttributionMap = {};
  let base_context: BaseContextAttribution = {};
  let unattributed: UnattributedAttribution = {};

  for (const rec of records) {
    if (!rec.tokens || rec.tokens <= 0) {
      continue;
    }
    const agent = (rec.agent ?? "claude") as AgentId;
    if (rec.skill === "base_context") {
      base_context[agent] = (base_context[agent] ?? 0) + rec.tokens;
    } else if (rec.skill === "unattributed") {
      unattributed[agent] = (unattributed[agent] ?? 0) + rec.tokens;
    }
  }

  migrateLegacyCostAttribution(target);
  const stored = readStoredAttributionFile(costAttributionPath(target));
  if (stored) {
    transcriptSkills = stored.transcriptSkills;
    base_context = { ...stored.base_context, ...base_context };
    unattributed = { ...stored.unattributed, ...unattributed };
  }

  return {
    skills: fromRuns,
    transcriptSkills,
    base_context,
    unattributed,
    agentTotals: agentTotalsFromTranscripts(libraryDir),
  };
}

/** Multiple skills with identical cost usually means session tokens were split equally (stale collector data). */
export function detectEqualSplitCluster(
  attribution: SkillAttributionMap
): { count: number; cost: number } | null {
  const clusters = new Map<number, number>();
  for (const agents of Object.values(attribution)) {
    const cost = Object.values(agents).reduce((s, a) => s + (a?.cost ?? 0), 0);
    if (cost <= 0) {
      continue;
    }
    const key = Math.round(cost * 100);
    clusters.set(key, (clusters.get(key) ?? 0) + 1);
  }
  let worst: { count: number; cost: number } | null = null;
  for (const [key, count] of clusters) {
    if (count >= 3 && (!worst || count > worst.count)) {
      worst = { count, cost: key / 100 };
    }
  }
  return worst;
}

export function formatEqualSplitWarning(cluster: { count: number; cost: number }, html = false): string {
  const costLabel = `$${cluster.cost.toFixed(2)}`;
  const reset = html ? "<b>Reset Mis-attributed Cost Data</b>" : "Reset Mis-attributed Cost Data";
  return (
    `${cluster.count} skills share the same attributed cost (${costLabel}) — session tokens were likely split equally across skills that were not actually invoked. Run ${reset} and reopen this dashboard.`
  );
}

export function resolveDisplayAttribution(
  built: {
    skills: SkillAttributionMap;
    transcriptSkills: SkillAttributionMap;
  },
  target?: string
): {
  attribution: SkillAttributionMap;
  staleEqualSplit: boolean;
  equalSplitCluster: { count: number; cost: number } | null;
  usesV2HookRuns: boolean;
} {
  const usesV2HookRuns = target ? countV2HookRuns(target) > 0 : false;
  if (usesV2HookRuns) {
    const cluster = detectEqualSplitCluster(built.skills);
    return {
      attribution: built.skills,
      staleEqualSplit: cluster !== null,
      equalSplitCluster: cluster,
      usesV2HookRuns: true,
    };
  }

  const merged = mergeSkillMaps(built.skills, built.transcriptSkills);
  const cluster = detectEqualSplitCluster(merged);
  if (!cluster) {
    return { attribution: merged, staleEqualSplit: false, equalSplitCluster: null, usesV2HookRuns: false };
  }
  const runsOnlyStale = detectEqualSplitCluster(built.skills);
  return {
    attribution: runsOnlyStale ? {} : built.skills,
    staleEqualSplit: true,
    equalSplitCluster: cluster,
    usesV2HookRuns: false,
  };
}

function mergeSkillMaps(a: SkillAttributionMap, b: SkillAttributionMap): SkillAttributionMap {
  const out: SkillAttributionMap = { ...a };
  for (const [skill, agents] of Object.entries(b)) {
    const existing = out[skill] ?? {};
    for (const [agent, stats] of Object.entries(agents) as [AgentId, AgentAttribution][]) {
      const bucket = existing[agent] ?? emptyAgent();
      addAgent(bucket, stats.tokens, stats.cost, stats.sessions);
      existing[agent] = bucket;
    }
    out[skill] = existing;
  }
  return out;
}

export function persistCostAttribution(target: string, libraryDir: string): void {
  const built = buildCostAttribution(target, libraryDir);
  const data = {
    updatedAt: new Date().toISOString(),
    workspacePath: target,
    skills: built.skills,
    transcriptSkills: built.transcriptSkills,
    base_context: built.base_context,
    unattributed: built.unattributed,
    agentTotals: built.agentTotals,
  };
  const file = costAttributionPath(target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function cheapestAgentForSkill(skill: string, attribution: SkillAttributionMap): AgentId | null {
  const entry = attribution[skill];
  if (!entry) {
    return null;
  }
  let best: AgentId | null = null;
  let bestCost = Infinity;
  for (const [agent, stats] of Object.entries(entry) as [AgentId, AgentAttribution][]) {
    if (stats.sessions > 0 && stats.cost / stats.sessions < bestCost) {
      bestCost = stats.cost / stats.sessions;
      best = agent;
    }
  }
  return best;
}

export function formatAttributionReport(
  attribution: SkillAttributionMap,
  agentTotals: Partial<Record<AgentId, AgentAttribution>>,
  baseContext?: BaseContextAttribution,
  transcriptSkills?: SkillAttributionMap,
  unattributed?: UnattributedAttribution,
  target?: string
): string[] {
  const lines: string[] = ["## Cross-agent cost attribution", ""];

  const agentKeys = Object.keys(agentTotals) as AgentId[];
  if (agentKeys.length > 0) {
    lines.push("### Agent totals (last 14 days, transcripts)", "");
    lines.push("| Agent | Tokens | Est. cost | Sessions |", "|---|---|---|---|");
    for (const id of agentKeys.sort()) {
      const s = agentTotals[id]!;
      lines.push(`| ${id} | ${formatK(s.tokens)} | $${s.cost.toFixed(2)} | ${s.sessions} |`);
    }
    lines.push("");
  }

  if (baseContext && Object.keys(baseContext).length > 0) {
    lines.push("### Base context (no skill detected)", "");
    for (const [agent, tokens] of Object.entries(baseContext).sort()) {
      const cost = (tokens / 1_000_000) * 9;
      lines.push(`- ${agent}: ${formatK(tokens)} tokens (~$${cost.toFixed(2)})`);
    }
    lines.push("");
  }

  if (unattributed && Object.keys(unattributed).length > 0) {
    lines.push("### Unattributed (no invoked skill detected in transcript)", "");
    lines.push(
      "> Warning: these tokens could not be assigned to a specific skill. Use the self-learning skill to record `invoked: true` runs for accurate attribution.",
      ""
    );
    for (const [agent, tokens] of Object.entries(unattributed).sort()) {
      const cost = (tokens / 1_000_000) * 9;
      lines.push(`- ${agent}: ${formatK(tokens)} tokens (~$${cost.toFixed(2)})`);
    }
    lines.push("");
  }

  const merged = mergeSkillMaps(attribution, transcriptSkills ?? {});
  const skillNames = Object.keys(merged).sort();
  if (skillNames.length === 0) {
    lines.push("No per-skill token data yet — record `tokens` in `.claude/learning/runs.jsonl` (self-learning skill).", "");
    return lines;
  }

  lines.push("### Per-skill (runs.jsonl + transcript collector)", "");
  lines.push("| Skill | Agent | Tokens | Est. cost | Sessions | Best agent? |", "|---|---|---|---|---|---|");
  for (const skill of skillNames) {
    const best = cheapestAgentForSkill(skill, merged);
    for (const [agent, stats] of Object.entries(merged[skill]!) as [AgentId, AgentAttribution][]) {
      const marker = agent === best ? "yes" : "";
      lines.push(
        `| ${skill} | ${agent} | ${formatK(stats.tokens)} | $${stats.cost.toFixed(2)} | ${stats.sessions} | ${marker} |`
      );
    }
  }
  if (target) {
    lines.push("", `Stored at \`${costAttributionPath(target)}\`.`, "");
  }
  return lines;
}

function formatK(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }
  return `${n}`;
}
