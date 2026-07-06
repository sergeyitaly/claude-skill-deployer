import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { appendAdoptionEvents } from "./skillAdoption";
import { loadManifest, writeSkillVersionSidecar } from "./skillOps";
import { workspaceAffinityLogPath } from "./workspaceAffinity";
import { computeSessionIntelligence, formatSessionIntelligenceMarkdown } from "./sessionIntelligence";

const libraryDir = path.join(__dirname, "..", "skills_library");

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "session-intelligence-"));
}

function installOutdatedSkill(target: string, name: string): void {
  const skillDir = path.join(target, ".claude", "skills", name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# test\n", "utf-8");
  writeSkillVersionSidecar(skillDir, "1.0.0");
}

describe("computeSessionIntelligence", () => {
  it("surfaces proven skills as top skills and outdated skills as updates available", () => {
    const target = makeWorkspace();
    installOutdatedSkill(target, "terraform-plan-review");

    const events = Array.from({ length: 20 }, (_, i) => ({
      taskId: `s${i}`, skill: "terraform-plan-review", event: "invoked" as const, source: "manual" as const,
    }));
    appendAdoptionEvents(target, [...events, ...events.map((e) => ({ ...e, event: "successful" as const }))]);

    const manifest = loadManifest(libraryDir);
    const report = computeSessionIntelligence(target, libraryDir, manifest);

    expect(report.topSkills.some((s) => s.skill === "terraform-plan-review")).toBe(true);
    expect(report.updatesAvailable.some((u) => u.skill === "terraform-plan-review")).toBe(true);
  });

  it("is advisory only — never installs or modifies skill files", () => {
    const target = makeWorkspace();
    installOutdatedSkill(target, "terraform-plan-review");
    const manifest = loadManifest(libraryDir);

    computeSessionIntelligence(target, libraryDir, manifest);

    // Still exactly the stub SKILL.md we wrote — nothing was upgraded/replaced.
    const content = fs.readFileSync(
      path.join(target, ".claude", "skills", "terraform-plan-review", "SKILL.md"),
      "utf-8"
    );
    expect(content).toBe("# test\n");
  });

  it("emits a bootstrap-generated observability event", () => {
    const target = makeWorkspace();
    const manifest = loadManifest(libraryDir);
    computeSessionIntelligence(target, libraryDir, manifest);

    const log = fs.readFileSync(workspaceAffinityLogPath(target), "utf-8");
    expect(log).toContain("bootstrap-generated");
  });
});

describe("formatSessionIntelligenceMarkdown", () => {
  it("renders top skills and updates with the expected markers", () => {
    const content = formatSessionIntelligenceMarkdown({
      generatedAt: new Date().toISOString(),
      topSkills: [
        { skill: "k3s-kuberocketci", observations: 265, manualInvocations: 12, recommendationInvocations: 2, successCount: 200, reuseCount: 30, affinityScore: 95 },
      ],
      updatesAvailable: [
        { skill: "profile-init", installedVersion: "1.0.0", latestVersion: "1.1.0", status: "outdated", affinity: 95, usageLast30d: 120, daysOutdated: 10, updatePriority: "HIGH", priorityScore: 90 },
      ],
    });

    expect(content).toContain("⭐ k3s-kuberocketci");
    expect(content).toContain("⚠ profile-init");
    expect(content).toContain("1.0.0 → 1.1.0");
    expect(content).toContain("Used 120 times recently");
  });

  it("returns undefined when there is nothing to report", () => {
    const content = formatSessionIntelligenceMarkdown({
      generatedAt: new Date().toISOString(),
      topSkills: [],
      updatesAvailable: [],
    });
    expect(content).toBeUndefined();
  });
});
