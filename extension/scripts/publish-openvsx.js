#!/usr/bin/env node
/**
 * Publish the packaged VSIX to Open VSX (Cursor + Kiro IDE gallery).
 * Requires OVSX_PAT. Run `npm run package` first if no *.vsix exists.
 */
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const extDir = path.join(__dirname, "..");
const token = process.env.OVSX_PAT;
if (!token) {
  console.error("OVSX_PAT is not set. Create a token at https://open-vsx.org/");
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(extDir, "package.json"), "utf-8"));
const expectedName = `${pkg.name}-${pkg.version}.vsix`;
const expectedPath = path.join(extDir, expectedName);

let vsixPath;
if (fs.existsSync(expectedPath)) {
  vsixPath = expectedPath;
} else {
  const prefix = `${pkg.name}-`;
  const candidates = fs
    .readdirSync(extDir)
    .filter((f) => f.endsWith(".vsix") && f.startsWith(prefix))
    .map((f) => {
      const full = path.join(extDir, f);
      return { name: f, full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  if (candidates.length === 0) {
    console.error(
      `No VSIX matching ${prefix}*.vsix — run: npm run package (expected ${expectedName})`
    );
    process.exit(1);
  }
  vsixPath = candidates[0].full;
  console.warn(
    `Warning: ${expectedName} not found; using newest match ${candidates[0].name}`
  );
}

console.log(`Publishing to Open VSX: ${path.basename(vsixPath)}`);
execSync(`npx ovsx publish "${vsixPath}" -p "${token}"`, {
  cwd: extDir,
  stdio: "inherit",
  shell: true,
});
