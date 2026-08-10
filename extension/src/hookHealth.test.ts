import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendHookHealth, computeHookHealthSummary, SLOW_HOOK_MS } from "./hookHealth";

const workspaces: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-health-"));
  workspaces.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of workspaces) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

describe("computeHookHealthSummary — hook_request latency (previously untracked entirely)", () => {
  it("aggregates hook_request durationMs without polluting skill-detection counts", () => {
    const target = makeWorkspace();
    appendHookHealth(target, { event: "hook_request", agent: "claude", hookName: "skill-invoke", durationMs: 120 });
    appendHookHealth(target, { event: "hook_request", agent: "claude", hookName: "prompt-context", durationMs: 3400 });
    appendHookHealth(target, { event: "hook_fired", agent: "claude", skill: "pdf", wrote_runs: true });

    const summary = computeHookHealthSummary(target);

    expect(summary.latency.requestsToday).toBe(2);
    expect(summary.latency.avgDurationMs).toBe(Math.round((120 + 3400) / 2));
    expect(summary.latency.maxDurationMs).toBe(3400);
    expect(summary.latency.slowCallsToday).toBe(1);
    // hook_request records must not be counted as skill detections or generic hook calls.
    expect(summary.skillDetectionsToday).toBe(1);
    expect(summary.hookCallsToday).toBe(1);
  });

  it("reports no latency data when only hook_fired records exist", () => {
    const target = makeWorkspace();
    appendHookHealth(target, { event: "hook_fired", agent: "claude", skill: "pdf", wrote_runs: true });

    const summary = computeHookHealthSummary(target);

    expect(summary.latency.hasData).toBe(false);
    expect(summary.latency.requestsToday).toBe(0);
  });

  it("counts a call at exactly SLOW_HOOK_MS as slow", () => {
    const target = makeWorkspace();
    appendHookHealth(target, { event: "hook_request", agent: "claude", hookName: "session-stop", durationMs: SLOW_HOOK_MS });

    const summary = computeHookHealthSummary(target);

    expect(summary.latency.slowCallsToday).toBe(1);
  });
});
