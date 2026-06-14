/**
 * Smoke test against the installed VSIX/Cursor extension (not dev tree).
 * Usage: node scripts/real-install-smoke.mjs [extensionDir] [workspaceDir]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveInstalledExtensionDir } from "./installed-extension-path.mjs";

const devExtensionDir = path.resolve(import.meta.dirname, "..");
const defaultExt = resolveInstalledExtensionDir(devExtensionDir);
const defaultWs = path.resolve(path.join(import.meta.dirname, "..", ".."));

const extensionDir = process.argv[2] ? path.resolve(process.argv[2]) : defaultExt;
const workspaceDir = process.argv[3] ? path.resolve(process.argv[3]) : defaultWs;
const libraryDir = path.join(extensionDir, "skills_library");

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
}

function ok(msg) {
  console.log(`OK: ${msg}`);
}

function loadModule(rel) {
  const file = path.join(extensionDir, "out", rel);
  if (!fs.existsSync(file)) {
    throw new Error(`missing module ${file}`);
  }
  return import(pathToFileURL(file).href);
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(extensionDir, "package.json"), "utf-8"));
  console.log(`=== Real install smoke (v${pkg.version}) ===`);
  console.log(`Extension: ${extensionDir}`);
  console.log(`Workspace: ${workspaceDir}`);

  if (!fs.existsSync(extensionDir)) {
    fail(`extension directory not found: ${extensionDir}`);
    return;
  }
  ok(`installed package version ${pkg.version}`);

  for (const mod of ["cacheWarmup.js", "eventLoop.js", "syncPredict.js", "userInteraction.js", "perfTelemetry.js", "syncFeedback.js"]) {
    if (!fs.existsSync(path.join(extensionDir, "out", mod))) {
      fail(`missing module out/${mod}`);
      return;
    }
  }
  ok("perf modules present in installed extension");

  const { listSkillStatuses, setSkillOverride } = await loadModule("skillOps.js");
  const {
    buildWorkspaceSyncFingerprint,
    syncWorkspaceSkillsToAllAgents,
    syncWorkspaceSkillsToAllAgentsAsync,
    wouldSkipAgentMirrorSync,
  } = await loadModule("agentOps.js");
  const { markPreToggleFingerprint, rapidToggleWouldBeNoOp } = await loadModule("syncPredict.js");
  const { readCachedEnrichedRuns, learningCacheSize } = await loadModule("learningStateIndex.js");
  const { ensureWorkspaceCachesWarm, isWorkspaceCacheWarmed } = await loadModule("cacheWarmup.js");
  const { fileContentHash } = await loadModule("fileHash.js");
  const { yieldToEventLoop } = await loadModule("eventLoop.js");
  const { getPerfPercentiles, resetPerfTelemetryForTests, measureSync } = await loadModule("perfTelemetry.js");

  resetPerfTelemetryForTests();

  const t0 = performance.now();
  const statuses = listSkillStatuses(libraryDir, workspaceDir);
  const listMs = performance.now() - t0;
  if (statuses.length === 0) {
    fail("listSkillStatuses returned empty");
    return;
  }
  ok(`listSkillStatuses: ${statuses.length} skills in ${listMs.toFixed(1)}ms`);

  ensureWorkspaceCachesWarm(workspaceDir, libraryDir);
  if (!isWorkspaceCacheWarmed()) {
    fail("cache warmup did not mark warmed");
    return;
  }
  ok("cache warmup");

  const tRuns0 = performance.now();
  const runs1 = readCachedEnrichedRuns(workspaceDir);
  const runsColdMs = performance.now() - tRuns0;
  const tRuns1 = performance.now();
  const runs2 = readCachedEnrichedRuns(workspaceDir);
  const runsHotMs = performance.now() - tRuns1;
  ok(`runs.jsonl: ${runs1.length} records, cold ${runsColdMs.toFixed(1)}ms hot ${runsHotMs.toFixed(1)}ms (cache ${learningCacheSize()})`);
  if (runsHotMs > 5) {
    console.warn(`WARN: hot runs read ${runsHotMs.toFixed(1)}ms (target <5ms)`);
  }

  const fp = buildWorkspaceSyncFingerprint(workspaceDir);
  ok(`workspace fingerprint: ${fp.slice(0, 12)}…`);

  markPreToggleFingerprint(workspaceDir);
  const candidate =
    statuses.find((s) => s.installedInWorkspace && s.localOverride !== "off") ??
    statuses.find((s) => s.installedInWorkspace) ??
    statuses[0];
  const skillName = candidate.name;
  const priorOverride = candidate.localOverride;
  setSkillOverride(workspaceDir, skillName, "off");
  if (rapidToggleWouldBeNoOp(workspaceDir)) {
    fail(`rapidToggleWouldBeNoOp true after disabling ${skillName} (should be false)`);
    return;
  }
  if (priorOverride === "off") {
    setSkillOverride(workspaceDir, skillName, undefined);
  } else {
    setSkillOverride(workspaceDir, skillName, priorOverride);
  }
  if (!rapidToggleWouldBeNoOp(workspaceDir)) {
    fail(`rapidToggleWouldBeNoOp false after restoring ${skillName}`);
    return;
  }
  ok(`rapid-toggle predictive no-op (${skillName})`);

  const skillMd = path.join(workspaceDir, ".claude", "skills", skillName, "SKILL.md");
  if (fs.existsSync(skillMd)) {
    const h1 = fileContentHash(skillMd);
    const past = new Date(Date.now() - 120_000);
    fs.utimesSync(skillMd, past, past);
    const h2 = fileContentHash(skillMd);
    if (h1 !== h2) {
      fail("file hash changed after mtime-only touch");
      return;
    }
    ok("size-stable file hash cache");
  }

  const syncT0 = performance.now();
  const synced = await syncWorkspaceSkillsToAllAgentsAsync(libraryDir, workspaceDir, { force: true });
  const syncMs = performance.now() - syncT0;
  ok(`async agent sync (chunked): ${synced.length} results in ${syncMs.toFixed(1)}ms`);

  if (wouldSkipAgentMirrorSync(libraryDir, workspaceDir)) {
    ok("wouldSkipAgentMirrorSync true after sync");
  } else {
    console.warn("WARN: mirrors still report need sync (may be expected in dev workspace)");
  }

  measureSync("smoke-total", () => undefined);
  const stats = getPerfPercentiles("smoke-total");
  ok(`perf telemetry: count=${stats.count}`);

  await yieldToEventLoop();
  ok("event loop yield");

  if (process.exitCode) {
    console.log("\n=== SMOKE FAILED ===");
  } else {
    console.log("\n=== SMOKE PASSED ===");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
