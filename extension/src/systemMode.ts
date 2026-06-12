import { AttributionHealth } from "./attributionHealth";
import { isPipelineCircuitOpen, isPipelineFresh, isPipelineReadyForOptimizer, PipelineCycleTimestamps, pipelineStaleSummary } from "./pipelineCycle";

export type SystemMode = "normal" | "degraded" | "safe";

export interface SystemModeContext {
  mode: SystemMode;
  pipelineReady: boolean;
  pipelineFresh: boolean;
  pipelineStaleMessage?: string;
  canShowPerSkillCosts: boolean;
  canSuggestOptimizations: boolean;
  canApplyOptimizations: boolean;
  canAutoApplyOptimizations: boolean;
  banner?: string;
}

export function resolveSystemMode(
  health: AttributionHealth,
  target: string,
  cycle: PipelineCycleTimestamps
): SystemMode {
  if (isPipelineCircuitOpen(cycle)) {
    return "safe";
  }
  const pipelineFresh = isPipelineFresh(target, cycle);
  if (health.staleEqualSplit || health.confidenceScore < 0.45 || !pipelineFresh) {
    return "safe";
  }
  if (!health.reliable || health.confidenceScore < 0.75) {
    return "degraded";
  }
  return "normal";
}

export function buildSystemModeContext(
  health: AttributionHealth,
  target: string,
  cycle: PipelineCycleTimestamps
): SystemModeContext {
  const pipelineReady = isPipelineReadyForOptimizer(cycle);
  const pipelineFresh = isPipelineFresh(target, cycle);
  const pipelineStaleMessage = pipelineStaleSummary(target, cycle);
  const mode = resolveSystemMode(health, target, cycle);

  let banner: string | undefined;
  if (mode === "safe") {
    if (isPipelineCircuitOpen(cycle)) {
      banner = `Safe mode: ${pipelineStaleMessage ?? "pipeline circuit open — too many sync runs"}`;
    } else if (health.staleEqualSplit) {
      banner = "Safe mode: mis-attributed cost data — reset attribution before trusting per-skill numbers.";
    } else if (!pipelineFresh) {
      banner = `Safe mode: ${pipelineStaleMessage ?? "pipeline not fresh"}`;
    } else {
      banner = `Safe mode: attribution confidence too low (${Math.round(health.confidenceScore * 100)}%) — suggestions hidden.`;
    }
  } else if (mode === "degraded") {
    banner = `Degraded mode: estimates only (${Math.round(health.confidenceScore * 100)}% confidence) — review before applying; auto-optimize disabled.`;
  }

  return {
    mode,
    pipelineReady,
    pipelineFresh,
    pipelineStaleMessage,
    canShowPerSkillCosts: mode !== "safe" && !health.staleEqualSplit && pipelineFresh,
    canSuggestOptimizations: mode !== "safe" && pipelineFresh,
    canApplyOptimizations: (mode === "normal" || mode === "degraded") && pipelineFresh,
    canAutoApplyOptimizations: mode === "normal" && pipelineFresh,
    banner,
  };
}
