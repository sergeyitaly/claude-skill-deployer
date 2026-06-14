/**
 * Resolve installed Cursor extension folder for smoke/bench scripts.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PUBLISHER_PREFIX = "serhiivoinolovych.claude-skill-deployer-";

export function readDevPackageVersion(devExtensionDir) {
  const pkgPath = path.join(devExtensionDir, "package.json");
  return JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version;
}

/** Prefer dev package version, else newest installed folder. */
export function resolveInstalledExtensionDir(devExtensionDir) {
  const version = readDevPackageVersion(devExtensionDir);
  const extRoot = path.join(os.homedir(), ".cursor", "extensions");
  const preferred = path.join(extRoot, `${PUBLISHER_PREFIX}${version}`);
  if (fs.existsSync(preferred)) {
    return preferred;
  }
  if (!fs.existsSync(extRoot)) {
    return preferred;
  }
  const matches = fs
    .readdirSync(extRoot)
    .filter((n) => n.startsWith(PUBLISHER_PREFIX))
    .sort()
    .reverse();
  if (matches[0]) {
    return path.join(extRoot, matches[0]);
  }
  return preferred;
}
