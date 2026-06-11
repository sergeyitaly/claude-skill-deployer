import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentId, loadAgentsManifest } from "./agentOps";
import { costAttributionPath, migrateLegacyCostAttribution } from "./costAttribution";
import { readCollectorState, writeCollectorState } from "./collectorState";
import { tokenCostUsd } from "./costRates";
import { enrichV2HookRunTokens } from "./v2TokenEnrichment";
import { appendSkillRun, sessionHasV2HookRuns } from "./runRecording";
import { claudeParser, cursorParser, listTranscriptFiles, ParsedTranscript, TranscriptParser } from "./transcriptParsers";

const COLLECTION_INTERVAL_MS = 5 * 60 * 1000;

export type { CollectorState } from "./collectorState";

export interface AttributionStore {
  updatedAt: string;
  workspacePath?: string;
  /** Incremental attribution from parsed transcripts (collector-owned). */
  transcriptSkills: Record<string, Partial<Record<AgentId, { tokens: number; cost: number; sessions: number }>>>;
  base_context: Partial<Record<AgentId, number>>;
  /** Tokens that could not be attributed to a specific invoked skill. */
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
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(attrPath, "utf-8")) as Record<string, unknown>;
  } catch {
    // fresh file
  }
  const data = {
    ...existing,
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

function transcriptWorkspace(filePath: string, content: string): string | null {
  for (const line of content.split("\n")) {
    if (!line.includes('"cwd"')) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as { cwd?: string };
      if (parsed.cwd) {
        return path.resolve(parsed.cwd);
      }
    } catch {
      // skip
    }
  }
  const parts = filePath.replace(/\\/g, "/").split("/");
  const projectsIdx = parts.indexOf("projects");
  if (projectsIdx >= 0 && parts[projectsIdx + 1]) {
    const encoded = parts[projectsIdx + 1];
    if (encoded.startsWith("c--")) {
      return path.resolve(encoded.slice(2).replace(/-/g, path.sep));
    }
  }
  return null;
}

function updateAttribution(store: AttributionStore, parsed: ParsedTranscript, target: string): void {
  const { agent, tokens, activeSkills } = parsed;
  if (tokens <= 0) {
    return;
  }

  store.unattributed = store.unattributed ?? {};

  if (sessionHasV2HookRuns(target, parsed.sessionId)) {
    store.unattributed[agent] = (store.unattributed[agent] ?? 0) + tokens;
    return;
  }

  if (activeSkills.length === 0) {
    store.unattributed[agent] = (store.unattributed[agent] ?? 0) + tokens;
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

function appendRunsForWorkspace(target: string, parsed: ParsedTranscript, content: string): void {
  const ws = transcriptWorkspace(parsed.filePath, content);
  if (!ws || path.resolve(ws) !== path.resolve(target)) {
    return;
  }

  if (sessionHasV2HookRuns(target, parsed.sessionId)) {
    return;
  }

  if (parsed.activeSkills.length === 0) {
    appendSkillRun(target, {
      skill: "unattributed",
      agent: parsed.agent,
      tokens: parsed.tokens,
      success: true,
      action: "transcript",
      session_id: parsed.sessionId,
      metadata: { source: "attribution-collector", file: parsed.filePath, invoked: false },
    });
    return;
  }

  const perSkill = Math.round(parsed.tokens / parsed.activeSkills.length);
  for (const skill of parsed.activeSkills) {
    appendSkillRun(target, {
      skill,
      agent: parsed.agent,
      tokens: perSkill,
      success: true,
      action: "transcript",
      session_id: parsed.sessionId,
      metadata: { source: "attribution-collector", file: parsed.filePath, invoked: true },
    });
  }
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

  async collect(force = false): Promise<number> {
    const now = Date.now();
    if (!force && now - this.lastRun < COLLECTION_INTERVAL_MS) {
      return 0;
    }

    enrichV2HookRunTokens(this.target, this.libraryDir);

    const state = readCollectorState(this.target);
    const since = state.lastRun || now - 24 * 60 * 60 * 1000;
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

          const parsed = parser.parseFile(file);
          if (!parsed || parsed.tokens <= 0) {
            continue;
          }

          state.processedSessions = state.processedSessions ?? {};
          const sessionKey = `${parsed.sessionId}|${file}`;
          const alreadyProcessed = state.processedSessions[sessionKey] === mtime;
          if (alreadyProcessed) {
            continue;
          }

          updateAttribution(store, parsed, this.target);
          appendRunsForWorkspace(this.target, parsed, content);
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
    this.lastRun = now;
    return processed;
  }
}
