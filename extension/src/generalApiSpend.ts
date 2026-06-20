import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentId, loadAgentsManifest } from "./agentOps";
import { buildCostAttribution } from "./costAttribution";
import { tokenCostUsd } from "./costRates";
import { readCachedEnrichedRuns } from "./runsStore";
import { isV2HookRun, sessionHasV2HookRuns, RunAgent } from "./runsStore";
import { claudeParser, cursorParser, listTranscriptFiles, ParsedTranscript } from "./transcriptParsers";
import { transcriptFileMatchesWorkspace } from "./workspaceTranscripts";

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** Sum v2 hook tokens logged for a session (optionally per agent). */
export function hookTokensForSession(target: string, sessionId: string, agent?: RunAgent): number {
  return readCachedEnrichedRuns(target)
    .filter(
      (r) =>
        isV2HookRun(r) &&
        r.session_id === sessionId &&
        (!agent || r.agent === agent)
    )
    .reduce((sum, r) => sum + Math.max(0, r.tokens ?? 0), 0);
}

/** Session tokens not attributed to skill-invoke hooks. */
export function residualGeneralApiTokens(sessionTokens: number, hookTokens: number): number {
  return Math.max(0, sessionTokens - hookTokens);
}

/**
 * General API tokens for one parsed transcript session:
 * - With hooks: session total minus hook-measured skill invokes.
 * - Without hooks and no skill reads: full session (base model / own knowledge).
 * - Without hooks but transcript skill paths detected: 0 (legacy equal-split territory).
 */
export function generalApiTokensForSession(parsed: ParsedTranscript, target: string): number {
  const hookTokens = hookTokensForSession(target, parsed.sessionId, parsed.agent);
  if (hookTokens > 0 || sessionHasV2HookRuns(target, parsed.sessionId)) {
    return residualGeneralApiTokens(parsed.tokens, hookTokens);
  }
  if (parsed.activeSkills.length === 0) {
    return parsed.tokens;
  }
  return 0;
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
  /** Pre-fix collector bucket — shown as legacy note when non-zero. */
  legacyUnattributedTokens: number;
}

function parserForAgent(agent: AgentId) {
  if (agent === "claude") {
    return claudeParser;
  }
  if (agent === "cursor") {
    return cursorParser;
  }
  return null;
}

/** 14d (or custom) general API spend from session transcripts minus hook skill invokes. */
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
        if (!transcriptFileMatchesWorkspace(file, target)) {
          continue;
        }
        let mtime = 0;
        try {
          mtime = fs.statSync(file).mtimeMs;
        } catch {
          continue;
        }
        if (mtime < windowStartMs) {
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

        const sessionKey = `${parsed.agent}|${parsed.sessionId}|${file}`;
        if (seenSessions.has(sessionKey)) {
          continue;
        }
        seenSessions.add(sessionKey);

        const general = generalApiTokensForSession(parsed, target);
        if (general <= 0) {
          continue;
        }

        const agent = parsed.agent;
        const row = byAgent[agent] ?? { tokens: 0, cost: 0, sessions: 0 };
        row.tokens += general;
        row.cost += tokenCostUsd(general);
        row.sessions += 1;
        byAgent[agent] = row;
        totalTokens += general;
        sessionCount += 1;
      }
    }
  }

  const built = buildCostAttribution(target, libraryDir);
  const legacyUnattributedTokens = Object.values(built.unattributed).reduce((s, t) => s + (t ?? 0), 0);

  return {
    daysBack,
    totalTokens,
    totalCost: tokenCostUsd(totalTokens),
    sessionCount,
    byAgent,
    legacyUnattributedTokens,
  };
}
