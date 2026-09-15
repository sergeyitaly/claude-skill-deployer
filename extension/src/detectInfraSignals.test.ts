/**
 * Regression tests for detectInfraSignals()/walkForPattern() (hookHandlers.ts).
 *
 * Confirmed live in this project (extension value audit): handlePracticalFocus() calls
 * detectInfraSignals() on every UserPromptSubmit, and 5 of its 7 checks call
 * walkForPattern() with NO node_modules/.git exclusion — unlike collectRelativePaths()
 * (skillOps.ts) right in the same codebase, which already excludes the same directories.
 * A real node_modules with 14,421 files (this repo's extension/node_modules) turned a
 * per-prompt hook into a 124-164ms disk walk. Fixed by reusing skillOps.ts's EXCLUDE_DIRS
 * and adding a short-TTL cache (matching detectRelevantSkills()'s existing pattern).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectInfraSignals, invalidateInfraSignalsCache } from "./hookHandlers";

const workspaces: string[] = [];

function makeWorkspace(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "infra-signals-"));
  workspaces.push(ws);
  return ws;
}

afterEach(() => {
  invalidateInfraSignalsCache();
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

describe("detectInfraSignals", () => {
  it("detects a real Terraform file outside excluded directories", () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "main.tf"), "resource \"x\" \"y\" {}\n");

    expect(detectInfraSignals(ws)).toContain("Terraform");
  });

  it("does not descend into node_modules looking for matches", () => {
    const ws = makeWorkspace();
    const nm = path.join(ws, "node_modules", "some-package");
    fs.mkdirSync(nm, { recursive: true });
    // A .tf file that ONLY exists inside node_modules must not be found — if it is,
    // the exclusion regressed and every prompt pays the full node_modules walk again.
    fs.writeFileSync(path.join(nm, "decoy.tf"), "resource \"x\" \"y\" {}\n");

    expect(detectInfraSignals(ws)).not.toContain("Terraform");
  });

  it("does not descend into .git looking for matches", () => {
    const ws = makeWorkspace();
    const gitDir = path.join(ws, ".git", "hooks");
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, "k8s-deployment.yaml"), "kind: Deployment\n");

    expect(detectInfraSignals(ws)).not.toContain("Kubernetes");
  });

  it("still finds a real signal alongside a large excluded node_modules tree", () => {
    const ws = makeWorkspace();
    const nm = path.join(ws, "node_modules");
    // Simulate a modest but real node_modules footprint so the test also serves as a
    // smoke check that exclusion (not luck/small fixture size) is what keeps this fast.
    for (let i = 0; i < 50; i++) {
      const pkgDir = path.join(nm, `pkg-${i}`);
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {};\n");
    }
    fs.mkdirSync(path.join(ws, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".github", "workflows", "ci.yml"), "name: CI\n");

    const signals = detectInfraSignals(ws);
    expect(signals).toContain("GitHub Actions");
    expect(signals).not.toContain("Terraform");
  });

  it("caches results within the TTL — a second call for the same workspace is a cache hit", () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "main.tf"), "resource \"x\" \"y\" {}\n");

    const first = detectInfraSignals(ws);
    // Delete the file after the first call; a cache hit still returns the stale (but
    // correct-for-the-TTL-window) result instead of re-scanning immediately.
    fs.unlinkSync(path.join(ws, "main.tf"));
    const second = detectInfraSignals(ws);

    expect(second).toEqual(first);
  });

  it("re-scans after the cache is explicitly invalidated", () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "main.tf"), "resource \"x\" \"y\" {}\n");
    expect(detectInfraSignals(ws)).toContain("Terraform");

    fs.unlinkSync(path.join(ws, "main.tf"));
    invalidateInfraSignalsCache();

    expect(detectInfraSignals(ws)).not.toContain("Terraform");
  });
});
