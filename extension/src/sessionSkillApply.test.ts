import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import * as featureFlags from "./featureFlags";
import { setSkillOverride } from "./skillOps";
import {
  applyProposedSkillsLocally,
  applyTaskProposalsIfPending,
  processSessionSkillApplyRequest,
  queueSessionSkillApplyRequest,
  readSessionSkillApplyRequest,
  resolveProposedSkillNamesWithSource,
  SESSION_APPLY_REQUEST_REL,
} from "./sessionSkillApply";
import { writeTaskSkillProposals } from "./taskSkillProposals";

function makeGitWorkspace(branch = "feature/session-apply"): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "session-apply-"));
  execSync("git init", { cwd: target, stdio: "ignore" });
  execSync(`git checkout -b ${branch}`, { cwd: target, stdio: "ignore" });
  execSync("git config user.email test@test.com", { cwd: target, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: target, stdio: "ignore" });
  return target;
}

describe("applyProposedSkillsLocally", () => {
  const libraryDir = path.join(__dirname, "..", "skills_library");

  it("installs missing skills and clears local off overrides", { timeout: 15000 }, () => {
    const target = makeGitWorkspace();
    setSkillOverride(target, "self-learning", "off");

    const result = applyProposedSkillsLocally(libraryDir, target, ["self-learning", "file-style-conventions"]);
    expect(result.overridesApplied).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(target, ".claude", "skills", "self-learning", "SKILL.md"))).toBe(true);
  });
});

describe("processSessionSkillApplyRequest", () => {
  const libraryDir = path.join(__dirname, "..", "skills_library");

  it("applies once per session id", { timeout: 20000 }, () => {
    const target = makeGitWorkspace();
    writeTaskSkillProposals(target, {
      version: 1,
      generatedAt: new Date().toISOString(),
      taskSummary: "Test task",
      proposals: [
        { name: "self-learning", reason: "platform", confidence: 95, installed: false },
      ],
    });
    queueSessionSkillApplyRequest(target, ["self-learning"], "proposals", "sess-abc");

    const first = processSessionSkillApplyRequest(libraryDir, target);
    expect(first.applied).toBe(true);
    expect(first.result?.installed.length).toBeGreaterThan(0);

    const second = processSessionSkillApplyRequest(libraryDir, target);
    expect(second.applied).toBe(false);

    queueSessionSkillApplyRequest(target, ["self-learning"], "proposals", "sess-def");
    const third = processSessionSkillApplyRequest(libraryDir, target);
    expect(third.applied).toBe(true);
  });

  it("reads hook-written session apply request", () => {
    const target = makeGitWorkspace();
    const file = path.join(target, SESSION_APPLY_REQUEST_REL);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          version: 1,
          requestedAt: new Date().toISOString(),
          sessionId: "hook-session-1",
          platform: "cursor",
          skills: ["skill-creator"],
          source: "proposals",
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );
    expect(readSessionSkillApplyRequest(target)?.sessionId).toBe("hook-session-1");
  });

  it("skips apply when sessionSkillAdaptation feature is off", () => {
    const target = makeGitWorkspace();
    queueSessionSkillApplyRequest(target, ["self-learning"], "proposals", "sess-off");
    const spy = vi.spyOn(featureFlags, "isFeatureEnabled").mockImplementation((key) => key !== "sessionSkillAdaptation");
    try {
      expect(processSessionSkillApplyRequest(libraryDir, target).applied).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("applyTaskProposalsIfPending", () => {
  const libraryDir = path.join(__dirname, "..", "skills_library");

  it("installs all proposals plus required platform skills", { timeout: 15000 }, () => {
    const target = makeGitWorkspace();
    writeTaskSkillProposals(target, {
      version: 1,
      generatedAt: new Date().toISOString(),
      taskSummary: "test task",
      proposals: [
        { name: "ci-preflight", reason: "test", confidence: 40, installed: false },
        { name: "self-learning", reason: "required", confidence: 95, installed: false },
      ],
    });
    const out = applyTaskProposalsIfPending(libraryDir, target);
    expect(out.applied).toBe(true);
    expect(fs.existsSync(path.join(target, ".claude", "skills", "ci-preflight", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(target, ".claude", "skills", "skill-creator", "SKILL.md"))).toBe(true);
  });

  it("resolveProposedSkillNamesWithSource merges required skills", () => {
    const target = makeGitWorkspace();
    writeTaskSkillProposals(target, {
      version: 1,
      generatedAt: new Date().toISOString(),
      taskSummary: "test",
      proposals: [{ name: "ci-preflight", reason: "test", confidence: 80, installed: false }],
    });
    const resolved = resolveProposedSkillNamesWithSource(target);
    expect(resolved.skills).toContain("ci-preflight");
    expect(resolved.skills).toContain("skill-creator");
  });
});
