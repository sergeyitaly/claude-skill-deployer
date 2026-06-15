import {
  appendPipelineTraceError,
  evaluatePipelineStatus,
  isPipelineCircuitOpen,
  PipelineCycleTimestamps,
  PipelineTrace,
  readPipelineCycle,
  setPipelineCircuitState,
  writePipelineTrace,
} from "./pipelineCycle";
import { notePipelineRun } from "./pipelineCircuitBreaker";
import { refreshRunsIndex } from "./runsIndex";
import { loadManifest } from "./skillOps";
import { refreshWorkspaceSystemState, readWorkspaceSystemState, WorkspaceSystemState } from "./workspaceSystemState";
import { SystemMode } from "./systemMode";
import { isFeatureEnabled } from "./featureFlags";
import { scheduleAutoOptimizePass } from "./autoOptimizer";
import { queueTeamEconomicsPrecompute } from "./teamEconomicsCache";
import { queueDashboardSnapshotPrecompute } from "./dashboardPrecompute";
import { maybePromoteIgnoredSkillsOnUnderuse } from "./taskSkillUnderuse";

export interface CostPipelineRunOptions {
  collectMs?: number;
}

export interface CostPipelineResult {
  ready: boolean;
  fresh: boolean;
  cycle: PipelineCycleTimestamps;
  systemMode: SystemMode;
  state: WorkspaceSystemState;
  staleMessage?: string;
  trace?: PipelineTrace;
  circuitOpen: boolean;
  skipped: boolean;
  /** Transcript sessions processed when collect ran. */
  processedSessions: number;
}

function buildSkippedResult(
  target: string,
  libraryDir: string,
  runsLastMinute: number,
  staleMessage: string
): CostPipelineResult {
  const cycle = setPipelineCircuitState(target, true, runsLastMinute);
  const state = readWorkspaceSystemState(target) ?? refreshWorkspaceSystemState(target, libraryDir);
  state.systemMode = "safe";
  state.lastCycle = cycle;
  return {
    ready: false,
    fresh: false,
    cycle,
    systemMode: "safe",
    state,
    staleMessage,
    trace: cycle.trace,
    circuitOpen: true,
    skipped: true,
    processedSessions: 0,
  };
}

/** Index materialized views and refresh system-state snapshot (sync). */
export function runCostPipelineSync(
  target: string,
  libraryDir: string,
  opts?: CostPipelineRunOptions
): CostPipelineResult {
  if (!isFeatureEnabled("costIntelligence") && !isFeatureEnabled("attributionCollector")) {
    const cycle = readPipelineCycle(target);
    const state = readWorkspaceSystemState(target) ?? refreshWorkspaceSystemState(target, libraryDir);
    return {
      ready: false,
      fresh: false,
      cycle,
      systemMode: state.systemMode,
      state,
      circuitOpen: isPipelineCircuitOpen(cycle),
      skipped: true,
      processedSessions: 0,
    };
  }

  const budget = notePipelineRun(target);
  setPipelineCircuitState(target, budget.tripped, budget.runsLastMinute);
  if (budget.tripped) {
    return buildSkippedResult(
      target,
      libraryDir,
      budget.runsLastMinute,
      `Pipeline circuit open (${budget.runsLastMinute} runs in the last minute) — cost sync paused.`
    );
  }

  const trace: PipelineTrace = { errors: [], collectMs: opts?.collectMs };
  const runStarted = Date.now();

  try {
    const manifest = loadManifest(libraryDir);
    const indexStarted = Date.now();
    refreshRunsIndex(target, manifest);
    trace.indexMs = Date.now() - indexStarted;

    const analyzeStarted = Date.now();
    const state = refreshWorkspaceSystemState(target, libraryDir);
    maybePromoteIgnoredSkillsOnUnderuse(target, libraryDir);
    trace.analyzeMs = Date.now() - analyzeStarted;

    trace.totalMs = Date.now() - runStarted;
    trace.lastCompletedAt = new Date().toISOString();
    writePipelineTrace(target, trace);

    const status = evaluatePipelineStatus(target, readPipelineCycle(target));
    scheduleAutoOptimizePass(target, libraryDir);
    queueTeamEconomicsPrecompute(target, libraryDir);
    queueDashboardSnapshotPrecompute(target, libraryDir, {
      ready: status.ready,
      fresh: status.fresh,
      cycle: status.cycle,
      systemMode: state.systemMode,
      state,
      staleMessage: status.staleMessage,
      trace,
      circuitOpen: isPipelineCircuitOpen(status.cycle),
      skipped: false,
      processedSessions: 0,
    });
    return {
      ready: status.ready,
      fresh: status.fresh,
      cycle: status.cycle,
      systemMode: state.systemMode,
      state,
      staleMessage: status.staleMessage,
      trace,
      circuitOpen: isPipelineCircuitOpen(status.cycle),
      skipped: false,
      processedSessions: 0,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failedPhase: "index" | "analyze" = trace.indexMs === undefined ? "index" : "analyze";
    appendPipelineTraceError(target, failedPhase, message);
    trace.errors = [
      ...(readPipelineCycle(target).trace?.errors ?? []),
      { phase: failedPhase, message, at: new Date().toISOString() },
    ].slice(-8);
    trace.totalMs = Date.now() - runStarted;
    writePipelineTrace(target, trace);
    throw err;
  }
}

/** collect (optional) → index → analyze — single entry point for cost consumers. */
export async function runCostPipeline(
  target: string,
  libraryDir: string,
  opts?: { collect?: boolean; forceCollect?: boolean }
): Promise<CostPipelineResult> {
  let processedSessions = 0;
  let collectMs: number | undefined;
  if (opts?.collect) {
    const collectStarted = Date.now();
    try {
      const { AttributionCollector } = await import("./attributionCollector.js");
      processedSessions = await AttributionCollector.getInstance(target, libraryDir).collect(
        opts.forceCollect ?? false,
        { schedulePipeline: false }
      );
      collectMs = Date.now() - collectStarted;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendPipelineTraceError(target, "collect", message);
      throw err;
    }
  }
  const result = runCostPipelineSync(target, libraryDir, { collectMs });
  return { ...result, processedSessions };
}
