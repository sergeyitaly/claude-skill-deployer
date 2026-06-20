import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { AgentId, computeEnabledAgentsCreditUsage, loadAgentsManifest } from "./agentOps";
import { assessClaudeVscodeAttributionGap } from "./claudeVscodeAttributionGap";
import { buildCostAttribution, resolveDisplayAttribution, SkillAttributionMap } from "./costAttribution";
import { topExpensiveSkills } from "./costOptimizer";
import { computeGeneralApiSpend } from "./generalApiSpend";
import { getWorkspaceHookStatus, WorkspaceHookStatus } from "./hookOps";
import { readCachedEnrichedRuns, countCachedV2HookRuns } from "./runsStore";
import { isPipelineCircuitOpen, isPipelineFresh, isPipelineReadyForOptimizer, PipelineCycleTimestamps, pipelineStaleSummary } from "./pipelineCycle";
import { countV2HookRuns, isUsageBreakdownRun, isUsageRunRecord, isV2HookRun } from "./runsStore";
import { RoiBand } from "./skillRoi";
import { summarizeSkillCostsFromRuns } from "./skillCostFromRuns";

// â”€â”€ Attribution Confidence â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type ConfidenceLevel = "high" | "estimated" | "low";

export interface AttributionHealthSignals {
  reliable: boolean;
  staleEqualSplit: boolean;
  highUnattributedRatio: boolean;
  noPerSkillData: boolean;
  v2HookRuns: number;
  summary: string;
}

export type SkillCostSource = "v2-hook" | "runs" | "transcript-split" | "heuristic";

export interface SkillCostConfidence {
  skill: string;
  level: ConfidenceLevel;
  score: number;
  source: SkillCostSource;
}

export interface WorkspaceConfidence {
  score: number;
  level: ConfidenceLevel;
  v2Coverage: number;
  summary: string;
}

function levelFromScore(score: number): ConfidenceLevel {
  if (score >= 0.75) return "high";
  if (score >= 0.45) return "estimated";
  return "low";
}

function sourceForSkill(
  skill: string,
  usesV2HookRuns: boolean,
  inTranscriptSkills: boolean,
  v2RunsForSkill: number
): SkillCostSource {
  if (v2RunsForSkill > 0 || (usesV2HookRuns && !inTranscriptSkills)) {
    return v2RunsForSkill > 0 ? "v2-hook" : "runs";
  }
  if (inTranscriptSkills) return "transcript-split";
  return "heuristic";
}

function scoreForSource(source: SkillCostSource, runs: number, staleEqualSplit: boolean): number {
  if (staleEqualSplit) return 0.15;
  switch (source) {
    case "v2-hook": return Math.min(0.95, 0.8 + runs * 0.03);
    case "runs": return Math.min(0.85, 0.55 + runs * 0.05);
    case "transcript-split": return 0.4;
    default: return 0.25;
  }
}

export function assessSkillCostConfidence(
  target: string,
  attribution: SkillAttributionMap,
  options: { usesV2HookRuns: boolean; staleEqualSplit: boolean; transcriptSkills?: SkillAttributionMap }
): Map<string, SkillCostConfidence> {
  const runs = readCachedEnrichedRuns(target);
  const v2BySkill = new Map<string, number>();
  const runsBySkill = new Map<string, number>();
  const measuredBySkill = new Map<string, number>();
  for (const r of runs) {
    if (!isUsageRunRecord(r)) continue;
    runsBySkill.set(r.skill, (runsBySkill.get(r.skill) ?? 0) + 1);
    if (isV2HookRun(r)) v2BySkill.set(r.skill, (v2BySkill.get(r.skill) ?? 0) + 1);
    if (isUsageBreakdownRun(r)) measuredBySkill.set(r.skill, (measuredBySkill.get(r.skill) ?? 0) + 1);
  }

  const transcriptSkills = options.transcriptSkills ?? {};
  const out = new Map<string, SkillCostConfidence>();
  for (const skill of Object.keys(attribution)) {
    const v2Count = v2BySkill.get(skill) ?? 0;
    const measuredCount = measuredBySkill.get(skill) ?? 0;
    const runCount = runsBySkill.get(skill) ?? 0;
    const inTranscript = skill in transcriptSkills;
    const hookSignal = Math.max(v2Count, measuredCount);
    const source = sourceForSkill(skill, options.usesV2HookRuns, inTranscript, hookSignal);
    const score = scoreForSource(source, Math.max(hookSignal, runCount), options.staleEqualSplit);
    out.set(skill, { skill, level: levelFromScore(score), score, source });
  }
  return out;
}

export function assessWorkspaceConfidence(
  target: string,
  libraryDir: string,
  health: AttributionHealthSignals,
  unattributedTokens: number
): WorkspaceConfidence {
  const credit = computeEnabledAgentsCreditUsage(libraryDir, 14, target);
  const v2Runs = countCachedV2HookRuns(target);
  const totalRuns = readCachedEnrichedRuns(target).length;
  const v2Coverage = totalRuns > 0 ? v2Runs / totalRuns : v2Runs > 0 ? 1 : 0;
  const unattributedRatio = credit.totalTokens > 0 ? unattributedTokens / credit.totalTokens : 0;

  let score = 0.35;
  if (health.reliable) {
    score = 0.82;
  } else if (v2Runs > 0) {
    score = 0.62;
  } else if (!health.noPerSkillData) {
    score = 0.48;
  }

  score += v2Coverage * 0.12;
  score -= Math.min(0.35, unattributedRatio * 0.5);
  if (health.staleEqualSplit) score = Math.min(score, 0.2);
  score = Math.max(0, Math.min(1, score));

  const level = levelFromScore(score);
  let summary = "Cost intelligence is best-effort, not an API invoice.";
  if (level === "high") {
    summary = `High confidence — v2 hooks logged ${v2Runs} invoke(s); per-skill costs are measured where hooks fired.`;
  } else if (level === "estimated") {
    summary = `Estimated — mix of hooks/transcripts; ${Math.round(unattributedRatio * 100)}% legacy unattributed (reset if pre-1.0.49). General API spend is shown separately on the dashboard.`;
  } else {
    summary = health.summary;
  }

  return { score, level, v2Coverage, summary };
}

export function formatConfidenceBadge(level: ConfidenceLevel): string {
  switch (level) {
    case "high": return "high confidence";
    case "estimated": return "estimated";
    default: return "low confidence";
  }
}

export function formatSkillCostWithConfidence(costLabel: string, conf: SkillCostConfidence | undefined): string {
  if (!conf) return `${costLabel} (confidence: estimated)`;
  return `${costLabel} (confidence: ${formatConfidenceBadge(conf.level)})`;
}

export function assessUsageSkillConfidence(target: string, skill: string): SkillCostConfidence {
  const runs = readCachedEnrichedRuns(target).filter((r) => r.skill === skill && isUsageRunRecord(r));
  const v2Count = runs.filter(isV2HookRun).length;
  const runCount = runs.length;
  if (v2Count > 0) {
    const score = scoreForSource("v2-hook", v2Count, false);
    return { skill, level: levelFromScore(score), score, source: "v2-hook" };
  }
  if (runCount > 0) {
    const score = scoreForSource("runs", runCount, false);
    return { skill, level: levelFromScore(score), score, source: "runs" };
  }
  return { skill, level: "low", score: 0.25, source: "heuristic" };
}

export function buildUsageSkillConfidenceMap(target: string, skillNames: string[]): Map<string, SkillCostConfidence> {
  const out = new Map<string, SkillCostConfidence>();
  for (const skill of skillNames) out.set(skill, assessUsageSkillConfidence(target, skill));
  return out;
}

// â”€â”€ Attribution Health â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface AttributionHealth {
  reliable: boolean;
  staleEqualSplit: boolean;
  highUnattributedRatio: boolean;
  noPerSkillData: boolean;
  v2HookRuns: number;
  confidenceScore: number;
  confidenceLevel: "high" | "estimated" | "low";
  summary: string;
}

export function assessAttributionHealth(target: string, libraryDir: string): AttributionHealth {
  const built = buildCostAttribution(target, libraryDir);
  const v2HookRuns = countV2HookRuns(target);
  const { staleEqualSplit, attribution } = resolveDisplayAttribution(built, target);
  const generalApi = computeGeneralApiSpend(target, libraryDir, 14);
  const legacyUnattributed = generalApi.legacyUnattributedTokens;
  const credit = computeEnabledAgentsCreditUsage(libraryDir, 14, target);
  const highUnattributedRatio =
    legacyUnattributed > 0 &&
    credit.totalTokens > 0 &&
    legacyUnattributed / credit.totalTokens > 0.3;
  const hookSkillCosts = summarizeSkillCostsFromRuns(target, 14);
  const noPerSkillData =
    hookSkillCosts.includedRuns === 0 && topExpensiveSkills(attribution, 1).length === 0;
  const reliable = !staleEqualSplit && !highUnattributedRatio && !noPerSkillData;

  let summary = "Per-skill attribution looks usable.";
  if (staleEqualSplit) {
    summary = "Equal-split mis-attribution detected — run Reset Mis-attributed Cost Data.";
  } else if (noPerSkillData && v2HookRuns === 0) {
    const gap = assessClaudeVscodeAttributionGap(target);
    if (gap.detected) {
      summary = gap.recommendation || gap.summary;
    } else {
      summary = "No per-skill cost data yet — enable Attribution Hooks (v2) or collect runs/transcripts.";
    }
  } else if (noPerSkillData) {
    summary = "Invoke skills in Claude Code to populate v2 hook runs, then reopen the dashboard.";
  } else if (highUnattributedRatio) {
    summary = "Legacy unattributed bucket inflated — run Reset Mis-attributed Cost Data (pre-1.0.49 collector).";
  } else if (v2HookRuns > 0) {
    summary = `Attribution v2 active (${v2HookRuns} explicit skill invoke(s) logged).`;
  }

  const workspaceConf = assessWorkspaceConfidence(target, libraryDir, {
    reliable, staleEqualSplit, highUnattributedRatio, noPerSkillData, v2HookRuns, summary,
  }, legacyUnattributed);

  return {
    reliable,
    staleEqualSplit,
    highUnattributedRatio,
    noPerSkillData,
    v2HookRuns,
    confidenceScore: workspaceConf.score,
    confidenceLevel: workspaceConf.level,
    summary: workspaceConf.summary,
  };
}

// â”€â”€ Attribution Strategy â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type AttributionTier = "hooks" | "transcripts" | "heuristics";

export interface AttributionStrategy {
  tier: AttributionTier;
  confidence: ConfidenceLevel;
  hookedAgents: AgentId[];
  transcriptAgents: AgentId[];
  summary: string;
}

function tierFromStatus(status: WorkspaceHookStatus, transcriptAgents: AgentId[]): AttributionTier {
  const hooked = status.attribution.agents.filter((a) => a.applicable && a.configured);
  if (hooked.length > 0) return "hooks";
  if (transcriptAgents.length > 0) return "transcripts";
  return "heuristics";
}

function confidenceForTier(tier: AttributionTier, hookedCount: number, transcriptCount: number): ConfidenceLevel {
  if (tier === "hooks" && hookedCount >= 2) return "high";
  if (tier === "hooks" || (tier === "transcripts" && transcriptCount >= 1)) return "estimated";
  return "low";
}

export function resolveAttributionStrategy(target: string, libraryDir: string): AttributionStrategy {
  const status = getWorkspaceHookStatus(target, libraryDir);
  const manifest = loadAgentsManifest(libraryDir);
  const transcriptAgents = (Object.entries(manifest.agents) as [AgentId, { supportsUsageTranscripts?: boolean }][])
    .filter(([, def]) => def.supportsUsageTranscripts)
    .map(([id]) => id);

  const hookedAgents = status.attribution.agents
    .filter((a) => a.applicable && a.configured)
    .map((a) => a.agent as AgentId);
  const tier = tierFromStatus(status, transcriptAgents);
  const confidence = confidenceForTier(tier, hookedAgents.length, transcriptAgents.length);

  let summary: string;
  switch (tier) {
    case "hooks":
      summary = `Primary: v2 hooks (${hookedAgents.join(", ") || "none"}). Fallback: session transcripts, then tier heuristics.`;
      break;
    case "transcripts":
      summary = `Primary: session transcripts (${transcriptAgents.join(", ")}). Per-skill split is best-effort without hooks.`;
      break;
    default:
      summary = "Primary: install-tier cost heuristics only — enable attribution hooks for measured per-skill data.";
  }

  return { tier, confidence, hookedAgents, transcriptAgents, summary };
}

export function formatAttributionStrategyLine(strategy: AttributionStrategy): string {
  return `Attribution: ${strategy.tier} (confidence: ${strategy.confidence}) — ${strategy.summary}`;
}

// â”€â”€ Attribution Trust â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type GlobalTrustTier = "reliable" | "estimated" | "low";

export interface GlobalTrustBadge {
  tier: GlobalTrustTier;
  label: string;
  shortLabel: string;
  detail: string;
  scorePct: number;
}

export interface SkillTrustLine {
  roiBand?: RoiBand;
  confidencePct: number;
  level: ConfidenceLevel;
  sourceLabel: string;
  summary: string;
}

function tierFromLevel(level: ConfidenceLevel, hooksActive: boolean): GlobalTrustTier {
  if (level === "high" && hooksActive) return "reliable";
  if (level === "low") return "low";
  return "estimated";
}

export function buildGlobalTrustBadge(
  health: Pick<AttributionHealth, "confidenceLevel" | "confidenceScore" | "summary" | "v2HookRuns">,
  hookStatus?: Pick<WorkspaceHookStatus, "attribution">
): GlobalTrustBadge {
  const hooksActive =
    (hookStatus?.attribution.allConfigured && (hookStatus.attribution.applicableCount ?? 0) > 0) ||
    health.v2HookRuns > 0;
  const tier = tierFromLevel(health.confidenceLevel, hooksActive);
  const scorePct = Math.round(health.confidenceScore * 100);

  switch (tier) {
    case "reliable":
      return { tier, label: "Reliable (hooks active)", shortLabel: "Reliable", detail: health.summary, scorePct };
    case "estimated":
      return {
        tier,
        label: "Estimated (transcripts)",
        shortLabel: "Estimated",
        detail: health.summary + " Per-skill costs are probabilistic when hooks did not fire — not an API invoice.",
        scorePct,
      };
    default:
      return {
        tier: "low",
        label: "Low confidence",
        shortLabel: "Low confidence",
        detail: health.summary + " Enable Attribution v2 hooks for measured per-skill costs.",
        scorePct,
      };
  }
}

export function formatGlobalTrustStatusBar(badge: GlobalTrustBadge): string {
  return `$(shield) Trust: ${badge.shortLabel} (${badge.scorePct}%)`;
}

export function formatGlobalTrustBannerHtml(badge: GlobalTrustBadge): string {
  const cls = badge.tier === "reliable" ? "trust-reliable" : badge.tier === "estimated" ? "trust-estimated" : "trust-low";
  return `<div class="trust-banner ${cls}"><b>Trust</b> — <b>${badge.label}</b> · ${badge.scorePct}% · <span class="trust-detail">${badge.detail}</span></div>`;
}

export function skillCostSourceLabel(source: SkillCostSource): string {
  switch (source) {
    case "v2-hook": return "Hook-based";
    case "runs": return "Self-learning runs";
    case "transcript-split": return "Transcript-based";
    default: return "Heuristic";
  }
}

export function buildSkillTrustLine(conf: SkillCostConfidence | undefined, roiBand?: RoiBand): SkillTrustLine {
  const level = conf?.level ?? "estimated";
  const score = conf?.score ?? 0.4;
  const source = conf?.source ?? "heuristic";
  const confidencePct = Math.round(score * 100);
  const sourceLabel = skillCostSourceLabel(source);
  const roiPart = roiBand ? `ROI: ${roiBand}` : undefined;
  const confPart = `Confidence: ${confidencePct}% (${sourceLabel})`;
  return { roiBand, confidencePct, level, sourceLabel, summary: roiPart ? `${roiPart} · ${confPart}` : confPart };
}

export function formatSkillTrustPlain(line: SkillTrustLine): string {
  return line.summary;
}

export function formatSkillTrustHtml(line: SkillTrustLine): string {
  const roi = line.roiBand != null
    ? `<span class="roi-${line.roiBand.toLowerCase()}">ROI: ${line.roiBand}</span>`
    : "";
  const conf = `<span class="conf-${line.level}">Confidence: ${line.confidencePct}% (${line.sourceLabel})</span>`;
  return [roi, conf].filter(Boolean).join(" · ");
}

// â”€â”€ Attribution Trust Config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const ATTRIBUTION_TRUST_REL = path.join(".claude", "learning", "attribution-trust.json");

export interface AttributionTrustPromptFile {
  version: 1;
  updatedAt: string;
  enabled: boolean;
  thresholdPct: number;
  scorePct: number;
  level: ConfidenceLevel;
  tier: GlobalTrustTier;
  summary: string;
  shouldInject: boolean;
}

export function attributionTrustPath(target: string): string {
  return path.join(target, ATTRIBUTION_TRUST_REL);
}

export function readLowTrustPromptSettings(): { enabled: boolean; thresholdPct: number } {
  const cfg = vscode.workspace.getConfiguration("claudeSkills.costIntelligence");
  const enabled = cfg.get<boolean>("lowTrustPromptEnabled", true);
  let thresholdPct = cfg.get<number>("lowTrustPromptThresholdPct", 50);
  if (!Number.isFinite(thresholdPct)) thresholdPct = 50;
  return { enabled, thresholdPct: Math.max(0, Math.min(100, Math.round(thresholdPct))) };
}

export function syncAttributionTrustConfig(target: string, libraryDir: string): AttributionTrustPromptFile | null {
  const { enabled, thresholdPct } = readLowTrustPromptSettings();
  const health = assessAttributionHealth(target, libraryDir);
  const badge = buildGlobalTrustBadge(health, getWorkspaceHookStatus(target, libraryDir));
  const scorePct = badge.scorePct;
  const shouldInject = enabled && scorePct < thresholdPct;

  const payload: AttributionTrustPromptFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    enabled,
    thresholdPct,
    scorePct,
    level: health.confidenceLevel,
    tier: badge.tier,
    summary: badge.detail,
    shouldInject,
  };

  const file = attributionTrustPath(target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  return payload;
}

// â”€â”€ System Mode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type SystemMode = "normal" | "degraded" | "safe";

export interface SystemModeContext {
  mode: SystemMode;
  pipelineReady: boolean;
  pipelineFresh: boolean;
  pipelineStaleMessage?: string;
  canShowPerSkillCosts: boolean;
  canSuggestOptimizations: boolean;
  canApplyOptimizations: boolean;
  canAutoApplyOptimizations: boolean;
  banner?: string;
}

export function resolveSystemMode(
  health: AttributionHealth,
  target: string,
  cycle: PipelineCycleTimestamps
): SystemMode {
  if (isPipelineCircuitOpen(cycle)) return "safe";
  const pipelineFresh = isPipelineFresh(target, cycle);
  if (health.staleEqualSplit || health.confidenceScore < 0.45 || !pipelineFresh) return "safe";
  if (!health.reliable || health.confidenceScore < 0.75) return "degraded";
  return "normal";
}

export function buildSystemModeContext(
  health: AttributionHealth,
  target: string,
  cycle: PipelineCycleTimestamps
): SystemModeContext {
  const pipelineReady = isPipelineReadyForOptimizer(cycle);
  const pipelineFresh = isPipelineFresh(target, cycle);
  const pipelineStaleMessage = pipelineStaleSummary(target, cycle);
  const mode = resolveSystemMode(health, target, cycle);

  let banner: string | undefined;
  if (mode === "safe") {
    if (isPipelineCircuitOpen(cycle)) {
      banner = `Safe mode: ${pipelineStaleMessage ?? "pipeline circuit open — too many sync runs"}`;
    } else if (health.staleEqualSplit) {
      banner = "Safe mode: mis-attributed cost data — reset attribution before trusting per-skill numbers.";
    } else if (!pipelineFresh) {
      banner = `Safe mode: ${pipelineStaleMessage ?? "pipeline not fresh"}`;
    } else {
      banner = `Safe mode: attribution confidence too low (${Math.round(health.confidenceScore * 100)}%) — suggestions hidden.`;
    }
  } else if (mode === "degraded") {
    banner = `Degraded mode: estimates only (${Math.round(health.confidenceScore * 100)}% confidence) — review before applying; auto-optimize disabled.`;
  }

  return {
    mode,
    pipelineReady,
    pipelineFresh,
    pipelineStaleMessage,
    canShowPerSkillCosts: mode !== "safe" && !health.staleEqualSplit && pipelineFresh,
    canSuggestOptimizations: mode !== "safe" && pipelineFresh,
    canApplyOptimizations: (mode === "normal" || mode === "degraded") && pipelineFresh,
    canAutoApplyOptimizations: mode === "normal" && pipelineFresh,
    banner,
  };
}
