/**
 * Coalesced workspace → multi-agent sync queue.
 * Rapid events (file watchers, toggles) merge into one sync run.
 */

export interface SyncQueue {
  enqueue: () => void;
  flush: () => void;
  pending: () => boolean;
}

const DEFAULT_SYNC_DEBOUNCE_MS = 2000;

export function createSyncQueue(run: () => void, debounceMs = DEFAULT_SYNC_DEBOUNCE_MS): SyncQueue {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hasPending = false;

  const runPending = (): void => {
    if (!hasPending) {
      return;
    }
    hasPending = false;
    run();
  };

  const enqueue = (): void => {
    hasPending = true;
    if (timer) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      runPending();
    }, debounceMs);
  };

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    runPending();
  };

  return {
    enqueue,
    flush,
    pending: () => hasPending || !!timer,
  };
}
