/** Coalesced refresh tiers — keeps status bars fresh without repeating heavy workspace walks. */

export interface RefreshOptions {
  /** Run profile-init / proposals / session-apply / cli-config (throttled). */
  workspaceState?: boolean;
  /** Fire skills tree refresh even when sidebar is hidden. */
  forceTree?: boolean;
}

export interface RefreshScheduler {
  schedule: (opts?: RefreshOptions) => void;
  flush: () => void;
  setTreeVisible: (visible: boolean) => void;
  isTreeVisible: () => boolean;
}

const DEFAULT_DEBOUNCE_MS = 200;
const WORKSPACE_STATE_MIN_MS = 2500;

export function createRefreshScheduler(runRefresh: (opts: Required<RefreshOptions>) => void): RefreshScheduler {
  let treeVisible = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: RefreshOptions = {};

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    const opts: Required<RefreshOptions> = {
      workspaceState: !!pending.workspaceState,
      forceTree: !!pending.forceTree,
    };
    pending = {};
    runRefresh(opts);
  };

  const schedule = (opts: RefreshOptions = {}): void => {
    pending = {
      workspaceState: pending.workspaceState || !!opts.workspaceState,
      forceTree: pending.forceTree || !!opts.forceTree,
    };
    if (timer) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      flush();
    }, DEFAULT_DEBOUNCE_MS);
  };

  return {
    schedule,
    flush,
    setTreeVisible(visible: boolean) {
      treeVisible = visible;
    },
    isTreeVisible() {
      return treeVisible;
    },
  };
}

export function shouldRunWorkspaceState(
  lastRunMs: number,
  opts: RefreshOptions,
  now = Date.now()
): boolean {
  if (opts.workspaceState) {
    return true;
  }
  return now - lastRunMs >= WORKSPACE_STATE_MIN_MS;
}
