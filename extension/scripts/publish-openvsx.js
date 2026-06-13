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

let vsixPath = expectedPath;
if (!fs.existsSync(vsixPath)) {
  console.log(`${expectedName} not found — running npm run package…`);
  execSync("npm run package", { cwd: extDir, stdio: "inherit", shell: true });
}
if (!fs.existsSync(vsixPath)) {
  console.error(`Expected VSIX missing after package: ${expectedPath}`);
  process.exit(1);
}

console.log(`Publishing to Open VSX: ${path.basename(vsixPath)}`);
execSync(`npx ovsx publish "${vsixPath}" -p "${token}"`, {
  cwd: extDir,
  stdio: "inherit",
  shell: true,
});
