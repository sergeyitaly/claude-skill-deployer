import { describe, expect, it, vi } from "vitest";
import { createSyncQueue } from "./workspaceSyncQueue";

describe("workspaceSyncQueue", () => {
  it("coalesces rapid enqueue calls", () => {
    vi.useFakeTimers();
    let runs = 0;
    const q = createSyncQueue(() => {
      runs += 1;
    });
    q.enqueue();
    q.enqueue();
    q.enqueue();
    expect(runs).toBe(0);
    vi.advanceTimersByTime(2000);
    expect(runs).toBe(1);
    vi.useRealTimers();
  });

  it("flush runs pending work immediately", () => {
    let runs = 0;
    const q = createSyncQueue(() => {
      runs += 1;
    });
    q.enqueue();
    q.flush();
    expect(runs).toBe(1);
  });
});
