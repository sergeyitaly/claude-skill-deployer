/**
 * Adoption Intelligence System
 *
 * Tracks why skills are ignored, measures adoption barriers, enriches proposals
 * with explainability data, and builds a personalized user affinity profile to
 * improve recommendation acceptance from <10% toward the 30-day target of >15%.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { readCachedEnrichedRuns } from "./runsStore";
import { readProposalOutcomes, ProposalOutcomeRecord } from "./proposalOutcome";

// ---------------------------------------------------------------------------
// Benefit estimates by skill category
// ---------------------------------------------------------------------------

const SKILL_BENEFIT_MINUTES: Record<string, number> = {
  // Infrastructure / deployment
  "terraform-plan-review":           20,
  "terraform-module-ops":            25,
  "azure-resource-ops":              18,
  "azure-rbac-diagnostics":          15,
  "azure-infra-preflight":           12,
  "infra-cost-guard":                10,
  "deployment-practical":            20,
  "ci-pipeline-debug":               25,
  "ci-preflight":                    12,
  "gitlab-pipeline-ops":             15,
  "github-actions-ci":               15,
  // Testing
  "vitest-extension-testing":         8,
  "webapp-testing":                  12,
  // Data / analytics
  "adx-schema-check":                15,
  // Extension / publishing
  "vscode-extension-publishing":     10,
  "cursor-kiro-extension-publishing": 8,
  "mcp-builder":                     20,
  "mcp-server-creation":             25,
  // Document / content
  "pdf":                              8,
  "docx":                             6,
  "pptx":                             6,
  "xlsx":                             6,
  "doc-coauthoring":                 10,
  // Learning / meta
  "self-learning":                    5,
  "skill-usage-insights":             5,
  "skill-feedback-adaptation":        5,
  "skill-creator":                   10,
  // Scripting
  "cross-platform-scripting":         8,
  // AI
  "claude-api":                      15,
  // Design
  "frontend-design":                 12,
  "canvas-design":                   10,
  "theme-factory":                    8,
  "drawio-diagrams":                 10,
  "web-artifacts-builder":           15,
};

const DEFAULT_BENEFIT_MINUTES = 8;

export function estimateBenefitMinutes(skillName: string): number {
  return SKILL_BENEFIT_MINUTES[skillName] ?? DEFAULT_BENEFIT_MINUTES;
}

// ---------------------------------------------------------------------------
// Skill success score
// ---------------------------------------------------------------------------

export interface SkillAdoptionStats {
  skillName: string;
  proposedCount: number;
  invokedCount: number;
  successCount: number;
  /** How many distinct sessions the skill was used in */
  reuseCount: number;
  acceptanceRate: number;   // invokedCount / proposedCount; -1 = no proposal history
  successRate: number;      // successCount / invokedCount; -1 = no invocations
  reuseRate: number;        // reuseCount / invokedCount (loyalty); -1 = no invocations
  /** Composite 0–100 score weighting acceptance (50%) + success (30%) + reuse (20%) */
  successScore: number;
  estimatedMinutesSaved: number;
  totalMinutesSaved: number;
  trend: "rising" | "stable" | "declining" | "new" | "dormant";
}

function computeTrend(
  recent: number,   // invocations in last 7d
  older: number,    // invocations in prior 7d
  acceptanceRate: number,
  proposedCount: number
): SkillAdoptionStats["trend"] {
  if (proposedCount === 0 && recent === 0) return "new";
  if (proposedCount >= 5 && acceptanceRate < 0.05) return "dormant";
  if (recent > older * 1.5) return "rising";
  if (older > recent * 1.5) return "declining";
  return "stable";
}

export function computeSkillAdoptionStats(
  target: string,
  skillName: string
): SkillAdoptionStats {
  const outcomes = readProposalOutcomes(target);
  let proposedCount = 0;
  let invokedCount = 0;

  for (const o of outcomes) {
    if (o.event !== "session_end") continue;
    if (o.proposed?.includes(skillName)) proposedCount++;
    if (o.invoked?.includes(skillName)) invokedCount++;
  }

  const now = Date.now();
  const cutoff7  = now - 7  * 86_400_000;
  const cutoff14 = now - 14 * 86_400_000;

  const runs = readCachedEnrichedRuns(target).filter(r => r.skill === skillName);
  const successCount = runs.filter(r => r.success).length;
  const sessionIds = new Set(runs.map(r => r.session_id).filter(Boolean));
  const reuseCount = sessionIds.size;

  const recentRuns = runs.filter(r => new Date(r.ts).getTime() >= cutoff7).length;
  const olderRuns  = runs.filter(r => {
    const t = new Date(r.ts).getTime();
    return t >= cutoff14 && t < cutoff7;
  }).length;

  const acceptanceRate = proposedCount > 0 ? invokedCount / proposedCount : -1;
  const successRate    = invokedCount  > 0 ? successCount / invokedCount  : -1;
  const reuseRate      = invokedCount  > 0 ? reuseCount   / invokedCount  : -1;

  const aScore = acceptanceRate >= 0 ? acceptanceRate * 100 : 0;
  const sScore = successRate    >= 0 ? successRate    * 100 : 50; // neutral when unknown
  const rScore = reuseRate      >= 0 ? Math.min(reuseRate * 100, 100) : 0;
  const successScore = Math.round(aScore * 0.50 + sScore * 0.30 + rScore * 0.20);

  const estimatedMinutesSaved = estimateBenefitMinutes(skillName);
  const totalMinutesSaved = runs.length * estimatedMinutesSaved;

  return {
    skillName, proposedCount, invokedCount, successCount, reuseCount,
    acceptanceRate, successRate, reuseRate, successScore,
    estimatedMinutesSaved, totalMinutesSaved,
    trend: computeTrend(recentRuns, olderRuns, acceptanceRate < 0 ? 0 : acceptanceRate, proposedCount),
  };
}

// ---------------------------------------------------------------------------
// Proposal enrichment
// ---------------------------------------------------------------------------

export interface EnrichedProposal {
  name: string;
  confidence: number;
  reason: string;
  /** One-liner for why this skill was surfaced, human-readable */
  whyText: string;
  /** Estimated developer time saved per invocation (minutes) */
  estimatedMinutes: number;
  acceptanceRate: number;
  successRate: number;
  reuseRate: number;
  /** Sessions where this skill was used (loyalty indicator) */
  reuseCount: number;
  successScore: number;
  trend: SkillAdoptionStats["trend"];
  /** Total estimated minutes saved across all invocations (historical ROI) */
  totalMinutesSaved: number;
  /** Number of times invoked */
  invokedCount: number;
}

export function enrichProposal(
  target: string,
  name: string,
  confidence: number,
  reason: string
): EnrichedProposal {
  const stats = computeSkillAdoptionStats(target, name);
  const minutes = estimateBenefitMinutes(name);

  const parts: string[] = [];
  if (stats.acceptanceRate >= 0) {
    parts.push(`${Math.round(stats.acceptanceRate * 100)}% acceptance`);
  }
  // Show success rate with 1+ invocation (not just ≥3) — flag low-sample cases with ~
  if (stats.successRate >= 0 && stats.invokedCount >= 1) {
    const prefix = stats.invokedCount < 3 ? "~" : "";
    parts.push(`${prefix}${Math.round(stats.successRate * 100)}% success`);
  }
  if (stats.invokedCount > 0) {
    parts.push(`used ${stats.invokedCount}×`);
  }
  if (stats.reuseCount > 1) {
    parts.push(`${stats.reuseCount} sessions`);
  }
  if (stats.totalMinutesSaved > 0) {
    const saved = stats.totalMinutesSaved >= 60
      ? `~${Math.round(stats.totalMinutesSaved / 60 * 10) / 10}h saved`
      : `~${stats.totalMinutesSaved}min saved`;
    parts.push(saved);
  }
  const reasonCleaned = reason
    .replace(/Workspace files match /, "detected: ")
    .replace(/repo stack match \([^)]+\)/, "repo stack match");
  const whyText = parts.length > 0
    ? `${reasonCleaned} · ${parts.join(" · ")}`
    : reasonCleaned;

  return {
    name, confidence, reason, whyText, estimatedMinutes: minutes,
    acceptanceRate: stats.acceptanceRate,
    successRate: stats.successRate,
    reuseRate: stats.reuseRate,
    reuseCount: stats.reuseCount,
    successScore: stats.successScore,
    trend: stats.trend,
    totalMinutesSaved: stats.totalMinutesSaved,
    invokedCount: stats.invokedCount,
  };
}

// ---------------------------------------------------------------------------
// Aggregate adoption metrics
// ---------------------------------------------------------------------------

export interface AdoptionMetrics {
  sessionsAnalyzed: number;
  totalProposed: number;
  totalInvoked: number;
  totalSucceeded: number;
  acceptanceRatePct: number;
  precisionPct: number;
  recallPct: number;
  f1Pct: number;
  totalMinutesSaved: number;
  topAdopted: SkillAdoptionStats[];
  topRejected: SkillAdoptionStats[];
  dormantSkills: string[];
  risingSkills: string[];
  affinityAreas: string[];
  hasData: boolean;
}

export function computeAdoptionMetrics(target: string): AdoptionMetrics {
  const outcomes = readProposalOutcomes(target);
  if (outcomes.length === 0) {
    return {
      sessionsAnalyzed: 0, totalProposed: 0, totalInvoked: 0, totalSucceeded: 0,
      acceptanceRatePct: 0, precisionPct: 0, recallPct: 0, f1Pct: 0,
      totalMinutesSaved: 0, topAdopted: [], topRejected: [], dormantSkills: [],
      risingSkills: [], affinityAreas: [], hasData: false,
    };
  }

  // Aggregate per-skill stats
  const allSkills = new Set<string>();
  let totalProposed = 0;
  let totalInvoked = 0;

  for (const o of outcomes) {
    if (o.event !== "session_end") continue;
    totalProposed += o.skills_proposed_count ?? 0;
    totalInvoked  += o.skills_invoked_count  ?? 0;
    for (const s of o.proposed ?? []) allSkills.add(s);
    for (const s of o.invoked  ?? []) allSkills.add(s);
  }

  const runs = readCachedEnrichedRuns(target);
  const totalSucceeded = runs.filter(r => r.success && r.metadata?.invoked).length;

  // Acceptance rate: session-level aggregate — invocations / total proposals across all sessions.
  const acceptanceRatePct = totalProposed > 0 ? Math.round((totalInvoked / totalProposed) * 100) : 0;

  // Precision: skill-level — of the UNIQUE skills ever proposed, what fraction was ever invoked?
  // This is deliberately different from acceptanceRatePct (which double-counts per-session proposals).
  // Example: skill A proposed 8× and invoked 1× → acceptanceRate=12%, but precision counts A only once.
  const usedSet = new Set(runs.map(r => r.skill));
  const proposedSet = new Set(outcomes.flatMap(o => o.proposed ?? []));
  const uniqueInvokedFromProposed = [...proposedSet].filter(s => usedSet.has(s)).length;

  const precisionPct = proposedSet.size > 0
    ? Math.round((uniqueInvokedFromProposed / proposedSet.size) * 100) : 0;

  // Recall: of all skills actually used, what fraction was proposed first?
  const invokedFromProposed = [...usedSet].filter(s => proposedSet.has(s)).length;
  const recallPct = usedSet.size > 0
    ? Math.round((invokedFromProposed / usedSet.size) * 100) : 0;
  const f1Pct = (precisionPct + recallPct) > 0
    ? Math.round(2 * precisionPct * recallPct / (precisionPct + recallPct)) : 0;

  const skillStats: SkillAdoptionStats[] = [...allSkills].map(s =>
    computeSkillAdoptionStats(target, s)
  );

  const topAdopted = [...skillStats]
    .filter(s => s.invokedCount > 0)
    .sort((a, b) => b.successScore - a.successScore)
    .slice(0, 5);

  const topRejected = [...skillStats]
    .filter(s => s.proposedCount >= 2 && s.invokedCount === 0)
    .sort((a, b) => b.proposedCount - a.proposedCount)
    .slice(0, 5);

  const dormantSkills = skillStats
    .filter(s => s.trend === "dormant")
    .map(s => s.skillName);

  const risingSkills = skillStats
    .filter(s => s.trend === "rising")
    .map(s => s.skillName);

  const totalMinutesSaved = skillStats.reduce((sum, s) => sum + s.totalMinutesSaved, 0);

  // Affinity areas: inferred from frequently used skills
  const affinityAreas = buildAffinityAreas(runs.map(r => r.skill));

  return {
    sessionsAnalyzed: outcomes.filter(o => o.event === "session_end").length,
    totalProposed, totalInvoked, totalSucceeded,
    acceptanceRatePct, precisionPct, recallPct, f1Pct,
    totalMinutesSaved, topAdopted, topRejected, dormantSkills, risingSkills,
    affinityAreas, hasData: true,
  };
}

// ---------------------------------------------------------------------------
// User affinity profile
// ---------------------------------------------------------------------------

const SKILL_AREA_MAP: Record<string, string> = {
  "terraform-plan-review": "Infrastructure",    "terraform-module-ops": "Infrastructure",
  "azure-resource-ops": "Azure",                "azure-rbac-diagnostics": "Azure",
  "azure-infra-preflight": "Azure",             "infra-cost-guard": "Infrastructure",
  "deployment-practical": "DevOps",             "ci-pipeline-debug": "CI/CD",
  "ci-preflight": "CI/CD",                      "gitlab-pipeline-ops": "CI/CD",
  "github-actions-ci": "CI/CD",                 "vitest-extension-testing": "Testing",
  "webapp-testing": "Testing",                  "adx-schema-check": "Data",
  "vscode-extension-publishing": "Publishing",  "cursor-kiro-extension-publishing": "Publishing",
  "mcp-builder": "MCP/SDK",                     "mcp-server-creation": "MCP/SDK",
  "pdf": "Documents",                           "docx": "Documents",
  "pptx": "Documents",                          "xlsx": "Documents",
  "doc-coauthoring": "Documents",               "self-learning": "Meta",
  "skill-usage-insights": "Meta",               "skill-feedback-adaptation": "Meta",
  "skill-creator": "Meta",                      "cross-platform-scripting": "Scripting",
  "claude-api": "AI/SDK",                       "frontend-design": "Frontend",
  "canvas-design": "Design",                    "web-artifacts-builder": "Frontend",
  "drawio-diagrams": "Design",
};

export function buildAffinityAreas(usedSkills: string[]): string[] {
  const counts = new Map<string, number>();
  for (const skill of usedSkills) {
    const area = SKILL_AREA_MAP[skill];
    if (area) counts.set(area, (counts.get(area) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([area]) => area);
}

// ---------------------------------------------------------------------------
// Smart timing — should we surface proposals now?
// ---------------------------------------------------------------------------

export interface ProposalMoment {
  shouldPropose: boolean;
  reason: string;
}

/**
 * Returns whether this is a good moment to surface skill proposals.
 * Avoids proposing on every prompt — waits for meaningful context signals.
 */
export function shouldSurfaceProposals(
  promptText: string,
  sessionProposedCount: number
): ProposalMoment {
  const lower = promptText.toLowerCase();

  // Always propose on first prompt of a session
  if (sessionProposedCount === 0) {
    return { shouldPropose: true, reason: "first prompt of session" };
  }

  // Proposal moments — high-signal contexts
  const moments = [
    { signal: /kubectl|k8s|kubernetes|helm|kube/i,          reason: "Kubernetes operation detected" },
    { signal: /terraform|bicep|pulumi|cdk/i,                reason: "IaC operation detected" },
    { signal: /pipeline|github actions|gitlab ci|ci.cd/i,   reason: "CI/CD work detected" },
    { signal: /error|failed|failing|exception|debug/i,      reason: "debugging session" },
    { signal: /adx|kusto|kql|azure data/i,                  reason: "ADX/Kusto query work" },
    { signal: /publish|release|deploy.*extension|vsix/i,    reason: "extension publishing" },
    { signal: /\.pdf|generate.*pdf|extract.*pdf/i,          reason: "PDF workflow detected" },
  ];

  for (const m of moments) {
    if (m.signal.test(lower)) {
      return { shouldPropose: true, reason: m.reason };
    }
  }

  // After 3 proposals in a session without a signal, back off
  if (sessionProposedCount >= 3) {
    return { shouldPropose: false, reason: "recommendation cooldown (3 proposals this session)" };
  }

  // Default: propose every 2nd prompt to avoid fatigue
  return { shouldPropose: sessionProposedCount % 2 === 0, reason: "periodic refresh" };
}

// ---------------------------------------------------------------------------
// Dashboard HTML
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function trendBadge(trend: SkillAdoptionStats["trend"]): string {
  switch (trend) {
    case "rising":   return `<span style="color:var(--vscode-charts-green,#4CAF50);font-size:10px">▲ rising</span>`;
    case "declining":return `<span style="color:var(--vscode-charts-red,#F44336);font-size:10px">▼ declining</span>`;
    case "dormant":  return `<span style="color:var(--vscode-charts-yellow,#FFC107);font-size:10px">⦾ dormant</span>`;
    case "new":      return `<span style="color:var(--vscode-charts-blue,#2196F3);font-size:10px">★ new</span>`;
    default:         return `<span style="font-size:10px;opacity:.6">● stable</span>`;
  }
}

export function formatAdoptionDashboardHtml(metrics: AdoptionMetrics): string {
  if (!metrics.hasData) {
    return `<div class="panel" style="margin-top:6px">
  <h2 style="margin-top:0">Skill Adoption Intelligence</h2>
  <p class="note">No session outcome data yet — adoption metrics populate after the first session completes with the extension active.</p>
  <p class="note">Target (30d): acceptance &gt;15% · utilization &gt;5% · precision &gt;25%</p>
</div>`;
  }

  const pctClass = (v: number, lo: number, hi: number) =>
    v >= hi ? "roi-high" : v >= lo ? "roi-medium" : "roi-low";

  const summaryGrid = `<div class="stat-grid" style="margin-bottom:10px">
  <div class="stat-pill"><b>Sessions</b><span class="val">${metrics.sessionsAnalyzed}</span></div>
  <div class="stat-pill" title="Skills invoked / skills proposed across all sessions">
    <b>Acceptance</b>
    <span class="val ${pctClass(metrics.acceptanceRatePct, 10, 25)}">${metrics.acceptanceRatePct}%</span>
  </div>
  <div class="stat-pill" title="Of all proposals, what fraction led to invocation">
    <b>Precision</b>
    <span class="val ${pctClass(metrics.precisionPct, 15, 40)}">${metrics.precisionPct > 0 ? metrics.precisionPct + "%" : "—"}</span>
  </div>
  <div class="stat-pill" title="Of all skills actually used, what fraction was proposed first">
    <b>Recall</b>
    <span class="val ${pctClass(metrics.recallPct, 20, 50)}">${metrics.recallPct > 0 ? metrics.recallPct + "%" : "—"}</span>
  </div>
  <div class="stat-pill" title="Harmonic mean of Precision and Recall">
    <b>F1</b>
    <span class="val ${pctClass(metrics.f1Pct, 15, 35)}">${metrics.f1Pct > 0 ? metrics.f1Pct + "%" : "—"}</span>
  </div>
  <div class="stat-pill" title="Estimated total developer time saved by skill invocations">
    <b>Time Saved</b>
    <span class="val roi-high">${metrics.totalMinutesSaved >= 60
      ? `~${Math.round(metrics.totalMinutesSaved / 60 * 10) / 10}h`
      : `~${metrics.totalMinutesSaved}min`}</span>
  </div>
</div>`;

  const funnelRows = [
    { label: "Proposed", value: metrics.totalProposed, pct: 100 },
    { label: "Invoked",  value: metrics.totalInvoked,
      pct: metrics.totalProposed > 0 ? Math.round(metrics.totalInvoked / metrics.totalProposed * 100) : 0 },
    { label: "Succeeded",value: metrics.totalSucceeded,
      pct: metrics.totalInvoked > 0 ? Math.round(metrics.totalSucceeded / metrics.totalInvoked * 100) : 0 },
  ];
  const funnelHtml = funnelRows.map(r =>
    `<div class="skill-row"><div class="skill-head"><b>${r.label}</b>
    <span class="cost">${r.value}</span>
    <span class="bar">${r.pct}%</span>
    <div style="display:inline-block;width:${r.pct * 0.6}px;height:6px;background:var(--vscode-charts-green,#4CAF50);border-radius:2px;vertical-align:middle;margin-left:4px"></div>
    </div></div>`
  ).join("");

  const adoptedRows = metrics.topAdopted.map(s =>
    `<div class="skill-row"><div class="skill-head">
    <b>${esc(s.skillName)}</b>
    ${trendBadge(s.trend)}
    <span class="cost roi-high">${s.successScore}/100</span>
    </div>
    <div class="hint">${s.invokedCount}× invoked · ~${s.totalMinutesSaved}min saved · ${s.acceptanceRate >= 0 ? Math.round(s.acceptanceRate * 100) + "% acceptance" : "no proposal data"}</div>
    </div>`
  ).join("") || `<p class="note">No adopted skills yet — invoke your first skill to start tracking.</p>`;

  const rejectedRows = metrics.topRejected.map(s =>
    `<div class="skill-row"><div class="skill-head">
    <b>${esc(s.skillName)}</b>
    <span class="cost roi-low">0% acceptance</span>
    </div>
    <div class="hint">Proposed ${s.proposedCount}× · never invoked · ${esc(estimateBenefitMinutes(s.skillName) + "min potential")}</div>
    </div>`
  ).join("") || `<p class="note">No consistently rejected skills yet.</p>`;

  const dormantBadges = metrics.dormantSkills.length > 0
    ? metrics.dormantSkills.map(s => `<span class="hint" style="margin-right:4px">${esc(s)}</span>`).join("")
    : `<span class="note">None yet.</span>`;

  const affinityBadges = metrics.affinityAreas.length > 0
    ? metrics.affinityAreas.map(a => `<span class="stat-pill" style="font-size:11px">${esc(a)}</span>`).join("")
    : `<span class="note">Builds after first few skill invocations.</span>`;

  const targets = `<table style="width:100%;font-size:11px;border-collapse:collapse;margin-top:4px">
  <tr><th style="text-align:left">Metric</th><th>Now</th><th>30d target</th><th>60d target</th></tr>
  <tr><td>Acceptance</td><td class="${pctClass(metrics.acceptanceRatePct,10,25)}">${metrics.acceptanceRatePct}%</td><td>15%</td><td>25%</td></tr>
  <tr><td>Precision</td><td class="${pctClass(metrics.precisionPct,15,40)}">${metrics.precisionPct}%</td><td>25%</td><td>40%</td></tr>
  <tr><td>F1</td><td class="${pctClass(metrics.f1Pct,15,35)}">${metrics.f1Pct}%</td><td>20%</td><td>35%</td></tr>
</table>`;

  return `<div class="panel" style="margin-top:6px">
  <h2 style="margin-top:0">Skill Adoption Intelligence</h2>
  ${summaryGrid}

  <details style="margin-bottom:8px">
    <summary style="cursor:pointer;font-size:12px;font-weight:600">Recommendation Funnel</summary>
    <div style="margin-top:6px">${funnelHtml}</div>
  </details>

  <details style="margin-bottom:8px">
    <summary style="cursor:pointer;font-size:12px;font-weight:600">Top Adopted Skills</summary>
    <div style="margin-top:6px">${adoptedRows}</div>
  </details>

  <details style="margin-bottom:8px">
    <summary style="cursor:pointer;font-size:12px;font-weight:600">Consistently Rejected (never invoked)</summary>
    <div style="margin-top:6px">${rejectedRows}</div>
  </details>

  <details style="margin-bottom:8px">
    <summary style="cursor:pointer;font-size:12px;font-weight:600">Dormant Skills · suppressed after ≥5 non-use sessions</summary>
    <div style="margin-top:6px;line-height:1.8">${dormantBadges}</div>
  </details>

  <details>
    <summary style="cursor:pointer;font-size:12px;font-weight:600">User Affinity Profile</summary>
    <div style="margin-top:6px">
      <p class="note" style="margin-top:0">Areas most frequently covered by invoked skills:</p>
      <div style="display:flex;flex-wrap:wrap;gap:4px">${affinityBadges}</div>
    </div>
  </details>

  <div style="margin-top:10px">
    <p class="note" style="font-weight:600;margin-bottom:4px">Progress toward targets</p>
    ${targets}
  </div>
</div>`;
}
