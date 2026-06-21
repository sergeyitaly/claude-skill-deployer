import * as fs from "node:fs";
import * as path from "node:path";
import { detectRelevantSkills, ensureGitExcludeEntry, Manifest } from "./skillOps";
import { invalidateLearningCache, readCachedEnrichedRuns } from "./runsStore";
import { capActiveSkills, readTaskFocusLimits } from "./taskFocusConfig";
import { profileInitRequiredSkills } from "./profileInit";

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
  return ageMs >= 0 && ageMs < maxAgeMs;
}

/**
 * Extension-owned proposal refresh — avoids agent Glob/Grep/manifest reads.
 * Refreshes when proposals are missing/stale, or when a new prompt excerpt is supplied.
 */
export function ensureWorkspaceTaskProposals(
  target: string,
  manifest: Manifest,
  promptText = ""
): { refreshed: boolean; file?: TaskSkillProposalsFile } {
  const trimmedPrompt = promptText.trim();
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
}

/**
 * Tokens that contribute zero confidence when matched against skill names or descriptions.
 * Includes domain-specific low-signal words and common English stop words (3+ chars)
 * that appear in virtually every skill description and name, producing false positives.
 */
const LOW_SIGNAL_TASK_TOKENS = new Set([
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

function scoreSkillForTask(
  skillName: string,
  description: string,
  tokens: string[],
  matchedGlobs: string[],
  installed: boolean,
  recentSkills: RecentSkills
): { confidence: number; reason: string } | null {
  let score = 0;
  const reasons: string[] = [];

  for (const token of tokens) {
    if (LOW_SIGNAL_TASK_TOKENS.has(token)) {
      continue;
    }
    if (skillName.includes(token)) {
      score += 25;
      reasons.push(`name matches "${token}"`);
    }
    if (description.toLowerCase().includes(token)) {
      score += 15;
      reasons.push(`description mentions "${token}"`);
    }
    const hints = TASK_KEYWORD_HINTS[token];
    if (hints?.includes(skillName)) {
      score += 30;
      reasons.push(`task keyword "${token}" maps to this skill`);
    }
  }

  // Only award the glob bonus for specific globs — catch-all patterns like **/*
  // match every project and add no signal, so skip them for scoring.
  const specificGlobs = matchedGlobs.filter((g) => !CATCH_ALL_GLOBS.has(g));
  if (specificGlobs.length > 0) {
    score += 20;
    reasons.push(`workspace files match ${specificGlobs.slice(0, 2).join(", ")}`);
  }

  if (installed) {
    score += 5;
  }

  // Boost skills with recent invocation history — evidence of actual value here.
  if (recentSkills.last7days.has(skillName)) {
    score += 25;
    reasons.push("used in last 7 days");
  } else if (recentSkills.last30days.has(skillName)) {
    score += 15;
    reasons.push("used in last 30 days");
  }

  if (score < 20) {
    return null;
  }

  const confidence = Math.min(100, score);
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
  const tokens = tokenize(promptText);

  const proposals = new Map<string, TaskSkillProposal>();
  const recentSkills = buildRecentSkills(target);

  for (const [name, rule] of Object.entries(manifest.skills)) {
    const matchedGlobs = detected[name] ?? [];
    const scored = scoreSkillForTask(name, rule.description, tokens, matchedGlobs, installed.has(name), recentSkills);
    if (!scored) {
      continue;
    }
    proposals.set(name, {
      name,
      reason: scored.reason,
      confidence: scored.confidence,
      installed: installed.has(name),
      matchedGlobs: matchedGlobs.length > 0 ? matchedGlobs : undefined,
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
    proposals.set(name, {
      name,
      reason: `Workspace files match ${specificGlobs.slice(0, 2).join(", ")}`,
      confidence: installed.has(name) ? 55 : 65,
      installed: installed.has(name),
      matchedGlobs: globs,
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
