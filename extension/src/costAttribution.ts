import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentId, loadAgentsManifest } from "./agentOps";
import { computeCreditUsageFromRoots } from "./usageCost";
import { readRunRecords, RunRecord } from "./usageStats";

export interface AgentAttribution {
  tokens: number;
  cost: number;
  sessions: number;
}

export type SkillAttributionMap = Record<string, Partial<Record<AgentId, AgentAttribution>>>;

export const COST_ATTRIBUTION_PATH = path.join(os.homedir(), ".claude", "learning", "cost-attribution.json");

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
    const cost = (rec.tokens / 1_000_000) * 9;
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

export function buildCostAttribution(target: string, libraryDir: string): {
  skills: SkillAttributionMap;
  transcriptSkills: SkillAttributionMap;
  base_context: BaseContextAttribution;
  agentTotals: Partial<Record<AgentId, AgentAttribution>>;
} {
  const records = readRunRecords(target);
  const fromRuns = attributionFromRuns(records);
  let transcriptSkills: SkillAttributionMap = {};
  let base_context: BaseContextAttribution = {};

  for (const rec of records) {
    if (rec.skill === "base_context" && rec.tokens && rec.tokens > 0) {
      const agent = (rec.agent ?? "claude") as AgentId;
      base_context[agent] = (base_context[agent] ?? 0) + rec.tokens;
    }
  }

  if (fs.existsSync(COST_ATTRIBUTION_PATH)) {
    try {
      const stored = JSON.parse(fs.readFileSync(COST_ATTRIBUTION_PATH, "utf-8")) as {
        transcriptSkills?: SkillAttributionMap;
        skills?: SkillAttributionMap;
        base_context?: BaseContextAttribution;
      };
      transcriptSkills = stored.transcriptSkills ?? stored.skills ?? {};
      base_context = { ...stored.base_context, ...base_context };
    } catch {
      // use runs only
    }
  }

  return {
    skills: fromRuns,
    transcriptSkills,
    base_context,
    agentTotals: agentTotalsFromTranscripts(libraryDir),
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
    agentTotals: built.agentTotals,
  };
  fs.mkdirSync(path.dirname(COST_ATTRIBUTION_PATH), { recursive: true });
  fs.writeFileSync(COST_ATTRIBUTION_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
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
  transcriptSkills?: SkillAttributionMap
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
  lines.push("", `Stored at \`${COST_ATTRIBUTION_PATH}\`.`, "");
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
