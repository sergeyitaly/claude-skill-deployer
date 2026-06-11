import * as fs from "node:fs";
import * as path from "node:path";

export type RunAgent = "claude" | "cursor" | "kiro" | "copilot";

/** Attribution v2: explicit per-invoke rows from PostToolUse hook. */
export const SKILL_INVOKE_HOOK_SOURCE = "skill-invoke-hook-v2";

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

const BLENDED_USD_PER_M_TOKEN = 9;

export function tokenCostUsd(tokens: number): number {
  return (tokens / 1_000_000) * BLENDED_USD_PER_M_TOKEN;
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
  return readEnrichedRunsFromFile(runsFilePath(target)).filter(isV2HookRun).length;
}

export function sessionHasV2HookRuns(target: string, sessionId: string): boolean {
  return readEnrichedRunsFromFile(runsFilePath(target)).some(
    (r) => r.session_id === sessionId && isV2HookRun(r)
  );
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

  return {
    ts,
    timestamp: ts,
    skill,
    action: typeof raw.action === "string" ? raw.action : "run",
    agent,
    tokens,
    cost: typeof raw.cost === "number" ? raw.cost : tokenCostUsd(tokens),
    rc,
    success: typeof raw.success === "boolean" ? raw.success : rc === 0,
    session_id: typeof raw.session_id === "string" ? raw.session_id : `unknown_${ts}`,
    project: typeof raw.project === "string" ? raw.project : "",
    branch: typeof raw.branch === "string" ? raw.branch : null,
    metadata: (raw.metadata as RunMetadata) ?? {},
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
    cost: tokenCostUsd(entry.tokens),
    rc: entry.success ? 0 : 1,
    success: entry.success,
    session_id: entry.session_id ?? `ext_${ts}`,
    project: target,
    branch: entry.branch ?? null,
    metadata: entry.metadata ?? {},
    duration: entry.duration,
  };
  fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf-8");
  return record;
}
