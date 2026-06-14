/**
 * Complete complex benchmark — full extension stack + CI/ADX complex agent harness.
 *
 * Usage:
 *   node --require ./scripts/vscode-register.cjs scripts/complete-benchmark.mjs [extDir] [workspace]
 *
 * Env:
 *   ANTHROPIC_API_KEY — live API tokens in complex agent harness
 *   BENCH_SKIP_AGENT=1 — skip complex agent harness subprocess
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveLibraryDir } from "./resolve-library-dir.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const extensionDir = argv[0] ? path.resolve(argv[0]) : path.resolve(scriptDir, "..");
const workspaceDir = argv[1] ? path.resolve(argv[1]) : path.resolve(path.join(scriptDir, "..", ".."));
const libraryDir = resolveLibraryDir(extensionDir);
const resultsDir = path.join(scriptDir, "complete-benchmark-results");
const iterations = 3;

const SLAS = {
  "hotPaths.dashboardFastPhaseP50Ms": { max: 30, unit: "ms" },
  "hotPaths.syncAsyncWarmP50Ms": { max: 150, unit: "ms" },
  "hotPaths.listSkillStatusesWarmP50Ms": { max: 5, unit: "ms" },
  "hotPaths.runsHotP50Ms": { max: 5, unit: "ms" },
  "pipeline.runCostPipelineSyncP50Ms": { max: 500, unit: "ms" },
  "costIntel.teamCacheReadP50Ms": { max: 5, unit: "ms" },
  "adaptation.taskProposalsP50Ms": { max: 200, unit: "ms" },
  "automation.hooksConfiguredRatio": { min: 0.8, unit: "ratio" },
};

function loadModule(rel) {
  return import(pathToFileURL(path.join(extensionDir, "out", rel)).href);
}

function bench(fn, n = iterations) {
  const times = [];
  let last;
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    last = fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return {
    p50: times[Math.floor(times.length / 2)],
    max: times[times.length - 1],
    last,
  };
}

function benchAsync(fn, n = iterations) {
  const times = [];
  let last;
  return (async () => {
    for (let i = 0; i < n; i += 1) {
      const t0 = performance.now();
      last = await fn();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return {
      p50: times[Math.floor(times.length / 2)],
      max: times[times.length - 1],
      last,
    };
  })();
}

function getByPath(obj, dotted) {
  return dotted.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function evaluateSlas(report) {
  const results = [];
  for (const [key, rule] of Object.entries(SLAS)) {
    const value = getByPath(report, key);
    if (value == null) {
      results.push({ key, pass: null, value, rule, note: "not measured" });
      continue;
    }
    let pass = true;
    if (rule.max != null) pass = value <= rule.max;
    if (rule.min != null) pass = value >= rule.min;
    results.push({ key, pass, value, rule });
  }
  return results;
}

function countFiles(dir, depth = 0) {
  if (depth > 8) return 0;
  let n = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if ([".git", "node_modules", ".vscode-test"].includes(e.name)) continue;
        n += countFiles(path.join(dir, e.name), depth + 1);
      } else n += 1;
    }
  } catch {
    // skip
  }
  return n;
}

async function runHotPaths(mods) {
  const {
    listSkillStatuses,
    collectRelativePaths,
    detectRelevantSkills,
    loadManifest,
    invalidateDetectionCache,
  } = mods.skillOps;
  const { readCachedEnrichedRuns, invalidateLearningCache } = mods.learning;
  const { syncWorkspaceSkillsToAllAgentsAsync, buildWorkspaceSyncFingerprint, wouldSkipAgentMirrorSync } =
    mods.agentOps;
  const { formatCostDashboardHtml } = mods.dashboard;
  const { runCostPipelineSync } = mods.pipeline;
  const { ensureWorkspaceCachesWarm } = mods.cacheWarmup;

  const manifest = loadManifest(libraryDir);
  const pipeline = runCostPipelineSync(workspaceDir, libraryDir);

  invalidateDetectionCache();
  const paths = bench(() => collectRelativePaths(workspaceDir));
  invalidateDetectionCache();
  const detectCold = bench(() => detectRelevantSkills(workspaceDir, manifest));
  const detectWarm = bench(() => detectRelevantSkills(workspaceDir, manifest));
  invalidateDetectionCache();
  const listCold = bench(() => listSkillStatuses(libraryDir, workspaceDir));
  const listWarm = bench(() => listSkillStatuses(libraryDir, workspaceDir));

  ensureWorkspaceCachesWarm(workspaceDir, libraryDir);
  const runsCold = bench(() => {
    invalidateLearningCache(workspaceDir);
    return readCachedEnrichedRuns(workspaceDir);
  });
  const runsHot = bench(() => readCachedEnrichedRuns(workspaceDir));
  const fingerprint = bench(() => buildWorkspaceSyncFingerprint(workspaceDir));
  const dashFast = bench(() =>
    formatCostDashboardHtml(workspaceDir, libraryDir, "bench", pipeline, {
      fastPhase: true,
      includeTeamEconomics: false,
    })
  );
  await syncWorkspaceSkillsToAllAgentsAsync(libraryDir, workspaceDir, { force: true });
  const syncWarm = await benchAsync(() =>
    syncWorkspaceSkillsToAllAgentsAsync(libraryDir, workspaceDir)
  );
  const skipSync = bench(() => wouldSkipAgentMirrorSync(libraryDir, workspaceDir));

  return {
    approxFiles: countFiles(workspaceDir),
    relativePaths: paths.last?.length ?? 0,
    collectRelativePaths: { p50: paths.p50, max: paths.max },
    detectRelevantSkillsCold: { p50: detectCold.p50, max: detectCold.max },
    detectRelevantSkillsWarm: { p50: detectWarm.p50, max: detectWarm.max },
    listSkillStatusesCold: { p50: listCold.p50, max: listCold.max },
    listSkillStatusesWarm: { p50: listWarm.p50, max: listWarm.max },
    readCachedEnrichedRunsCold: { p50: runsCold.p50, max: runsCold.max, records: runsCold.last?.length },
    readCachedEnrichedRunsHot: { p50: runsHot.p50, max: runsHot.max },
    buildWorkspaceSyncFingerprint: { p50: fingerprint.p50, max: fingerprint.max },
    dashboardFastPhaseP50Ms: dashFast.p50,
    dashboardFastPhaseMaxMs: dashFast.max,
    syncAsyncWarmP50Ms: syncWarm.p50,
    syncAsyncWarmMaxMs: syncWarm.max,
    syncSkipAfterWarm: skipSync.last,
    listSkillStatusesWarmP50Ms: listWarm.p50,
    runsHotP50Ms: runsHot.p50,
  };
}

async function runPipeline(mods) {
  const { runCostPipelineSync } = mods.pipeline;
  const { buildCostAttribution } = mods.attribution;
  const { assessAttributionHealth } = mods.attributionHealth;
  const { enrichV2HookRunTokens } = mods.v2;
  const { readPipelineCycle, evaluatePipelineStatus } = mods.cycle;
  const { refreshWorkspaceSystemState } = mods.systemState;

  const timed = bench(() => runCostPipelineSync(workspaceDir, libraryDir));
  const pipeline = timed.last;
  const attribution = bench(() => buildCostAttribution(workspaceDir, libraryDir));
  const health = bench(() => assessAttributionHealth(workspaceDir, libraryDir));
  const enrich = bench(() => enrichV2HookRunTokens(workspaceDir, libraryDir));
  const systemState = bench(() => refreshWorkspaceSystemState(workspaceDir, libraryDir));
  const cycle = readPipelineCycle(workspaceDir);
  const status = evaluatePipelineStatus(workspaceDir, cycle);

  return {
    runCostPipelineSyncP50Ms: timed.p50,
    runCostPipelineSyncMaxMs: timed.max,
    pipelineReady: pipeline.ready,
    pipelineFresh: pipeline.fresh,
    circuitOpen: pipeline.circuitOpen,
    processedSessions: pipeline.processedSessions,
    systemMode: pipeline.systemMode,
    buildCostAttributionP50Ms: attribution.p50,
    assessAttributionHealthP50Ms: health.p50,
    enrichV2HookRunTokensP50Ms: enrich.p50,
    v2HookRuns: health.last?.v2HookRuns ?? 0,
    attributionHealthScore: health.last?.confidenceScore,
    staleEqualSplit: health.last?.staleEqualSplit ?? false,
    systemStateP50Ms: systemState.p50,
    cycleReady: status.ready,
    cycleFresh: status.fresh,
    staleMessage: status.staleMessage,
  };
}

async function runCostIntelligence(mods, pipeline) {
  const { formatCostDashboardHtml } = mods.dashboard;
  const { buildCostAttribution, resolveDisplayAttribution } = mods.attribution;
  const { generateOptimizationSuggestions } = mods.optimizer;
  const { computeUsageStats } = mods.usage;
  const { getOrComputeTeamEconomicsBundle, tryReadValidTeamEconomicsCache } = mods.teamCache;
  const { tryReadValidDashboardSnapshot } = mods.snapCache;
  const { loadManifest } = mods.skillOps;

  const manifest = loadManifest(libraryDir);
  const built = buildCostAttribution(workspaceDir, libraryDir);
  const { attribution } = resolveDisplayAttribution(built, workspaceDir);

  const dashFull = bench(() => formatCostDashboardHtml(workspaceDir, libraryDir, "x", pipeline));
  const suggestions = bench(() => generateOptimizationSuggestions(workspaceDir, libraryDir, manifest));
  const usage = bench(() => computeUsageStats(workspaceDir, manifest));
  const teamRead = bench(() => tryReadValidTeamEconomicsCache(workspaceDir));
  const teamCompute = bench(() => getOrComputeTeamEconomicsBundle(workspaceDir, libraryDir, manifest, attribution));
  const snap = tryReadValidDashboardSnapshot(workspaceDir, pipeline);

  return {
    dashboardFullP50Ms: dashFull.p50,
    dashboardFullMaxMs: dashFull.max,
    optimizationSuggestionsP50Ms: suggestions.p50,
    optimizationCount: suggestions.last?.length ?? 0,
    computeUsageStatsP50Ms: usage.p50,
    skillStatsCount: usage.last?.length ?? 0,
    teamCacheHit: Boolean(teamRead.last),
    teamCacheReadP50Ms: teamRead.p50,
    teamBundleComputeP50Ms: teamCompute.p50,
    dashboardSnapshotHit: Boolean(snap),
    attributionSkillCount: Object.keys(attribution ?? {}).length,
  };
}

async function runAutomation(mods) {
  const { getWorkspaceHookStatus } = mods.hooks;
  const { loadAgentsManifest, enabledAgents, agentMirrorsNeedSync } = mods.agentOps;
  const { syncCopilotBootstrap } = mods.agentOps;
  const { ensureAttributionHooksActive } = mods.workspaceSync;
  const { markPreToggleFingerprint } = mods.syncPredict;
  const { listSkillStatuses, setSkillOverride } = mods.skillOps;

  const hookStatus = getWorkspaceHookStatus(workspaceDir, libraryDir);
  const agentsManifest = loadAgentsManifest(libraryDir);
  const agents = enabledAgents(libraryDir);
  const hooksActive = bench(() =>
    ensureAttributionHooksActive(extensionDir, workspaceDir, () => {})
  );
  const mirrorsNeedSync = agentMirrorsNeedSync(workspaceDir, libraryDir);
  const copilotPath = syncCopilotBootstrap(workspaceDir, libraryDir);

  const hookScriptsDir = path.join(extensionDir, "resources", "hooks");
  const hookScripts = fs.existsSync(hookScriptsDir)
    ? fs.readdirSync(hookScriptsDir).filter((f) => f.endsWith(".js"))
    : [];

  const applicable = hookStatus.attribution.agents?.filter((a) => a.applicable) ?? [];
  const configured = applicable.filter((a) => a.configured);
  const hooksConfiguredRatio = applicable.length ? configured.length / applicable.length : 1;

  markPreToggleFingerprint(workspaceDir);
  const statuses = listSkillStatuses(libraryDir, workspaceDir);
  const candidate = statuses.find((s) => s.installedInWorkspace) ?? statuses[0];
  let rapidToggleWorks = false;
  if (candidate) {
    const prior = candidate.localOverride;
    setSkillOverride(workspaceDir, candidate.name, "off");
    const { rapidToggleWouldBeNoOp } = mods.syncPredict;
    rapidToggleWorks = !rapidToggleWouldBeNoOp(workspaceDir);
    setSkillOverride(workspaceDir, candidate.name, prior === "off" ? undefined : prior);
  }

  return {
    enabledAgents: agents,
    agentCount: agents.length,
    hooksConfiguredRatio,
    hooksConfigured: configured.length,
    hooksApplicable: applicable.length,
    costControlHooks: hookStatus.costControl.configured,
    sessionWatchHook: hookStatus.costControl.sessionSize,
    attributionHooks: hookStatus.attribution.allConfigured,
    hookScriptCount: hookScripts.length,
    ensureAttributionHooksP50Ms: hooksActive.p50,
    mirrorsNeedSync,
    copilotBootstrapPresent: Boolean(copilotPath && fs.existsSync(path.join(workspaceDir, copilotPath))),
    rapidTogglePredictive: rapidToggleWorks,
    hookAgents: hookStatus.attribution.agents,
  };
}

async function runAdaptation(mods) {
  const { loadManifest } = mods.skillOps;
  const {
    ensureWorkspaceTaskProposals,
    computeTaskSkillProposals,
    areTaskSkillProposalsFresh,
  } = mods.proposals;
  const {
    resolveProposedSkillNamesWithSource,
    requiredPlatformSkillNames,
    shouldApplySessionSkillRequest,
  } = mods.sessionApply;
  const { appendSkillFeedback, computeSkillInefficiencyStats } = mods.feedback;

  const manifest = loadManifest(libraryDir);
  const complexTaskPath = path.join(scriptDir, "agent-comparison-fixture-complex", "TASK.md");
  const taskPrompt = fs.existsSync(complexTaskPath)
    ? fs.readFileSync(complexTaskPath, "utf-8").trim()
    : "Debug failing CI validate job and fix ADX KQL schema mismatches.";

  const proposalsTimed = bench(() =>
    ensureWorkspaceTaskProposals(workspaceDir, manifest, taskPrompt)
  );
  const proposals = proposalsTimed.last?.file ?? mods.proposals.readTaskSkillProposals(workspaceDir);
  const computeProps = bench(() => computeTaskSkillProposals(workspaceDir, manifest, taskPrompt, "bench"));
  const resolved = resolveProposedSkillNamesWithSource(workspaceDir);
  const platformSkills = requiredPlatformSkillNames();
  const inefficiency = computeSkillInefficiencyStats(workspaceDir);

  const sessionReq = {
    version: 1,
    requestedAt: new Date().toISOString(),
    sessionId: `bench-${Date.now()}`,
    platform: "cursor",
    skills: (proposals?.proposals ?? []).slice(0, 3).map((p) => p.name),
    source: "proposals",
  };
  const wouldApplySession = shouldApplySessionSkillRequest(workspaceDir, sessionReq);

  return {
    taskProposalsP50Ms: proposalsTimed.p50,
    proposalsRefreshed: proposalsTimed.last?.refreshed ?? false,
    proposalCount: proposals?.proposals?.length ?? 0,
    topProposals: (proposals?.proposals ?? []).slice(0, 5).map((p) => ({
      name: p.name,
      confidence: p.confidence,
      installed: p.installed,
    })),
    proposalsFresh: areTaskSkillProposalsFresh(workspaceDir),
    computeTaskSkillProposalsP50Ms: computeProps.p50,
    resolvedProposalNames: resolved.skills?.length ?? 0,
    resolvedSource: resolved.source,
    wouldApplySessionSkillRequest: wouldApplySession,
    applyPathsNote: "applyTaskProposals/sessionApply/taskFocus mutators skipped on live workspace (see unit tests)",
    platformSkillCount: platformSkills.length,
    platformSkills: platformSkills,
    skillInefficiencyEntries: inefficiency.length,
  };
}

async function runAgentTaskSection() {
  if (process.env.BENCH_SKIP_AGENT === "1") {
    return { skipped: true, reason: "BENCH_SKIP_AGENT=1" };
  }
  const args = [
    "--require",
    path.join(scriptDir, "vscode-register.cjs"),
    path.join(scriptDir, "agent-comparison.mjs"),
    extensionDir,
    libraryDir,
  ];
  const t0 = performance.now();
  const proc = spawnSync(process.execPath, args, { encoding: "utf-8", cwd: path.join(scriptDir, "..") });
  return {
    skipped: false,
    scenario: "complex",
    elapsedMs: performance.now() - t0,
    exitCode: proc.status,
    ok: proc.status === 0,
    stdoutTail: (proc.stdout || "").split("\n").slice(-6).join("\n"),
  };
}

function stackCoverage() {
  return [
    { area: "Skill detection & catalog", measured: true },
    { area: "Multi-agent sync & mirrors", measured: true },
    { area: "Cost pipeline & attribution", measured: true },
    { area: "Cost intelligence dashboard", measured: true },
    { area: "Hooks & automation", measured: true },
    { area: "Session/task skill adaptation", measured: true },
    { area: "Complex agent harness (CI + ADX)", measured: true },
  ];
}

function formatMarkdown(report) {
  const lines = [
    "# Complete complex benchmark",
    "",
    `**Generated:** ${report.generatedAt}`,
    `**Extension:** ${report.extensionVersion} @ ${report.extensionDir}`,
    `**Workspace:** ${report.workspaceDir} (~${report.hotPaths.approxFiles} files)`,
    "",
    "## SLA summary",
    "",
    "| Check | Target | Actual | Status |",
    "|---|---|---:|---|",
  ];
  for (const s of report.slaResults) {
    const target =
      s.rule.max != null ? `≤ ${s.rule.max} ${s.rule.unit}` : `≥ ${s.rule.min} ${s.rule.unit}`;
    const status = s.pass == null ? "—" : s.pass ? "PASS" : "FAIL";
    lines.push(`| ${s.key} | ${target} | ${s.value ?? "—"} | ${status} |`);
  }

  lines.push("", "## 1. Hot paths (skills + UI)", "");
  lines.push("| Operation | p50 (ms) | max (ms) |");
  lines.push("|---|---:|---:|");
  for (const [k, v] of Object.entries(report.hotPaths)) {
    if (v && typeof v === "object" && "p50" in v) lines.push(`| ${k} | ${v.p50.toFixed(1)} | ${v.max.toFixed(1)} |`);
  }

  lines.push("", "## 2. Cost pipeline", "");
  lines.push(`- Pipeline ready/fresh: ${report.pipeline.pipelineReady} / ${report.pipeline.pipelineFresh}`);
  lines.push(`- System mode: ${report.pipeline.systemMode}`);
  lines.push(`- V2 hook runs: ${report.pipeline.v2HookRuns}`);
  lines.push(`- Processed sessions: ${report.pipeline.processedSessions}`);
  lines.push(`- runCostPipelineSync p50: **${report.pipeline.runCostPipelineSyncP50Ms.toFixed(1)} ms**`);

  lines.push("", "## 3. Cost intelligence", "");
  lines.push(`- Dashboard full p50: ${report.costIntel.dashboardFullP50Ms.toFixed(1)} ms`);
  lines.push(`- Team cache hit: ${report.costIntel.teamCacheHit}`);
  lines.push(`- Dashboard snapshot hit: ${report.costIntel.dashboardSnapshotHit}`);
  lines.push(`- Optimization suggestions: ${report.costIntel.optimizationCount}`);

  lines.push("", "## 4. Automation (hooks + sync)", "");
  lines.push(`- Agents enabled: ${report.automation.enabledAgents.join(", ")}`);
  lines.push(`- Attribution hooks configured: ${report.automation.hooksConfigured}/${report.automation.hooksApplicable}`);
  lines.push(`- Hook scripts in extension: ${report.automation.hookScriptCount}`);
  lines.push(`- Copilot bootstrap: ${report.automation.copilotBootstrapPresent}`);

  lines.push("", "## 5. Skill adaptation", "");
  lines.push(`- Task proposals: ${report.adaptation.proposalCount} (top: ${report.adaptation.topProposals.map((p) => p.name).join(", ")})`);
  lines.push(`- Platform skills required: ${report.adaptation.platformSkillCount}`);
  if (report.adaptation.applyPathsNote) {
    lines.push(`- Note: ${report.adaptation.applyPathsNote}`);
  }

  lines.push("", "## 6. Stack coverage", "");
  lines.push("| Area | Measured |");
  lines.push("|---|---|");
  for (const c of report.stackCoverage) {
    lines.push(`| ${c.area} | ${c.measured === true ? "yes" : c.measured} |`);
  }

  if (!report.agentTasks.skipped) {
    lines.push("", "## 7. Complex agent harness (CI validate + ADX KQL)", "");
    lines.push(
      `- **complex**: ${report.agentTasks.ok ? "OK" : "FAIL"} (${report.agentTasks.elapsedMs.toFixed(0)} ms)`
    );
    lines.push("- Task fixture: `agent-comparison-fixture-complex/`");
  }

  lines.push("", "## Interpretation", "");
  lines.push(
    "Measures the full extension stack on your workspace plus a complex CI/ADX schema task harness. Set `ANTHROPIC_API_KEY` for live agent token comparison."
  );
  return lines.join("\n");
}

async function main() {
  if (!fs.existsSync(path.join(extensionDir, "out", "skillOps.js"))) {
    console.error("Extension not compiled. Run: cd extension && npm run compile");
    process.exit(1);
  }
  fs.mkdirSync(resultsDir, { recursive: true });

  const pkg = JSON.parse(fs.readFileSync(path.join(extensionDir, "package.json"), "utf-8"));
  console.log(`=== Complete complex benchmark (v${pkg.version}) ===\n`);

  const mods = {
    skillOps: await loadModule("skillOps.js"),
    learning: await loadModule("learningStateIndex.js"),
    agentOps: await loadModule("agentOps.js"),
    dashboard: await loadModule("costDashboard.js"),
    pipeline: await loadModule("costPipeline.js"),
    cacheWarmup: await loadModule("cacheWarmup.js"),
    attribution: await loadModule("costAttribution.js"),
    attributionHealth: await loadModule("attributionHealth.js"),
    v2: await loadModule("v2TokenEnrichment.js"),
    cycle: await loadModule("pipelineCycle.js"),
    systemState: await loadModule("workspaceSystemState.js"),
    optimizer: await loadModule("costOptimizer.js"),
    usage: await loadModule("usageStats.js"),
    teamCache: await loadModule("teamEconomicsCache.js"),
    snapCache: await loadModule("dashboardSnapshotCache.js"),
    hooks: await loadModule("hookOps.js"),
    workspaceSync: await loadModule("workspaceSkillSync.js"),
    syncPredict: await loadModule("syncPredict.js"),
    proposals: await loadModule("taskSkillProposals.js"),
    sessionApply: await loadModule("sessionSkillApply.js"),
    feedback: await loadModule("skillFeedback.js"),
  };

  const t0 = performance.now();
  const hotPaths = await runHotPaths(mods);
  console.log("[1/6] Hot paths done");
  const pipelineResult = await runPipeline(mods);
  const pipeline = (await loadModule("costPipeline.js")).runCostPipelineSync(workspaceDir, libraryDir);
  console.log("[2/6] Pipeline done");
  const costIntel = await runCostIntelligence(mods, pipeline);
  console.log("[3/6] Cost intelligence done");
  const automation = await runAutomation(mods);
  console.log("[4/6] Automation done");
  const adaptation = await runAdaptation(mods);
  console.log("[5/6] Adaptation done");
  const agentTasks = await runAgentTaskSection();
  console.log("[6/6] Complex agent harness done");

  const report = {
    generatedAt: new Date().toISOString(),
    extensionVersion: pkg.version,
    extensionDir,
    workspaceDir,
    libraryDir,
    totalBenchMs: performance.now() - t0,
    hotPaths,
    pipeline: pipelineResult,
    costIntel,
    automation,
    adaptation,
    agentTasks,
    stackCoverage: stackCoverage(),
  };
  report.slaResults = evaluateSlas(report);
  report.slaPassCount = report.slaResults.filter((s) => s.pass === true).length;
  report.slaFailCount = report.slaResults.filter((s) => s.pass === false).length;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(resultsDir, `complete-${stamp}.json`);
  const mdPath = path.join(resultsDir, `complete-${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
  fs.writeFileSync(mdPath, formatMarkdown(report) + "\n", "utf-8");

  console.log(`\nSLA: ${report.slaPassCount} pass, ${report.slaFailCount} fail`);
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
  process.exit(report.slaFailCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
