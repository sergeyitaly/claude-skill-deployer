/**
 * HACE Coaching Engine (Phase 3 + Phase 9)
 *
 * Converts raw HACE scores into actionable, prioritised coaching advice.
 * Each weak metric gets: why it's low, concrete steps to improve it,
 * and an estimated point gain — so users see HACE as a lever they control,
 * not a passive score.
 *
 * Phase 9 — Productivity Impact Simulation: projects what total HACE gain
 * the user could realise by following the top N recommendations.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { readPromptHistory, PromptIntelligenceMetrics, computePromptMetrics } from "./promptIntelligence";

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

export type CoachingMetric =
  | "promptClarity"
  | "taskVelocity"
  | "accuracyRate"
  | "resolutionVelocity"
  | "skillLeverage"
  | "cliEfficiency";

export interface CoachingRule {
  metric: CoachingMetric;
  label: string;
  score: number;
  threshold: number;
  grade: "critical" | "poor" | "fair";
  why: string[];
  advice: string[];
  estimatedGain: number;        // approximate HACE points this metric could add
  compositeWeight: number;      // metric's weight in the HACE composite (%)
  priority: number;             // 1 = highest
}

export interface HaceCoachingReport {
  overallScore: number;
  grade: string;
  activeRules: CoachingRule[];
  topRecommendation: string | null;
  /** Phase 9: projected HACE gain if top 3 recommendations followed */
  projectedGain: number;
  projectedScore: number;
  behaviorInsights: string[];
}

// ---------------------------------------------------------------------------
// Coaching rule definitions
// ---------------------------------------------------------------------------

function makeRule(
  metric: CoachingMetric,
  label: string,
  score: number,
  threshold: number,
  compositeWeight: number,
  priority: number,
  lowWhy: string[],
  lowAdvice: string[],
  fairWhy: string[],
  fairAdvice: string[]
): CoachingRule | null {
  if (score >= threshold) return null;

  const grade: CoachingRule["grade"] = score < threshold * 0.4 ? "critical" : score < threshold * 0.7 ? "poor" : "fair";
  const estimatedGain = Math.round((threshold - score) * compositeWeight / 100 * 0.6);

  const [why, advice] = grade === "fair" ? [fairWhy, fairAdvice] : [lowWhy, lowAdvice];

  return { metric, label, score, threshold, grade, why, advice, estimatedGain, compositeWeight, priority };
}

export function buildCoachingRules(h: {
  promptClarityScore: number;
  taskVelocityScore: number;
  accuracyScore: number;
  resolutionVelocityScore: number;
  skillLeverageScore: number;
  cliEfficiencyScore: number;
}, promptMetrics?: PromptIntelligenceMetrics): CoachingRule[] {
  const rules: Array<CoachingRule | null> = [

    makeRule(
      "promptClarity", "Prompt Clarity",
      h.promptClarityScore, 65, 25, 1,
      /* critical why */ [
        "91%+ of turns trigger extended thinking blocks — indicates vague or multi-goal prompts",
        "AI needs to reason extensively to interpret what you want",
        promptMetrics?.multiGoalPct && promptMetrics.multiGoalPct > 20
          ? `${promptMetrics.multiGoalPct}% of your prompts contain multiple goals`
          : "Prompts likely contain multiple goals or lack constraints",
        "Missing error evidence in debugging requests causes the AI to speculate",
      ],
      /* critical advice */ [
        "One objective per prompt — split multi-goal requests before submitting",
        "Start prompts with a single action verb: Fix / Implement / Analyze / Generate",
        "Include the exact error message or log output for debugging requests",
        "State success criteria: 'Done when: ...' at the end of every prompt",
        "Use a Prompt Template (see template library) for structured requests",
      ],
      /* fair why */ [
        "Some turns trigger extended thinking — a few prompts are still multi-goal or vague",
        "Occasional missing context causes unnecessary AI reasoning cycles",
      ],
      /* fair advice */ [
        "Review your last 3 prompts — identify any that had multiple goals",
        "Add environment context (OS, platform, version) to technical prompts",
        "Include 'Expected: ...' at the end of implementation requests",
      ]
    ),

    makeRule(
      "taskVelocity", "Task Velocity",
      h.taskVelocityScore, 60, 20, 2,
      [
        "Very low turns/minute of active work — likely caused by large, slow-to-answer prompts",
        "Excessive corrections force the AI to redo work, consuming time and tokens",
        "Large context windows slow each response significantly",
        "Multi-topic sessions dilute focus and increase response latency",
      ],
      [
        "Use /clear between unrelated tasks to reset context and speed up responses",
        "Break large tasks into sub-tasks — submit one at a time",
        "Invoke relevant skills at the start of a task (reduces exploration overhead)",
        "Keep sessions under 30 minutes of active work — create a new session for new topics",
        "Provide file paths explicitly — don't ask the AI to search for them",
      ],
      [
        "Active work pace is below target — some sessions are sprawling across multiple topics",
        "Occasional large context windows are slowing individual responses",
      ],
      [
        "Use /clear when switching from one feature to another",
        "For file-heavy tasks, provide exact paths rather than descriptions",
      ]
    ),

    makeRule(
      "accuracyRate", "Accuracy Rate",
      h.accuracyScore, 70, 20, 3,
      [
        "High correction rate (>30%) — short re-prompts after long AI responses signal frequent misalignment",
        "AI is misunderstanding intent, producing output that needs significant revision",
        "Prompts may lack enough specificity for the AI to get it right first time",
      ],
      [
        "Specify exactly what you want changed vs what should stay the same",
        "For code tasks: name the function, file, and expected signature",
        "For content tasks: provide an example of the desired output format",
        "After a wrong answer, correct with: 'No — the issue is X. Try: ...' with full context",
        "Use success criteria so the AI self-checks before responding",
      ],
      [
        "Some corrections needed — prompts occasionally lack enough specificity",
        "A few responses required follow-up adjustments",
      ],
      [
        "Include 'keep everything else unchanged' when making targeted edits",
        "For refactors: specify which patterns to apply and which to avoid",
      ]
    ),

    makeRule(
      "resolutionVelocity", "Resolution Velocity",
      h.resolutionVelocityScore, 50, 10, 4,
      [
        "Active session duration significantly exceeds the 30-minute target",
        "Long sessions often indicate multi-topic work, repeated troubleshooting loops, or context buildup",
        "Extended sessions accumulate correction overhead and increase cost per resolved task",
      ],
      [
        "Create task-focused sessions: one session = one goal",
        "Use /clear to start fresh when pivoting to a different problem",
        "If stuck after 3 attempts, take a different approach rather than repeating the same prompt",
        "Break investigations into: Diagnose → Root cause → Fix — each as its own prompt",
        "Timebox troubleshooting: if unresolved after 20 min active, add more evidence and retry",
      ],
      [
        "Sessions slightly exceed target duration — some multi-topic work detected",
        "A few extended troubleshooting loops could be broken into focused sub-sessions",
      ],
      [
        "When switching topics, use /clear to start a focused session",
        "Set a mental 30-minute timer per task goal",
      ]
    ),

    makeRule(
      "skillLeverage", "Skill Leverage",
      h.skillLeverageScore, 40, 10, 5,
      [
        "0-3% of sessions include a skill invocation — you are leaving structured AI tooling unused",
        "Skills encode domain-specific workflows that dramatically reduce prompt length and correction rate",
        "Ignoring skill recommendations means repeating context the AI already has in skill files",
      ],
      [
        "When you see a skill recommendation, invoke it before asking the AI to explore manually",
        "Use vitest-extension-testing for any test/bench work in this repo",
        "Use github-actions-ci when editing workflow files",
        "Use vscode-extension-publishing before packaging or publishing",
        "Invoking a skill once per session is enough — the structured context persists",
      ],
      [
        "Skill invocations are infrequent — most sessions still rely on unstructured prompts",
        "Some recommended skills are being ignored",
      ],
      [
        "Try invoking one recommended skill per session this week to build the habit",
        "Check the proposal panel — skills at ≥60% confidence are high-signal recommendations",
      ]
    ),

    makeRule(
      "cliEfficiency", "CLI Efficiency",
      h.cliEfficiencyScore, 80, 15, 6,
      [
        "CLI failures (non-zero exit codes) detected — indicates credential, path, or config issues",
        "Failed commands that are blindly retried waste context and increase session length",
        "AI may be using wrong flags or stale assumptions about your environment",
      ],
      [
        "After a CLI failure, correct the command explicitly: 'The error is X, the correct flag is Y'",
        "Check credentials and environment variables before running cloud CLI commands",
        "Provide the full command + error output when asking the AI to fix a CLI issue",
        "Use dry-run flags (--dry-run, --plan, --what-if) before destructive commands",
      ],
      [
        "Occasional CLI failures reducing efficiency slightly",
        "A few commands needed correction before succeeding",
      ],
      [
        "Add --dry-run or similar flags for commands you are unsure about",
        "Paste the exact failure output when asking for CLI help",
      ]
    ),
  ];

  return rules
    .filter((r): r is CoachingRule => r !== null)
    .sort((a, b) => a.priority - b.priority || b.estimatedGain - a.estimatedGain);
}

// ---------------------------------------------------------------------------
// Main coaching report builder
// ---------------------------------------------------------------------------

export function buildCoachingReport(
  target: string,
  h: {
    haceScore: number;
    grade: string;
    promptClarityScore: number;
    taskVelocityScore: number;
    accuracyScore: number;
    resolutionVelocityScore: number;
    skillLeverageScore: number;
    cliEfficiencyScore: number;
    noData?: boolean;
  }
): HaceCoachingReport {
  const promptMetrics = computePromptMetrics(target, 14);
  const activeRules = buildCoachingRules(h, promptMetrics);

  // Top recommendation: highest-priority rule's first advice item
  const topRecommendation = activeRules[0]?.advice[0] ?? null;

  // Phase 9: project gain from following top 3 rules
  const topGain = activeRules.slice(0, 3).reduce((s, r) => s + r.estimatedGain, 0);
  const projectedScore = Math.min(100, h.haceScore + topGain);

  // Behavior insights from prompt history
  const behaviorInsights = buildBehaviorInsights(promptMetrics);

  return {
    overallScore: h.haceScore,
    grade: h.grade,
    activeRules,
    topRecommendation,
    projectedGain: topGain,
    projectedScore,
    behaviorInsights,
  };
}

function buildBehaviorInsights(m: PromptIntelligenceMetrics): string[] {
  if (!m.hasData) return [];
  const insights: string[] = [];

  if (m.multiGoalPct > 30) insights.push(`${m.multiGoalPct}% of prompts contain multiple goals — the single largest efficiency drain`);
  if (m.missingErrorPct > 40) insights.push(`${m.missingErrorPct}% of debugging prompts lack error evidence — causes speculative AI responses`);
  if (m.missingEnvPct > 50) insights.push(`${m.missingEnvPct}% of prompts omit environment context — forces the AI to ask follow-ups`);
  if (m.missingSuccessPct > 60) insights.push(`${m.missingSuccessPct}% of prompts have no success criteria — AI response quality is harder to verify`);
  if (m.missingLogsPct > 50) insights.push(`${m.missingLogsPct}% of investigation prompts lack log output`);
  if (m.avgScore < 40) insights.push(`Avg prompt quality ${m.avgScore}/100 — significant room for improvement through structured templates`);
  else if (m.avgScore >= 65) insights.push(`Avg prompt quality ${m.avgScore}/100 — strong baseline, focus on success criteria and error evidence`);

  return insights.slice(0, 4);
}

// ---------------------------------------------------------------------------
// Dashboard HTML
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const GRADE_COLOR: Record<CoachingRule["grade"], string> = {
  critical: "var(--vscode-charts-red,#F44336)",
  poor:     "var(--vscode-charts-yellow,#FFC107)",
  fair:     "var(--vscode-descriptionForeground)",
};

export function formatCoachingReportHtml(report: HaceCoachingReport): string {
  if (report.activeRules.length === 0) {
    return `<div class="panel" style="margin-top:6px">
  <h2 style="margin-top:0">HACE Coaching</h2>
  <p class="note" style="color:var(--vscode-charts-green,#4CAF50)">All metrics within target ranges — no active coaching rules. Keep it up.</p>
</div>`;
  }

  const projectionHtml = report.projectedGain > 0
    ? `<div class="skill-row" style="margin-bottom:10px;padding:6px;border-left:3px solid var(--vscode-charts-blue,#2196F3)">
  <div class="skill-head"><b>Productivity Impact Simulation</b></div>
  <div class="hint">Following the top ${Math.min(3, report.activeRules.length)} recommendation${report.activeRules.length > 1 ? "s" : ""} could improve HACE by approximately <b>+${report.projectedGain} points</b> (${report.overallScore} → ${report.projectedScore}/100).</div>
</div>`
    : "";

  const insightHtml = report.behaviorInsights.length > 0
    ? `<details style="margin-bottom:8px">
  <summary style="cursor:pointer;font-size:12px;font-weight:600">Behavior Insights from Prompt History</summary>
  <div style="margin-top:6px">${report.behaviorInsights.map(i =>
    `<div class="hint" style="margin-bottom:4px">• ${esc(i)}</div>`
  ).join("")}</div>
</details>` : "";

  const ruleHtml = report.activeRules.map((rule, idx) => {
    const whyItems = rule.why.map(w => `<li style="margin-bottom:3px">${esc(w)}</li>`).join("");
    const adviceItems = rule.advice.map(a => `<li style="margin-bottom:3px">${esc(a)}</li>`).join("");
    return `<details ${idx === 0 ? "open" : ""} style="margin-bottom:8px">
  <summary style="cursor:pointer;font-size:12px;font-weight:600">
    <span style="color:${GRADE_COLOR[rule.grade]};text-transform:uppercase;font-size:10px">${rule.grade}</span>
    &nbsp;<b>${esc(rule.label)}</b>
    <span class="cost roi-low" style="margin-left:4px">${rule.score}%</span>
    <span class="hint" style="margin-left:6px">est. +${rule.estimatedGain} HACE pts if fixed</span>
  </summary>
  <div style="margin-top:8px;padding-left:8px">
    <p class="note" style="font-weight:600;margin-bottom:4px">Why it's low:</p>
    <ul style="margin:0 0 8px;padding-left:16px;font-size:12px">${whyItems}</ul>
    <p class="note" style="font-weight:600;margin-bottom:4px">What to do:</p>
    <ul style="margin:0;padding-left:16px;font-size:12px">${adviceItems}</ul>
  </div>
</details>`;
  }).join("");

  return `<div class="panel" style="margin-top:6px">
  <h2 style="margin-top:0">HACE Coaching · ${report.activeRules.length} active rule${report.activeRules.length !== 1 ? "s" : ""}</h2>
  ${projectionHtml}
  ${insightHtml}
  ${ruleHtml}
</div>`;
}

// ---------------------------------------------------------------------------
// Session-level coaching hint (used by hook session coach)
// ---------------------------------------------------------------------------

export interface SessionCoachHint {
  message: string;
  metric: CoachingMetric;
  priority: number;
}

export function getSessionCoachHints(
  target: string,
  h: Parameters<typeof buildCoachingRules>[0],
  promptText: string
): SessionCoachHint[] {
  const rules = buildCoachingRules(h);
  const hints: SessionCoachHint[] = [];

  for (const rule of rules.slice(0, 3)) {
    let hint: string | null = null;

    switch (rule.metric) {
      case "promptClarity":
        if (/\b(fix|debug|investigate)\b.*\b(and|also|plus)\b/i.test(promptText))
          hint = "Multi-goal prompt detected — consider splitting into one prompt per task for faster, more accurate responses.";
        else if (rule.grade === "critical")
          hint = "Prompt Clarity is low — try starting with one clear action verb and including the exact error message.";
        break;
      case "taskVelocity":
        if (rule.grade === "critical")
          hint = "Task Velocity is low — use /clear to start a focused session, or invoke a skill to shortcut exploration.";
        break;
      case "skillLeverage":
        hint = "Skill Leverage is low — invoking a relevant skill now could save significant context and back-and-forth.";
        break;
      case "resolutionVelocity":
        if (rule.grade === "critical")
          hint = "Sessions are running long — consider narrowing this task to a single goal and using /clear between topics.";
        break;
      case "accuracyRate":
        if (rule.grade !== "fair")
          hint = "High correction rate — try including 'keep everything else unchanged' and exact success criteria in your next prompt.";
        break;
    }

    if (hint) hints.push({ message: hint, metric: rule.metric, priority: rule.priority });
  }

  return hints.slice(0, 2); // max 2 hints from this source (session coach adds its own limit)
}
