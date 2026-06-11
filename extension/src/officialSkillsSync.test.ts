import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyOfficialSkillCandidates,
  formatOfficialSkillsSessionContext,
  listLocalSkillNames,
  readOfficialSkillsState,
  resolveSkillsLibraryDir,
  workspaceUsesOfficialSkillUpdater,
} from "./officialSkillsSync";

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
