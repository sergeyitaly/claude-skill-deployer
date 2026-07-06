import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { appendAdoptionEvents } from "./skillAdoption";
import { loadManifest, writeSkillVersionSidecar } from "./skillOps";
import {
  computeSkillLifecycleIntelligence,
  rankOutdatedSkillsByPriority,
  readSkillLifecycleIndex,
} from "./skillLifecycleIntelligence";

const libraryDir = path.join(__dirname, "..", "skills_library");

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skill-lifecycle-intel-"));
}

function installOutdatedSkill(target: string, name: string): void {
  const skillDir = path.join(target, ".claude", "skills", name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# test\n", "utf-8");
  writeSkillVersionSidecar(skillDir, "1.0.0"); // real catalog version is newer
}

describe("computeSkillLifecycleIntelligence", () => {
  it("flags an outdated installed skill with affinity, usage, and a priority bucket", () => {
    const target = makeWorkspace();
    installOutdatedSkill(target, "terraform-plan-review");
    // Heavy recent manual usage should push this toward HIGH priority.
    const events = Array.from({ length: 25 }, (_, i) => ({
      taskId: `s${i}`, skill: "terraform-plan-review", event: "invoked" as const, source: "manual" as const,
    }));
    appendAdoptionEvents(target, [
      ...events,
      ...events.map((e) => ({ ...e, event: "successful" as const })),
    ]);

    const manifest = loadManifest(libraryDir);
    const index = computeSkillLifecycleIntelligence(target, libraryDir, manifest);
    const record = index.skills["terraform-plan-review"];

    expect(record).toBeDefined();
    expect(record.status).toBe("outdated");
    expect(record.installedVersion).toBe("1.0.0");
    expect(record.affinity).toBeGreaterThan(0);
    expect(record.usageLast30d).toBe(25);
    expect(["HIGH", "MEDIUM", "LOW"]).toContain(record.updatePriority);
  });

  it("marks a skill with no adoption/affinity history as LOW priority when outdated", () => {
    const target = makeWorkspace();
    installOutdatedSkill(target, "terraform-plan-review");

    const manifest = loadManifest(libraryDir);
    const index = computeSkillLifecycleIntelligence(target, libraryDir, manifest);
    const record = index.skills["terraform-plan-review"];

    expect(record.affinity).toBe(0);
    expect(record.usageLast30d).toBe(0);
    expect(record.updatePriority).toBe("LOW");
  });

  it("records a 'missing' status for a skill with history but no longer installed", () => {
    const target = makeWorkspace();
    appendAdoptionEvents(target, [
      { taskId: "s1", skill: "ghost-skill", event: "invoked", source: "manual" },
    ]);

    const manifest = loadManifest(libraryDir);
    const index = computeSkillLifecycleIntelligence(target, libraryDir, manifest);

    expect(index.skills["ghost-skill"]?.status).toBe("missing");
    expect(index.skills["ghost-skill"]?.installedVersion).toBe("not installed");
  });

  it("persists skill-lifecycle.json readable via readSkillLifecycleIndex", () => {
    const target = makeWorkspace();
    installOutdatedSkill(target, "terraform-plan-review");
    const manifest = loadManifest(libraryDir);
    computeSkillLifecycleIntelligence(target, libraryDir, manifest);

    const saved = readSkillLifecycleIndex(target);
    expect(saved?.skills["terraform-plan-review"]).toBeDefined();
  });

  it("recovers from a corrupted skill-lifecycle.json instead of throwing", () => {
    const target = makeWorkspace();
    fs.mkdirSync(path.join(target, ".claude", "learning"), { recursive: true });
    fs.writeFileSync(path.join(target, ".claude", "learning", "skill-lifecycle.json"), "not json{{{", "utf-8");
    expect(readSkillLifecycleIndex(target)).toBeUndefined();

    installOutdatedSkill(target, "terraform-plan-review");
    const manifest = loadManifest(libraryDir);
    expect(() => computeSkillLifecycleIntelligence(target, libraryDir, manifest)).not.toThrow();
    expect(readSkillLifecycleIndex(target)?.skills["terraform-plan-review"]).toBeDefined();
  });
});

describe("rankOutdatedSkillsByPriority", () => {
  it("sorts outdated/deprecated skills by priority score descending", () => {
    const target = makeWorkspace();
    installOutdatedSkill(target, "terraform-plan-review");
    const events = Array.from({ length: 20 }, (_, i) => ({
      taskId: `s${i}`, skill: "terraform-plan-review", event: "invoked" as const, source: "manual" as const,
    }));
    appendAdoptionEvents(target, events);

    const manifest = loadManifest(libraryDir);
    const index = computeSkillLifecycleIntelligence(target, libraryDir, manifest);
    const ranked = rankOutdatedSkillsByPriority(index);

    expect(ranked.every((r) => r.status === "outdated" || r.status === "deprecated")).toBe(true);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].priorityScore).toBeGreaterThanOrEqual(ranked[i].priorityScore);
    }
  });
});
