import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { estimateUsageCostUsd } from "./costRates";
import { readCachedEnrichedRuns } from "./runsStore";
import { localDateKey } from "./localDate";
import { isUsageBreakdownRun, isUsageRunRecord, RunAgent } from "./runsStore";
import { cursorParser, listTranscriptFiles } from "./transcriptParsers";
import { isCursorTranscriptRoot, transcriptFileMatchesWorkspace } from "./workspaceTranscripts";

/** Model id for Cursor agent transcripts (no per-line model metadata; Sonnet-like default rates). */
export const CURSOR_TRANSCRIPT_MODEL = "cursor-agent";

export type ModelCostBasis = "usage" | "size_estimate";

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  /** Portion of cacheCreationTokens written with a 1-hour TTL (priced higher than 5-minute). */
  cacheCreation1hTokens: number;
  cacheReadTokens: number;
}

interface ModelBucket extends TokenUsage {
  costBasis: ModelCostBasis;
  cost: number;
}

function emptyModelBucket(): ModelBucket {
  return { ...emptyUsage(), costBasis: "usage", cost: 0 };
}

function getOrCreateModelBucket(map: Map<string, ModelBucket>, key: string): ModelBucket {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = emptyModelBucket();
    map.set(key, bucket);
  }
  return bucket;
}

function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheCreation1hTokens: 0, cacheReadTokens: 0 };
}

function addUsage(target: TokenUsage, delta: TokenUsage): void {
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cacheCreationTokens += delta.cacheCreationTokens;
  target.cacheCreation1hTokens += delta.cacheCreation1hTokens;
  target.cacheReadTokens += delta.cacheReadTokens;
}

function totalTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
}

/** Sum all token fields on a model usage row (dashboard / export). */
export function totalTokensForModelUsage(usage: TokenUsage): number {
  return totalTokens(usage);
}

export function creditUsageCostLabel(summary: CreditUsageSummary): string {
  const prefix = spendPrefixForCreditSummary(summary);
  if (prefix === "API") {
    return "API cost";
  }
  if (prefix === "Mixed") {
    return "Mixed cost";
  }
  return "Est. cost";
}

/** Status-bar / overview prefix: API when all transcript rows have usage metadata. */
export function spendPrefixForCreditSummary(summary: CreditUsageSummary): "API" | "Mixed" | "Est." | "" {
  if (summary.totalTokens === 0) {
    return "";
  }
  const hasEst = summary.byModel.some((m) => m.costBasis === "size_estimate");
  const hasApi = summary.byModel.some((m) => m.costBasis === "usage");
  if (hasApi && !hasEst) {
    return "API";
  }
  if (hasEst && !hasApi) {
    return "Est.";
  }
  return "Mixed";
}

export function modelCostCellLabel(costBasis: ModelCostBasis): string {
  return costBasis === "size_estimate" ? "Est." : "API";
}

/** Human-readable model label for dashboard rows. */
export function formatModelLabel(model: string, costBasis?: ModelCostBasis): string {
  let label: string;
  if (model === CURSOR_TRANSCRIPT_MODEL) {
    label = "Cursor agent (transcript size estimate)";
  } else if (model.startsWith("cursor/task:")) {
    label = `Cursor Task subagent (${model.slice("cursor/task:".length)})`;
  } else if (model.startsWith("skill-invoke:")) {
    label = `Skill invokes (${model.slice("skill-invoke:".length)})`;
  } else {
    label = model;
  }
  if (costBasis === "size_estimate") {
    return `${label} (size est.)`;
  }
  return label;
}

function getOrCreate(map: Map<string, ModelBucket>, key: string): ModelBucket {
  return getOrCreateModelBucket(map, key);
}

interface RawUsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  /** Flat 1h-cache portion (runs.jsonl `metadata.usage`). */
  cache_creation_input_tokens_1h?: number;
  /** Nested breakdown as logged in raw Claude session transcripts. */
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
  cache_read_input_tokens?: number;
  total_tokens?: number;
}

function rawUsageToDelta(raw: RawUsageLike): TokenUsage | null {
  const delta = {
    inputTokens: raw.input_tokens ?? 0,
    outputTokens: raw.output_tokens ?? 0,
    cacheCreationTokens: raw.cache_creation_input_tokens ?? 0,
    cacheCreation1hTokens: raw.cache_creation_input_tokens_1h ?? raw.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    cacheReadTokens: raw.cache_read_input_tokens ?? 0,
  };
  if (totalTokens(delta) > 0) {
    return delta;
  }
  if (typeof raw.total_tokens === "number" && raw.total_tokens > 0) {
    const input = Math.round(raw.total_tokens * 0.6);
    return {
      inputTokens: input,
      outputTokens: raw.total_tokens - input,
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
    };
  }
  return null;
}

interface ParsedUsageLine {
  timestamp: string;
  sessionId?: string;
  model: string;
  usage: TokenUsage;
}

function parseUsageLine(line: string): ParsedUsageLine | null {
  if (!line.includes("usage")) {
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }

  const message = parsed.message;
  const msg = message && typeof message === "object" ? (message as Record<string, unknown>) : undefined;
  const usageRaw =
    (msg?.usage as RawUsageLike | undefined) ??
    (parsed.usage as RawUsageLike | undefined);
  const model =
    (typeof msg?.model === "string" && msg.model) ||
    (typeof parsed.model === "string" && parsed.model) ||
    undefined;
  const timestamp =
    (typeof parsed.timestamp === "string" && parsed.timestamp) ||
    (typeof parsed.ts === "string" && parsed.ts) ||
    undefined;

  if (!usageRaw || !model || !timestamp) {
    return null;
  }

  const delta = rawUsageToDelta(usageRaw);
  if (!delta || totalTokens(delta) === 0) {
    return null;
  }

  return {
    timestamp,
    sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
    model,
    usage: delta,
  };
}

function estimateCost(model: string, usage: TokenUsage): number {
  return estimateUsageCostUsd(
    {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      cacheCreation1hTokens: usage.cacheCreation1hTokens,
      cacheReadTokens: usage.cacheReadTokens,
    },
    model
  );
}

export interface DayUsage extends TokenUsage {
  date: string;
  cost: number;
}

export interface ModelUsage extends TokenUsage {
  model: string;
  cost: number;
  /** How cost was derived — usage lines from transcripts vs size-based fallback. */
  costBasis: ModelCostBasis;
}

export interface CreditUsageSummary {
  byDay: DayUsage[];
  byModel: ModelUsage[];
  totalTokens: number;
  totalCost: number;
  sessionCount: number;
  daysBack: number;
  /** True when totals are filtered to a single workspace folder. */
  workspaceScoped?: boolean;
}

export function claudeProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/** date|model -> token usage for that day/model combination. */
type Buckets = Map<string, ModelBucket>;

const BUCKET_KEY_SEP = "|";

function bucketKey(date: string, model: string): string {
  return `${date}${BUCKET_KEY_SEP}${model}`;
}

function recordLine(line: string, windowStartMs: number, buckets: Buckets, sessionIds: Set<string>): void {
  const parsed = parseUsageLine(line);
  if (!parsed) {
    return;
  }

  const tsMs = new Date(parsed.timestamp).getTime();
  if (Number.isNaN(tsMs) || tsMs < windowStartMs) {
    return;
  }

  const date = localDateKey(new Date(parsed.timestamp));
  const bucket = getOrCreate(buckets, bucketKey(date, parsed.model));
  addUsage(bucket, parsed.usage);

  if (parsed.sessionId) {
    sessionIds.add(parsed.sessionId);
  }
}

function recordCursorFile(
  file: string,
  cutoffMs: number,
  windowStartMs: number,
  buckets: Buckets,
  sessionIds: Set<string>
): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return;
  }
  if (stat.mtimeMs < cutoffMs || stat.mtimeMs < windowStartMs) {
    return;
  }

  let content: string;
  try {
    content = fs.readFileSync(file, "utf-8");
  } catch {
    return;
  }

  const parsed = cursorParser.parseFile(file, content);
  if (!parsed) {
    return;
  }

  const date = localDateKey(new Date(stat.mtimeMs));
  let recorded = false;
  for (const line of content.split("\n")) {
    const usageLine = parseUsageLine(line);
    if (!usageLine) {
      continue;
    }
    const model = usageLine.model === CURSOR_TRANSCRIPT_MODEL ? CURSOR_TRANSCRIPT_MODEL : usageLine.model;
    const bucket = getOrCreate(buckets, bucketKey(date, model));
    addUsage(bucket, usageLine.usage);
    recorded = true;
  }

  if (!recorded && parsed.tokens > 0) {
    const usage: TokenUsage = {
      inputTokens: Math.round(parsed.tokens * 0.6),
      outputTokens: parsed.tokens - Math.round(parsed.tokens * 0.6),
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
    };
    const bucket = getOrCreate(buckets, bucketKey(date, CURSOR_TRANSCRIPT_MODEL));
    bucket.costBasis = "size_estimate";
    addUsage(bucket, usage);
  }
  sessionIds.add(parsed.sessionId);
}

function recordFile(
  file: string,
  cutoffMs: number,
  windowStartMs: number,
  buckets: Buckets,
  sessionIds: Set<string>,
  cursorFormat: boolean
): void {
  if (cursorFormat) {
    recordCursorFile(file, cutoffMs, windowStartMs, buckets, sessionIds);
    return;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return;
  }
  if (stat.mtimeMs < cutoffMs) {
    return;
  }

  let content: string;
  try {
    content = fs.readFileSync(file, "utf-8");
  } catch {
    return;
  }

  for (const line of content.split("\n")) {
    recordLine(line, windowStartMs, buckets, sessionIds);
  }
}

function summarizeByDay(buckets: Buckets): DayUsage[] {
  const byDay = new Map<string, { usage: TokenUsage; cost: number }>();
  for (const [key, bucket] of buckets) {
    const [date, model] = key.split(BUCKET_KEY_SEP);
    const entry = byDay.get(date) ?? { usage: emptyUsage(), cost: 0 };
    addUsage(entry.usage, bucket);
    entry.cost += estimateCost(model, bucket);
    byDay.set(date, entry);
  }
  return [...byDay.entries()]
    .map(([date, { usage, cost }]) => ({ date, ...usage, cost }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function summarizeByModel(buckets: Buckets): ModelUsage[] {
  const byModel = new Map<string, ModelBucket>();
  for (const [key, bucket] of buckets) {
    const [, model] = key.split(BUCKET_KEY_SEP);
    const target = getOrCreate(byModel, model);
    addUsage(target, bucket);
    if (bucket.costBasis === "size_estimate") {
      target.costBasis = "size_estimate";
    }
  }
  return [...byModel.entries()]
    .map(([model, bucket]) => ({
      model,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      cacheCreationTokens: bucket.cacheCreationTokens,
      cacheCreation1hTokens: bucket.cacheCreation1hTokens,
      cacheReadTokens: bucket.cacheReadTokens,
      cost: estimateCost(model, bucket),
      costBasis: bucket.costBasis,
    }))
    .sort((a, b) => totalTokens(b) - totalTokens(a));
}

/** Token and estimated cost for today (local calendar day) across all projects. */
export function computeTodayCreditUsage(): { totalTokens: number; totalCost: number } {
  const today = localDateKey();
  const summary = computeCreditUsage(1);
  const todayRow = summary.byDay.find((d) => d.date === today);
  if (!todayRow) {
    return { totalTokens: 0, totalCost: 0 };
  }
  return { totalTokens: totalTokens(todayRow), totalCost: todayRow.cost };
}

function expandTranscriptRoot(root: string): string {
  return root.startsWith("~/") ? path.join(os.homedir(), root.slice(2)) : root;
}

/** Aggregates token usage from session transcripts under the given roots. */
export function computeCreditUsageFromRoots(
  roots: string[],
  daysBack = 14,
  workspaceTarget?: string
): CreditUsageSummary {
  const cutoffMs = Date.now() - (daysBack + 1) * 24 * 60 * 60 * 1000;
  const windowStartMs = Date.now() - daysBack * 24 * 60 * 60 * 1000;

  const buckets: Buckets = new Map();
  const sessionIds = new Set<string>();

  for (const root of roots) {
    const dir = expandTranscriptRoot(root);
    const cursorFormat = isCursorTranscriptRoot(dir);
    for (const file of listTranscriptFiles(dir)) {
      if (workspaceTarget && !transcriptFileMatchesWorkspace(file, workspaceTarget)) {
        continue;
      }
      recordFile(file, cutoffMs, windowStartMs, buckets, sessionIds, cursorFormat);
    }
  }

  const byModel = summarizeByModel(buckets);
  const byDay = summarizeByDay(buckets);

  return {
    byDay,
    byModel,
    totalTokens: byModel.reduce((sum, m) => sum + totalTokens(m), 0),
    totalCost: byModel.reduce((sum, m) => sum + m.cost, 0),
    sessionCount: sessionIds.size,
    daysBack,
    workspaceScoped: Boolean(workspaceTarget),
  };
}

/** Claude Code transcripts only (under ~/.claude/projects). */
export function computeCreditUsage(daysBack = 14): CreditUsageSummary {
  return computeCreditUsageFromRoots([claudeProjectsDir()], daysBack);
}

function modelIdForHookRun(run: { agent: RunAgent; metadata?: Record<string, unknown> }): string {
  const meta = run.metadata ?? {};
  if (typeof meta.model === "string" && meta.model.trim()) {
    return meta.model;
  }
  return `skill-invoke:${run.agent}`;
}

/** Per-agent model rows from skill-invoke hooks in runs.jsonl (API-priced when usage present). */
export function aggregateHookModelUsageByAgent(
  target: string,
  daysBack: number
): Partial<Record<RunAgent, ModelUsage[]>> {
  const cutoff = Date.now() - daysBack * 86_400_000;
  const buckets = new Map<string, ModelBucket>();

  for (const run of readCachedEnrichedRuns(target)) {
    if (!isUsageRunRecord(run)) {
      continue;
    }
    if (new Date(run.ts).getTime() < cutoff) {
      continue;
    }
    const model = modelIdForHookRun(run);
    const key = `${run.agent}\0${model}`;
    const bucket = getOrCreateModelBucket(buckets, key);
    const usageRaw = run.metadata?.usage as RawUsageLike | undefined;

    if (isUsageBreakdownRun(run) && usageRaw) {
      const delta = rawUsageToDelta(usageRaw);
      if (delta) {
        addUsage(bucket, delta);
        bucket.cost += run.cost > 0 ? run.cost : estimateCost(model, delta);
        bucket.costBasis = "usage";
      }
    } else if (run.cost > 0 || run.tokens > 0) {
      const tokens = run.tokens > 0 ? run.tokens : 0;
      if (tokens > 0) {
        const input = Math.round(tokens * 0.6);
        addUsage(bucket, {
          inputTokens: input,
          outputTokens: tokens - input,
          cacheCreationTokens: 0,
          cacheCreation1hTokens: 0,
          cacheReadTokens: 0,
        });
      }
      bucket.cost += run.cost > 0 ? run.cost : estimateCost(model, bucket);
      bucket.costBasis = "usage";
    }
  }

  const byAgent: Partial<Record<RunAgent, ModelUsage[]>> = {};
  for (const [key, bucket] of buckets) {
    if (bucket.cost <= 0 && totalTokens(bucket) <= 0) {
      continue;
    }
    const [agent, model] = key.split("\0") as [RunAgent, string];
    const row: ModelUsage = {
      model,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      cacheCreationTokens: bucket.cacheCreationTokens,
      cacheCreation1hTokens: bucket.cacheCreation1hTokens,
      cacheReadTokens: bucket.cacheReadTokens,
      cost: bucket.cost,
      costBasis: bucket.costBasis,
    };
    const list = byAgent[agent] ?? [];
    list.push(row);
    byAgent[agent] = list;
  }

  for (const agent of Object.keys(byAgent) as RunAgent[]) {
    byAgent[agent]!.sort((a, b) => b.cost - a.cost);
  }
  return byAgent;
}

/** Prepend hook-measured model rows ahead of transcript estimates (e.g. Cursor size est.). */
export function mergeHookModelsIntoAgentRows<T extends { agent: RunAgent; models: ModelUsage[] }>(
  rows: T[],
  target: string | undefined,
  daysBack: number
): T[] {
  if (!target) {
    return rows;
  }
  const hookByAgent = aggregateHookModelUsageByAgent(target, daysBack);
  return rows.map((row) => {
    const hookModels = hookByAgent[row.agent];
    if (!hookModels?.length) {
      return row;
    }
    const hookModelIds = new Set(hookModels.map((m) => m.model));
    const transcriptOnly = row.models.filter((m) => !hookModelIds.has(m.model));
    return {
      ...row,
      models: [...hookModels, ...transcriptOnly].sort((a, b) => b.cost - a.cost),
    };
  });
}
