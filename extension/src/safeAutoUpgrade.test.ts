import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SkillVersionStatus } from "./skillLifecycle";
import {
  autoUpgradeTrustedSkills,
  isTrustedRelease,
  listSkillBackups,
  rollbackSkillUpgrade,
  snapshotSkillForRollback,
} from "./safeAutoUpgrade";

const libraryDir = path.join(__dirname, "..", "skills_library");

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "safe-auto-upgrade-"));
}

function status(overrides: Partial<SkillVersionStatus>): SkillVersionStatus {
  return {
    name: "example-skill",
    installedVersion: "1.0.0",
    catalogVersion: "1.0.1",
    deprecated: false,
    outdated: true,
    ...overrides,
  };
}

describe("isTrustedRelease", () => {
  it("trusts a patch-only version bump", () => {
    expect(isTrustedRelease(status({ installedVersion: "1.0.0", catalogVersion: "1.0.1" }))).toBe(true);
  });

  it("does not trust a minor version bump", () => {
    expect(isTrustedRelease(status({ installedVersion: "1.0.0", catalogVersion: "1.1.0" }))).toBe(false);
  });

  it("does not trust a major version bump", () => {
    expect(isTrustedRelease(status({ installedVersion: "1.0.0", catalogVersion: "2.0.0" }))).toBe(false);
  });

  it("trusts a minor bump whose changelog reads as documentation-only", () => {
    expect(
      isTrustedRelease(status({ installedVersion: "1.0.0", catalogVersion: "1.1.0", changelog: "Fixed typos in README wording" }))
    ).toBe(true);
  });

  it("never trusts a release whose changelog mentions a breaking change", () => {
    expect(
      isTrustedRelease(status({ installedVersion: "1.0.0", catalogVersion: "1.0.1", changelog: "Breaking change to output format" }))
    ).toBe(false);
  });

  it("never trusts a deprecated skill", () => {
    expect(isTrustedRelease(status({ deprecated: true }))).toBe(false);
  });

  it("returns false for a skill that isn't outdated", () => {
    expect(isTrustedRelease(status({ outdated: false }))).toBe(false);
  });
});

describe("snapshotSkillForRollback / rollbackSkillUpgrade", () => {
  it("snapshots the skill directory and restores it on rollback", () => {
    const target = makeWorkspace();
    const skillDir = path.join(target, ".claude", "skills", "example-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# version 1.0.0\n", "utf-8");

    const meta = snapshotSkillForRollback(target, "example-skill", "1.0.0", "1.0.1");
    expect(meta).toBeDefined();
    expect(fs.readFileSync(path.join(meta!.backupDir, "SKILL.md"), "utf-8")).toBe("# version 1.0.0\n");

    // Simulate the upgrade actually changing the file.
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# version 1.0.1\n", "utf-8");

    const rolledBack = rollbackSkillUpgrade(target, "example-skill");
    expect(rolledBack).toBe(true);
    expect(fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8")).toBe("# version 1.0.0\n");
  });

  it("lists backups most-recent first", () => {
    const target = makeWorkspace();
    const skillDir = path.join(target, ".claude", "skills", "example-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# v1\n", "utf-8");
    snapshotSkillForRollback(target, "example-skill", "1.0.0", "1.0.1");

    const backups = listSkillBackups(target, "example-skill");
    expect(backups.length).toBeGreaterThanOrEqual(1);
    expect(backups[0].fromVersion).toBe("1.0.0");
  });

  it("returns false when rolling back a skill with no backup", () => {
    const target = makeWorkspace();
    expect(rollbackSkillUpgrade(target, "never-backed-up")).toBe(false);
  });
});

describe("autoUpgradeTrustedSkills", () => {
  it("upgrades nothing when claudeSkills.autoUpgradeTrustedSkills is disabled (the default)", async () => {
    const target = makeWorkspace();
    const skillDir = path.join(target, ".claude", "skills", "terraform-plan-review");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# test\n", "utf-8");

    // The vscode test mock returns the config default (false) for this setting,
    // matching the shipped default — auto-upgrade must be a strict opt-in.
    const upgraded = await autoUpgradeTrustedSkills(libraryDir, target);
    expect(upgraded).toEqual([]);
  });
});
