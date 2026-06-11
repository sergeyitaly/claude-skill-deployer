#!/usr/bin/env node
/**
 * Copies ../skills_library (the repo's source-of-truth skill library) into
 * ./skills_library so the extension can bundle it into the .vsix. Run via
 * `npm run sync-skills` (also runs automatically before compile/package).
 */

const fs = require("fs");
const path = require("path");

const SRC = path.resolve(__dirname, "..", "..", "skills_library");
const DEST = path.resolve(__dirname, "..", "skills_library");

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

if (!fs.existsSync(SRC)) {
  console.error(`Source skill library not found: ${SRC}`);
  process.exit(1);
}

fs.rmSync(DEST, { recursive: true, force: true });
copyRecursive(SRC, DEST);
console.log(`Synced skill library: ${SRC} -> ${DEST}`);
