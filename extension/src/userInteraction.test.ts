import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isUserActive,
  markUserInteraction,
  resetUserInteractionForTests,
  runWhenIdle,
  shouldDeferBackgroundWork,
} from "./userInteraction";

describe("userInteraction", () => {
  afterEach(() => {
    resetUserInteractionForTests();
    vi.useRealTimers();
  });

  it("marks user active for a short window", () => {
    vi.useFakeTimers();
    markUserInteraction();
    expect(isUserActive()).toBe(true);
    vi.advanceTimersByTime(799);
    expect(isUserActive()).toBe(true);
    vi.advanceTimersByTime(2);
    expect(isUserActive()).toBe(false);
  });

  it("defers background work until idle", () => {
    vi.useFakeTimers();
    markUserInteraction();
    let ran = false;
    runWhenIdle(() => {
      ran = true;
    });
    expect(ran).toBe(false);
    vi.advanceTimersByTime(800);
    vi.advanceTimersByTime(500);
    expect(ran).toBe(true);
  });

  it("runs immediately when not deferred", () => {
    let ran = false;
    runWhenIdle(() => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(shouldDeferBackgroundWork()).toBe(false);
  });
});
