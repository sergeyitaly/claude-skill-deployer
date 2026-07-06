import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { appendAdoptionEvents } from "./skillAdoption";
import {
  computeAffinityScore,
  computeWorkspaceAffinity,
  getWorkspaceAffinityScore,
  invalidateWorkspaceAffinity,
  readWorkspaceAffinity,
  topWorkspaceSkills,
  workspaceAffinityBoost,
  workspaceAffinityLogPath,
} from "./workspaceAffinity";

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "workspace-affinity-"));
}

function readLog(target: string): Array<Record<string, unknown>> {
  const file = workspaceAffinityLogPath(target);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe("computeAffinityScore", () => {
  it("normalizes to 0-100 and rewards manual invocations most heavily", () => {
    const manualHeavy = computeAffinityScore({
      manualInvocations: 10,
      observations: 0,
      successCount: 0,
      totalInvocations: 10,
      reuseCount: 0,
    });
    const observationHeavy = computeAffinityScore({
      manualInvocations: 0,
      observations: 100,
      successCount: 0,
      totalInvocations: 0,
      reuseCount: 0,
    });
    // Manual and observation saturation both weight 30% — equal at full saturation.
    expect(manualHeavy).toBe(30);
    expect(observationHeavy).toBe(30);
    expect(computeAffinityScore({
      manualInvocations: 0, observations: 0, successCount: 0, totalInvocations: 0, reuseCount: 0,
    })).toBe(0);
  });

  it("clamps every component to 0-100 even with out-of-range inputs", () => {
    const score = computeAffinityScore({
      manualInvocations: 999,
      observations: 999,
      successCount: 999,
      totalInvocations: 10,
      reuseCount: 999,
      lastUsed: new Date().toISOString(),
    });
    expect(score).toBeLessThanOrEqual(100);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it("decays recency component by age", () => {
    const now = Date.now();
    const fresh = computeAffinityScore(
      { manualInvocations: 0, observations: 0, successCount: 0, totalInvocations: 0, reuseCount: 0, lastUsed: new Date(now).toISOString() },
      now
    );
    const stale = computeAffinityScore(
      { manualInvocations: 0, observations: 0, successCount: 0, totalInvocations: 0, reuseCount: 0, lastUsed: new Date(now - 60 * 86_400_000).toISOString() },
      now
    );
    expect(fresh).toBeGreaterThan(stale);
  });
});

describe("workspaceAffinityBoost", () => {
  it("applies the correct tier for each threshold", () => {
    expect(workspaceAffinityBoost(95)).toBe(25);
    expect(workspaceAffinityBoost(91)).toBe(25);
    expect(workspaceAffinityBoost(90)).toBe(15); // boundary: not > 90
    expect(workspaceAffinityBoost(80)).toBe(15);
    expect(workspaceAffinityBoost(75)).toBe(10); // boundary: not > 75
    expect(workspaceAffinityBoost(65)).toBe(10);
    expect(workspaceAffinityBoost(60)).toBe(0); // boundary: not > 60
    expect(workspaceAffinityBoost(10)).toBe(0);
  });
});

describe("computeWorkspaceAffinity", () => {
  it("derives manual vs recommendation invocation counts from adoption events", () => {
    const target = makeWorkspace();
    appendAdoptionEvents(target, [
      { taskId: "s1", skill: "k3s-kuberocketci", event: "invoked", source: "manual" },
      { taskId: "s2", skill: "k3s-kuberocketci", event: "invoked", source: "manual" },
      { taskId: "s3", skill: "k3s-kuberocketci", event: "invoked", source: "recommended" },
      { taskId: "s1", skill: "k3s-kuberocketci", event: "successful", source: "manual" },
      { taskId: "s1", skill: "k3s-kuberocketci", event: "reused", source: "manual" },
    ]);

    const index = computeWorkspaceAffinity(target);
    const record = index.skills["k3s-kuberocketci"];
    expect(record.manualInvocations).toBe(2);
    expect(record.recommendationInvocations).toBe(1);
    expect(record.successCount).toBe(1);
    expect(record.reuseCount).toBe(1);
    expect(record.affinityScore).toBeGreaterThan(0);
    expect(record.affinityScore).toBeLessThanOrEqual(100);
  });

  it("persists workspace-affinity.json and is readable back", () => {
    const target = makeWorkspace();
    appendAdoptionEvents(target, [{ taskId: "s1", skill: "self-learning", event: "invoked", source: "manual" }]);
    computeWorkspaceAffinity(target);
    const saved = readWorkspaceAffinity(target);
    expect(saved?.skills["self-learning"]).toBeDefined();
  });

  it("emits affinity-created then affinity-updated observability events", () => {
    const target = makeWorkspace();
    appendAdoptionEvents(target, [{ taskId: "s1", skill: "self-learning", event: "invoked", source: "manual" }]);
    computeWorkspaceAffinity(target);
    appendAdoptionEvents(target, [
      { taskId: "s2", skill: "self-learning", event: "invoked", source: "manual" },
      { taskId: "s2", skill: "self-learning", event: "successful", source: "manual" },
    ]);
    computeWorkspaceAffinity(target);

    const events = readLog(target);
    expect(events.some((e) => e.event === "affinity-created" && e.skill === "self-learning")).toBe(true);
    expect(events.some((e) => e.event === "affinity-updated" && e.skill === "self-learning")).toBe(true);
  });

  it("recovers gracefully from a corrupted workspace-affinity.json", () => {
    const target = makeWorkspace();
    fs.mkdirSync(path.join(target, ".claude", "learning"), { recursive: true });
    fs.writeFileSync(path.join(target, ".claude", "learning", "workspace-affinity.json"), "{not valid json", "utf-8");
    expect(readWorkspaceAffinity(target)).toBeUndefined();

    appendAdoptionEvents(target, [{ taskId: "s1", skill: "self-learning", event: "invoked", source: "manual" }]);
    // Recompute must succeed and overwrite the corrupt file rather than throwing.
    const index = computeWorkspaceAffinity(target);
    expect(index.skills["self-learning"]).toBeDefined();
    expect(readWorkspaceAffinity(target)?.skills["self-learning"]).toBeDefined();
  });
});

describe("topWorkspaceSkills", () => {
  it("ranks by affinity score above the minimum threshold", () => {
    const target = makeWorkspace();
    invalidateWorkspaceAffinity(target);
    // High affinity: sustained manual invocations, mostly successful, some reuse, all recent.
    const events: Array<{ taskId: string; skill: string; event: "invoked" | "successful" | "reused"; source: "manual" | "recommended" }> = [];
    for (let i = 0; i < 30; i++) {
      events.push({ taskId: `s${i}`, skill: "k3s-kuberocketci", event: "invoked", source: "manual" });
      events.push({ taskId: `s${i}`, skill: "k3s-kuberocketci", event: "successful", source: "manual" });
    }
    for (let i = 0; i < 5; i++) {
      events.push({ taskId: `r${i}`, skill: "k3s-kuberocketci", event: "reused", source: "manual" });
    }
    // Low affinity: a single recommendation-accepted invocation, no success, no reuse.
    events.push({ taskId: "x0", skill: "rarely-used-skill", event: "invoked", source: "recommended" });

    appendAdoptionEvents(target, events);
    computeWorkspaceAffinity(target);

    const top = topWorkspaceSkills(target, 3, 60);
    expect(top.length).toBeGreaterThanOrEqual(1);
    expect(top[0].skill).toBe("k3s-kuberocketci");
    expect(top.every((r) => r.affinityScore >= 60)).toBe(true);
    expect(top.some((r) => r.skill === "rarely-used-skill")).toBe(false);
  });
});

describe("getWorkspaceAffinityScore", () => {
  it("returns 0 for a skill with no data", () => {
    const target = makeWorkspace();
    expect(getWorkspaceAffinityScore(target, "never-seen-skill")).toBe(0);
  });
});
