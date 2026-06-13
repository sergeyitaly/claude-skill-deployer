import { describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_SYNC_DEBOUNCE_MS,
  createAdaptiveSyncQueue,
  USER_SYNC_DEBOUNCE_MS,
} from "./workspaceSyncQueue";

describe("workspaceSyncQueue", () => {
  it("coalesces background enqueue calls", () => {
    vi.useFakeTimers();
    let runs = 0;
    const q = createAdaptiveSyncQueue(() => {
      runs += 1;
    });
    q.enqueue();
    q.enqueue();
    q.enqueue();
    expect(runs).toBe(0);
    vi.advanceTimersByTime(BACKGROUND_SYNC_DEBOUNCE_MS);
    expect(runs).toBe(1);
    vi.useRealTimers();
  });

  it("uses shorter delay when user triggered", () => {
    vi.useFakeTimers();
    let runs = 0;
    const q = createAdaptiveSyncQueue(() => {
      runs += 1;
    });
    q.enqueue({ userTriggered: true });
    vi.advanceTimersByTime(USER_SYNC_DEBOUNCE_MS - 1);
    expect(runs).toBe(0);
    vi.advanceTimersByTime(1);
    expect(runs).toBe(1);
    vi.useRealTimers();
  });

  it("reschedules to user delay when user action joins a pending background batch", () => {
    vi.useFakeTimers();
    let runs = 0;
    const q = createAdaptiveSyncQueue(() => {
      runs += 1;
    });
    q.enqueue();
    vi.advanceTimersByTime(500);
    q.enqueue({ userTriggered: true });
    vi.advanceTimersByTime(USER_SYNC_DEBOUNCE_MS);
    expect(runs).toBe(1);
    vi.useRealTimers();
  });

  it("flush runs pending work immediately", () => {
    let runs = 0;
    const q = createAdaptiveSyncQueue(() => {
      runs += 1;
    });
    q.enqueue();
    q.flush();
    expect(runs).toBe(1);
  });
});
