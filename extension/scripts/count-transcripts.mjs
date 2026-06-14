import * as path from "node:path";
import { pathToFileURL } from "node:url";

const ext = path.resolve(import.meta.dirname, "..");
const lib = path.join(ext, "skills_library");
const { loadAgentsManifest, enabledAgents } = await import(
  pathToFileURL(path.join(ext, "out", "agentOps.js")).href
);
const { listTranscriptFiles } = await import(
  pathToFileURL(path.join(ext, "out", "transcriptParsers.js")).href
);
const { fingerprintTranscriptRoots, readCachedCreditUsageFromRoots } = await import(
  pathToFileURL(path.join(ext, "out", "transcriptUsageIndex.js")).href
);

const manifest = loadAgentsManifest(lib);
let total = 0;
for (const id of enabledAgents(lib)) {
  const def = manifest.agents[id];
  if (!def.transcriptRoots?.length) continue;
  for (const root of def.transcriptRoots) {
    const dir = root.startsWith("~/")
      ? path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", root.slice(2))
      : root;
    const t0 = performance.now();
    const files = listTranscriptFiles(dir);
    console.log(`${id}: ${files.length} files in ${(performance.now() - t0).toFixed(0)}ms — ${dir}`);
    total += files.length;
  }
}
console.log(`total: ${total}`);

const ws = path.resolve(ext, "..");
const roots = manifest.agents.cursor?.transcriptRoots ?? [];
if (roots.length) {
  const t0 = performance.now();
  fingerprintTranscriptRoots(roots, 14, ws);
  console.log(`fingerprint cursor roots: ${(performance.now() - t0).toFixed(0)}ms`);
  const t1 = performance.now();
  readCachedCreditUsageFromRoots(roots, 14, ws);
  console.log(`readCached (cold): ${(performance.now() - t1).toFixed(0)}ms`);
  const t2 = performance.now();
  readCachedCreditUsageFromRoots(roots, 14, ws);
  console.log(`readCached (warm): ${(performance.now() - t2).toFixed(0)}ms`);
}
