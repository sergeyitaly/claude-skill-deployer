/**
 * Coalesced workspace → multi-agent sync queue with adaptive debounce.
 * User actions (toggles) flush faster; background watchers coalesce longer.
 */

export const USER_SYNC_DEBOUNCE_MS = 400;
export const BACKGROUND_SYNC_DEBOUNCE_MS = 1200;

export interface SyncEnqueueOptions {
  userTriggered?: boolean;
}

export interface SyncQueue {
  enqueue: (opts?: SyncEnqueueOptions) => void;
  flush: () => void;
  pending: () => boolean;
}

/** @deprecated Use createAdaptiveSyncQueue */
export function createSyncQueue(run: () => void, debounceMs = BACKGROUND_SYNC_DEBOUNCE_MS): SyncQueue {
  return createAdaptiveSyncQueue(run, debounceMs, debounceMs);
}

export function createAdaptiveSyncQueue(
  run: () => void,
  userMs = USER_SYNC_DEBOUNCE_MS,
  backgroundMs = BACKGROUND_SYNC_DEBOUNCE_MS
): SyncQueue {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hasPending = false;
  let userTriggeredPending = false;
  let activeDelay = backgroundMs;

  const runPending = (): void => {
    if (!hasPending) {
      return;
    }
    hasPending = false;
    userTriggeredPending = false;
    activeDelay = backgroundMs;
    run();
  };

  const schedule = (): void => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      runPending();
    }, activeDelay);
  };

  const enqueue = (opts?: SyncEnqueueOptions): void => {
    hasPending = true;
    if (opts?.userTriggered) {
      userTriggeredPending = true;
    }
    const nextDelay = userTriggeredPending ? userMs : backgroundMs;
    const reschedule = !timer || nextDelay < activeDelay;
    activeDelay = nextDelay;
    if (reschedule) {
      schedule();
    }
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
