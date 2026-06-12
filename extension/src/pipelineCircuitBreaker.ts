const RUN_WINDOW_MS = 60_000;
export const MAX_PIPELINE_RUNS_PER_MINUTE = 10;

const recentRunsByTarget = new Map<string, number[]>();

function targetKey(target: string): string {
  return target.toLowerCase();
}

export interface PipelineRunBudget {
  runsLastMinute: number;
  tripped: boolean;
}

/** Record a pipeline run attempt and return whether the circuit should open. Skipped when already tripped so the window can recover. */
export function notePipelineRun(target: string, now = Date.now()): PipelineRunBudget {
  const key = targetKey(target);
  const windowStart = now - RUN_WINDOW_MS;
  const recent = (recentRunsByTarget.get(key) ?? []).filter((t) => t > windowStart);
  const tripped = recent.length > MAX_PIPELINE_RUNS_PER_MINUTE;
  if (!tripped) {
    recent.push(now);
  }
  recentRunsByTarget.set(key, recent);
  return {
    runsLastMinute: recent.length,
    tripped: recent.length > MAX_PIPELINE_RUNS_PER_MINUTE,
  };
}

/** @internal Test helper */
export function resetPipelineCircuitBreakerForTests(): void {
  recentRunsByTarget.clear();
}
