/**
 * Benchmark extension hot paths. Usage:
 *   node --require ./scripts/vscode-register.cjs scripts/perf-benchmark.mjs [extDir] [workspace]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveLibraryDir } from "./resolve-library-dir.mjs";

const extensionDir =
  process.argv[2] ??
  path.resolve(import.meta.dirname, "..");
const workspaceDir = process.argv[3] ?? path.resolve(path.join(import.meta.dirname, "..", ".."));
const libraryDir = resolveLibraryDir(extensionDir);
const iterations = 3;

function loadModule(rel) {
  return import(pathToFileURL(path.join(extensionDir, "out", rel)).href);
}

function bench(label, fn) {
  const times = [];
  let last;
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    last = fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)];
  const max = times[times.length - 1];
  console.log(`${label.padEnd(42)} p50=${p50.toFixed(1)}ms max=${max.toFixed(1)}ms`);
  return last;
}

function countFiles(dir, depth = 0) {
  if (depth > 8) return 0;
  let n = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if ([".git", "node_modules", ".vscode-test"].includes(e.name)) continue;
        n += countFiles(path.join(dir, e.name), depth + 1);
      } else {
        n += 1;
      }
    }
  } catch {
    // skip
  }
  return n;
}

async function main() {
  console.log("=== Extension perf benchmark ===");
  console.log(`Extension: ${extensionDir}`);
  console.log(`Workspace: ${workspaceDir}`);
  const approxFiles = countFiles(workspaceDir);
  console.log(`Approx files (sample walk): ${approxFiles}\n`);

  const {
    listSkillStatuses,
    collectRelativePaths,
    detectRelevantSkills,
    loadManifest,
    invalidateDetectionCache,
  } = await loadModule("skillOps.js");
  const { readCachedEnrichedRuns, invalidateLearningCache } = await loadModule("learningStateIndex.js");
  const {
    syncWorkspaceSkillsToAllAgentsAsync,
    buildWorkspaceSyncFingerprint,
    wouldSkipAgentMirrorSync,
  } = await loadModule("agentOps.js");
  const { computeUsageStats } = await loadModule("usageStats.js");
  const { formatCostDashboardHtml } = await loadModule("costDashboard.js");
  const { buildCostAttribution } = await loadModule("costAttribution.js");
  const { ensureWorkspaceCachesWarm } = await loadModule("cacheWarmup.js");

  const manifest = loadManifest(libraryDir);

  invalidateDetectionCache();
  invalidateLearningCache(workspaceDir);

  bench("collectRelativePaths (cold)", () => collectRelativePaths(workspaceDir));
  const paths = collectRelativePaths(workspaceDir);
  console.log(`  -> ${paths.length} relative paths\n`);

  invalidateDetectionCache();
  bench("detectRelevantSkills (cold)", () => detectRelevantSkills(workspaceDir, manifest));
  bench("detectRelevantSkills (warm)", () => detectRelevantSkills(workspaceDir, manifest));

  invalidateDetectionCache();
  bench("listSkillStatuses (cold)", () => listSkillStatuses(libraryDir, workspaceDir));
  bench("listSkillStatuses (warm)", () => listSkillStatuses(libraryDir, workspaceDir));

  ensureWorkspaceCachesWarm(workspaceDir, libraryDir);
  bench("readCachedEnrichedRuns (cold)", () => {
    invalidateLearningCache(workspaceDir);
    return readCachedEnrichedRuns(workspaceDir);
  });
  bench("readCachedEnrichedRuns (hot)", () => readCachedEnrichedRuns(workspaceDir));

  bench("buildWorkspaceSyncFingerprint", () => buildWorkspaceSyncFingerprint(workspaceDir));
  bench("computeUsageStats", () => computeUsageStats(workspaceDir, manifest));

  bench("buildCostAttribution", () => buildCostAttribution(workspaceDir, libraryDir));

  const { enrichV2HookRunTokens } = await loadModule("v2TokenEnrichment.js");
  const { runCostPipelineSync } = await loadModule("costPipeline.js");
  bench("enrichV2HookRunTokens", () => enrichV2HookRunTokens(workspaceDir, libraryDir));
  const pipeline = runCostPipelineSync(workspaceDir, libraryDir);
  bench("runCostPipelineSync", () => runCostPipelineSync(workspaceDir, libraryDir));
  bench("formatCostDashboardHtml (no pipeline)", () =>
    formatCostDashboardHtml(workspaceDir, libraryDir)
  );
  bench("formatCostDashboardHtml (cached pipeline)", () =>
    formatCostDashboardHtml(workspaceDir, libraryDir, "bench", pipeline)
  );
  bench("formatCostDashboardHtml (fast phase)", () =>
    formatCostDashboardHtml(workspaceDir, libraryDir, "bench", pipeline, {
      fastPhase: true,
      includeTeamEconomics: false,
    })
  );
  const cachedTeam = (await loadModule("teamEconomicsCache.js")).tryReadValidTeamEconomicsCache(workspaceDir);
  if (cachedTeam) {
    bench("formatCostDashboardHtml (disk team cache)", () =>
      formatCostDashboardHtml(workspaceDir, libraryDir, "bench", pipeline, { teamBundle: cachedTeam })
    );
  }

  invalidateDetectionCache();
  await bench("syncWorkspaceSkillsToAllAgentsAsync", async () =>
    syncWorkspaceSkillsToAllAgentsAsync(libraryDir, workspaceDir, { force: true })
  );
  bench("wouldSkipAgentMirrorSync", () => wouldSkipAgentMirrorSync(libraryDir, workspaceDir));

  const pkg = JSON.parse(fs.readFileSync(path.join(extensionDir, "package.json"), "utf-8"));
  console.log(`\n=== Targets (v${pkg.version}) ===`);
  console.log("dashboard fast-phase <30ms (snapshot) | team-economics cache <5ms | sync <150ms");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
