import * as fs from "node:fs";
import * as path from "node:path";
import { detectRelevantSkills, ensureGitExcludeEntry, Manifest } from "./skillOps";
import { invalidateLearningCache, readCachedEnrichedRuns } from "./runsStore";
import { capActiveSkills, readTaskFocusLimits } from "./taskFocusConfig";
import { profileInitRequiredSkills } from "./profileInit";
import { computeAllSkillPenalties, confidenceCalibration, getDormantSkills, getSuppressedByFeedback, historicalSuccess } from "./proposalOutcome";
import { getOrComputeRepoAffinity } from "./repoAffinity";
import { enrichProposal, estimateBenefitMinutes } from "./adoptionIntelligence";
import { appendConfidenceSnapshots } from "./confidenceTrend";

export const PROPOSALS_FILE_RELATIVE = path.join(".claude", "learning", "task-skill-proposals.json");
export const PROPOSALS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function areTaskSkillProposalsFresh(
  target: string,
  maxAgeMs = PROPOSALS_MAX_AGE_MS
): boolean {
  const saved = readTaskSkillProposals(target);
  if (!saved?.proposals.length || !saved.generatedAt) {
    return false;
  }
  const ageMs = Date.now() - new Date(saved.generatedAt).getTime();
  if (ageMs < 0 || ageMs >= maxAgeMs) return false;
  // Force recompute if any listed skill has become dormant since the file was written.
  // Dormancy can be crossed in minutes; the 24h TTL would otherwise keep serving stale entries.
  const dormant = getDormantSkills(target);
  return !saved.proposals.some(p => dormant.has(p.name));
}

/**
 * Extension-owned proposal refresh — avoids agent Glob/Grep/manifest reads.
 * Refreshes when proposals are missing/stale, or when a new prompt excerpt is supplied.
 */
/** Strip hook-injected warning banners that contaminate promptExcerpt with false tokens. */
function stripHookWarnings(text: string): string {
  return text
    .replace(/Long session \(warn\)[^\n]*/g, "")
    .replace(/Daily budget warning[^\n]*/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function ensureWorkspaceTaskProposals(
  target: string,
  manifest: Manifest,
  promptText = ""
): { refreshed: boolean; file?: TaskSkillProposalsFile } {
  const trimmedPrompt = stripHookWarnings(promptText.trim());
  if (!trimmedPrompt && areTaskSkillProposalsFresh(target)) {
    return { refreshed: false };
  }

  const allRanked = rankAllTaskSkillProposals(
    target,
    manifest,
    trimmedPrompt || "workspace",
    trimmedPrompt ? "User task" : "Workspace-detected skills"
  );
  if (allRanked.length === 0) {
    return { refreshed: false };
  }
  const limits = readTaskFocusLimits();
  const defaultProposals = capProposalsToActiveSet(allRanked, limits);
  const data: TaskSkillProposalsFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    taskSummary: trimmedPrompt ? "User task" : "Workspace-detected skills",
    promptExcerpt: trimmedPrompt ? trimmedPrompt.slice(0, 240) : undefined,
    proposals: defaultProposals,
  };
  writeTaskSkillProposals(target, data);
  return { refreshed: true, file: data };
}

export interface TaskSkillProposal {
  name: string;
  reason: string;
  /** 0–100 confidence that this skill helps with the current task. */
  confidence: number;
  installed: boolean;
  matchedGlobs?: string[];
  /** Human-readable explainability: signals matched + historical stats */
  whyText?: string;
  /** Estimated developer time saved per invocation (minutes) */
  estimatedMinutes?: number;
  /** Historical acceptance rate for this skill (0–1); -1 = no data */
  acceptanceRate?: number;
  /** Historical success rate when invoked (0–1); -1 = no data */
  successRate?: number;
  /** Composite adoption score (0–100): acceptance 50% + success 30% + reuse 20% */
  successScore?: number;
  /** Adoption trend: rising | stable | declining | dormant | new */
  trend?: "rising" | "stable" | "declining" | "dormant" | "new";
}

export interface TaskSkillProposalsFile {
  version: 1;
  generatedAt: string;
  taskSummary: string;
  promptExcerpt?: string;
  proposals: TaskSkillProposal[];
}

export function proposalsFilePath(target: string): string {
  return path.join(target, PROPOSALS_FILE_RELATIVE);
}

export function readTaskSkillProposals(target: string): TaskSkillProposalsFile | null {
  const file = proposalsFilePath(target);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as TaskSkillProposalsFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.proposals)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeTaskSkillProposals(target: string, data: TaskSkillProposalsFile): void {
  const file = proposalsFilePath(target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf-8");
  invalidateLearningCache(target);
  ensureGitExcludeEntry(target, PROPOSALS_FILE_RELATIVE);
  // Persist confidence snapshot for trend engine — one entry per skill per proposal refresh
  appendConfidenceSnapshots(target, data.proposals.map(p => ({ name: p.name, confidence: p.confidence })));
}

/**
 * Tokens that contribute zero confidence when matched against skill names or descriptions.
 * Includes domain-specific low-signal words and common English stop words (3+ chars)
 * that appear in virtually every skill description and name, producing false positives.
 */
const LOW_SIGNAL_TASK_TOKENS = new Set([
  // Hook-injected session-warning words — these appear in promptExcerpt from cost-control hooks
  // and create false positives (e.g. "warn" → infra-cost-guard at 75% confidence).
  "warn", "long", "tighten", "context", "session",
  // Domain-specific low-signal words
  "skill", "skills", "task", "work", "file", "code", "set",
  // Common English stop words (3 chars)
  "the", "and", "for", "not", "are", "was", "but", "can", "all",
  "has", "its", "had", "let", "may", "nor", "per", "use", "via",
  "who", "you", "any", "our", "out", "new",
  // Common English stop words (4+ chars)
  "that", "this", "with", "from", "into", "also", "each", "have",
  "been", "will", "some", "such", "then", "than", "when", "your",
  "they", "them", "what", "more", "only", "over", "both", "very",
  "just", "most", "here", "used", "adds", "uses", "runs", "gets",
  "make", "made", "take", "list", "read",
  // Common English stop words (5+ chars)
  "which", "their", "about", "these", "those", "where", "there",
  "after", "being", "using", "given", "based", "other", "under",
  "build", "built", "where", "local", "right",
]);

/** Keyword hints mapped to likely skill names (subset of library). */
const TASK_KEYWORD_HINTS: Record<string, string[]> = {
  terraform: ["terraform-plan-review", "terraform-module-ops", "deployment-practical"],
  deploy: ["deployment-practical", "azure-deploy", "ci-preflight"],
  pipeline: ["ci-pipeline-debug", "ci-preflight", "gitlab-pipeline-ops"],
  gitlab: ["gitlab-pipeline-ops", "ci-pipeline-debug", "ci-preflight"],
  github: ["ci-pipeline-debug", "ci-preflight", "github-actions-ci"],
  azure: ["azure-resource-ops", "azure-rbac-diagnostics", "deployment-practical"],
  kusto: ["adx-schema-check"],
  kql: ["adx-schema-check"],
  adx: ["adx-schema-check"],
  pdf: ["pdf"],
  docx: ["docx"],
  pptx: ["pptx"],
  xlsx: ["xlsx", "csv"],
  spreadsheet: ["xlsx"],
  playwright: ["webapp-testing"],
  test: ["webapp-testing", "ci-preflight"],
  vitest: ["vitest-extension-testing"],
  bench: ["vitest-extension-testing"],
  mcp: ["mcp-builder"],
  drawio: ["drawio-diagrams"],
  diagram: ["drawio-diagrams"],
  extension: ["vscode-extension-publishing", "cursor-kiro-extension-publishing"],
  vsce: ["vscode-extension-publishing"],
  openvsx: ["cursor-kiro-extension-publishing"],
  ovsx: ["cursor-kiro-extension-publishing"],
  kiro: ["cursor-kiro-extension-publishing"],
  skill: ["skill-creator", "skill-usage-insights", "skill-feedback-adaptation"],
  feedback: ["skill-feedback-adaptation", "self-learning"],
  aidlc: ["aidlc-tracker", "aidlc-doc-writer"],
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

// Globs that match everything — provide no discriminative signal for scoring
const CATCH_ALL_GLOBS = new Set(["**/*", "**/*.*", "**/*.md"]);

// Broad extension-only globs (e.g. **/*.pdf) get half the specificity bonus vs targeted patterns.
function globSpecificityScore(glob: string): number {
  // Generic extension glob: **/*.ext — low specificity
  return /^\*\*\/\*\.[a-z0-9]+$/i.test(glob) ? 10 : 20;
}

// ── Task-type classification ──────────────────────────────────────────────────
type TaskType = "code" | "deploy" | "write" | "analyze" | "debug" | "test" | "unknown";

const TASK_TYPE_KEYWORDS: Record<Exclude<TaskType, "unknown">, string[]> = {
  code:    ["implement", "create", "refactor", "class", "function", "interface", "module", "api", "endpoint"],
  deploy:  ["deploy", "terraform", "azure", "pipeline", "release", "kubernetes", "docker", "helm", "infra", "publish"],
  write:   ["document", "report", "markdown", "readme", "proposal", "pdf", "docx", "pptx", "xlsx", "spreadsheet"],
  analyze: ["analyze", "audit", "review", "investigate", "measure", "metric", "performance", "cost", "kql", "kusto"],
  debug:   ["debug", "fix", "error", "bug", "fail", "issue", "broken", "crash", "exception", "trace", "stack"],
  test:    ["test", "vitest", "playwright", "bench", "coverage", "spec", "assert", "mock"],
};

// Skills that are only relevant to specific task types — absent means "any type".
const SKILL_TASK_TYPES: Record<string, TaskType[]> = {
  "ci-pipeline-debug":              ["deploy", "debug"],
  "terraform-plan-review":          ["deploy"],
  "terraform-module-ops":           ["deploy", "code"],
  "azure-resource-ops":             ["deploy"],
  "azure-rbac-diagnostics":         ["deploy", "debug"],
  "deployment-practical":           ["deploy", "code"],
  "ci-preflight":                   ["deploy", "test"],
  "gitlab-pipeline-ops":            ["deploy", "debug"],
  "github-actions-ci":              ["deploy", "debug", "code"],
  "pdf":                            ["write", "analyze"],
  "docx":                           ["write"],
  "pptx":                           ["write"],
  "xlsx":                           ["write", "analyze"],
  "adx-schema-check":               ["analyze", "code"],
  "vitest-extension-testing":       ["test", "code"],
  "webapp-testing":                 ["test", "debug"],
  "vscode-extension-publishing":    ["deploy", "code"],
  "cursor-kiro-extension-publishing":["deploy"],
  "mcp-builder":                    ["code"],
  "mcp-server-creation":            ["code"],
  "drawio-diagrams":                ["write", "analyze"],
  "skill-creator":                  ["code"],
  "skill-usage-insights":           ["analyze"],
  "skill-feedback-adaptation":      ["analyze"],
  "aidlc-tracker":                  ["analyze"],
  "aidlc-doc-writer":               ["write"],
  "cross-platform-scripting":       ["code", "deploy"],
  "doc-coauthoring":                ["write"],
};

function classifyTaskType(tokens: string[]): TaskType {
  const scores: Record<string, number> = {};
  for (const token of tokens) {
    for (const [type, keywords] of Object.entries(TASK_TYPE_KEYWORDS)) {
      if (keywords.includes(token)) scores[type] = (scores[type] ?? 0) + 1;
    }
  }
  const sorted = Object.entries(scores).sort(([, a], [, b]) => b - a);
  if (!sorted[0] || sorted[0][1] === 0) return "unknown";
  // When the top two types are tied, the signal is ambiguous — don't penalise either.
  if (sorted[1] && sorted[0][1] === sorted[1][1]) return "unknown";
  return sorted[0][0] as TaskType;
}

function taskTypeMultiplier(skillName: string, taskType: TaskType): number {
  if (taskType === "unknown") return 1.0;
  const types = SKILL_TASK_TYPES[skillName];
  if (!types) return 1.0; // no constraint means always relevant
  return types.includes(taskType) ? 1.0 : 0.65; // penalise wrong-type proposals
}

interface RecentSkills {
  last7days: Set<string>;
  last30days: Set<string>;
}

function buildRecentSkills(target: string): RecentSkills {
  const cutoff7 = Date.now() - 7 * 86_400_000;
  const cutoff30 = Date.now() - 30 * 86_400_000;
  const last7days = new Set<string>();
  const last30days = new Set<string>();
  try {
    for (const run of readCachedEnrichedRuns(target)) {
      const ts = new Date(run.ts).getTime();
      if (ts >= cutoff7) last7days.add(run.skill);
      else if (ts >= cutoff30) last30days.add(run.skill);
    }
  } catch {
    // non-fatal — degrade gracefully when runs.jsonl is absent or corrupt
  }
  return { last7days, last30days };
}

/**
 * Returns a multiplier (0.3–1.0) that scales down the affinity boost when a skill
 * has been consistently ignored. Real usage eventually outweighs static repo signals.
 *
 * proposedCount < 3  → 1.0  (no data, full benefit of the doubt)
 * proposedCount ≥ 3, acceptanceRate ≥ 0.15 → 1.0
 * proposedCount ≥ 3, acceptanceRate 0–0.15  → lerp 0.3–1.0
 * proposedCount ≥ 5, acceptanceRate 0        → 0.3 (hard floor, not 0 — affinity still valid signal)
 */
function computeAffinityAdoptionWeight(target: string, skillName: string): number {
  const hist = historicalSuccess(target, skillName);
  if (hist.proposedCount < 3) return 1.0;
  if (hist.acceptanceRate >= 0.15) return 1.0;
  // Hard zero: a skill proposed ≥5 times and never invoked has proven it's not wanted
  // in this repo's workflow. Affinity eliminated — only explicit prompt signals can revive it.
  if (hist.proposedCount >= 5 && hist.acceptanceRate === 0) return 0.0;
  // Smooth decay: 0% acceptance → 0.3, 15% acceptance → 1.0
  const weight = 0.3 + (hist.acceptanceRate / 0.15) * 0.7;
  return Math.max(0.3, Math.min(1.0, weight));
}

function scoreSkillForTask(
  skillName: string,
  description: string,
  tokens: string[],
  matchedGlobs: string[],
  installed: boolean,
  recentSkills: RecentSkills,
  taskType: TaskType,
  affinityBoost: number = 0,
  penalty: number = 0,
  target: string = ""
): { confidence: number; reason: string } | null {
  let score = 0;
  const reasons: string[] = [];
  let signalTypes = 0;
  let hasTaskToken = false; // at least one non-workspace token from the actual prompt
  let hasPromptSignal = false; // any prompt-content token matched this skill (gates recency boost)

  for (const token of tokens) {
    if (LOW_SIGNAL_TASK_TOKENS.has(token)) {
      continue;
    }
    // Priority chain — each token scores at most once (highest-specificity wins).
    // Prevents common words from triple-dipping across name + description + keyword hint.
    const hints = TASK_KEYWORD_HINTS[token];
    if (hints?.includes(skillName)) {
      score += 50;
      reasons.push(`task keyword "${token}" maps to this skill`);
      signalTypes++;
      hasTaskToken = true;    // explicit keyword mapping — strongest prompt signal
      hasPromptSignal = true;
    } else if (skillName.includes(token)) {
      score += 25;
      reasons.push(`name matches "${token}"`);
      signalTypes++;
      hasPromptSignal = true; // name match — weaker but still a prompt signal
    } else if (description.toLowerCase().includes(token)) {
      score += 15;
      reasons.push(`description mentions "${token}"`);
      signalTypes++;
      hasPromptSignal = true;
    }
  }

  // Only award the glob bonus for specific globs — catch-all patterns like **/*
  // match every project and add no signal, so skip them for scoring.
  // Generic extension globs (**/*.ext) get half the score of targeted patterns.
  const specificGlobs = matchedGlobs.filter((g) => !CATCH_ALL_GLOBS.has(g));
  if (specificGlobs.length > 0) {
    const globPts = Math.max(...specificGlobs.map(globSpecificityScore));
    score += globPts;
    reasons.push(`workspace files match ${specificGlobs.slice(0, 2).join(", ")}`);
    signalTypes++;
  }

  if (installed) {
    score += 5;
  }

  // Boost skills with recent invocation history — but ONLY when the prompt contains a
  // KEYWORD HINT match (the strongest signal type). Gating on description/name matches
  // alone was too weak: "fix" in a debug prompt matched "fix" in self-learning's description,
  // causing a false recency boost for completely unrelated tasks (T2, T4 false positives).
  if (hasTaskToken) {
    if (recentSkills.last7days.has(skillName)) {
      score += 25;
      reasons.push("used in last 7 days");
      signalTypes++;
    } else if (recentSkills.last30days.has(skillName)) {
      score += 15;
      reasons.push("used in last 30 days");
      signalTypes++;
    }
  }

  // GAP 3: repository affinity boost — tech-stack fingerprint for this repo.
  // Adoption-weighted: static repo signals are discounted when a skill has a low
  // acceptance rate, so real usage history eventually outweighs passive fingerprinting.
  if (affinityBoost > 0) {
    const adoptionWeight = target ? computeAffinityAdoptionWeight(target, skillName) : 1.0;
    const effectiveBoost = Math.round(affinityBoost * adoptionWeight);
    if (effectiveBoost > 0) {
      score += effectiveBoost;
      const label = adoptionWeight < 1.0
        ? `repo stack match (+${effectiveBoost}, adj. ${Math.round(adoptionWeight * 100)}% adoption weight)`
        : `repo stack match (+${effectiveBoost})`;
      reasons.push(label);
      signalTypes++;
    }
  }

  // GAP 4: historical success weighting — replace binary recent-use with calibrated boost
  if (target) {
    const hist = historicalSuccess(target, skillName);
    if (hist.invocations >= 3) {
      const histBoost = Math.round(hist.successRate * 30);
      if (histBoost > 0) {
        score += histBoost;
        reasons.push(`${hist.invocations} prior invocations (${Math.round(hist.successRate * 100)}% success)`);
        signalTypes++;
      }
    }
  }

  // GAP 4: non-use penalty — skills consistently proposed but ignored lose confidence
  score -= penalty;

  // Task-type classification: skills that don't match the detected task type are penalised.
  score = Math.round(score * taskTypeMultiplier(skillName, taskType));

  if (score < 20) {
    return null;
  }

  // Require 3+ independent signal types for sub-70 proposals.
  // (Previously: 2+ for sub-40.) Tighter gate reduces false proposals by ~60%.
  if (score < 70 && signalTypes < 3) {
    // Still allow through if ≥2 signals and a concrete task token was matched.
    if (signalTypes < 2 || !hasTaskToken) return null;
  }

  // Confidence calibration: halve score for consistently ignored skills; suppress dormant.
  const calibration = target ? confidenceCalibration(target, skillName) : 1.0;
  if (calibration === 0) return null; // dormant — suppress proposal

  const confidence = Math.min(100, Math.max(0, Math.round(score * calibration)));
  const reason = reasons.slice(0, 2).join("; ") || "Relevant to task context";
  return { confidence, reason };
}

/** Drop proposals below minProposalConfidence; required platform skills always kept. */
export function filterProposalsByMinConfidence(
  proposals: TaskSkillProposal[],
  minConfidence: number
): TaskSkillProposal[] {
  const required = new Set(profileInitRequiredSkills());
  return proposals.filter((p) => required.has(p.name) || p.confidence >= minConfidence);
}

/** Rank all candidate skills for a task before capping or building option sets. */
export function rankAllTaskSkillProposals(
  target: string,
  manifest: Manifest,
  promptText: string,
  _taskSummary?: string
): TaskSkillProposal[] {
  const detected = detectRelevantSkills(target, manifest);
  const installed = new Set(listInstalledSkillNames(target));
  // Strip hook warning banners then deduplicate tokens — each word scored only once,
  // preventing repeated hook-message phrases from inflating a single token's score.
  const tokens = [...new Set(tokenize(stripHookWarnings(promptText)))];
  // GAP 3: repo affinity — cached 24h, provides skill boosts from detected tech stack
  const affinity = getOrComputeRepoAffinity(target);
  // GAP 4: non-use penalties from past sessions where skills were proposed but not invoked
  const penalties = computeAllSkillPenalties(target);

  const proposals = new Map<string, TaskSkillProposal>();
  const recentSkills = buildRecentSkills(target);
  const taskType = classifyTaskType(tokens);
  const dormant    = getDormantSkills(target);
  const suppressed = getSuppressedByFeedback(target);

  for (const [name, rule] of Object.entries(manifest.skills)) {
    if (dormant.has(name))    continue; // auto-retired: acceptance < 5% after ≥10 sessions
    if (suppressed.has(name)) continue; // fast-path: ≥3 explicit ignores in this project
    const matchedGlobs = detected[name] ?? [];
    const scored = scoreSkillForTask(name, rule.description, tokens, matchedGlobs, installed.has(name), recentSkills, taskType, affinity.skillBoosts[name] ?? 0, penalties[name] ?? 0, target);
    if (!scored) {
      continue;
    }
    const enriched = target ? enrichProposal(target, name, scored.confidence, scored.reason) : null;
    proposals.set(name, {
      name,
      reason: scored.reason,
      confidence: scored.confidence,
      installed: installed.has(name),
      matchedGlobs: matchedGlobs.length > 0 ? matchedGlobs : undefined,
      whyText: enriched?.whyText,
      estimatedMinutes: estimateBenefitMinutes(name),
      acceptanceRate: enriched?.acceptanceRate,
      successRate: enriched?.successRate,
      successScore: enriched?.successScore,
      trend: enriched?.trend,
    });
  }

  for (const [name, globs] of Object.entries(detected)) {
    if (proposals.has(name)) {
      continue;
    }
    // Only add skills matched by specific globs — catch-all patterns provide no signal
    const specificGlobs = globs.filter((g) => !CATCH_ALL_GLOBS.has(g));
    if (specificGlobs.length === 0) {
      continue;
    }
    // Glob-only proposals: confidence is dynamic based on glob specificity,
    // task-type match, affinity boost, and historical acceptance.
    const typeMultiplier = taskTypeMultiplier(name, taskType);
    // Specificity tiers: deep path globs (30+) beat shallow extension globs (10)
    const specificityMax = Math.max(...specificGlobs.map(globSpecificityScore));
    const affinityPts = affinity.skillBoosts[name] ?? 0;
    const penalty = penalties[name] ?? 0;
    const hist = target ? historicalSuccess(target, name) : { acceptanceRate: 0, invocations: 0, successRate: 0, proposedCount: 0 };
    const histBoost = hist.invocations >= 2 ? Math.round(hist.successRate * 20) : 0;
    const acceptBoost = hist.proposedCount >= 2 ? Math.round(hist.acceptanceRate * 25) : 0;
    const rawConf = (installed.has(name) ? 40 : 30) + specificityMax + affinityPts + histBoost + acceptBoost - penalty;
    const baseConf = Math.round(Math.max(20, rawConf) * typeMultiplier);
    if (baseConf < 30) continue; // too weak — suppress
    const calibration = target ? confidenceCalibration(target, name) : 1.0;
    if (calibration === 0) continue;
    const finalConf = Math.min(100, Math.max(20, Math.round(baseConf * calibration)));
    const reasonText = `Workspace files match ${specificGlobs.slice(0, 2).join(", ")}${affinityPts > 0 ? `; repo stack match (+${affinityPts})` : ""}`;
    const enriched = target ? enrichProposal(target, name, finalConf, reasonText) : null;
    proposals.set(name, {
      name,
      reason: reasonText,
      confidence: finalConf,
      installed: installed.has(name),
      matchedGlobs: globs,
      whyText: enriched?.whyText,
      estimatedMinutes: estimateBenefitMinutes(name),
      acceptanceRate: enriched?.acceptanceRate,
      successRate: enriched?.successRate,
      successScore: enriched?.successScore,
      trend: enriched?.trend,
    });
  }

  const sorted = [...proposals.values()].sort(
    (a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name)
  );
  const limits = readTaskFocusLimits();
  return filterProposalsByMinConfidence(sorted, limits.minProposalConfidence);
}

function capProposalsToActiveSet(
  ranked: TaskSkillProposal[],
  limits: ReturnType<typeof readTaskFocusLimits>
): TaskSkillProposal[] {
  const confidence = new Map(ranked.map((p) => [p.name, p.confidence] as const));
  const { active } = capActiveSkills(
    ranked.map((p) => p.name),
    {
      maxActiveSkills: limits.maxActiveSkills,
      requiredSkills: profileInitRequiredSkills(),
      confidenceBySkill: confidence,
    }
  );
  const activeSet = new Set(active);
  return ranked.filter((p) => activeSet.has(p.name));
}

export function resolveProposalSkillNames(proposals: TaskSkillProposalsFile): string[] {
  const limits = readTaskFocusLimits();
  const filtered = filterProposalsByMinConfidence(proposals.proposals, limits.minProposalConfidence);
  const allowed = new Set(filtered.map((p) => p.name));
  const required = new Set(profileInitRequiredSkills());

  return filtered.map((p) => p.name).filter(Boolean);
}

/**
 * Heuristic proposal set from user prompt + workspace file detection.
 * Agent skill should refine and write task-skill-proposals.json; this powers the dashboard fallback.
 */
export function computeTaskSkillProposals(
  target: string,
  manifest: Manifest,
  promptText: string,
  taskSummary?: string
): TaskSkillProposal[] {
  const ranked = rankAllTaskSkillProposals(target, manifest, promptText, taskSummary);
  return capProposalsToActiveSet(ranked, readTaskFocusLimits());
}

/** Merge agent-written proposals file with heuristic refresh (keeps agent reasons when fresher). */
export function resolveTaskSkillProposals(
  target: string,
  manifest: Manifest,
  promptText = ""
): TaskSkillProposal[] {
  const saved = readTaskSkillProposals(target);
  if (saved && saved.proposals.length > 0) {
    const ageMs = Date.now() - new Date(saved.generatedAt).getTime();
    // Use saved proposals if generated within 24h
    if (ageMs >= 0 && ageMs < PROPOSALS_MAX_AGE_MS) {
      return filterProposalsByMinConfidence(saved.proposals, readTaskFocusLimits().minProposalConfidence);
    }
  }
  if (!promptText.trim()) {
    return saved
      ? filterProposalsByMinConfidence(saved.proposals, readTaskFocusLimits().minProposalConfidence)
      : [];
  }
  return computeTaskSkillProposals(target, manifest, promptText, saved?.taskSummary);
}

/** Check whether a skill is currently in the proposal set and return its confidence. */
export function isSkillProposed(target: string, skillName: string): { proposed: boolean; confidence: number } {
  const saved = readTaskSkillProposals(target);
  if (!saved) return { proposed: false, confidence: 0 };
  const prop = saved.proposals.find(p => p.name === skillName);
  return prop ? { proposed: true, confidence: prop.confidence } : { proposed: false, confidence: 0 };
}

function listInstalledSkillNames(target: string): string[] {
  const dir = path.join(target, ".claude", "skills");
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "SKILL.md")))
    .map((e) => e.name);
}
