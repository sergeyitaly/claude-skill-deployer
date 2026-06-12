import { runCostPipelineSync, CostPipelineResult } from "./costPipeline";

const DEFAULT_DEBOUNCE_MS = 2000;

interface PendingDebounce {
  timer: ReturnType<typeof setTimeout>;
  libraryDir: string;
}

const debounceByTarget = new Map<string, PendingDebounce>();
const inflightByTarget = new Map<string, Promise<CostPipelineResult>>();

function targetKey(target: string): string {
  return target.toLowerCase();
}

/** Run pipeline immediately; coalesce concurrent calls for the same workspace. */
export function runCostPipelineNow(target: string, libraryDir: string): Promise<CostPipelineResult> {
  cancelScheduledCostPipeline(target);
  const key = targetKey(target);
  const existing = inflightByTarget.get(key);
  if (existing) {
    return existing;
  }
  const run = Promise.resolve().then(() => runCostPipelineSync(target, libraryDir));
  inflightByTarget.set(
    key,
    run.finally(() => {
      if (inflightByTarget.get(key) === run) {
        inflightByTarget.delete(key);
      }
    })
  );
  return inflightByTarget.get(key)!;
}

export function cancelScheduledCostPipeline(target: string): void {
  const pending = debounceByTarget.get(targetKey(target));
  if (pending) {
    clearTimeout(pending.timer);
    debounceByTarget.delete(targetKey(target));
  }
}

/** Debounced pipeline refresh — shared by file watchers and refreshAll. */
export function scheduleCostPipelineSync(
  target: string,
  libraryDir: string,
  debounceMs = DEFAULT_DEBOUNCE_MS
): void {
  const key = targetKey(target);
  const pending = debounceByTarget.get(key);
  if (pending) {
    clearTimeout(pending.timer);
  }
  const timer = setTimeout(() => {
    debounceByTarget.delete(key);
    void runCostPipelineNow(target, libraryDir);
  }, debounceMs);
  debounceByTarget.set(key, { timer, libraryDir });
}

/** Flush any pending debounced run and await a fresh pipeline pass. */
export async function flushCostPipeline(target: string, libraryDir: string): Promise<CostPipelineResult> {
  cancelScheduledCostPipeline(target);
  return runCostPipelineNow(target, libraryDir);
}

/** @internal Test helper */
export function resetCostPipelineSchedulerForTests(): void {
  for (const pending of debounceByTarget.values()) {
    clearTimeout(pending.timer);
  }
  debounceByTarget.clear();
  inflightByTarget.clear();
}
