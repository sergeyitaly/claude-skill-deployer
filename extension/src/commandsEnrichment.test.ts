/**
 * Real-runtime regression test for the 1.0.127 enrichment auto-apply fix.
 *
 * v1.0.126 defaulted `claudeSkills.enrichment.autoApply` to `true`, which meant
 * autoApplyEnrichmentProposals() approved *and* wrote proposals into SKILL.md
 * automatically whenever the pipeline ran (e.g. on SessionStart) — contradicting
 * skillEnrichmentProposal.ts's documented safety contract that SKILL.md is only
 * ever written after an explicit user confirmation, unless autoApply is opted in.
 *
 * v1.0.127 split the single setting into `autoApprove` (default true, never
 * touches SKILL.md) and `autoApply` (default false, gates the actual write).
 * These tests exercise the real autoApplyEnrichmentProposals() function against
 * a real proposal file and a real SKILL.md on disk — not a re-implementation of
 * its logic — to confirm the default is now safe and the opt-in path still works.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { afterEach, describe, expect, it, vi } from "vitest";
import { autoApplyEnrichmentProposals } from "./commandsEnrichment";
import { readEnrichmentProposals, type EnrichmentProposal } from "./skillEnrichmentProposal";

// applyEnrichmentProposal() (invoked by autoApplyEnrichmentProposals) checks the REAL
// globalSkillsDir() (~/.claude/skills) as one of its SKILL.md search paths. Without this
// mock, a test-seeded proposal for a skill name that happens to exist in the developer's
// actual global skills dir (e.g. "pdf") would silently append real enrichment text into
// that real, non-test file. Redirect os.homedir() to an isolated temp dir for every test
// in this file so globalSkillsDir() can never resolve outside the sandbox.
const mockedHome = vi.hoisted(() => ({ value: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockedHome.value || actual.homedir(),
  };
});

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  mockedHome.value = "";
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* non-fatal */ }
  }
});

function makeTarget(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enrichment-auto-apply-"));
  fs.mkdirSync(path.join(dir, ".claude", "learning"), { recursive: true });
  tempDirs.push(dir);
  // Point the mocked homedir at an isolated directory with no .claude/skills of its own,
  // so globalSkillsDir() (~/.claude/skills) can never resolve to the real global skills dir.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "enrichment-fake-home-"));
  tempDirs.push(fakeHome);
  mockedHome.value = fakeHome;
  return dir;
}

/**
 * Seeds a real skills library dir with a SKILL.md, and a real pending proposal for it.
 * autoApplyEnrichmentProposals() searches `libraryDir/..` for SKILL.md (mirroring the
 * real command's `path.join(libraryDir, "..")` — the skills_library's parent), so the
 * file must live one level up from libraryDir, not inside it.
 */
function seedPendingProposal(target: string, libraryDir: string, skill = "pdf"): string {
  const skillMdDir = path.join(libraryDir, "..", skill);
  fs.mkdirSync(skillMdDir, { recursive: true });
  fs.writeFileSync(path.join(skillMdDir, "SKILL.md"), "# PDF skill\n\nOriginal content.\n", "utf-8");

  const proposal: EnrichmentProposal = {
    id: "prop-1",
    ts: new Date().toISOString(),
    skill,
    patternId: "pattern-1",
    patternLabel: "common troubleshooting step",
    status: "pending",
    evidence: { sessions: 5, successRate: 0.9, occurrences: 5 },
    confidence: 0.85,
    sectionTitle: "## Troubleshooting XYZ",
    proposedContent: "## Troubleshooting XYZ\n\nWhen XYZ fails, do ABC.",
    affectedFiles: [],
    typicalCommands: [],
  };
  const file = path.join(target, ".claude", "learning", "skill-enrichment-proposals.jsonl");
  fs.writeFileSync(file, JSON.stringify(proposal) + "\n", "utf-8");
  return proposal.id;
}

/** Overrides the vscode mock's getConfiguration for claudeSkills.enrichment.* only. */
function mockEnrichmentSettings(overrides: { autoApprove?: boolean; autoApply?: boolean }): void {
  vi.spyOn(vscode.workspace, "getConfiguration").mockImplementation((section?: string) => ({
    get: <T,>(key: string, defaultValue?: T): T | undefined => {
      if (section === "claudeSkills.enrichment" && key === "autoApprove" && overrides.autoApprove !== undefined) {
        return overrides.autoApprove as T;
      }
      if (section === "claudeSkills.enrichment" && key === "autoApply" && overrides.autoApply !== undefined) {
        return overrides.autoApply as T;
      }
      return defaultValue;
    },
    inspect: () => undefined,
    update: async () => undefined,
  }) as unknown as vscode.WorkspaceConfiguration);
}

describe("autoApplyEnrichmentProposals — default settings (autoApprove=true, autoApply=false)", () => {
  it("approves the pending proposal but never writes to SKILL.md", () => {
    const target = makeTarget();
    const libraryDir = path.join(target, "skills_library");
    const skillMdPath = path.join(libraryDir, "..", "pdf", "SKILL.md");
    seedPendingProposal(target, libraryDir);
    const originalSkillMd = fs.readFileSync(skillMdPath, "utf-8");

    const result = autoApplyEnrichmentProposals(target, libraryDir, () => {});

    expect(result.approved).toBe(1);
    expect(result.applied).toBe(0);

    const [proposal] = readEnrichmentProposals(target);
    expect(proposal.status).toBe("approved");

    // The safety contract: SKILL.md must be byte-for-byte untouched under defaults.
    expect(fs.readFileSync(skillMdPath, "utf-8")).toBe(originalSkillMd);
  });
});

describe("autoApplyEnrichmentProposals — autoApply explicitly enabled", () => {
  it("approves and writes the proposal into SKILL.md when the user opts in", () => {
    const target = makeTarget();
    const libraryDir = path.join(target, "skills_library");
    const skillMdPath = path.join(libraryDir, "..", "pdf", "SKILL.md");
    seedPendingProposal(target, libraryDir);

    mockEnrichmentSettings({ autoApprove: true, autoApply: true });

    const result = autoApplyEnrichmentProposals(target, libraryDir, () => {});

    expect(result.approved).toBe(1);
    expect(result.applied).toBe(1);

    const [proposal] = readEnrichmentProposals(target);
    expect(proposal.status).toBe("applied");
    expect(fs.readFileSync(skillMdPath, "utf-8")).toContain("Troubleshooting XYZ");
  });
});

describe("autoApplyEnrichmentProposals — gates are independent", () => {
  it("autoApply=true has nothing to apply when autoApprove=false leaves the proposal pending", () => {
    const target = makeTarget();
    const libraryDir = path.join(target, "skills_library");
    const skillMdPath = path.join(libraryDir, "..", "pdf", "SKILL.md");
    seedPendingProposal(target, libraryDir);
    const originalSkillMd = fs.readFileSync(skillMdPath, "utf-8");

    mockEnrichmentSettings({ autoApprove: false, autoApply: true });

    const result = autoApplyEnrichmentProposals(target, libraryDir, () => {});

    // Nothing was ever approved, so applyEnrichmentProposal has no "approved"
    // candidate to act on — the proposal stays pending and SKILL.md is untouched.
    expect(result.approved).toBe(0);
    expect(result.applied).toBe(0);

    const [proposal] = readEnrichmentProposals(target);
    expect(proposal.status).toBe("pending");
    expect(fs.readFileSync(skillMdPath, "utf-8")).toBe(originalSkillMd);
  });
});
