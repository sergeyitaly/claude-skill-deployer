#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "package.json",
  "out/extension.js",
  "resources/hooks/hookPlatform.js",
  "resources/hooks/budget-watch.js",
  "resources/hooks/session-size-watch.js",
  "resources/hooks/context-focus-watch.js",
  "resources/hooks/practical-focus-watch.js",
  "resources/hooks/task-drift-watch.js",
  "resources/hooks/official-skills-watch.js",
];

let failed = 0;
for (const rel of required) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    console.error(`Missing: ${rel}`);
    failed += 1;
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version ?? "")) {
  console.error(`Invalid semver in package.json: ${pkg.version}`);
  failed += 1;
}

if (failed > 0) {
  process.exit(1);
}
console.log(`Smoke tests passed (v${pkg.version}).`);
