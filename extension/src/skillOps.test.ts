import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectRelevantSkills, loadManifest, patternMatchesAny } from "./skillOps";

const workspaces: string[] = [];

function makeWorkspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-ops-"));
  workspaces.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf-8");
  }
  return root;
}

afterEach(() => {
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

describe("patternMatchesAny", () => {
  it("matches a top-level file against a **/ prefixed glob", () => {
    expect(patternMatchesAny("**/*.tf", ["main.tf"])).toBe(true);
  });

  it("does not match unrelated extensions", () => {
    expect(patternMatchesAny("**/*.tf", ["README.md"])).toBe(false);
  });
});

describe("catch-all detect_globs (regression: universal-match skills shouldn't auto-install)", () => {
  // Real, bundled manifest — several skills (brand-guidelines, canvas-design, claude-api,
  // frontend-design, mcp-builder, theme-factory, web-artifacts-builder, webapp-testing)
  // have detect_globs: ["**/*"], a literal match-everything pattern. A live benchmark run
  // against a pure Terraform/Azure/GitHub-Actions repo found "Install Relevant Skills for
  // Workspace" installing all of them anyway — 13 of 24 installed skills had zero real
  // relevance, because detectRelevantSkills() (unlike the task-skill-proposals confidence
  // scoring) had no discount for catch-all globs.
  const manifest = loadManifest(path.join(__dirname, "..", "skills_library"));

  it("does NOT detect brand-guidelines (detect_globs: [\"**/*\"]) for an unrelated infra repo", () => {
    const root = makeWorkspace({
      "main.tf": 'resource "null_resource" "x" {}\n',
      ".github/workflows/ci.yml": "name: CI\non: [push]\n",
    });

    const detected = detectRelevantSkills(root, manifest);

    expect(detected["brand-guidelines"]).toBeUndefined();
  });

  it("still detects a skill with a real, specific glob match in the same repo", () => {
    const root = makeWorkspace({
      "main.tf": 'resource "null_resource" "x" {}\n',
      ".github/workflows/ci.yml": "name: CI\non: [push]\n",
    });

    const detected = detectRelevantSkills(root, manifest);

    expect(detected["terraform-plan-review"]).toBeDefined();
    expect(detected["github-actions-ci"]).toBeDefined();
  });
});

describe("deployment-practical detect_globs (regression: broad-glob false positives)", () => {
  // Real, bundled manifest — catches any future re-widening of detect_globs,
  // not just a hand-written fixture copy.
  const manifest = loadManifest(path.join(__dirname, "..", "skills_library"));

  it("does NOT propose deployment-practical for a repo with only a README and a CI workflow", () => {
    const root = makeWorkspace({
      "README.md": "# Just a readme\n",
      ".github/workflows/ci.yml": "name: CI\non: [push]\n",
    });

    const detected = detectRelevantSkills(root, manifest);

    expect(detected["deployment-practical"]).toBeUndefined();
  });

  it("still proposes deployment-practical when real IaC/container evidence is present", () => {
    const root = makeWorkspace({
      "main.tf": 'resource "null_resource" "x" {}\n',
      Dockerfile: "FROM node:22\n",
    });

    const detected = detectRelevantSkills(root, manifest);

    expect(detected["deployment-practical"]).toBeDefined();
    expect(detected["deployment-practical"]).toEqual(
      expect.arrayContaining(["**/*.tf", "**/Dockerfile"])
    );
  });
});
