import { AgentId, loadAgentsManifest } from "./agentOps";
import { getWorkspaceHookStatus } from "./hookOps";

export interface AgentCapability {
  supportsHooks: boolean;
  supportsTokens: boolean;
  supportsTranscripts: boolean;
  hookConfigured: boolean;
  format: string;
}

export type AgentCapabilitiesSnapshot = Record<AgentId, AgentCapability>;

/** Deterministic capability map — drives fallback logic and debugging. */
export function detectAgentCapabilities(target: string, libraryDir: string): AgentCapabilitiesSnapshot {
  const manifest = loadAgentsManifest(libraryDir);
  const hookStatus = getWorkspaceHookStatus(target, libraryDir);
  const hookByAgent = new Map(
    hookStatus.attribution.agents.map((a) => [a.agent as AgentId, a.configured])
  );

  const out = {} as AgentCapabilitiesSnapshot;
  for (const [id, def] of Object.entries(manifest.agents) as [AgentId, typeof manifest.agents[AgentId]][]) {
    out[id] = {
      supportsHooks: def.supportsAttributionHooks ?? false,
      supportsTokens: def.supportsUsageTranscripts ?? false,
      supportsTranscripts: def.supportsUsageTranscripts ?? false,
      hookConfigured: hookByAgent.get(id) ?? false,
      format: def.format,
    };
  }
  return out;
}

export function formatCapabilitiesSummary(caps: AgentCapabilitiesSnapshot): string {
  return (Object.entries(caps) as [AgentId, AgentCapability][])
    .map(([id, c]) => {
      const parts = [
        c.hookConfigured ? "hooks:on" : c.supportsHooks ? "hooks:off" : "hooks:n/a",
        c.supportsTokens ? "tokens:yes" : "tokens:no",
      ];
      return `${id}(${parts.join(", ")})`;
    })
    .join("; ");
}
