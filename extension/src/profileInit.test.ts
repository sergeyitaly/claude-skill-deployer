import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/** File copies + multi-agent sync can exceed 5s on Windows CI runners. */
const SLOW_TEST_MS = 30_000;
import {
  applyLocalProfileInit,
  BranchProfileInit,
  DEFAULT_PROFILE_INIT_REQUIRED_SKILLS,
  findMissingRequiredProfileSkills,
  mergeProfileInitSkills,
  profileInitToBranchProfile,
  profileLocalPath,
  readUserPosition,
  recoverRequiredProfileSkills,
  refreshSkillsCatalog,
  SkillsCatalog,
  validateProfileSkills,
  writeProfileInitSkillProposals,
  writeUserPosition,
} from "./profileInit";
import { setSkillOverride } from "./skillOps";

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "profile-init-"));
}

function makeGitWorkspace(branch = "feature/test"): string {
  const target = makeWorkspace();
  execSync("git init", { cwd: target, stdio: "ignore" });
  execSync(`git checkout -b ${branch}`, { cwd: target, stdio: "ignore" });
  execSync("git config user.email test@test.com", { cwd: target, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: target, stdio: "ignore" });
  return target;
}

function positionLocalPath(target: string): string {
  return path.join(target, ".claude", "position.local.json");
}

describe("mergeProfileInitSkills", () => {
  it("prepends required platform skills and dedupes", () => {
    const merged = mergeProfileInitSkills(["ci-pipeline-debug", "self-learning", "terraform-plan-review"]);
    expect(merged.slice(0, DEFAULT_PROFILE_INIT_REQUIRED_SKILLS.length)).toEqual([
      ...DEFAULT_PROFILE_INIT_REQUIRED_SKILLS,
    ]);
    expect(merged).toContain("ci-pipeline-debug");
    expect(merged).toContain("terraform-plan-review");
    expect(merged.filter((s) => s === "self-learning")).toHaveLength(1);
  });
});

describe("validateProfileSkills", () => {
  const catalog: SkillsCatalog = {
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    workspacePath: "/tmp/ws",
    skills: [
      {
        name: "ci-pipeline-debug",
        description: "CI debug",
        detectGlobs: ["**/.gitlab-ci.yml"],
        isRelevant: true,
        matchedGlobs: ["**/.gitlab-ci.yml"],
        installedInWorkspace: false,
        availableInGlobal: true,
        inLibrary: true,
      },
      {
        name: "self-learning",
        description: "Learning",
        detectGlobs: ["**/*"],
        isRelevant: false,
        matchedGlobs: [],
        installedInWorkspace: false,
        availableInGlobal: true,
        inLibrary: true,
      },
    ],
  };

  it("splits known and unknown skill names", () => {
    const { valid, invalid } = validateProfileSkills(
      ["ci-pipeline-debug", "fake-skill", "ci-pipeline-debug"],
      catalog
    );
    expect(valid).toEqual(["ci-pipeline-debug"]);
    expect(invalid).toEqual(["fake-skill"]);
  });
});

describe("position local file", () => {
  it("writes and reads position", () => {
    const target = makeWorkspace();
    fs.mkdirSync(path.join(target, ".git", "info"), { recursive: true });
    const pos = writeUserPosition(target, "qa");
    expect(pos.role).toBe("qa");
    expect(pos.label).toBe("QA");
    expect(readUserPosition(target)?.role).toBe("qa");
    expect(fs.existsSync(positionLocalPath(target))).toBe(true);
  });
});

describe("refreshSkillsCatalog", () => {
  const libraryDir = path.join(__dirname, "..", "skills_library");

  it("writes skills-catalog.json", () => {
    const target = makeWorkspace();
    const catalog = refreshSkillsCatalog(target, libraryDir);
    expect(catalog.skills.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(target, ".claude", "learning", "skills-catalog.json"))).toBe(true);
  });
});

describe("applyLocalProfileInit", () => {
  const libraryDir = path.join(__dirname, "..", "skills_library");

  it("installs skills from profile.local.json and saves branch profile", () => {
    const target = makeGitWorkspace("feature/test");

    refreshSkillsCatalog(target, libraryDir);

    const init: BranchProfileInit = {
      version: 1,
      branch: "feature/test",
      role: "devops",
      roleLabel: "DevOps",
      skills: ["self-learning", "file-style-conventions"],
      initBy: "agent",
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(profileLocalPath(target)), { recursive: true });
    fs.writeFileSync(profileLocalPath(target), JSON.stringify(init, null, 2) + "\n");

    const { result, init: applied, invalid } = applyLocalProfileInit(libraryDir, target);
    expect(invalid).toEqual([]);
    expect(applied?.status).toBe("applied");
    expect(result?.installed.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(target, ".claude", "skills", "self-learning", "SKILL.md"))).toBe(true);

    const onDisk = JSON.parse(fs.readFileSync(profileLocalPath(target), "utf-8")) as BranchProfileInit;
    expect(onDisk.status).toBe("applied");
    expect(onDisk.skills).toContain("self-learning");
  }, SLOW_TEST_MS);
});

describe("profileInitToBranchProfile", () => {
  it("maps init file to branch profile shape", () => {
    const target = makeWorkspace();
    const init: BranchProfileInit = {
      version: 1,
      branch: "main",
      role: "ba",
      roleLabel: "BA",
      skills: ["doc-coauthoring"],
      initBy: "agent",
      status: "pending",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const bp = profileInitToBranchProfile(init, target);
    expect(bp.branch).toBe("main");
    expect(bp.skills).toEqual(mergeProfileInitSkills(["doc-coauthoring"]));
  });
});

describe("writeProfileInitSkillProposals", () => {
  const libraryDir = path.join(__dirname, "..", "skills_library");

  it("writes task-skill-proposals.json for a pending branch profile", () => {
    const target = makeGitWorkspace("feature/proposals");
    const position = writeUserPosition(target, "devops");
    const catalog = refreshSkillsCatalog(target, libraryDir);
    const request = {
      version: 1 as const,
      requestedAt: new Date().toISOString(),
      branch: "feature/proposals",
      position,
      catalogPath: ".claude/learning/skills-catalog.json",
      outputPath: ".claude/profile.local.json",
      relevantSkillNames: catalog.skills.filter((s) => s.isRelevant).map((s) => s.name).slice(0, 5),
      requiredSkillNames: [...DEFAULT_PROFILE_INIT_REQUIRED_SKILLS],
      skillCount: catalog.skills.length,
      status: "pending" as const,
      agentInstructions: "Run profile-init.",
    };

    writeProfileInitSkillProposals(target, catalog, request);

    const proposalsPath = path.join(target, ".claude", "learning", "task-skill-proposals.json");
    expect(fs.existsSync(proposalsPath)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(proposalsPath, "utf-8")) as { proposals: { name: string }[] };
    expect(saved.proposals.length).toBeGreaterThan(0);
    expect(saved.proposals.some((p) => p.name === "self-learning")).toBe(true);
  });
});

describe("recoverRequiredProfileSkills", () => {
  const libraryDir = path.join(__dirname, "..", "skills_library");

  it("detects missing required skills", () => {
    const target = makeGitWorkspace("feature/recover");
    expect(findMissingRequiredProfileSkills(target).length).toBeGreaterThan(0);
  });

  it("reinstalls accidentally deleted required skills", () => {
    const target = makeGitWorkspace("feature/recover-delete");
    const skillDir = path.join(target, ".claude", "skills", "skill-creator");
    fs.mkdirSync(path.dirname(skillDir), { recursive: true });

    const { recovered } = recoverRequiredProfileSkills(libraryDir, target);
    expect(recovered).toContain("skill-creator");
    expect(fs.existsSync(path.join(skillDir, "SKILL.md"))).toBe(true);

    fs.rmSync(skillDir, { recursive: true, force: true });
    expect(findMissingRequiredProfileSkills(target)).toContain("skill-creator");

    const again = recoverRequiredProfileSkills(libraryDir, target);
    expect(again.recovered).toContain("skill-creator");
    expect(fs.existsSync(path.join(skillDir, "SKILL.md"))).toBe(true);
  }, SLOW_TEST_MS);

  it("re-enables locally disabled required skills", () => {
    const target = makeGitWorkspace("feature/recover-off");
    recoverRequiredProfileSkills(libraryDir, target);
    setSkillOverride(target, "self-learning", "off");
    expect(findMissingRequiredProfileSkills(target)).toContain("self-learning");

    const { reEnabled } = recoverRequiredProfileSkills(libraryDir, target);
    expect(reEnabled).toContain("self-learning");
    expect(findMissingRequiredProfileSkills(target)).not.toContain("self-learning");
  });
});
