import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockConfig: Record<string, Record<string, unknown>> = {
  "claudeSkills.taskFocus": { enabled: false },
};

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: (section: string) => ({
      get: (key: string, defaultValue?: unknown) => {
        if (mockConfig[section] && key in mockConfig[section]) {
          return mockConfig[section][key];
        }
        if (section === "claudeSkills.agents" && key === "enabled") {
          return ["claude", "cursor", "kiro", "copilot"];
        }
        return defaultValue;
      },
    }),
  },
}));

import { readSkillOverrides } from "./skillOps";
import {
  applyTaskSkillFocus,
  applyTaskSkillFocusFromProposals,
  taskSkillFocusEnabled,
} from "./taskSkillFocus";
import { applyProposedSkillsLocally } from "./sessionSkillApply";
import { writeTaskSkillProposals } from "./taskSkillProposals";
import { listInstalledSkills } from "./usageStats";

const workspaces: string[] = [];

function makeWorkspace(skillNames: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csd-taskfocus-off-"));
  workspaces.push(dir);
  for (const name of skillNames) {
    const skillDir = path.join(dir, ".claude", "skills", name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf-8");
  }
  return dir;
}

function makeGitWorkspaceWithCommittedSkills(skillNames: string[]): string {
  const dir = makeWorkspace(skillNames);
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
  execSync("git add .claude", { cwd: dir, stdio: "ignore" });
  execSync('git commit -m "seed skills"', { cwd: dir, stdio: "ignore" });
  return dir;
}

afterEach(() => {
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
  mockConfig["claudeSkills.taskFocus"] = { enabled: false };
});

describe("claudeSkills.taskFocus.enabled = false", () => {
  it("taskSkillFocusEnabled() reflects the setting", () => {
    expect(taskSkillFocusEnabled()).toBe(false);
    mockConfig["claudeSkills.taskFocus"] = { enabled: true };
    expect(taskSkillFocusEnabled()).toBe(true);
  });

  it("applyTaskSkillFocusFromProposals() is a no-op — no skills get disabled", () => {
    const target = makeWorkspace([
      "dependency-analysis",
      "documentation-review",
      "test-coverage-review",
      "ci-cd-inspection",
      "security-audit-review",
    ]);

    // A narrow proposal set that WOULD normally trigger narrowing to just one skill.
    writeTaskSkillProposals(target, {
      version: 1,
      generatedAt: new Date().toISOString(),
      taskSummary: "Create a release-readiness report",
      promptExcerpt: "release readiness",
      proposals: [
        { name: "dependency-analysis", reason: "release readiness", confidence: 95, installed: true },
      ],
    });

    const result = applyTaskSkillFocusFromProposals(
      path.join(__dirname, "..", "skills_library"),
      target
    );

    expect(result.applied).toBe(false);
    const overrides = readSkillOverrides(target);
    expect(Object.keys(overrides)).toHaveLength(0);
    // Every branch of exploration stays reachable — none force-disabled.
    for (const name of [
      "dependency-analysis",
      "documentation-review",
      "test-coverage-review",
      "ci-cd-inspection",
      "security-audit-review",
    ]) {
      expect(listInstalledSkills(target)).toContain(name);
      expect(overrides[name]).toBeUndefined();
    }
  });

  it("directly calling applyTaskSkillFocus still narrows (enabled only gates the caller) — documents the exact seam disabled by the setting", () => {
    // This asserts the boundary precisely: taskFocus.enabled controls whether
    // applyTaskSkillFocus is *invoked* at all (in applyTaskSkillFocusFromProposals /
    // applyProposedSkillsLocally) — it is not re-checked inside applyTaskSkillFocus
    // itself, which remains a pure function usable directly by tests/other callers.
    const target = makeWorkspace(["pdf", "mcp-builder"]);
    const focus = applyTaskSkillFocus(target, ["pdf"], "task-skill-proposals");
    expect(focus.ignoredSkills).toContain("mcp-builder");
  });

  it(
    "applyProposedSkillsLocally() does not force-disable other branch-committed installed skills",
    { timeout: 15000 },
    () => {
      // Regression: applyProposedSkillsLocally reuses applyBranchProfile's reconciliation
      // machinery to install proposed skills. That machinery force-disables any installed,
      // branch-committed skill outside the "desired" set — a check that never consulted
      // taskSkillFocusEnabled() at all, so it kept reintroducing "off" overrides on every
      // session-apply even with the master switch off.
      const target = makeGitWorkspaceWithCommittedSkills(["mcp-builder", "github-actions-ci"]);

      applyProposedSkillsLocally(
        path.join(__dirname, "..", "skills_library"),
        target,
        ["mcp-builder"]
      );

      const overrides = readSkillOverrides(target);
      expect(overrides["github-actions-ci"]).toBeUndefined();
    }
  );
});
