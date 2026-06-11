import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { autoApplySlotsRemaining, recordAutoApplies } from "./autoOptimizerRateLimit";

const tempDirs: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-opt-rate-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("autoOptimizerRateLimit", () => {
  it("allows three applies per 30-minute window", () => {
    const target = makeWorkspace();
    const now = Date.now();
    expect(autoApplySlotsRemaining(target, now)).toBe(3);

    recordAutoApplies(target, 2, now);
    expect(autoApplySlotsRemaining(target, now)).toBe(1);

    recordAutoApplies(target, 1, now);
    expect(autoApplySlotsRemaining(target, now)).toBe(0);
  });

  it("resets the window after 30 minutes", () => {
    const target = makeWorkspace();
    const start = Date.now();
    recordAutoApplies(target, 3, start);
    expect(autoApplySlotsRemaining(target, start)).toBe(0);

    const afterWindow = start + 30 * 60 * 1000 + 1;
    expect(autoApplySlotsRemaining(target, afterWindow)).toBe(3);
  });

  it("ignores non-positive apply counts", () => {
    const target = makeWorkspace();
    const now = Date.now();
    recordAutoApplies(target, 0, now);
    recordAutoApplies(target, -1, now);
    expect(autoApplySlotsRemaining(target, now)).toBe(3);
  });
});
