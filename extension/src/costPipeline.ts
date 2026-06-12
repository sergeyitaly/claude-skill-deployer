import {
  isPipelineReadyForOptimizer,
  PipelineCycleTimestamps,
  readPipelineCycle,
} from "./pipelineCycle";
import { refreshRunsIndex } from "./runsIndex";
import { loadManifest } from "./skillOps";
import { SystemMode } from "./systemMode";
import { refreshWorkspaceSystemState, WorkspaceSystemState } from "./workspaceSystemState";

export interface CostPipelineResult {
  ready: boolean;
  cycle: PipelineCycleTimestamps;
  systemMode: SystemMode;
  state: WorkspaceSystemState;
  /** Transcript sessions processed when collect ran. */
  processedSessions: number;
}

/** Index materialized views and refresh system-state snapshot (sync). */
export function runCostPipelineSync(target: string, libraryDir: string): CostPipelineResult {
  const manifest = loadManifest(libraryDir);
  refreshRunsIndex(target, manifest);
  const state = refreshWorkspaceSystemState(target, libraryDir);
  const cycle = readPipelineCycle(target);
  return {
    ready: isPipelineReadyForOptimizer(cycle),
    cycle,
    systemMode: state.systemMode,
    state,
    processedSessions: 0,
  };
}

/** collect (optional) → index → analyze — single entry point for cost consumers. */
export async function runCostPipeline(
  target: string,
  libraryDir: string,
  opts?: { collect?: boolean; forceCollect?: boolean }
): Promise<CostPipelineResult> {
  let processedSessions = 0;
  if (opts?.collect) {
    const { AttributionCollector } = await import("./attributionCollector");
    processedSessions = await AttributionCollector.getInstance(target, libraryDir).collect(
      opts.forceCollect ?? false
    );
  }
  const result = runCostPipelineSync(target, libraryDir);
  return { ...result, processedSessions };
}
