import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentId, loadAgentsManifest } from "./agentOps";
import { computeCreditUsageFromRoots } from "./usageCost";
import { tokenCostUsd } from "./costRates";
import { countV2HookRuns, isCollectorTranscriptRun, isUsageRunRecord, readCachedEnrichedRuns, isV2HookRun, sessionHasV2HookRuns, RunAgent } from "./runsStore";
import { collectorStatePath, LEGACY_COLLECTOR_STATE_PATH } from "./collectorState";
import { pruneBackupFiles, pruneRunsJsonl } from "./learningPrune";
import { invalidateLearningCache } from "./runsStore";
import { readRunRecords, RunRecord } from "./usageStats";
import { claudeParser, cursorParser, listTranscriptFiles, ParsedTranscript } from "./transcriptParsers";
import { transcriptFileMatchesWorkspace } from "./workspaceTranscripts";

/** Prefer hook/self-learning stored cost; fall back to blended estimate when missing. */
export function costForRunRecord(rec: RunRecord): number {
  if (typeof rec.cost === "number" && rec.cost > 0) {
    return rec.cost;
  }
  const meta = rec.metadata ?? {};
  const model = typeof meta.model === "string" ? meta.model : undefined;
  return tokenCostUsd(rec.tokens ?? 0, model);
}

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
    const raw = JSON.parse(fs.readFileSync(LEGACY_COST_ATTRIBUTION_PATH, "utf-8")) as Record<string, unknown> & {
      workspacePath?: string;
    };
    const legacyWs = raw.workspacePath;
    if (legacyWs && path.resolve(legacyWs) !== path.resolve(target)) {
      return false;
    }
    fs.mkdirSync(path.dirname(wsPath), { recursive: true });
    const ts = (raw.transcriptSkills ?? raw.skills) as SkillAttributionMap | undefined;
    if (ts && detectEqualSplitCluster(ts)) {
      raw.transcriptSkills = {};
      delete raw.skills;
    }
    fs.writeFileSync(wsPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** Drop equal-split transcriptSkills blobs (stale collector data). */
export function sanitizeTranscriptSkills(skills: SkillAttributionMap): {
  skills: SkillAttributionMap;
  purgedStaleEqualSplit: boolean;
} {
  if (!detectEqualSplitCluster(skills)) {
    return { skills, purgedStaleEqualSplit: false };
  }
  return { skills: {}, purgedStaleEqualSplit: true };
}

function persistPurgedTranscriptSkills(target: string): void {
  const file = costAttributionPath(target);
  if (!fs.existsSync(file)) {
    return;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    raw.transcriptSkills = {};
    delete raw.skills;
    raw.updatedAt = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n", "utf-8");
  } catch {
    // ignore
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
    if (!isUsageRunRecord(rec) || !rec.tokens || rec.tokens <= 0) {
      continue;
    }
    const agent = (rec.agent ?? "claude") as AgentId;
    const cost = costForRunRecord(rec);
    const skillMap = map[rec.skill] ?? {};
    const bucket = skillMap[agent] ?? emptyAgent();
    addAgent(bucket, rec.tokens, cost);
    skillMap[agent] = bucket;
    map[rec.skill] = skillMap;
  }
  return map;
}

/** Agent-level totals from session transcripts scoped to workspace when target provided. */
function agentTotalsFromTranscripts(
  libraryDir: string,
  workspaceTarget?: string
): Partial<Record<AgentId, AgentAttribution>> {
  const agents = loadAgentsManifest(libraryDir).agents;
  const totals: Partial<Record<AgentId, AgentAttribution>> = {};
  for (const [id, def] of Object.entries(agents)) {
    if (!def.supportsUsageTranscripts || def.transcriptRoots.length === 0) {
      continue;
    }
    const summary = computeCreditUsageFromRoots(def.transcriptRoots, 14, workspaceTarget);
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
    if (!isUsageRunRecord(rec) || !rec.tokens || rec.tokens <= 0) {
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
    const sanitized = sanitizeTranscriptSkills(stored.transcriptSkills);
    transcriptSkills = sanitized.skills;
    if (sanitized.purgedStaleEqualSplit) {
      persistPurgedTranscriptSkills(target);
    }
    base_context = { ...stored.base_context, ...base_context };
    unattributed = { ...stored.unattributed, ...unattributed };
  }

  return {
    skills: fromRuns,
    transcriptSkills,
    base_context,
    unattributed,
    agentTotals: agentTotalsFromTranscripts(libraryDir, target),
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

  const transcriptCluster = detectEqualSplitCluster(built.transcriptSkills);
  const merged = mergeSkillMaps(built.skills, built.transcriptSkills);
  const mergedCluster = detectEqualSplitCluster(merged);

  if (!mergedCluster) {
    return { attribution: merged, staleEqualSplit: false, equalSplitCluster: null, usesV2HookRuns: false };
  }

  const runsCluster = detectEqualSplitCluster(built.skills);
  if (transcriptCluster && !runsCluster) {
    return {
      attribution: built.skills,
      staleEqualSplit: false,
      equalSplitCluster: null,
      usesV2HookRuns: false,
    };
  }

  return {
    attribution: built.skills,
    staleEqualSplit: true,
    equalSplitCluster: mergedCluster,
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
    lines.push("### General API (base model, no listed skill invoke)", "");
    for (const [agent, tokens] of Object.entries(baseContext).sort()) {
      const cost = (tokens / 1_000_000) * 9;
      lines.push(`- ${agent}: ${formatK(tokens)} tokens (~$${cost.toFixed(2)})`);
    }
    lines.push("");
  }

  if (unattributed && Object.keys(unattributed).length > 0) {
    lines.push("### Legacy unattributed (pre-1.0.49 collector — reset recommended)", "");
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
  lines.push("_Hook rows use measured API cost when present; transcript-only rows use blended estimates._", "");
  lines.push("| Skill | Agent | Tokens | Cost | Sessions | Best agent? |", "|---|---|---|---|---|---|");
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

// â”€â”€ Attribution Reset (inlined from attributionReset.ts) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const RUNS_RELATIVE = path.join(".claude", "learning", "runs.jsonl");

export interface ResetResult {
  removedRuns: number;
  keptRuns: number;
  backupAttribution: string | null;
  backupRuns: string | null;
}

function isCollectorTranscriptLine(line: string): boolean {
  try {
    return isCollectorTranscriptRun(JSON.parse(line) as { action?: string; metadata?: { source?: string } });
  } catch {
    return false;
  }
}

export function resetMisattributedData(target: string): ResetResult {
  const result: ResetResult = { removedRuns: 0, keptRuns: 0, backupAttribution: null, backupRuns: null };

  const runsFile = path.join(target, RUNS_RELATIVE);
  const learningDir = path.dirname(runsFile);
  if (fs.existsSync(runsFile)) {
    const backup = `${runsFile}.pre-reset-${Date.now()}.bak`;
    fs.copyFileSync(runsFile, backup);
    result.backupRuns = backup;
    const kept: string[] = [];
    for (const line of fs.readFileSync(runsFile, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (isCollectorTranscriptLine(trimmed)) {
        result.removedRuns += 1;
      } else {
        kept.push(trimmed);
        result.keptRuns += 1;
      }
    }
    fs.writeFileSync(runsFile, kept.join("\n") + (kept.length ? "\n" : ""), "utf-8");
  }

  migrateLegacyCostAttribution(target);
  const attrPath = costAttributionPath(target);
  if (fs.existsSync(attrPath)) {
    const backup = `${attrPath}.pre-reset-${Date.now()}.bak`;
    fs.copyFileSync(attrPath, backup);
    result.backupAttribution = backup;
    try {
      const raw = JSON.parse(fs.readFileSync(attrPath, "utf-8")) as Record<string, unknown>;
      raw.transcriptSkills = {};
      raw.unattributed = {};
      raw.base_context = {};
      delete raw.agentTotals;
      raw.updatedAt = new Date().toISOString();
      delete raw.skills;
      fs.writeFileSync(attrPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
    } catch {
      fs.writeFileSync(attrPath, JSON.stringify({ transcriptSkills: {}, unattributed: {}, base_context: {} }, null, 2) + "\n", "utf-8");
    }
  }

  const statePath = collectorStatePath(target);
  const resetState = { lastRun: 0, fileMtimes: {}, processedSessions: {}, workspacePath: target };
  if (fs.existsSync(statePath)) {
    const backup = `${statePath}.pre-reset-${Date.now()}.bak`;
    fs.copyFileSync(statePath, backup);
    fs.writeFileSync(statePath, JSON.stringify(resetState, null, 2) + "\n", "utf-8");
  } else if (fs.existsSync(LEGACY_COLLECTOR_STATE_PATH)) {
    const backup = `${LEGACY_COLLECTOR_STATE_PATH}.pre-reset-${Date.now()}.bak`;
    fs.copyFileSync(LEGACY_COLLECTOR_STATE_PATH, backup);
    fs.writeFileSync(LEGACY_COLLECTOR_STATE_PATH, JSON.stringify(resetState, null, 2) + "\n", "utf-8");
  }

  pruneRunsJsonl(runsFile);
  invalidateLearningCache(target);
  pruneBackupFiles(learningDir, "pre-reset-");
  pruneBackupFiles(learningDir, ".bak-");

  return result;
}

// ---------------------------------------------------------------------------
// General API spend (moved from generalApiSpend.ts)
// ---------------------------------------------------------------------------



function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function hookTokensForSession(target: string, sessionId: string, agent?: RunAgent): number {
  return readCachedEnrichedRuns(target)
    .filter(r => isV2HookRun(r) && r.session_id === sessionId && (!agent || r.agent === agent))
    .reduce((sum, r) => sum + Math.max(0, r.tokens ?? 0), 0);
}

export function residualGeneralApiTokens(sessionTokens: number, hookTokens: number): number {
  return Math.max(0, sessionTokens - hookTokens);
}

export function generalApiTokensForSession(parsed: ParsedTranscript, target: string): number {
  const hookTokens = hookTokensForSession(target, parsed.sessionId, parsed.agent);
  if (hookTokens > 0 || sessionHasV2HookRuns(target, parsed.sessionId)) {
    return residualGeneralApiTokens(parsed.tokens, hookTokens);
  }
  return parsed.activeSkills.length === 0 ? parsed.tokens : 0;
}

export interface GeneralApiAgentRow {
  tokens: number;
  cost: number;
  sessions: number;
}

export interface GeneralApiSpendSummary {
  daysBack: number;
  totalTokens: number;
  totalCost: number;
  sessionCount: number;
  byAgent: Partial<Record<AgentId, GeneralApiAgentRow>>;
  legacyUnattributedTokens: number;
}

function parserForAgent(agent: AgentId) {
  if (agent === "claude") return claudeParser;
  if (agent === "cursor") return cursorParser;
  return null;
}

export function computeGeneralApiSpend(
  target: string,
  libraryDir: string,
  daysBack = 14
): GeneralApiSpendSummary {
  const windowStartMs = Date.now() - daysBack * 86_400_000;
  const byAgent: Partial<Record<AgentId, GeneralApiAgentRow>> = {};
  const seenSessions = new Set<string>();
  let totalTokens = 0;
  let sessionCount = 0;

  const agents = loadAgentsManifest(libraryDir).agents;
  for (const [agentId, def] of Object.entries(agents)) {
    if (!def.supportsUsageTranscripts) continue;
    const parser = parserForAgent(agentId as AgentId);
    if (!parser) continue;
    for (const root of def.transcriptRoots) {
      for (const file of listTranscriptFiles(expandHome(root))) {
        if (!transcriptFileMatchesWorkspace(file, target)) continue;
        let mtime = 0;
        try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
        if (mtime < windowStartMs) continue;
        let content = "";
        try { content = fs.readFileSync(file, "utf-8"); } catch { continue; }
        const parsed = parser.parseFile(file, content);
        if (!parsed || parsed.tokens <= 0) continue;
        const sessionKey = `${parsed.agent}|${parsed.sessionId}|${file}`;
        if (seenSessions.has(sessionKey)) continue;
        seenSessions.add(sessionKey);
        const general = generalApiTokensForSession(parsed, target);
        if (general <= 0) continue;
        const agent = parsed.agent;
        const row = byAgent[agent] ?? { tokens: 0, cost: 0, sessions: 0 };
        row.tokens += general; row.cost += tokenCostUsd(general); row.sessions += 1;
        byAgent[agent] = row;
        totalTokens += general; sessionCount += 1;
      }
    }
  }

  const built = buildCostAttribution(target, libraryDir);
  const legacyUnattributedTokens = Object.values(built.unattributed).reduce((s, t) => s + (t ?? 0), 0);
  return { daysBack, totalTokens, totalCost: tokenCostUsd(totalTokens), sessionCount, byAgent, legacyUnattributedTokens };
}
