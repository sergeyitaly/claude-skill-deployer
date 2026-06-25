/**
 * Prompt Intelligence Engine
 *
 * Analyzes user prompts for quality across 9 dimensions, detects anti-patterns,
 * generates coaching recommendations, and produces improved prompt rewrites —
 * all without any additional API calls (pure heuristic, runs in-process).
 */
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const HISTORY_REL = path.join(".claude", "learning", "prompt-intelligence.jsonl");
const MAX_HISTORY_RECORDS = 500;

export function promptIntelligencePath(target: string): string {
  return path.join(target, HISTORY_REL);
}

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

export interface PromptDimension {
  id: string;
  name: string;
  score: number;       // 0–100
  found: boolean;
  evidence?: string;
  weight: number;      // contribution to overall score
}

export type AntiPatternType =
  | "multi_goal"
  | "no_success_criteria"
  | "no_environment"
  | "no_error_evidence"
  | "vague_request"
  | "mixed_mode"
  | "missing_logs"
  | "excessive_length"
  | "no_constraints";

export interface PromptAntiPattern {
  type: AntiPatternType;
  severity: "high" | "medium" | "low";
  evidence: string;
  advice: string;
}

export interface ImprovedPrompt {
  concise: string;
  troubleshooting: string;
  expert: string;
}

export interface PromptQualityResult {
  ts: string;
  sessionId: string;
  promptIndex: number;
  score: number;
  length: number;
  goalCount: number;
  dimensions: PromptDimension[];
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];
  antiPatterns: PromptAntiPattern[];
  improved: ImprovedPrompt;
}

// ---------------------------------------------------------------------------
// Dimension detectors
// ---------------------------------------------------------------------------

const GOAL_VERBS = /\b(fix|implement|create|build|add|remove|update|refactor|debug|analyze|review|explain|generate|migrate|deploy|configure|optimize|test|design|investigate|find|check|help|write|convert|integrate|set up|enable|disable)\b/i;
const ERROR_PATTERNS = /error:|exception:|failed:|failure:|traceback|stack trace|exit code|non-zero|not found|timeout|forbidden|unauthorized|crash|panic|undefined is not|cannot read|typeerror|referenceerror|syntaxerror|\[error\]|\[warn\]/i;
const LOG_PATTERNS  = /\b(log|stdout|stderr|console\.log|kubectl logs|docker logs|journalctl|tail -f|cat .*\.log|output:|print:|debug:)\b|```[\s\S]{20,}```|\[20\d{2}/i;
const CONSTRAINT_PATTERNS = /\b(must|should not|without|only|do not|avoid|keep|ensure|maintain|preserve|no more than|at most|at least|within|limited to|don't)\b/i;
const SUCCESS_PATTERNS = /\b(expected|should result|verify|confirmed|working|resolved|so that|in order to|the result should|success criteria|acceptance criteria|done when|complete when)\b/i;
const ENV_PATTERNS = /\b(kubernetes|k8s|aws|azure|gcp|docker|linux|windows|macos|node|python|terraform|helm|kubectl|postgres|mysql|redis|nginx|ubuntu|debian|arm|amd64|x86|production|staging|dev|local|cluster|namespace|region|zone|version \d|v\d+\.\d+)\b/i;
const CONTEXT_PATTERNS = /\b(currently|right now|the issue is|we have|our|this repo|this project|existing|already|before this|previously|the current|in our|the system|the service|the component|the pipeline|the workflow)\b/i;
const OUTPUT_PATTERNS = /\b(return|output|provide|list|show|generate|format|produce|print|display|export|give me|i need|i want|what is|how to|step[s]? to|instructions)\b/i;

function detectGoalCount(text: string): number {
  // Split on common multi-goal connectors between imperative clauses
  const parts = text.split(/\s*(?:,\s*(?:and\s+)?(?:also\s+)?|;\s*|and\s+also\s+|additionally\s*,?\s*|as\s+well\s+as\s+|plus\s+|then\s+(?:also\s+)?)\s*/i);
  const goalParts = parts.filter(p => GOAL_VERBS.test(p.trim().slice(0, 60)));
  return Math.max(1, goalParts.length);
}

function scoreDimension(id: string, name: string, pattern: RegExp, text: string, weight: number): PromptDimension {
  const match = text.match(pattern);
  const found = !!match;
  const evidence = match ? match[0].slice(0, 60) : undefined;
  return { id, name, score: found ? 100 : 0, found, evidence, weight };
}

function scoreGoalDimension(text: string): PromptDimension {
  const goalCount = detectGoalCount(text);
  const found = GOAL_VERBS.test(text) && goalCount === 1;
  const score = found ? 100 : goalCount > 3 ? 10 : goalCount > 1 ? 40 : GOAL_VERBS.test(text) ? 70 : 30;
  return { id: "goal", name: "Goal defined", score, found: goalCount === 1, evidence: `${goalCount} goal(s) detected`, weight: 20 };
}

// ---------------------------------------------------------------------------
// Anti-pattern detector
// ---------------------------------------------------------------------------

function detectAntiPatterns(text: string, goalCount: number, dimensions: PromptDimension[]): PromptAntiPattern[] {
  const patterns: PromptAntiPattern[] = [];
  const lower = text.toLowerCase();

  if (goalCount > 3) {
    patterns.push({
      type: "multi_goal",
      severity: "high",
      evidence: `${goalCount} separate goals detected in one prompt`,
      advice: `Split into ${goalCount} separate prompts, one per goal. Start with the highest-priority item.`,
    });
  } else if (goalCount > 1) {
    patterns.push({
      type: "multi_goal",
      severity: "medium",
      evidence: `${goalCount} goals in one prompt`,
      advice: "Address one goal at a time for clearer AI responses and easier verification.",
    });
  }

  if (!dimensions.find(d => d.id === "success")?.found) {
    patterns.push({
      type: "no_success_criteria",
      severity: "medium",
      evidence: "No success criteria or expected outcome specified",
      advice: 'Add "Expected result: ..." or "Done when: ..." to let the AI know when to stop.',
    });
  }

  if (!dimensions.find(d => d.id === "env")?.found && /\b(fix|debug|deploy|configure|install|run|start|build)\b/i.test(text)) {
    patterns.push({
      type: "no_environment",
      severity: "medium",
      evidence: "No environment/platform context detected",
      advice: "Specify OS, cloud provider, tool version, or cluster name so the AI gives platform-specific advice.",
    });
  }

  if (!dimensions.find(d => d.id === "error")?.found && /\b(fix|debug|broken|failing|not working|issue|problem|error)\b/i.test(text)) {
    patterns.push({
      type: "no_error_evidence",
      severity: "high",
      evidence: "Debugging requested but no error message/trace provided",
      advice: "Paste the exact error message, stack trace, or exit code. AI accuracy jumps significantly with concrete evidence.",
    });
  }

  if (!dimensions.find(d => d.id === "logs")?.found && /\b(fix|debug|investigate|logs?|diagnose)\b/i.test(text)) {
    patterns.push({
      type: "missing_logs",
      severity: "medium",
      evidence: "No log output or command output provided",
      advice: 'Include relevant log lines with `kubectl logs`, `docker logs`, or `cat /var/log/...` output.',
    });
  }

  // Vague request: short text with no concrete artifact
  if (text.trim().length < 80 && !/\b(error|file|function|module|service|api|endpoint|config|yaml|json|terraform|dockerfile)\b/i.test(text)) {
    patterns.push({
      type: "vague_request",
      severity: "low",
      evidence: `Prompt is very short (${text.trim().length} chars) with no specific artifact referenced`,
      advice: "Name the specific file, service, or component. Short vague prompts lead to generic responses.",
    });
  }

  // Mixed architecture + troubleshooting
  const archTokens = (lower.match(/\b(design|architect|plan|roadmap|strategy|approach|proposal|compare)\b/g) ?? []).length;
  const debugTokens = (lower.match(/\b(fix|debug|error|broken|failing|crash|diagnose)\b/g) ?? []).length;
  if (archTokens >= 1 && debugTokens >= 1) {
    patterns.push({
      type: "mixed_mode",
      severity: "medium",
      evidence: "Mix of architecture/design and debugging/troubleshooting detected",
      advice: "Separate strategic design questions from tactical debugging. Each needs a different AI context.",
    });
  }

  if (text.trim().length > 2000) {
    patterns.push({
      type: "excessive_length",
      severity: "low",
      evidence: `Prompt is ${text.trim().length} characters — context overhead increases cost`,
      advice: "Extract only the critical context. Link to files instead of pasting full content.",
    });
  }

  return patterns;
}

// ---------------------------------------------------------------------------
// Main analyzer
// ---------------------------------------------------------------------------

export function analyzePrompt(
  text: string,
  sessionId = "",
  promptIndex = 0
): PromptQualityResult {
  const goalCount = detectGoalCount(text);

  const dimensions: PromptDimension[] = [
    scoreGoalDimension(text),
    scoreDimension("context",  "Context provided",       CONTEXT_PATTERNS, text, 10),
    scoreDimension("error",    "Error evidence included", ERROR_PATTERNS,   text, 15),
    scoreDimension("constraint","Constraints included",   CONSTRAINT_PATTERNS, text, 8),
    scoreDimension("success",  "Success criteria",       SUCCESS_PATTERNS,  text, 12),
    scoreDimension("env",      "Environment specified",  ENV_PATTERNS,      text, 12),
    scoreDimension("logs",     "Logs/output included",   LOG_PATTERNS,      text, 10),
    scoreDimension("output",   "Expected output stated", OUTPUT_PATTERNS,   text,  8),
    scoreDimension("context2", "Task scope focused",     GOAL_VERBS,        text,  5),
  ];

  // Weighted score
  const totalWeight = dimensions.reduce((s, d) => s + d.weight, 0);
  const rawScore = dimensions.reduce((s, d) => s + d.score * d.weight, 0) / totalWeight;
  // Penalise multi-goal prompts directly
  const goalPenalty = Math.max(0, (goalCount - 1) * 8);
  const score = Math.max(0, Math.min(100, Math.round(rawScore - goalPenalty)));

  const strengths = dimensions.filter(d => d.found).map(d => d.name);
  const weaknesses = dimensions.filter(d => !d.found).map(d => d.name);

  const antiPatterns = detectAntiPatterns(text, goalCount, dimensions);

  // Ordered recommendations — most impactful first
  const recommendations: string[] = [];
  if (goalCount > 1) recommendations.push(`Break into ${goalCount} separate prompts — one goal per message.`);
  if (!dimensions.find(d => d.id === "error")?.found && antiPatterns.some(a => a.type === "no_error_evidence"))
    recommendations.push("Include the exact error message or stack trace.");
  if (!dimensions.find(d => d.id === "env")?.found)
    recommendations.push("Specify the environment (OS, cloud, tool version, cluster).");
  if (!dimensions.find(d => d.id === "success")?.found)
    recommendations.push('Add a success criterion: "Expected: ..." or "Done when: ..."');
  if (!dimensions.find(d => d.id === "logs")?.found && /\b(debug|fix|investigate)\b/i.test(text))
    recommendations.push("Paste relevant log output or command results.");
  if (!dimensions.find(d => d.id === "constraint")?.found)
    recommendations.push("State any constraints (no breaking changes, keep under budget, etc.).");

  return {
    ts: new Date().toISOString(),
    sessionId,
    promptIndex,
    score,
    length: text.trim().length,
    goalCount,
    dimensions,
    strengths,
    weaknesses,
    recommendations: recommendations.slice(0, 4),
    antiPatterns,
    improved: generateImprovedPrompts(text, dimensions, antiPatterns),
  };
}

// ---------------------------------------------------------------------------
// Prompt rewriter (Phase 4)
// ---------------------------------------------------------------------------

function extractGoal(text: string): string {
  const match = text.match(/\b(fix|implement|create|build|add|remove|update|debug|analyze|deploy|configure|investigate|find|check|write)\b.{0,80}/i);
  return match ? match[0].trim() : text.slice(0, 80).trim();
}

function extractArtifact(text: string): string {
  const m = text.match(/\b([A-Z][a-zA-Z]*(Operator|Controller|Service|Manager|Handler|Config|Pipeline|Workflow|Deployment|Secret|Pod|Node|Cluster|Stack|Module|Function|API|Endpoint))\b/);
  return m ? m[0] : "";
}

function generateImprovedPrompts(
  original: string,
  dimensions: PromptDimension[],
  antiPatterns: PromptAntiPattern[]
): ImprovedPrompt {
  const goal = extractGoal(original);
  const artifact = extractArtifact(original);
  const hasEnv = dimensions.find(d => d.id === "env")?.found;
  const envHint = hasEnv ? "" : "[Specify: environment/platform/version]";
  const artifactHint = artifact || "[Specify: component/service/file]";

  const concise = [
    `Task: ${goal}`,
    envHint ? `Environment: ${envHint}` : "",
    `Component: ${artifactHint}`,
    `Expected result: [What success looks like]`,
  ].filter(Boolean).join("\n");

  const troubleshooting = [
    `## Problem`,
    `${goal}`,
    ``,
    `## Environment`,
    `${envHint || "[runtime/platform/version]"}`,
    ``,
    `## Current behavior`,
    `[What is happening — paste error/log here]`,
    ``,
    `## Expected behavior`,
    `[What should happen instead]`,
    ``,
    `## What I tried`,
    `[Steps already attempted]`,
    ``,
    `## Request`,
    `1. Root cause analysis`,
    `2. Fix with validation commands`,
    `3. Rollback plan`,
  ].join("\n");

  const expert = [
    `# Task: ${goal}`,
    ``,
    `**Objective:** [Single, specific goal]`,
    `**Artifact:** ${artifactHint}`,
    `**Environment:** ${envHint || "[platform + version]"}`,
    `**Constraints:** [Must not break X / stay within Y / only touch Z]`,
    ``,
    `**Current state:**`,
    `\`\`\``,
    `[Error message / log output / current config]`,
    `\`\`\``,
    ``,
    `**Success criteria:**`,
    `- [ ] [Verifiable outcome 1]`,
    `- [ ] [Verifiable outcome 2]`,
    ``,
    `**Provide:** root cause → fix → validation → rollback`,
  ].join("\n");

  return { concise, troubleshooting, expert };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function appendPromptRecord(target: string, record: PromptQualityResult): void {
  const file = promptIntelligencePath(target);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf-8");
    prunePromptHistory(target, file);
  } catch { /* non-fatal */ }
}

function prunePromptHistory(target: string, file: string): void {
  try {
    const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
    if (lines.length > MAX_HISTORY_RECORDS) {
      fs.writeFileSync(file, lines.slice(-MAX_HISTORY_RECORDS).join("\n") + "\n", "utf-8");
    }
  } catch { /* non-fatal */ }
}

export function readPromptHistory(target: string, daysBack = 30): PromptQualityResult[] {
  const file = promptIntelligencePath(target);
  if (!fs.existsSync(file)) return [];
  const cutoff = Date.now() - daysBack * 86_400_000;
  const records: PromptQualityResult[] = [];
  try {
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as PromptQualityResult;
        if (new Date(r.ts).getTime() >= cutoff) records.push(r);
      } catch { /* skip corrupt */ }
    }
  } catch { /* non-fatal */ }
  return records;
}

// ---------------------------------------------------------------------------
// Aggregated metrics for dashboard (Phase 8)
// ---------------------------------------------------------------------------

export interface PromptIntelligenceMetrics {
  sampledPrompts: number;
  avgScore: number;
  avgGoalCount: number;
  multiGoalPct: number;
  missingErrorPct: number;
  missingEnvPct: number;
  missingSuccessPct: number;
  missingLogsPct: number;
  topAntiPatterns: Array<{ type: AntiPatternType; count: number; pct: number }>;
  scoreHistory: Array<{ date: string; avgScore: number; count: number }>;
  hasData: boolean;
}

export function computePromptMetrics(target: string, daysBack = 14): PromptIntelligenceMetrics {
  const records = readPromptHistory(target, daysBack);
  if (records.length === 0) {
    return {
      sampledPrompts: 0, avgScore: 0, avgGoalCount: 0,
      multiGoalPct: 0, missingErrorPct: 0, missingEnvPct: 0,
      missingSuccessPct: 0, missingLogsPct: 0,
      topAntiPatterns: [], scoreHistory: [], hasData: false,
    };
  }

  const n = records.length;
  const avgScore = Math.round(records.reduce((s, r) => s + r.score, 0) / n);
  const avgGoalCount = Math.round((records.reduce((s, r) => s + r.goalCount, 0) / n) * 10) / 10;
  const multiGoalPct = Math.round(records.filter(r => r.goalCount > 1).length / n * 100);

  const dimMissingPct = (id: string) =>
    Math.round(records.filter(r => !r.dimensions.find(d => d.id === id)?.found).length / n * 100);

  const antiCounts = new Map<AntiPatternType, number>();
  for (const r of records) {
    for (const ap of r.antiPatterns) {
      antiCounts.set(ap.type, (antiCounts.get(ap.type) ?? 0) + 1);
    }
  }
  const topAntiPatterns = [...antiCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([type, count]) => ({ type, count, pct: Math.round(count / n * 100) }));

  // Daily score history
  const byDay = new Map<string, number[]>();
  for (const r of records) {
    const day = r.ts.slice(0, 10);
    const arr = byDay.get(day) ?? [];
    arr.push(r.score);
    byDay.set(day, arr);
  }
  const scoreHistory = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, scores]) => ({
      date,
      avgScore: Math.round(scores.reduce((s, x) => s + x, 0) / scores.length),
      count: scores.length,
    }));

  return {
    sampledPrompts: n, avgScore, avgGoalCount, multiGoalPct,
    missingErrorPct: dimMissingPct("error"),
    missingEnvPct: dimMissingPct("env"),
    missingSuccessPct: dimMissingPct("success"),
    missingLogsPct: dimMissingPct("logs"),
    topAntiPatterns, scoreHistory, hasData: true,
  };
}

// ---------------------------------------------------------------------------
// Dashboard HTML (Phase 8)
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function scoreColor(s: number): string {
  return s >= 70 ? "roi-high" : s >= 45 ? "roi-medium" : "roi-low";
}

function sparkbar(pct: number, color = "var(--vscode-charts-blue,#2196F3)"): string {
  const w = Math.round(Math.min(pct, 100) * 0.8);
  return `<div style="display:inline-block;width:${w}px;height:5px;background:${color};border-radius:2px;vertical-align:middle;margin-left:4px"></div>`;
}

const ANTI_PATTERN_LABELS: Record<AntiPatternType, string> = {
  multi_goal: "Multi-goal prompt",
  no_success_criteria: "Missing success criteria",
  no_environment: "Missing environment",
  no_error_evidence: "Missing error evidence",
  vague_request: "Vague request",
  mixed_mode: "Mixed architecture+debugging",
  missing_logs: "Missing logs/output",
  excessive_length: "Excessive prompt length",
  no_constraints: "No constraints stated",
};

export function formatPromptIntelligencePanelHtml(target: string, daysBack = 14): string {
  const m = computePromptMetrics(target, daysBack);

  if (!m.hasData) {
    return `<div class="panel" style="margin-top:6px">
  <h2 style="margin-top:0">Prompt Intelligence</h2>
  <p class="note">No prompt quality data yet — populates automatically as you work. The hook analyzes each prompt you submit and records quality scores over time.</p>
</div>`;
  }

  const scoreGrade = m.avgScore >= 70 ? "B+" : m.avgScore >= 50 ? "C" : m.avgScore >= 30 ? "D" : "F";

  const scoreTrend = m.scoreHistory.slice(-7).map(d =>
    `<span title="${d.date}: ${d.avgScore}/100 (${d.count} prompt${d.count !== 1 ? "s" : ""})" style="display:inline-block;width:8px;height:${Math.round(d.avgScore * 0.24)}px;background:var(--vscode-charts-blue,#2196F3);margin-right:1px;vertical-align:bottom;border-radius:1px 1px 0 0"></span>`
  ).join("");

  const dimRows = [
    { label: "Goal Clarity",           pct: 100 - m.multiGoalPct,      hint: `${m.multiGoalPct}% multi-goal` },
    { label: "Evidence Quality",        pct: 100 - m.missingErrorPct,   hint: `${m.missingErrorPct}% missing error context` },
    { label: "Environment Context",     pct: 100 - m.missingEnvPct,     hint: `${m.missingEnvPct}% missing env` },
    { label: "Success Criteria Usage",  pct: 100 - m.missingSuccessPct, hint: `${m.missingSuccessPct}% without success criteria` },
    { label: "Log/Output Inclusion",    pct: 100 - m.missingLogsPct,    hint: `${m.missingLogsPct}% missing logs` },
  ].map(row => `<div class="skill-row">
  <div class="skill-head">
    <span>${esc(row.label)}</span>
    <span class="cost ${scoreColor(row.pct)}">${row.pct}%</span>
    ${sparkbar(row.pct)}
  </div>
  <div class="hint">${esc(row.hint)}</div>
</div>`).join("");

  const antiRows = m.topAntiPatterns.map(ap => `<div class="skill-row">
  <div class="skill-head">
    <b>${esc(ANTI_PATTERN_LABELS[ap.type] ?? ap.type)}</b>
    <span class="cost roi-low">${ap.pct}% of prompts</span>
    ${sparkbar(ap.pct, "var(--vscode-charts-red,#F44336)")}
  </div>
</div>`).join("") || `<p class="note">No significant anti-patterns detected.</p>`;

  return `<div class="panel" style="margin-top:6px">
  <h2 style="margin-top:0">Prompt Intelligence · ${daysBack}d</h2>
  <div class="stat-grid" style="margin-bottom:10px">
    <div class="stat-pill" title="Average prompt quality score across sampled prompts">
      <b>Avg Quality</b>
      <span class="val ${scoreColor(m.avgScore)}">${m.avgScore}/100 (${scoreGrade})</span>
    </div>
    <div class="stat-pill"><b>Sampled</b><span class="val">${m.sampledPrompts}</span></div>
    <div class="stat-pill" title="Average number of goals per prompt"><b>Avg Goals/Prompt</b><span class="val ${m.avgGoalCount > 1.5 ? "roi-low" : "roi-high"}">${m.avgGoalCount}</span></div>
    <div class="stat-pill" title="Prompts with more than one goal"><b>Multi-goal</b><span class="val ${m.multiGoalPct > 30 ? "roi-low" : m.multiGoalPct > 15 ? "roi-medium" : "roi-high"}">${m.multiGoalPct}%</span></div>
  </div>

  <div style="margin-bottom:8px">
    <p class="note" style="margin-bottom:4px;font-weight:600">Quality trend · last 7 days</p>
    <div style="display:flex;align-items:flex-end;height:28px;gap:0;padding:0 2px">${scoreTrend}</div>
  </div>

  <details open style="margin-bottom:8px">
    <summary style="cursor:pointer;font-size:12px;font-weight:600">Prompt Quality Dimensions</summary>
    <div style="margin-top:6px">${dimRows}</div>
  </details>

  <details style="margin-bottom:8px">
    <summary style="cursor:pointer;font-size:12px;font-weight:600">Top Anti-Patterns Detected</summary>
    <div style="margin-top:6px">${antiRows}</div>
  </details>

  <p class="note" style="margin-top:4px">Scores are heuristic — based on structural signals in prompts, not semantic evaluation. Target: ≥70 average.</p>
</div>`;
}
