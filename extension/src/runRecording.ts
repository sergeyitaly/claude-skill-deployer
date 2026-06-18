import * as fs from "node:fs";
import * as path from "node:path";
import { invalidateLearningCache, countCachedV2HookRuns, sessionHasCachedV2HookRuns } from "./learningStateIndex";

export type RunAgent = "claude" | "cursor" | "kiro" | "copilot";

/** Attribution v2: explicit per-invoke rows from PostToolUse / PreToolUse hooks. */
export const SKILL_INVOKE_HOOK_SOURCE = "skill-invoke-hook-v2";

/** Background collector writes equal-split transcript rows (cost-attribution only). */
export const ATTRIBUTION_COLLECTOR_SOURCE = "attribution-collector";

export function isCollectorTranscriptRun(entry: {
  action?: string;
  metadata?: { source?: string };
}): boolean {
  return entry.action === "transcript" && entry.metadata?.source === ATTRIBUTION_COLLECTOR_SOURCE;
}

/** Rows suitable for Usage Report / skill KPIs (hooks, self-learning — not transcript splits). */
export function isUsageRunRecord(entry: {
  action?: string;
  metadata?: { source?: string };
}): boolean {
  return !isCollectorTranscriptRun(entry);
}

/** Run has API usage breakdown (input/output/cache) for model-aware cost. */
export function isUsageBreakdownRun(entry: { metadata?: RunMetadata }): boolean {
  const meta = entry.metadata ?? {};
  return meta.cost_method === "usage_breakdown" || Boolean(meta.usage);
}

export interface RunMetadata {
  task_type?: string;
  duration_seconds?: number;
  cache_hit?: boolean;
  source?: string;
  invoked?: boolean;
  [key: string]: unknown;
}

export interface EnrichedRunRecord {
  ts: string;
  timestamp: string;
  skill: string;
  action: string;
  agent: RunAgent;
  tokens: number;
  cost: number;
  rc: number;
  success: boolean;
  session_id: string;
  project: string;
  branch?: string | null;
  metadata: RunMetadata;
  duration?: number;
  error?: string;
  hint?: string;
  note?: string;
}

import { tokenCostUsd as estimateTokenCost, estimateUsageCostFromRaw } from "./costRates";

export { BLENDED_USD_PER_M_TOKEN, tokenCostUsd } from "./costRates";

export function tokenCostUsdForRun(tokens: number, model?: string): number {
  return estimateTokenCost(tokens, model);
}

export function runsFilePath(target: string): string {
  return path.join(target, ".claude", "learning", "runs.jsonl");
}

export function readEnrichedRunsFromFile(file: string): EnrichedRunRecord[] {
  if (!fs.existsSync(file)) {
    return [];
  }
  const out: EnrichedRunRecord[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const row = normalizeRunRecord(JSON.parse(line) as Record<string, unknown>);
      if (row) {
        out.push(row);
      }
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

export function isV2HookRun(record: EnrichedRunRecord): boolean {
  return record.metadata?.source === SKILL_INVOKE_HOOK_SOURCE && record.metadata?.invoked === true;
}

export function countV2HookRuns(target: string): number {
  return countCachedV2HookRuns(target);
}

export function sessionHasV2HookRuns(target: string, sessionId: string): boolean {
  return sessionHasCachedV2HookRuns(target, sessionId);
}

/** Normalize legacy and enriched runs.jsonl rows into a common shape. */
export function normalizeRunRecord(raw: Record<string, unknown>): EnrichedRunRecord | null {
  const skill = raw.skill;
  const ts = (raw.ts ?? raw.timestamp) as string | undefined;
  if (typeof skill !== "string" || typeof ts !== "string") {
    return null;
  }

  const tokens = typeof raw.tokens === "number" ? raw.tokens : 0;
  const rc = typeof raw.rc === "number" ? raw.rc : raw.success === false ? 1 : 0;
  const agent = (typeof raw.agent === "string" ? raw.agent : "claude") as RunAgent;
  const metadata = (raw.metadata as RunMetadata) ?? {};
  const model =
    typeof raw.model === "string"
      ? raw.model
      : typeof metadata.model === "string"
        ? metadata.model
        : undefined;
  const usageRaw = metadata.usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_creation_input_tokens_1h?: number;
        cache_read_input_tokens?: number;
      }
    | undefined;
  const usageCost = estimateUsageCostFromRaw(usageRaw, model);
  const cost =
    usageCost > 0
      ? usageCost
      : typeof raw.cost === "number"
        ? raw.cost
        : estimateTokenCost(tokens, model);

  return {
    ts,
    timestamp: ts,
    skill,
    action: typeof raw.action === "string" ? raw.action : "run",
    agent,
    tokens,
    cost,
    rc,
    success: typeof raw.success === "boolean" ? raw.success : rc === 0,
    session_id: typeof raw.session_id === "string" ? raw.session_id : `unknown_${ts}`,
    project: typeof raw.project === "string" ? raw.project : "",
    branch: typeof raw.branch === "string" ? raw.branch : null,
    metadata,
    duration: typeof raw.duration === "number" ? raw.duration : undefined,
    error: typeof raw.error === "string" ? raw.error : undefined,
    hint: typeof raw.hint === "string" ? raw.hint : undefined,
    note: typeof raw.note === "string" ? raw.note : undefined,
  };
}

export function appendSkillRun(
  target: string,
  entry: {
    skill: string;
    agent: RunAgent;
    tokens: number;
    success: boolean;
    action?: string;
    session_id?: string;
    branch?: string | null;
    metadata?: RunMetadata;
    duration?: number;
  }
): EnrichedRunRecord {
  const file = runsFilePath(target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ts = new Date().toISOString();
  const record: EnrichedRunRecord = {
    ts,
    timestamp: ts,
    skill: entry.skill,
    action: entry.action ?? "run",
    agent: entry.agent,
    tokens: entry.tokens,
    cost: estimateTokenCost(entry.tokens, (entry.metadata as RunMetadata | undefined)?.model as string | undefined),
    rc: entry.success ? 0 : 1,
    success: entry.success,
    session_id: entry.session_id ?? `ext_${ts}`,
    project: target,
    branch: entry.branch ?? null,
    metadata: entry.metadata ?? {},
    duration: entry.duration,
  };
  fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf-8");
  invalidateLearningCache(target);
  return record;
}

/**
 * Log a native IDE tool invocation (run_task, run_in_terminal, etc.) to mcp-usage.jsonl
 * for tracking native tool operations captured via postToolUse hooks.
 */
export function appendToolUse(
  target: string,
  entry: {
    tool: string;           // e.g. "run_task", "run_in_terminal", "run_command"
    agent?: RunAgent;
    sessionId?: string;
    durationMs?: number;
    metadata?: Record<string, unknown>;
  }
): void {
  const file = path.join(target, ".claude", "mcp-usage.jsonl");
  const globalFile = path.join(process.env.HOME || process.env.USERPROFILE || "~", ".claude", "learning", "mcp-usage.jsonl");

  const record = {
    ts: new Date().toISOString(),
    tool: `native:${entry.tool}`,  // Prefix with "native:" to distinguish from MCP servers
    durationMs: entry.durationMs ?? 0,
    sessionId: entry.sessionId,
    ...entry.metadata,
  };

  // Dual-path logging: workspace + global
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf-8");
  } catch (e) {
    // Silently fail if unable to write workspace log
  }

  try {
    fs.mkdirSync(path.dirname(globalFile), { recursive: true });
    fs.appendFileSync(globalFile, JSON.stringify(record) + "\n", "utf-8");
  } catch (e) {
    // Silently fail if unable to write global log
  }
}

export { pruneRunsJsonl } from "./learningPrune";
