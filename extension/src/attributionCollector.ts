import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentId, loadAgentsManifest } from "./agentOps";
import { COST_ATTRIBUTION_PATH } from "./costAttribution";
import { appendSkillRun, tokenCostUsd } from "./runRecording";
import { claudeParser, cursorParser, listTranscriptFiles, ParsedTranscript, TranscriptParser } from "./transcriptParsers";

const COLLECTOR_STATE_PATH = path.join(os.homedir(), ".claude", "learning", "attribution-collector-state.json");
const COLLECTION_INTERVAL_MS = 5 * 60 * 1000;

export interface CollectorState {
  lastRun: number;
  fileMtimes: Record<string, number>;
  /** sessionId|filePath -> mtime when runs.jsonl row was written (prevents double count). */
  processedSessions?: Record<string, number>;
}

export interface AttributionStore {
  updatedAt: string;
  workspacePath?: string;
  /** Incremental attribution from parsed transcripts (collector-owned). */
  transcriptSkills: Record<string, Partial<Record<AgentId, { tokens: number; cost: number; sessions: number }>>>;
  base_context: Partial<Record<AgentId, number>>;
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function readCollectorState(): CollectorState {
  try {
    return JSON.parse(fs.readFileSync(COLLECTOR_STATE_PATH, "utf-8")) as CollectorState;
  } catch {
    return { lastRun: 0, fileMtimes: {}, processedSessions: {} };
  }
}

function writeCollectorState(state: CollectorState): void {
  fs.mkdirSync(path.dirname(COLLECTOR_STATE_PATH), { recursive: true });
  fs.writeFileSync(COLLECTOR_STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function loadAttribution(): AttributionStore {
  try {
    const raw = JSON.parse(fs.readFileSync(COST_ATTRIBUTION_PATH, "utf-8")) as {
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
    };
  } catch {
    return { updatedAt: new Date().toISOString(), transcriptSkills: {}, base_context: {} };
  }
}

function saveAttribution(store: AttributionStore): void {
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(COST_ATTRIBUTION_PATH, "utf-8")) as Record<string, unknown>;
  } catch {
    // fresh file
  }
  const data = {
    ...existing,
    updatedAt: new Date().toISOString(),
    workspacePath: store.workspacePath,
    transcriptSkills: store.transcriptSkills,
    base_context: store.base_context,
  };
  fs.mkdirSync(path.dirname(COST_ATTRIBUTION_PATH), { recursive: true });
  fs.writeFileSync(COST_ATTRIBUTION_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
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

function updateAttribution(store: AttributionStore, parsed: ParsedTranscript): void {
  const { agent, tokens, skills } = parsed;
  if (tokens <= 0) {
    return;
  }

  if (skills.length === 0) {
    store.base_context[agent] = (store.base_context[agent] ?? 0) + tokens;
    return;
  }

  const perSkill = tokens / skills.length;
  const perSkillCost = tokenCostUsd(perSkill);
  for (const skill of skills) {
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

  const skills = parsed.skills.length > 0 ? parsed.skills : ["base_context"];
  const perSkill = Math.round(parsed.tokens / skills.length);

  for (const skill of skills) {
    appendSkillRun(target, {
      skill,
      agent: parsed.agent,
      tokens: perSkill,
      success: true,
      action: "transcript",
      session_id: parsed.sessionId,
      metadata: { source: "attribution-collector", file: parsed.filePath },
    });
  }
}

export class AttributionCollector {
  private static instance: AttributionCollector | undefined;
  private lastRun = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  private constructor(
    private target: string,
    private libraryDir: string
  ) {}

  static getInstance(target: string, libraryDir: string): AttributionCollector {
    if (!AttributionCollector.instance) {
      AttributionCollector.instance = new AttributionCollector(target, libraryDir);
    } else {
      AttributionCollector.instance.target = target;
      AttributionCollector.instance.libraryDir = libraryDir;
    }
    return AttributionCollector.instance;
  }

  start(): void {
    void this.collect(true);
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.collect();
    }, COLLECTION_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  static stopAll(): void {
    AttributionCollector.instance?.stop();
    AttributionCollector.instance = undefined;
  }

  async collect(force = false): Promise<number> {
    const now = Date.now();
    if (!force && now - this.lastRun < COLLECTION_INTERVAL_MS) {
      return 0;
    }

    const state = readCollectorState();
    const since = state.lastRun || now - 24 * 60 * 60 * 1000;
    const store = loadAttribution();
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

          updateAttribution(store, parsed);
          appendRunsForWorkspace(this.target, parsed, content);
          state.fileMtimes[file] = mtime;
          state.processedSessions[sessionKey] = mtime;
          processed += 1;
        }
      }
    }

    state.lastRun = now;
    writeCollectorState(state);
    saveAttribution(store);
    this.lastRun = now;
    return processed;
  }
}
