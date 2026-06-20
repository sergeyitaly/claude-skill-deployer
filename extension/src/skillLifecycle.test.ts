import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessSkillVersion,
  compareSemver,
  getInstalledSkillVersion,
  listOutdatedSkills,
  stampMissingVersionSidecars,
} from "./skillLifecycle";
import { writeSkillVersionSidecar } from "./skillOps";

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skill-lifecycle-"));
}

describe("compareSemver", () => {
  it("orders semver strings", () => {
    expect(compareSemver("1.0.0", "1.2.0")).toBeLessThan(0);
    expect(compareSemver("1.2.0", "1.2.0")).toBe(0);
    expect(compareSemver("2.0.0", "1.9.9")).toBeGreaterThan(0);
  });
});

describe("assessSkillVersion", () => {
  it("flags outdated installed skills", () => {
    const target = makeWorkspace();
    const skillDir = path.join(target, ".claude", "skills", "terraform-plan-review");
    fs.mkdirSync(skillDir, { recursive: true });
    writeSkillVersionSidecar(skillDir, "1.0.0", "Old copy");

    const status = assessSkillVersion(
      "terraform-plan-review",
      { description: "x", detect_globs: ["**/*.tf"], version: "1.2.0", changelog: "Improved Terraform parsing" },
      target
    );
    expect(status.outdated).toBe(true);
    expect(status.catalogVersion).toBe("1.2.0");
    expect(getInstalledSkillVersion(target, "terraform-plan-review")).toBe("1.0.0");
  });

  it("lists outdated skills from library manifest", () => {
    const target = makeWorkspace();
    const libraryDir = path.join(__dirname, "..", "skills_library");
    const skillDir = path.join(target, ".claude", "skills", "terraform-plan-review");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# test\n", "utf-8");
    writeSkillVersionSidecar(skillDir, "1.0.0");

    const outdated = listOutdatedSkills(libraryDir, target);
    expect(outdated.some((s) => s.name === "terraform-plan-review")).toBe(true);
  });
});


describe("stampMissingVersionSidecars", () => {
  it("stamps a sidecar for a skill that has none", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-stamp-"));
    const libraryDir = path.join(__dirname, "..", "skills_library");
    const skillDir = path.join(target, ".claude", "skills", "terraform-plan-review");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# test\n", "utf-8");

    const stamped = stampMissingVersionSidecars(libraryDir, target);

    expect(stamped).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(skillDir, ".skill-version.json"))).toBe(true);
    fs.rmSync(target, { recursive: true, force: true });
  });

  it("skips skills that already have a sidecar", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-stamp2-"));
    const libraryDir = path.join(__dirname, "..", "skills_library");
    const skillDir = path.join(target, ".claude", "skills", "terraform-plan-review");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# test\n", "utf-8");
    writeSkillVersionSidecar(skillDir, "1.2.0");

    const stamped = stampMissingVersionSidecars(libraryDir, target);

    expect(stamped).toBe(0);
    fs.rmSync(target, { recursive: true, force: true });
  });
});

describe("compareSemver edge cases", () => {
  it("handles v prefix", () => {
    expect(compareSemver("v1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("v2.0.0", "v1.9.9")).toBeGreaterThan(0);
  });

  it("handles partial versions (major only)", () => {
    expect(compareSemver("2", "1.9.9")).toBeGreaterThan(0);
    expect(compareSemver("1", "1.0.0")).toBe(0);
  });

  it("treats missing segments as 0", () => {
    expect(compareSemver("1.1", "1.1.0")).toBe(0);
    expect(compareSemver("1.2", "1.1.9")).toBeGreaterThan(0);
  });
});