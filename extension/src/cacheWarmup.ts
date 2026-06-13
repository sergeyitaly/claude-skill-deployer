import { loadManifest, listSkillStatuses } from "./skillOps";
import { readCachedEnrichedRuns } from "./learningStateIndex";

let warmed = false;
let warming = false;

/** Preload hot paths so the first user interaction avoids cold-cache latency. */
export function warmupWorkspaceCaches(target: string, libraryDir: string): void {
  try {
    loadManifest(libraryDir);
    listSkillStatuses(libraryDir, target);
    readCachedEnrichedRuns(target);
    warmed = true;
  } catch {
    // non-fatal
  }
}

/** Idempotent — safe on first click before the delayed startup warmup. */
export function ensureWorkspaceCachesWarm(target: string, libraryDir: string): void {
  if (warmed || warming) {
    return;
  }
  warming = true;
  try {
    warmupWorkspaceCaches(target, libraryDir);
  } finally {
    warming = false;
  }
}

export function isWorkspaceCacheWarmed(): boolean {
  return warmed;
}

/** @internal */
export function resetCacheWarmupForTests(): void {
  warmed = false;
  warming = false;
}
