import { AttributionHealth } from "./attributionHealth";
import { isPipelineReadyForOptimizer, PipelineCycleTimestamps, pipelineStaleSummary } from "./pipelineCycle";

export type SystemMode = "normal" | "degraded" | "safe";

export interface SystemModeContext {
  mode: SystemMode;
  pipelineReady: boolean;
  pipelineStaleMessage?: string;
  canShowPerSkillCosts: boolean;
  canSuggestOptimizations: boolean;
  canApplyOptimizations: boolean;
  canAutoApplyOptimizations: boolean;
  banner?: string;
}

export function resolveSystemMode(health: AttributionHealth, cycle: PipelineCycleTimestamps): SystemMode {
  const pipelineReady = isPipelineReadyForOptimizer(cycle);
  if (health.staleEqualSplit || health.confidenceScore < 0.45 || !pipelineReady) {
    return "safe";
  }
  if (!health.reliable || health.confidenceScore < 0.75) {
    return "degraded";
  }
  return "normal";
}

export function buildSystemModeContext(health: AttributionHealth, cycle: PipelineCycleTimestamps): SystemModeContext {
  const pipelineReady = isPipelineReadyForOptimizer(cycle);
  const pipelineStaleMessage = pipelineStaleSummary(cycle);
  const mode = resolveSystemMode(health, cycle);

  let banner: string | undefined;
  if (mode === "safe") {
    if (health.staleEqualSplit) {
      banner = "Safe mode: mis-attributed cost data — reset attribution before trusting per-skill numbers.";
    } else if (!pipelineReady) {
      banner = `Safe mode: ${pipelineStaleMessage ?? "pipeline not ready"}`;
    } else {
      banner = `Safe mode: attribution confidence too low (${Math.round(health.confidenceScore * 100)}%) — suggestions hidden.`;
    }
  } else if (mode === "degraded") {
    banner = `Degraded mode: estimates only (${Math.round(health.confidenceScore * 100)}% confidence) — review before applying; auto-optimize disabled.`;
  }

  return {
    mode,
    pipelineReady,
    pipelineStaleMessage,
    canShowPerSkillCosts: mode !== "safe" && !health.staleEqualSplit,
    canSuggestOptimizations: mode !== "safe",
    canApplyOptimizations: mode === "normal" || mode === "degraded",
    canAutoApplyOptimizations: mode === "normal",
    banner,
  };
}
