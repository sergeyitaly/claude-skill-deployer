import * as path from "node:path";
import { assessAttributionHealth } from "./attributionHealth";
import { detectAgentCapabilities, AgentCapabilitiesSnapshot } from "./agentCapabilities";
import { buildSystemModeContext } from "./systemMode";
import { getWorkspaceHookStatus } from "./hookOps";
import {
  profileInitRequestPending,
  readBranchProfileInit,
  readProfileInitRequest,
} from "./profileInit";
import { writeJsonAtomic, readJsonFile } from "./fileWriteCoordination";
import { markPipelineAnalyzed, PipelineCycleTimestamps, readPipelineCycle } from "./pipelineCycle";
import { SystemMode } from "./systemMode";

export type ProfileInitState = "idle" | "pending" | "applied" | "failed";
export type AttributionStatus = "healthy" | "degraded" | "broken";

export interface WorkspaceSystemState {
  version: 1;
  updatedAt: string;
  profileInit: ProfileInitState;
  attribution: {
    status: AttributionStatus;
    confidence: number;
    reliable: boolean;
  };
  hooks: {
    installed: boolean;
    allConfigured: boolean;
    lastSync: string;
  };
  capabilities: AgentCapabilitiesSnapshot;
  lastCycle: PipelineCycleTimestamps;
  systemMode: SystemMode;
}

export function systemStatePath(target: string): string {
  return path.join(target, ".claude", "learning", "system-state.json");
}

function resolveProfileInitState(target: string): ProfileInitState {
  const profile = readBranchProfileInit(target);
  const request = readProfileInitRequest(target);

  if (profile?.status === "applied" && profile.skills.length > 0) {
    return "applied";
  }
  if (profileInitRequestPending(target) || profile?.status === "pending") {
    if (profile?.status === "pending" && profile.skills.length === 0 && request?.status === "completed") {
      return "failed";
    }
    return "pending";
  }
  if (request?.status === "completed") {
    return "applied";
  }
  return "idle";
}

function attributionStatusFromHealth(
  reliable: boolean,
  confidence: number,
  staleEqualSplit: boolean,
  noPerSkillData: boolean
): AttributionStatus {
  if (staleEqualSplit || noPerSkillData) {
    return "broken";
  }
  if (reliable && confidence >= 0.75) {
    return "healthy";
  }
  return "degraded";
}

export function buildWorkspaceSystemState(target: string, libraryDir: string): WorkspaceSystemState {
  const health = assessAttributionHealth(target, libraryDir);
  const hooks = getWorkspaceHookStatus(target, libraryDir);
  const capabilities = detectAgentCapabilities(target, libraryDir);
  const lastCycle = readPipelineCycle(target);
  const modeCtx = buildSystemModeContext(health, target, lastCycle);

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    profileInit: resolveProfileInitState(target),
    attribution: {
      status: attributionStatusFromHealth(
        health.reliable,
        health.confidenceScore,
        health.staleEqualSplit,
        health.noPerSkillData
      ),
      confidence: Math.round(health.confidenceScore * 100) / 100,
      reliable: health.reliable,
    },
    hooks: {
      installed: hooks.attribution.configuredCount > 0,
      allConfigured: hooks.attribution.allConfigured,
      lastSync: new Date().toISOString(),
    },
    capabilities,
    lastCycle,
    systemMode: modeCtx.mode,
  };
}

export function refreshWorkspaceSystemState(target: string, libraryDir: string): WorkspaceSystemState {
  const state = buildWorkspaceSystemState(target, libraryDir);
  markPipelineAnalyzed(target);
  state.lastCycle = readPipelineCycle(target);
  writeJsonAtomic(systemStatePath(target), state);
  return state;
}

export function readWorkspaceSystemState(target: string): WorkspaceSystemState | undefined {
  return readJsonFile<WorkspaceSystemState>(systemStatePath(target));
}
