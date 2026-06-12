import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadAgentsManifest } from "./agentOps";
import { listTranscriptFiles } from "./transcriptParsers";
import {
  EnrichedRunRecord,
  isV2HookRun,
  readEnrichedRunsFromFile,
  runsFilePath,
  tokenCostUsd,
} from "./runRecording";
import { invalidateLearningCache } from "./learningStateIndex";

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function sumUsage(u: Record<string, number> | undefined): number {
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
function lineUsage(node: unknown): number {
  if (!node || typeof node !== "object") {
    return 0;
  }
  const rec = node as Record<string, unknown>;
  let total = 0;
  if (rec.usage && typeof rec.usage === "object") {
    total += sumUsage(rec.usage as Record<string, number>);
  }
  const message = rec.message;
  if (message && typeof message === "object") {
    const msg = message as Record<string, unknown>;
    if (msg.usage && typeof msg.usage === "object") {
      total += sumUsage(msg.usage as Record<string, number>);
    }
  }
  return total;
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

      let usage = lineUsage(parsed);
      if (usage <= 0) {
        for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
          if (!lines[j].includes("usage")) {
            continue;
          }
          try {
            usage = lineUsage(JSON.parse(lines[j]) as unknown);
          } catch {
            usage = 0;
          }
          if (usage > 0) {
            break;
          }
        }
      }

      if (usage <= 0) {
        continue;
      }

      const perId = Math.max(1, Math.round(usage / ids.length));
      for (const id of ids) {
        index.set(id, (index.get(id) ?? 0) + perId);
      }
    } catch {
      // skip corrupt line
    }
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
  sessionIndexes: Map<string, Map<string, number>>
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

      const fileIndex = buildToolUseTokenIndex(content);
      if (fileIndex.size === 0) {
        continue;
      }

      for (const sid of matchedSessions) {
        const existing = sessionIndexes.get(sid) ?? new Map<string, number>();
        mergeIndexes(existing, fileIndex);
        sessionIndexes.set(sid, existing);
      }
    }
  }
}

function mergeIndexes(into: Map<string, number>, from: Map<string, number>): void {
  for (const [id, tokens] of from) {
    into.set(id, (into.get(id) ?? 0) + tokens);
  }
}

/** Backfill tokens on v2 hook rows using transcript tool_use_id usage. Returns rows updated. */
export function enrichV2HookRunTokens(target: string, libraryDir: string): number {
  const runsFile = runsFilePath(target);
  const records = readEnrichedRunsFromFile(runsFile);
  const pending = records.filter(
    (r) =>
      isV2HookRun(r) &&
      (r.tokens ?? 0) <= 0 &&
      typeof r.metadata?.tool_use_id === "string" &&
      r.metadata.tool_use_id.length > 0
  );
  if (pending.length === 0) {
    return 0;
  }

  const sessionIds = new Set(pending.map((r) => r.session_id));
  const sessionIndexes = new Map<string, Map<string, number>>();

  const agents = loadAgentsManifest(libraryDir).agents;
  for (const agentDef of Object.values(agents)) {
    if (!agentDef?.supportsUsageTranscripts || !agentDef.transcriptRoots?.length) {
      continue;
    }
    indexTranscriptsForSessions(agentDef.transcriptRoots, sessionIds, sessionIndexes);
  }

  let enriched = 0;
  const updated: EnrichedRunRecord[] = records.map((record) => {
    if (!isV2HookRun(record) || (record.tokens ?? 0) > 0) {
      return record;
    }
    const toolUseId = record.metadata?.tool_use_id;
    if (typeof toolUseId !== "string" || !toolUseId) {
      return record;
    }
    const tokens = sessionIndexes.get(record.session_id)?.get(toolUseId) ?? 0;
    if (tokens <= 0) {
      return record;
    }
    enriched += 1;
    return {
      ...record,
      tokens,
      cost: tokenCostUsd(tokens),
      metadata: { ...record.metadata, tokens_enriched: true, enriched_from: "transcript" },
    };
  });

  if (enriched > 0) {
    fs.writeFileSync(runsFile, updated.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
    invalidateLearningCache(target);
  }

  return enriched;
}
