import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { estimateUsageCostUsd } from "./costRates";
import { localDateKey } from "./localDate";
import { listTranscriptFiles } from "./transcriptParsers";
import { transcriptFileMatchesWorkspace } from "./workspaceTranscripts";

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

function addUsage(target: TokenUsage, delta: TokenUsage): void {
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cacheCreationTokens += delta.cacheCreationTokens;
  target.cacheReadTokens += delta.cacheReadTokens;
}

function totalTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
}

function getOrCreate(map: Map<string, TokenUsage>, key: string): TokenUsage {
  let usage = map.get(key);
  if (!usage) {
    usage = emptyUsage();
    map.set(key, usage);
  }
  return usage;
}

function estimateCost(model: string, usage: TokenUsage): number {
  return estimateUsageCostUsd(
    {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
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

interface TranscriptLine {
  timestamp?: string;
  sessionId?: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

/** date|model -> token usage for that day/model combination. */
type Buckets = Map<string, TokenUsage>;

const BUCKET_KEY_SEP = "|";

function bucketKey(date: string, model: string): string {
  return `${date}${BUCKET_KEY_SEP}${model}`;
}

function recordLine(line: string, windowStartMs: number, buckets: Buckets, sessionIds: Set<string>): void {
  if (!line.includes('"usage"')) {
    return;
  }
  let parsed: TranscriptLine;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }

  const usage = parsed.message?.usage;
  const model = parsed.message?.model;
  const timestamp = parsed.timestamp;
  if (!usage || !model || !timestamp) {
    return;
  }
  const tsMs = new Date(timestamp).getTime();
  if (Number.isNaN(tsMs) || tsMs < windowStartMs) {
    return;
  }

  const delta: TokenUsage = {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  };
  if (totalTokens(delta) === 0) {
    // Synthetic/placeholder messages (e.g. model "<synthetic>") carry an
    // all-zero usage block and would otherwise show up as noise rows.
    return;
  }

  const date = localDateKey(new Date(timestamp));
  addUsage(getOrCreate(buckets, bucketKey(date, model)), delta);

  if (parsed.sessionId) {
    sessionIds.add(parsed.sessionId);
  }
}

function recordFile(file: string, cutoffMs: number, windowStartMs: number, buckets: Buckets, sessionIds: Set<string>): void {
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
  for (const [key, usage] of buckets) {
    const [date, model] = key.split(BUCKET_KEY_SEP);
    const entry = byDay.get(date) ?? { usage: emptyUsage(), cost: 0 };
    addUsage(entry.usage, usage);
    entry.cost += estimateCost(model, usage);
    byDay.set(date, entry);
  }
  return [...byDay.entries()]
    .map(([date, { usage, cost }]) => ({ date, ...usage, cost }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function summarizeByModel(buckets: Buckets): ModelUsage[] {
  const byModel = new Map<string, TokenUsage>();
  for (const [key, usage] of buckets) {
    const [, model] = key.split(BUCKET_KEY_SEP);
    addUsage(getOrCreate(byModel, model), usage);
  }
  return [...byModel.entries()]
    .map(([model, usage]) => ({ model, ...usage, cost: estimateCost(model, usage) }))
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
    for (const file of listTranscriptFiles(dir)) {
      if (workspaceTarget && !transcriptFileMatchesWorkspace(file, workspaceTarget)) {
        continue;
      }
      recordFile(file, cutoffMs, windowStartMs, buckets, sessionIds);
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
