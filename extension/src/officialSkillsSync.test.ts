import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkOfficialSkillUpdates,
  classifyOfficialSkillCandidates,
  formatOfficialSkillsSessionContext,
  listLocalSkillNames,
  OFFICIAL_SKILLS_CHECK_TTL_MS,
  readOfficialSkillsState,
  resolveSkillsLibraryDir,
  workspaceUsesOfficialSkillUpdater,
  writeOfficialSkillsState,
} from "./officialSkillsSync";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(() => "deadbeef1234\tHEAD\n"),
}));

// No real network calls in tests — fetchUpstreamSkillNames() always fails fast here, which
// is fine: the TTL-gate tests below only care about whether execFileSync (git ls-remote)
// ran, and both the success and failure paths after it now cache repoSha the same way.
vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network disabled in tests"))));

const workspaces: string[] = [];

function makeLibrary(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csd-official-"));
  workspaces.push(root);
  const libraryDir = path.join(root, "skills_library");
  fs.mkdirSync(path.join(libraryDir, "existing-skill"), { recursive: true });
  fs.writeFileSync(path.join(libraryDir, "existing-skill", "SKILL.md"), "# existing\n", "utf-8");
  fs.writeFileSync(path.join(libraryDir, "manifest.json"), '{"skills":{}}\n', "utf-8");
  return root;
}

afterEach(() => {
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

describe("officialSkillsSync", () => {
  it("resolves skills_library from workspace root", () => {
    const root = makeLibrary();
    expect(resolveSkillsLibraryDir(root)).toBe(path.join(root, "skills_library"));
  });

  it("classifies new, managed updated, and collision skills", () => {
    const root = makeLibrary();
    const libraryDir = path.join(root, "skills_library");
    fs.writeFileSync(
      path.join(libraryDir, ".official-skills-state.json"),
      JSON.stringify({ repoSha: "abc", skills: { "managed-skill": "oldsha" } }) + "\n",
      "utf-8"
    );
    fs.mkdirSync(path.join(libraryDir, "managed-skill"), { recursive: true });
    fs.writeFileSync(path.join(libraryDir, "managed-skill", "SKILL.md"), "# managed\n", "utf-8");

    const candidates = classifyOfficialSkillCandidates(
      libraryDir,
      ["brand-new", "managed-skill", "existing-skill"],
      readOfficialSkillsState(libraryDir)
    );

    expect(candidates).toEqual([
      { name: "brand-new", kind: "new" },
      { name: "managed-skill", kind: "updated" },
      { name: "existing-skill", kind: "collision" },
    ]);
  });

  it("formats session context when updates exist", () => {
    const message = formatOfficialSkillsSessionContext({
      libraryDir: "/tmp/lib",
      remoteSha: "deadbeef1234",
      previousSha: null,
      unchanged: false,
      candidates: [
        { name: "pdf", kind: "new" },
        { name: "docx", kind: "updated" },
      ],
    });
    expect(message).toContain("skill-official-updater");
    expect(message).toContain("automatically pull");
    expect(message).toContain("pdf");
    expect(message).toContain("docx");
  });

  it("detects official updater via skills_library or installed skill", () => {
    const root = makeLibrary();
    expect(workspaceUsesOfficialSkillUpdater(root)).toBe(true);

    const other = fs.mkdtempSync(path.join(os.tmpdir(), "csd-official-other-"));
    workspaces.push(other);
    fs.mkdirSync(path.join(other, ".claude", "skills", "skill-official-updater"), { recursive: true });
    fs.writeFileSync(path.join(other, ".claude", "skills", "skill-official-updater", "SKILL.md"), "# x\n", "utf-8");
    expect(workspaceUsesOfficialSkillUpdater(other)).toBe(true);
  });

  it("lists local skill directories with SKILL.md", () => {
    const root = makeLibrary();
    const names = listLocalSkillNames(path.join(root, "skills_library"));
    expect(names.has("existing-skill")).toBe(true);
  });
});

describe("checkOfficialSkillUpdates — TTL gate (previously missing entirely)", () => {
  afterEach(() => {
    vi.mocked(childProcess.execFileSync).mockClear();
  });

  it("regression: no state file at all means the network check always ran — now still checks, but persists state for next time", async () => {
    // Confirmed live: writeOfficialSkillsState() didn't exist anywhere in production code,
    // so readOfficialSkillsState() always returned null and every single SessionStart paid
    // a real git-ls-remote round trip (avg ~880ms, up to a 15s timeout), despite the
    // skill's own docs calling this "a cheap check."
    const root = makeLibrary();
    const libraryDir = path.join(root, "skills_library");
    expect(readOfficialSkillsState(libraryDir)).toBeNull();

    await checkOfficialSkillUpdates(libraryDir);

    expect(childProcess.execFileSync).toHaveBeenCalledTimes(1);
    const state = readOfficialSkillsState(libraryDir);
    expect(state?.repoSha).toBe("deadbeef1234");
    expect(state?.lastCheckedAt).toBeDefined();
  });

  it("skips the network entirely when the last check is within the TTL window", async () => {
    const root = makeLibrary();
    const libraryDir = path.join(root, "skills_library");
    writeOfficialSkillsState(libraryDir, {
      repoSha: "cachedsha",
      lastCheckedAt: new Date(Date.now() - 60_000).toISOString(), // 1 minute ago
    });

    const result = await checkOfficialSkillUpdates(libraryDir);

    expect(childProcess.execFileSync).not.toHaveBeenCalled();
    expect(result.unchanged).toBe(true);
    expect(result.remoteSha).toBe("cachedsha");
  });

  it("checks the network again once the TTL window has passed", async () => {
    const root = makeLibrary();
    const libraryDir = path.join(root, "skills_library");
    writeOfficialSkillsState(libraryDir, {
      repoSha: "staleSha",
      lastCheckedAt: new Date(Date.now() - OFFICIAL_SKILLS_CHECK_TTL_MS - 60_000).toISOString(),
    });

    await checkOfficialSkillUpdates(libraryDir);

    expect(childProcess.execFileSync).toHaveBeenCalledTimes(1);
  });
});
