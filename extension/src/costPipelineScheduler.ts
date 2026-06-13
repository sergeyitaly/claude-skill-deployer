import * as vscode from "vscode";
import { runCostPipelineSync, CostPipelineResult, CostPipelineRunOptions } from "./costPipeline";

const DEFAULT_DEBOUNCE_MS = 2000;
const FOCUSED_DEBOUNCE_MS = 3500;

interface PendingDebounce {
  timer: ReturnType<typeof setTimeout>;
  libraryDir: string;
}

const debounceByTarget = new Map<string, PendingDebounce>();
const inflightByTarget = new Map<string, Promise<CostPipelineResult>>();

function targetKey(target: string): string {
  return target.toLowerCase();
}

function resolveDebounceMs(requested?: number): number {
  if (requested !== undefined) {
    return requested;
  }
  try {
    if (vscode.window.state.focused) {
      return FOCUSED_DEBOUNCE_MS;
    }
  } catch {
    // vscode may be unavailable in unit tests
  }
  return DEFAULT_DEBOUNCE_MS;
}

/** Run pipeline immediately; coalesce concurrent calls for the same workspace. */
export function runCostPipelineNow(
  target: string,
  libraryDir: string,
  opts?: CostPipelineRunOptions
): Promise<CostPipelineResult> {
  cancelScheduledCostPipeline(target);
  const key = targetKey(target);
  const existing = inflightByTarget.get(key);
  if (existing) {
    return existing;
  }
  const run = Promise.resolve().then(() => runCostPipelineSync(target, libraryDir, opts));
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
  debounceMs?: number
): void {
  const key = targetKey(target);
  const delay = resolveDebounceMs(debounceMs);
  const pending = debounceByTarget.get(key);
  if (pending) {
    clearTimeout(pending.timer);
  }
  const timer = setTimeout(() => {
    debounceByTarget.delete(key);
    void runCostPipelineNow(target, libraryDir);
  }, delay);
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
