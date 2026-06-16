import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadAgentsManifest } from "./agentOps";
import { listTranscriptFiles } from "./transcriptParsers";
import { estimateUsageCostFromRaw } from "./costRates";
import {
  EnrichedRunRecord,
  isV2HookRun,
  readEnrichedRunsFromFile,
  runsFilePath,
} from "./runRecording";
import { invalidateLearningCache } from "./learningStateIndex";

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** Usage block as logged on a transcript line (snake_case, as emitted by the API). */
interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** Nested 1h/5m cache-write breakdown (sums to `cache_creation_input_tokens`). */
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
  total_tokens?: number;
}

function sumUsage(u: RawUsage | undefined): number {
  if (!u) {
    return 0;
  }
  if (typeof u.total_tokens === "number") {
    return u.total_tokens;
  }
  return (
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0)
  );
}

/** Usage on a single transcript line (no deep recursion — avoids double-count). */
function lineUsageRecord(node: unknown): {
  usage: RawUsage;
  model?: string;
} | null {
  if (!node || typeof node !== "object") {
    return null;
  }
  const rec = node as Record<string, unknown>;
  let usage: RawUsage | undefined;
  let model: string | undefined;
  if (rec.usage && typeof rec.usage === "object") {
    usage = rec.usage as RawUsage;
  }
  const message = rec.message;
  if (message && typeof message === "object") {
    const msg = message as Record<string, unknown>;
    if (msg.usage && typeof msg.usage === "object") {
      usage = msg.usage as RawUsage;
    }
    if (typeof msg.model === "string") {
      model = msg.model;
    }
  }
  if (typeof rec.model === "string") {
    model = rec.model;
  }
  if (!usage || sumUsage(usage) <= 0) {
    return null;
  }
  return { usage, model };
}

function lineUsage(node: unknown): number {
  return lineUsageRecord(node) ? sumUsage(lineUsageRecord(node)!.usage) : 0;
}

export interface ToolUseEnrichment {
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    /** Portion of `cache_creation_input_tokens` written with a 1-hour TTL (billed at 2x input). */
    cache_creation_input_tokens_1h: number;
    cache_read_input_tokens: number;
  };
  model?: string;
  tokens: number;
}

function splitUsage(
  usage: RawUsage,
  parts: number
): ToolUseEnrichment["usage"] {
  const divisor = Math.max(1, parts);
  const cache1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return {
    input_tokens: Math.round((usage.input_tokens ?? 0) / divisor),
    output_tokens: Math.round((usage.output_tokens ?? 0) / divisor),
    cache_creation_input_tokens: Math.round((usage.cache_creation_input_tokens ?? 0) / divisor),
    cache_creation_input_tokens_1h: Math.round(cache1h / divisor),
    cache_read_input_tokens: Math.round((usage.cache_read_input_tokens ?? 0) / divisor),
  };
}

/** Map tool_use_id -> usage breakdown by scanning transcript JSONL (forward-looking usage). */
export function buildToolUseUsageIndex(content: string): Map<string, ToolUseEnrichment> {
  const index = new Map<string, ToolUseEnrichment>();
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("tool_use")) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      const ids = extractToolUseIds(parsed);
      if (ids.length === 0) {
        continue;
      }

      let record = lineUsageRecord(parsed);
      if (!record) {
        for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
          if (!lines[j].includes("usage")) {
            continue;
          }
          try {
            record = lineUsageRecord(JSON.parse(lines[j]) as unknown);
          } catch {
            record = null;
          }
          if (record) {
            break;
          }
        }
      }

      if (!record) {
        continue;
      }

      const split = splitUsage(record.usage, ids.length);
      const tokens = sumUsage(split);
      for (const id of ids) {
        index.set(id, { usage: split, model: record.model, tokens });
      }
    } catch {
      // skip corrupt line
    }
  }

  return index;
}

/** Collect tool_use ids from a parsed transcript line (Skill and other tools). */
export function extractToolUseIds(node: unknown): string[] {
  const ids: string[] = [];
  const walk = (current: unknown): void => {
    if (!current || typeof current !== "object") {
      return;
    }
    const rec = current as Record<string, unknown>;
    if (rec.type === "tool_use" && typeof rec.id === "string") {
      ids.push(rec.id);
    }
    for (const value of Object.values(rec)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          walk(item);
        }
      } else if (value && typeof value === "object") {
        walk(value);
      }
    }
  };
  walk(node);
  return [...new Set(ids)];
}

/** Map tool_use_id -> tokens by scanning transcript JSONL (forward-looking usage). */
export function buildToolUseTokenIndex(content: string): Map<string, number> {
  const index = new Map<string, number>();
  for (const [id, enrichment] of buildToolUseUsageIndex(content)) {
    index.set(id, enrichment.tokens);
  }
  return index;
}

function transcriptMatchesSession(content: string, sessionId: string): boolean {
  if (!sessionId || sessionId.length < 8) {
    return false;
  }
  const escaped = sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fields = ["sessionId", "session_id", "conversationId", "conversation_id"];
  const patterns = fields.map((field) => new RegExp(`"${field}"\\s*:\\s*"${escaped}"`));
  return patterns.some((re) => re.test(content));
}

function indexTranscriptsForSessions(
  transcriptRoots: string[],
  sessionIds: Set<string>,
  sessionIndexes: Map<string, Map<string, ToolUseEnrichment>>
): void {
  for (const root of transcriptRoots) {
    const expanded = expandHome(root);
    for (const file of listTranscriptFiles(expanded)) {
      let content = "";
      try {
        content = fs.readFileSync(file, "utf-8");
      } catch {
        continue;
      }

      const matchedSessions = [...sessionIds].filter((sid) => transcriptMatchesSession(content, sid));
      if (matchedSessions.length === 0) {
        continue;
      }

      const fileIndex = buildToolUseUsageIndex(content);
      if (fileIndex.size === 0) {
        continue;
      }

      for (const sid of matchedSessions) {
        const existing = sessionIndexes.get(sid) ?? new Map<string, ToolUseEnrichment>();
        mergeUsageIndexes(existing, fileIndex);
        sessionIndexes.set(sid, existing);
      }
    }
  }
}

function mergeUsageIndexes(into: Map<string, ToolUseEnrichment>, from: Map<string, ToolUseEnrichment>): void {
  for (const [id, enrichment] of from) {
    into.set(id, enrichment);
  }
}

/** Backfill tokens on v2 hook rows using transcript tool_use_id usage. Returns rows updated. */
export function enrichV2HookRunTokens(target: string, libraryDir: string): number {
  const runsFile = runsFilePath(target);
  const records = readEnrichedRunsFromFile(runsFile);
  const pending = records.filter(
    (r) =>
      isV2HookRun(r) &&
      typeof r.metadata?.tool_use_id === "string" &&
      r.metadata.tool_use_id.length > 0 &&
      ((r.tokens ?? 0) <= 0 || !r.metadata?.usage)
  );
  if (pending.length === 0) {
    return 0;
  }

  const sessionIds = new Set(pending.map((r) => r.session_id));
  const sessionIndexes = new Map<string, Map<string, ToolUseEnrichment>>();

  const agents = loadAgentsManifest(libraryDir).agents;
  for (const agentDef of Object.values(agents)) {
    if (!agentDef?.supportsUsageTranscripts || !agentDef.transcriptRoots?.length) {
      continue;
    }
    indexTranscriptsForSessions(agentDef.transcriptRoots, sessionIds, sessionIndexes);
  }

  let enriched = 0;
  const updated: EnrichedRunRecord[] = records.map((record) => {
    if (!isV2HookRun(record)) {
      return record;
    }
    const toolUseId = record.metadata?.tool_use_id;
    if (typeof toolUseId !== "string" || !toolUseId) {
      return record;
    }
    const enrichment = sessionIndexes.get(record.session_id)?.get(toolUseId);
    if (!enrichment || enrichment.tokens <= 0) {
      return record;
    }
    if ((record.tokens ?? 0) > 0 && record.metadata?.usage) {
      return record;
    }
    enriched += 1;
    const cost = estimateUsageCostFromRaw(enrichment.usage, enrichment.model);
    return {
      ...record,
      tokens: enrichment.tokens,
      cost,
      metadata: {
        ...record.metadata,
        usage: enrichment.usage,
        model: enrichment.model,
        tokens_enriched: true,
        enriched_from: "transcript",
        cost_method: "usage_breakdown",
      },
    };
  });

  if (enriched > 0) {
    fs.writeFileSync(runsFile, updated.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
    invalidateLearningCache(target);
  }

  return enriched;
}
