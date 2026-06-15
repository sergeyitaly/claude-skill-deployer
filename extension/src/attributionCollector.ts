import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentId, loadAgentsManifest } from "./agentOps";
import { costAttributionPath, migrateLegacyCostAttribution } from "./costAttribution";
import { readCollectorState, writeCollectorState } from "./collectorState";
import { tokenCostUsd } from "./costRates";
import { enrichV2HookRunTokens } from "./v2TokenEnrichment";
import { markPipelineCollected } from "./pipelineCycle";
import { scheduleCostPipelineSync } from "./costPipelineScheduler";
import { maybePromoteIgnoredSkillsOnUnderuse } from "./taskSkillUnderuse";
import { generalApiTokensForSession } from "./generalApiSpend";
import { invalidateTranscriptUsageCache } from "./transcriptUsageIndex";
import { claudeParser, cursorParser, listTranscriptFiles, ParsedTranscript, TranscriptParser } from "./transcriptParsers";
import { transcriptFileMatchesWorkspace } from "./workspaceTranscripts";

const COLLECTION_INTERVAL_MS = 5 * 60 * 1000;

export type { CollectorState } from "./collectorState";

export interface AttributionStore {
  updatedAt: string;
  workspacePath?: string;
  /** Incremental attribution from parsed transcripts (collector-owned). */
  transcriptSkills: Record<string, Partial<Record<AgentId, { tokens: number; cost: number; sessions: number }>>>;
  base_context: Partial<Record<AgentId, number>>;
  /** @deprecated Pre-1.0.49 collector bucket — reset mis-attributed data to clear. */
  unattributed: Partial<Record<AgentId, number>>;
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function loadAttribution(target: string): AttributionStore {
  migrateLegacyCostAttribution(target);
  const attrPath = costAttributionPath(target);
  try {
    const raw = JSON.parse(fs.readFileSync(attrPath, "utf-8")) as {
      transcriptSkills?: AttributionStore["transcriptSkills"];
      skills?: AttributionStore["transcriptSkills"];
      base_context?: AttributionStore["base_context"];
      workspacePath?: string;
      updatedAt?: string;
    };
    return {
      updatedAt: raw.updatedAt ?? new Date().toISOString(),
      workspacePath: raw.workspacePath,
      transcriptSkills: raw.transcriptSkills ?? raw.skills ?? {},
      base_context: raw.base_context ?? {},
      unattributed: (raw as { unattributed?: Partial<Record<AgentId, number>> }).unattributed ?? {},
    };
  } catch {
    return { updatedAt: new Date().toISOString(), transcriptSkills: {}, base_context: {}, unattributed: {} };
  }
}

function saveAttribution(target: string, store: AttributionStore): void {
  const attrPath = costAttributionPath(target);
  const data = {
    updatedAt: new Date().toISOString(),
    workspacePath: store.workspacePath ?? target,
    transcriptSkills: store.transcriptSkills,
    base_context: store.base_context,
    unattributed: store.unattributed,
  };
  fs.mkdirSync(path.dirname(attrPath), { recursive: true });
  fs.writeFileSync(attrPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function parserForAgent(agent: AgentId): TranscriptParser | null {
  if (agent === "claude") {
    return claudeParser;
  }
  if (agent === "cursor") {
    return cursorParser;
  }
  return null;
}

function addBaseContext(store: AttributionStore, agent: AgentId, tokens: number): void {
  store.base_context = store.base_context ?? {};
  store.base_context[agent] = (store.base_context[agent] ?? 0) + tokens;
}

/** Exported for unit tests — applies one parsed transcript to the attribution store. */
export function applyTranscriptAttribution(
  store: AttributionStore,
  parsed: ParsedTranscript,
  target: string
): void {
  const { agent, tokens, activeSkills } = parsed;
  if (tokens <= 0) {
    return;
  }

  const general = generalApiTokensForSession(parsed, target);
  if (general > 0) {
    addBaseContext(store, agent, general);
    return;
  }

  if (activeSkills.length === 0) {
    return;
  }

  const perSkill = tokens / activeSkills.length;
  const perSkillCost = tokenCostUsd(perSkill);
  for (const skill of activeSkills) {
    const skillMap = store.transcriptSkills[skill] ?? {};
    const bucket = skillMap[agent] ?? { tokens: 0, cost: 0, sessions: 0 };
    bucket.tokens += perSkill;
    bucket.cost += perSkillCost;
    bucket.sessions += 1;
    skillMap[agent] = bucket;
    store.transcriptSkills[skill] = skillMap;
  }
}

function updateAttribution(store: AttributionStore, parsed: ParsedTranscript, target: string): void {
  applyTranscriptAttribution(store, parsed, target);
}

export class AttributionCollector {
  private static readonly instances = new Map<string, AttributionCollector>();
  private static interval: ReturnType<typeof setInterval> | undefined;
  private static activeTarget: string | undefined;
  private static sharedLibraryDir = "";

  private lastRun = 0;

  private constructor(
    private readonly target: string,
    private libraryDir: string
  ) {}

  static getInstance(target: string, libraryDir: string): AttributionCollector {
    const key = path.normalize(target);
    AttributionCollector.setActiveTarget(key, libraryDir);
    let inst = AttributionCollector.instances.get(key);
    if (!inst) {
      inst = new AttributionCollector(key, libraryDir);
      AttributionCollector.instances.set(key, inst);
    } else {
      inst.libraryDir = libraryDir;
    }
    return inst;
  }

  /** Track which workspace the periodic collector should run for. */
  static setActiveTarget(target: string | undefined, libraryDir: string): void {
    AttributionCollector.activeTarget = target ? path.normalize(target) : undefined;
    AttributionCollector.sharedLibraryDir = libraryDir;
  }

  start(): void {
    void this.collect(true);
    if (AttributionCollector.interval) {
      return;
    }
    AttributionCollector.interval = setInterval(() => {
      const key = AttributionCollector.activeTarget;
      if (!key) {
        return;
      }
      const inst = AttributionCollector.instances.get(key);
      if (inst) {
        void inst.collect();
      }
    }, COLLECTION_INTERVAL_MS);
  }

  stop(): void {
    // Interval stopped globally via stopAll()
  }

  static stopAll(): void {
    if (AttributionCollector.interval) {
      clearInterval(AttributionCollector.interval);
      AttributionCollector.interval = undefined;
    }
    AttributionCollector.instances.clear();
    AttributionCollector.activeTarget = undefined;
  }

  async collect(force = false, opts?: { schedulePipeline?: boolean }): Promise<number> {
    const now = Date.now();
    if (!force && now - this.lastRun < COLLECTION_INTERVAL_MS) {
      return 0;
    }

    enrichV2HookRunTokens(this.target, this.libraryDir);

    const state = readCollectorState(this.target);
    const since = force ? 0 : state.lastRun || now - 24 * 60 * 60 * 1000;
    const store = loadAttribution(this.target);
    store.workspacePath = this.target;
    let processed = 0;

    const agents = loadAgentsManifest(this.libraryDir).agents;
    for (const [agentId, def] of Object.entries(agents)) {
      if (!def.supportsUsageTranscripts) {
        continue;
      }
      const parser = parserForAgent(agentId as AgentId);
      if (!parser) {
        continue;
      }
      for (const root of def.transcriptRoots) {
        const expanded = expandHome(root);
        for (const file of listTranscriptFiles(expanded)) {
          if (!transcriptFileMatchesWorkspace(file, this.target)) {
            continue;
          }
          let mtime = 0;
          try {
            mtime = fs.statSync(file).mtimeMs;
          } catch {
            continue;
          }
          if (mtime < since && state.fileMtimes[file] === mtime) {
            continue;
          }

          let content = "";
          try {
            content = fs.readFileSync(file, "utf-8");
          } catch {
            continue;
          }

          const parsed = parser.parseFile(file, content);
          if (!parsed || parsed.tokens <= 0) {
            continue;
          }

          state.processedSessions = state.processedSessions ?? {};
          const sessionKey = `${parsed.sessionId}|${file}`;
          const alreadyProcessed = !force && state.processedSessions[sessionKey] === mtime;
          if (alreadyProcessed) {
            continue;
          }

          updateAttribution(store, parsed, this.target);
          state.fileMtimes[file] = mtime;
          state.processedSessions[sessionKey] = mtime;
          processed += 1;
        }
      }
    }

    state.lastRun = now;
    state.workspacePath = this.target;
    writeCollectorState(this.target, state);
    saveAttribution(this.target, store);
    invalidateTranscriptUsageCache(this.target);
    markPipelineCollected(this.target);
    maybePromoteIgnoredSkillsOnUnderuse(this.target, this.libraryDir);
    if (opts?.schedulePipeline !== false) {
      scheduleCostPipelineSync(this.target, this.libraryDir);
    }
    this.lastRun = now;
    return processed;
  }
}
