import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWorkspaceCachesWarm, isWorkspaceCacheWarmed, resetCacheWarmupForTests } from "./cacheWarmup";

describe("cacheWarmup", () => {
  afterEach(() => {
    resetCacheWarmupForTests();
  });

  it("marks warmed after ensureWarm and skips repeat work", () => {
    const libraryDir = path.join(__dirname, "..", "skills_library");
    expect(isWorkspaceCacheWarmed()).toBe(false);
    ensureWorkspaceCachesWarm("/tmp/warmup-a", libraryDir);
    expect(isWorkspaceCacheWarmed()).toBe(true);
    ensureWorkspaceCachesWarm("/tmp/warmup-b", libraryDir);
    expect(isWorkspaceCacheWarmed()).toBe(true);
  });
});
