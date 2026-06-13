import { describe, expect, it, vi } from "vitest";
import { createRefreshScheduler, shouldRunWorkspaceState } from "./workspaceRefresh";

describe("workspaceRefresh", () => {
  it("coalesces rapid refresh requests", () => {
    vi.useFakeTimers();
    const runs: number[] = [];
    const scheduler = createRefreshScheduler(() => {
      runs.push(Date.now());
    });
    scheduler.schedule({});
    scheduler.schedule({ forceTree: true });
    scheduler.schedule({ workspaceState: true });
    expect(runs).toHaveLength(0);
    vi.advanceTimersByTime(200);
    expect(runs).toHaveLength(1);
    vi.useRealTimers();
  });

  it("throttles workspace state unless forced", () => {
    const now = 1_000_000;
    expect(shouldRunWorkspaceState(now - 1000, {}, now)).toBe(false);
    expect(shouldRunWorkspaceState(now - 5000, {}, now)).toBe(true);
    expect(shouldRunWorkspaceState(now, { workspaceState: true }, now)).toBe(true);
  });
});
