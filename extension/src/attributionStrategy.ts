import { AgentId, loadAgentsManifest } from "./agentOps";
import { getWorkspaceHookStatus, WorkspaceHookStatus } from "./hookOps";
import { ConfidenceLevel } from "./attributionConfidence";

/** How per-skill cost was resolved — ordered from most to least trustworthy. */
export type AttributionTier = "hooks" | "transcripts" | "heuristics";

export interface AttributionStrategy {
  tier: AttributionTier;
  confidence: ConfidenceLevel;
  /** Agents with v2 PostToolUse hooks installed for this workspace. */
  hookedAgents: AgentId[];
  /** Agents that support transcript-based token totals. */
  transcriptAgents: AgentId[];
  summary: string;
}

function tierFromStatus(status: WorkspaceHookStatus, transcriptAgents: AgentId[]): AttributionTier {
  const hooked = status.attribution.agents.filter((a) => a.applicable && a.configured);
  if (hooked.length > 0) {
    return "hooks";
  }
  if (transcriptAgents.length > 0) {
    return "transcripts";
  }
  return "heuristics";
}

function confidenceForTier(tier: AttributionTier, hookedCount: number, transcriptCount: number): ConfidenceLevel {
  if (tier === "hooks" && hookedCount >= 2) {
    return "high";
  }
  if (tier === "hooks" || (tier === "transcripts" && transcriptCount >= 1)) {
    return "estimated";
  }
  return "low";
}

/** Formal fallback: hooks → transcripts → install-tier heuristics. */
export function resolveAttributionStrategy(target: string, libraryDir: string): AttributionStrategy {
  const status = getWorkspaceHookStatus(target, libraryDir);
  const manifest = loadAgentsManifest(libraryDir);
  const transcriptAgents = (Object.entries(manifest.agents) as [AgentId, { supportsUsageTranscripts?: boolean }][])
    .filter(([, def]) => def.supportsUsageTranscripts)
    .map(([id]) => id);

  const hookedAgents = status.attribution.agents
    .filter((a) => a.applicable && a.configured)
    .map((a) => a.agent as AgentId);
  const tier = tierFromStatus(status, transcriptAgents);
  const confidence = confidenceForTier(tier, hookedAgents.length, transcriptAgents.length);

  let summary: string;
  switch (tier) {
    case "hooks":
      summary = `Primary: v2 hooks (${hookedAgents.join(", ") || "none"}). Fallback: session transcripts, then tier heuristics.`;
      break;
    case "transcripts":
      summary = `Primary: session transcripts (${transcriptAgents.join(", ")}). Per-skill split is best-effort without hooks.`;
      break;
    default:
      summary = "Primary: install-tier cost heuristics only — enable attribution hooks for measured per-skill data.";
  }

  return { tier, confidence, hookedAgents, transcriptAgents, summary };
}

export function formatAttributionStrategyLine(strategy: AttributionStrategy): string {
  return `Attribution: ${strategy.tier} (confidence: ${strategy.confidence}) — ${strategy.summary}`;
}
