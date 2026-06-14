/**
 * Tier benefit benchmark — auto-detected tier vs no extension vs naive full stack.
 *
 * Usage:
 *   node --require ./scripts/vscode-register.cjs scripts/tier-benefit-benchmark.mjs [extDir] [workspace]
 *
 * Env:
 *   BENCH_TIER_PROBE_REMOTE=1 — include auto-detected-remote arm (git ls-remote)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveLibraryDir } from "./resolve-library-dir.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const extensionDir = argv[0] ? path.resolve(argv[0]) : path.resolve(scriptDir, "..");
const workspaceDir = argv[1] ? path.resolve(argv[1]) : path.resolve(path.join(scriptDir, "..", ".."));
const libraryDir = resolveLibraryDir(extensionDir);
const resultsDir = path.join(scriptDir, "tier-benefit-results");
const probeRemote = process.env.BENCH_TIER_PROBE_REMOTE === "1";

function loadModule(rel) {
  return import(pathToFileURL(path.join(extensionDir, "out", rel)).href);
}

function bench(fn, n = 3) {
  const times = [];
  let last;
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    last = fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { p50: times[Math.floor(times.length / 2)], last };
}

const ALL_OFF = {
  multiAgent: false,
  attributionCollector: false,
  costIntelligence: false,
  autoOptimizer: false,
  branchProfiles: false,
  budgetControls: false,
  teamCostSharing: false,
  sessionSkillAdaptation: false,
  autoApplyTaskProposals: false,
  deterministicTaskProposals: false,
  taskSkillFocus: false,
  costAwareSearch: false,
  skillSetResolver: false,
  predictiveAlerts: false,
  emergencyCutoff: false,
  skillArchival: false,
  contextFocus: false,
  practicalFocus: false,
  communityBenchmarks: false,
  prCostEstimate: false,
};

async function measureScenario(mods, enabledFeatures, applyTier = true) {
  const { setActiveProjectProfileContext } = mods.activeProfile;
  const { isFeatureEnabled } = mods.featureFlags;
  const { runCostPipelineSync } = mods.pipeline;
  const { shouldSyncWorkspaceToAll, wouldSkipAgentMirrorSync } = mods.agentOps;
  const { countEnabledFeatures } = mods.tierBench;

  setActiveProjectProfileContext(enabledFeatures, applyTier);

  const pipeline = bench(() => runCostPipelineSync(workspaceDir, libraryDir));
  const syncWouldRun = shouldSyncWorkspaceToAll();
  const syncSkip = bench(() => wouldSkipAgentMirrorSync(libraryDir, workspaceDir));

  return {
    pipelineP50Ms: pipeline.p50,
    pipelineSkipped: Boolean(pipeline.last?.skipped),
    multiAgentSyncEnabled: syncWouldRun,
    syncSkipAfterWarm: syncSkip.last,
    featuresEnabledCount: countEnabledFeatures(enabledFeatures, true),
    pipelineReady: pipeline.last?.ready,
    processedSessions: pipeline.last?.processedSessions ?? 0,
    isFeatureEnabledSample: {
      multiAgent: isFeatureEnabled("multiAgent"),
      attributionCollector: isFeatureEnabled("attributionCollector"),
      costIntelligence: isFeatureEnabled("costIntelligence"),
    },
  };
}

function profileToFeatures(profile) {
  return profile.enabledFeatures ?? {};
}

async function main() {
  if (!fs.existsSync(path.join(extensionDir, "out", "tierBenefitBenchmark.js"))) {
    console.error("Extension not compiled. Run: cd extension && npm run compile");
    process.exit(1);
  }

  fs.mkdirSync(resultsDir, { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(extensionDir, "package.json"), "utf-8"));
  console.log(`=== Tier benefit benchmark (v${pkg.version}) ===\n`);
  console.log(`Workspace: ${workspaceDir}`);
  console.log(`Remote probe: ${probeRemote ? "on" : "off (set BENCH_TIER_PROBE_REMOTE=1)"}\n`);

  const mods = {
    projectProfile: await loadModule("projectProfile.js"),
    activeProfile: await loadModule("activeProjectProfile.js"),
    featureFlags: await loadModule("featureFlags.js"),
    pipeline: await loadModule("costPipeline.js"),
    agentOps: await loadModule("agentOps.js"),
    tierBench: await loadModule("tierBenefitBenchmark.js"),
  };

  const {
    buildProjectProfile,
    buildProjectProfileWithRemoteProbe,
    tierFeaturePreset,
    detectProjectProfileSignals,
    PROFILE_TYPE_LABELS,
  } = mods.projectProfile;
  const { buildScenarioResult, compareTierBenefits, formatTierBenefitMarkdown } = mods.tierBench;

  const signals = detectProjectProfileSignals(workspaceDir, { network: false, useCache: true });

  const noExtMeasure = await measureScenario(mods, ALL_OFF, true);
  const noExtension = buildScenarioResult({
    id: "no-extension",
    label: "No extension (baseline)",
    enabledFeatures: ALL_OFF,
    ...noExtMeasure,
    rationale: "Extension not installed — no tier features, hooks, or background pipeline.",
  });

  const fullPreset = tierFeaturePreset("team-multi-agent", signals);
  const fullMeasure = await measureScenario(mods, fullPreset, true);
  const naiveFullStack = buildScenarioResult({
    id: "naive-full-stack",
    label: "Naive full stack (always team-multi-agent)",
    profileType: "team-multi-agent",
    enabledFeatures: fullPreset,
    ...fullMeasure,
    rationale: "Worst case: every repo treated as full team multi-agent stack.",
  });

  const autoLocalProfile = buildProjectProfile(workspaceDir);
  const autoLocalMeasure = await measureScenario(mods, profileToFeatures(autoLocalProfile), true);
  const autoDetectedLocal = buildScenarioResult({
    id: "auto-detected-local",
    label: "Auto-detected (local git)",
    profileType: autoLocalProfile.profileType,
    enabledFeatures: profileToFeatures(autoLocalProfile),
    confidencePct: Math.round(autoLocalProfile.confidence * 100),
    rationale: autoLocalProfile.rationale,
    ...autoLocalMeasure,
  });

  const scenarios = [noExtension, naiveFullStack, autoDetectedLocal];

  if (probeRemote) {
    try {
      const autoRemoteProfile = await buildProjectProfileWithRemoteProbe(workspaceDir);
      const autoRemoteMeasure = await measureScenario(mods, profileToFeatures(autoRemoteProfile), true);
      scenarios.push(
        buildScenarioResult({
          id: "auto-detected-remote",
          label: "Auto-detected (remote git probe)",
          profileType: autoRemoteProfile.profileType,
          enabledFeatures: profileToFeatures(autoRemoteProfile),
          confidencePct: Math.round(autoRemoteProfile.confidence * 100),
          rationale: autoRemoteProfile.rationale,
          ...autoRemoteMeasure,
        })
      );
    } catch (err) {
      console.warn(`Remote probe skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const comparison = compareTierBenefits(autoDetectedLocal, noExtension, naiveFullStack);
  const generatedAt = new Date().toISOString();
  const report = {
    generatedAt,
    extensionVersion: pkg.version,
    extensionDir,
    workspaceDir,
    probeRemote,
    detectedTier: autoLocalProfile.profileType,
    detectedTierLabel: PROFILE_TYPE_LABELS[autoLocalProfile.profileType],
    scenarios,
    comparison,
    signals: {
      isGitRepo: signals.isGitRepo,
      branchCount: signals.branchCount,
      remoteBranchCount: signals.remoteBranchCount,
      authorCount30d: signals.authorCount30d,
      teamSize: signals.teamSize,
      activityLevel: signals.activityLevel,
    },
  };

  const stamp = generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(resultsDir, `tier-benefits-${stamp}.json`);
  const mdPath = path.join(resultsDir, `tier-benefits-${stamp}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(
    mdPath,
    `${formatTierBenefitMarkdown(workspaceDir, pkg.version, scenarios, comparison, generatedAt)}\n`
  );

  console.log("--- Team benefit summary ---");
  console.log(comparison.summary);
  console.log("");
  console.log(`Net team benefit index: ${comparison.netTeamBenefitPct}%`);
  console.log(`Capability retained: ${comparison.capabilityRetainedPct}%`);
  console.log(`Overhead savings: ${comparison.overheadSavingsPct}% (~$${comparison.monthlySavingsUsd}/mo)`);
  console.log(`Uplift vs no extension: +${comparison.extensionValueUpliftPct}%`);
  console.log(`Auto tier: ${PROFILE_TYPE_LABELS[autoLocalProfile.profileType]} (${autoLocalProfile.profileType})`);
  console.log("");
  console.log(`JSON: ${jsonPath}`);
  console.log(`Markdown: ${mdPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
