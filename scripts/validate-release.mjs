#!/usr/bin/env node
/**
 * Cross-platform pre-publish validation for v1.0.0.
 * Run from repo root: node scripts/validate-release.mjs
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const extDir = path.join(repoRoot, "extension");

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

console.log("Validating v1.0.0 release...");

const pkg = JSON.parse(fs.readFileSync(path.join(extDir, "package.json"), "utf-8"));
if (pkg.version !== "1.0.0") {
  fail(`extension/package.json version is ${pkg.version}, expected 1.0.0`);
}

const changelog = fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf-8");
if (!changelog.includes("## [1.0.0]")) {
  fail("CHANGELOG.md missing [1.0.0] section");
}

try {
  execSync("npm run compile", { cwd: extDir, stdio: "inherit" });
} catch {
  fail("TypeScript compile failed");
}

try {
  execSync("node scripts/smoke-test.mjs", { cwd: extDir, stdio: "inherit" });
} catch {
  fail("Smoke tests failed");
}

try {
  execSync("npm audit --omit=dev", { cwd: extDir, stdio: "inherit" });
} catch {
  console.warn("WARN: npm audit reported issues (review before publish)");
}

const iconCandidates = [
  path.join(extDir, "resources", "icon.png"),
  path.join(extDir, "images", "icon.png"),
];
if (!iconCandidates.some((p) => fs.existsSync(p))) {
  console.warn("WARN: Marketplace icon missing (resources/icon.png or images/icon.png)");
}

const vsixGlob = fs.readdirSync(extDir).filter((f) => f.endsWith(".vsix"));
if (vsixGlob.length > 0) {
  const vsix = path.join(extDir, vsixGlob.sort().pop());
  const size = fs.statSync(vsix).size;
  if (size > 10 * 1024 * 1024) {
    console.warn(`WARN: VSIX >10MB (${(size / 1024 / 1024).toFixed(1)} MB)`);
  }
}

console.log("Ready for publish (review warnings above).");
