import * as fs from "node:fs";
import * as path from "node:path";
import { detectRelevantSkills, Manifest } from "./skillOps";
import { invalidateLearningCache } from "./learningStateIndex";
import { capActiveSkills, readTaskFocusLimits, taskSkillSetApprovalEnabled } from "./taskFocusConfig";
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
  const options = taskSkillSetApprovalEnabled()
    ? computeTaskSkillSetOptions(allRanked, limits)
    : undefined;
  const defaultProposals = capProposalsToActiveSet(allRanked, limits);
  const data: TaskSkillProposalsFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    taskSummary: trimmedPrompt ? "User task" : "Workspace-detected skills",
    promptExcerpt: trimmedPrompt ? trimmedPrompt.slice(0, 240) : undefined,
    proposals: defaultProposals,
    options,
    approvalStatus: taskSkillSetApprovalEnabled() ? "pending" : "approved",
    selectedOptionId: taskSkillSetApprovalEnabled() ? undefined : options?.[0]?.id,
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

export interface TaskSkillSetOption {
  id: string;
  label: string;
  description: string;
  skills: string[];
}

export type TaskSkillSetApprovalStatus = "pending" | "approved" | "skipped";

export interface TaskSkillProposalsFile {
  version: 1;
  generatedAt: string;
  taskSummary: string;
  promptExcerpt?: string;
  proposals: TaskSkillProposal[];
  /** Alternative skill sets for user approval (extension-generated). */
  options?: TaskSkillSetOption[];
  selectedOptionId?: string;
  approvalStatus?: TaskSkillSetApprovalStatus;
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
}

/** Tokens too generic to score (e.g. \"skills\" matching every *skill* name). */
const LOW_SIGNAL_TASK_TOKENS = new Set(["skill", "skills", "task", "work", "file", "code", "set"]);

/** Keyword hints mapped to likely skill names (subset of library). */
const TASK_KEYWORD_HINTS: Record<string, string[]> = {
  terraform: ["terraform-plan-review", "terraform-module-ops", "deployment-practical"],
  deploy: ["deployment-practical", "azure-deploy", "ci-preflight"],
  pipeline: ["ci-pipeline-debug", "ci-preflight", "gitlab-pipeline-ops"],
  gitlab: ["gitlab-pipeline-ops", "ci-pipeline-debug", "ci-preflight"],
  github: ["ci-pipeline-debug", "ci-preflight"],
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

function scoreSkillForTask(
  skillName: string,
  description: string,
  tokens: string[],
  matchedGlobs: string[],
  installed: boolean
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

  if (matchedGlobs.length > 0) {
    score += 20;
    reasons.push(`workspace files match ${matchedGlobs.slice(0, 2).join(", ")}`);
  }

  if (installed) {
    score += 5;
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

  for (const [name, rule] of Object.entries(manifest.skills)) {
    const matchedGlobs = detected[name] ?? [];
    const scored = scoreSkillForTask(name, rule.description, tokens, matchedGlobs, installed.has(name));
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
    proposals.set(name, {
      name,
      reason: `Workspace files match ${globs.slice(0, 2).join(", ")}`,
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

/** Build 2–3 distinct skill-set options for user approval. */
export function computeTaskSkillSetOptions(
  ranked: TaskSkillProposal[],
  limits: ReturnType<typeof readTaskFocusLimits>
): TaskSkillSetOption[] {
  if (ranked.length === 0) {
    return [];
  }
  const required = profileInitRequiredSkills();
  const confidence = new Map(ranked.map((p) => [p.name, p.confidence] as const));

  const capNames = (names: string[], max: number): string[] =>
    capActiveSkills(names, {
      maxActiveSkills: max,
      requiredSkills: required,
      confidenceBySkill: confidence,
    }).active;

  const focused = capNames(
    ranked.map((p) => p.name),
    limits.maxActiveSkills
  );
  const workspaceNames = ranked.filter((p) => (p.matchedGlobs?.length ?? 0) > 0).map((p) => p.name);
  const workspace = workspaceNames.length
    ? capNames(workspaceNames, limits.maxActiveSkills)
    : focused.slice(0, Math.min(6, focused.length));
  const broadMax = Math.min(limits.maxActiveSkills + 4, ranked.length, 30);
  const broad = capNames(ranked.map((p) => p.name), broadMax);

  const raw: TaskSkillSetOption[] = [
    {
      id: "focused",
      label: "Focused",
      description: "Highest-confidence skills for this task",
      skills: focused,
    },
    {
      id: "workspace",
      label: "Workspace match",
      description: "Skills whose detect_globs match files in the repo",
      skills: workspace,
    },
    {
      id: "broad",
      label: "Broader coverage",
      description: "More skills enabled — higher context, wider help",
      skills: broad,
    },
  ];

  const seen = new Set<string>();
  const options: TaskSkillSetOption[] = [];
  for (const option of raw) {
    if (option.skills.length === 0) {
      continue;
    }
    const key = [...option.skills].sort().join("\0");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    options.push(option);
  }
  return options.slice(0, 3);
}

export function resolveProposalSkillNames(proposals: TaskSkillProposalsFile): string[] {
  const limits = readTaskFocusLimits();
  const filtered = filterProposalsByMinConfidence(proposals.proposals, limits.minProposalConfidence);
  const allowed = new Set(filtered.map((p) => p.name));
  const required = new Set(profileInitRequiredSkills());

  if (proposals.selectedOptionId && proposals.options?.length) {
    const selected = proposals.options.find((o) => o.id === proposals.selectedOptionId);
    if (selected?.skills.length) {
      return selected.skills.filter((name) => required.has(name) || allowed.has(name));
    }
  }
  return filtered.map((p) => p.name).filter(Boolean);
}

export function taskSkillSetApprovalPending(proposals: TaskSkillProposalsFile | null): boolean {
  if (!taskSkillSetApprovalEnabled() || !proposals) {
    return false;
  }
  return proposals.approvalStatus === "pending" && (proposals.options?.length ?? 0) > 0;
}

/** Apply a user-approved option and sync the flat proposals list for hooks/agents. */
export function selectTaskSkillSetOption(target: string, optionId: string): TaskSkillProposalsFile | null {
  const file = readTaskSkillProposals(target);
  if (!file?.options?.length) {
    return null;
  }
  const option = file.options.find((o) => o.id === optionId);
  if (!option) {
    return null;
  }
  const byName = new Map(file.proposals.map((p) => [p.name, p] as const));
  const installed = new Set(listInstalledSkillNames(target));
  const limits = readTaskFocusLimits();
  const allowed = new Set(
    filterProposalsByMinConfidence(file.proposals, limits.minProposalConfidence).map((p) => p.name)
  );
  const required = new Set(profileInitRequiredSkills());
  const updatedProposals = option.skills
    .filter((name) => required.has(name) || allowed.has(name))
    .map(
      (name) =>
        byName.get(name) ?? {
          name,
          reason: option.description,
          confidence: 50,
          installed: installed.has(name),
        }
    );
  const next: TaskSkillProposalsFile = {
    ...file,
    proposals: updatedProposals,
    selectedOptionId: optionId,
    approvalStatus: "approved",
  };
  writeTaskSkillProposals(target, next);
  return next;
}

export function markTaskSkillSetSkipped(target: string): void {
  const file = readTaskSkillProposals(target);
  if (!file) {
    return;
  }
  writeTaskSkillProposals(target, { ...file, approvalStatus: "skipped" });
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
