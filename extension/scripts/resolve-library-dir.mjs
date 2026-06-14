import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Prefer repo-root skills_library (source of truth); fall back to bundled copy under extDir.
 */
export function resolveLibraryDir(extensionDir) {
  const extLibrary = path.join(extensionDir, "skills_library");
  const repoLibrary = path.resolve(extensionDir, "..", "skills_library");
  if (fs.existsSync(path.join(repoLibrary, "agents.json"))) {
    return repoLibrary;
  }
  if (fs.existsSync(path.join(extLibrary, "agents.json"))) {
    return extLibrary;
  }
  throw new Error(
    `skills library not found (missing agents.json). Run: npm run sync-skills\n` +
      `  tried: ${repoLibrary}\n` +
      `  tried: ${extLibrary}`
  );
}
