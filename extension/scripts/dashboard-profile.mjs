import * as path from "node:path";
import { pathToFileURL } from "node:url";

const ext = path.resolve(import.meta.dirname, "..");
const ws = path.resolve(ext, "..");
const lib = path.join(ext, "skills_library");

function bench(label, fn) {
  const t0 = performance.now();
  fn();
  console.log(`${label.padEnd(44)} ${(performance.now() - t0).toFixed(1)}ms`);
}

const load = (rel) => import(pathToFileURL(path.join(ext, "out", rel)).href);

const { formatCostDashboardHtml } = await load("costDashboard.js");
const { runCostPipelineSync } = await load("costPipeline.js");
const { buildCostAttribution } = await load("costAttribution.js");
const { assessAttributionHealth } = await load("attributionHealth.js");
const { computeEnabledAgentsCreditUsage, computePerAgentCreditUsage } = await load("agentOps.js");
const { generateOptimizationSuggestions, topExpensiveSkills, crossAgentSavingsSummary } = await load("costOptimizer.js");
const { calculateTrend } = await load("costPredictor.js");
const { loadCostProfile } = await load("costProfiles.js");
const { computeUsageStats } = await load("usageStats.js");
const { getWorkspaceHookStatus } = await load("hookOps.js");
const { resolveAttributionStrategy } = await load("attributionStrategy.js");
const { assessSkillCostConfidence } = await load("attributionConfidence.js");
const { buildTeamEconomicsSnapshot } = await load("teamEconomics.js");
const { attributeCostToAuthors } = await load("teamCostSharing.js");
const { listArchivedSkills } = await load("skillArchival.js");
const { loadManifest } = await load("skillOps.js");
const { enrichV2HookRunTokens } = await load("v2TokenEnrichment.js");
const { resolveDisplayAttribution } = await load("costAttribution.js");
const { buildSystemModeContext } = await load("systemMode.js");
const { readPipelineCycle } = await load("pipelineCycle.js");

const manifest = loadManifest(lib);
const pipeline = runCostPipelineSync(ws, lib);

bench("enrichV2HookRunTokens", () => enrichV2HookRunTokens(ws, lib));
bench("buildCostAttribution", () => buildCostAttribution(ws, lib));
const built = buildCostAttribution(ws, lib);
bench("assessAttributionHealth", () => assessAttributionHealth(ws, lib));
const health = assessAttributionHealth(ws, lib);
bench("buildSystemModeContext", () => buildSystemModeContext(health, ws, pipeline.cycle));
bench("resolveDisplayAttribution", () => resolveDisplayAttribution(built, ws));
bench("computeEnabledAgentsCreditUsage", () => computeEnabledAgentsCreditUsage(lib, 14, ws));
bench("computePerAgentCreditUsage", () => computePerAgentCreditUsage(lib, 14, ws));
bench("generateOptimizationSuggestions", () => generateOptimizationSuggestions(ws, lib, manifest));
const { attribution } = resolveDisplayAttribution(built, ws);
bench("topExpensiveSkills", () => topExpensiveSkills(attribution, 5));
bench("crossAgentSavingsSummary", () => crossAgentSavingsSummary(attribution));
bench("calculateTrend", () => calculateTrend(ws, lib));
bench("loadCostProfile", () => loadCostProfile(ws, lib));
bench("computeUsageStats", () => computeUsageStats(ws, manifest));
bench("getWorkspaceHookStatus", () => getWorkspaceHookStatus(ws, lib));
bench("resolveAttributionStrategy", () => resolveAttributionStrategy(ws, lib));
bench("assessSkillCostConfidence", () =>
  assessSkillCostConfidence(ws, attribution, {
    usesV2HookRuns: health.v2HookRuns > 0,
    staleEqualSplit: health.staleEqualSplit,
    transcriptSkills: built.transcriptSkills,
  })
);
const { getOrComputeTeamEconomicsBundle, tryReadValidTeamEconomicsCache } = await load("teamEconomicsCache.js");
bench("getOrComputeTeamEconomicsBundle (disk hit)", () => {
  const hit = tryReadValidTeamEconomicsCache(ws);
  if (hit) return hit;
  return getOrComputeTeamEconomicsBundle(ws, lib, manifest, attribution);
});
bench("attributeCostToAuthors (via cache bundle)", () => {
  const hit = tryReadValidTeamEconomicsCache(ws);
  return hit ? hit.skillAuthors : getOrComputeTeamEconomicsBundle(ws, lib, manifest, attribution).skillAuthors;
});
bench("formatCostDashboardHtml TOTAL", () => formatCostDashboardHtml(ws, lib, "x", pipeline));
const teamHit = tryReadValidTeamEconomicsCache(ws);
bench("formatCostDashboardHtml (fast phase)", () =>
  formatCostDashboardHtml(ws, lib, "x", pipeline, { includeTeamEconomics: false })
);
if (teamHit) {
  bench("formatCostDashboardHtml (disk team cache)", () =>
    formatCostDashboardHtml(ws, lib, "x", pipeline, { teamBundle: teamHit })
  );
}
