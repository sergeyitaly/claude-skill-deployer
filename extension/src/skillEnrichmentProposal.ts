/**
 * Skill Enrichment Review Workflow — Phase 6
 *
 * SAFETY CONTRACT: applyEnrichmentProposal() is the single write path to
 * SKILL.md, and by default it only ever runs from the user clicking "Apply to
 * SKILL.md" after an explicit confirmation dialog. The one exception is opt-in:
 * commandsEnrichment.ts's runEnrichmentPipeline command will call it
 * automatically, without a dialog, only if the user has explicitly turned on
 * claudeSkills.enrichment.autoApply (default false). Auto-approval
 * (claudeSkills.enrichment.autoApprove, default true) never reaches this
 * function's write path — it only flips proposal status to "approved".
 *
 * Workflow:
 *   1. generateEnrichmentProposals() writes pending proposals to skill-enrichment-proposals.jsonl
 *   2. The user reviews them in the VS Code enrichment panel (commandsEnrichment.ts),
 *      or they're auto-approved per the setting above — either way, no SKILL.md change yet
 *   3. approveEnrichmentProposal() marks a proposal "approved" — still no SKILL.md change
 *   4. applyEnrichmentProposal() writes to SKILL.md — user-confirmed by default,
 *      or automatic only when autoApply is explicitly enabled (see contract above)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { EnrichmentCandidate } from "./skillEnrichment";

// ── Storage ───────────────────────────────────────────────────────────────────

const ENRICHMENT_PROPOSALS_REL = path.join(".claude", "learning", "skill-enrichment-proposals.jsonl");

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProposalStatus = "pending" | "approved" | "rejected" | "applied" | "postponed";

export interface EnrichmentProposal {
  id: string;
  ts: string;
  skill: string;
  patternId: string;
  patternLabel: string;
  status: ProposalStatus;
  /** Set when status === "postponed": the proposal returns to pending after this date. */
  postponedUntil?: string;
  evidence: {
    sessions: number;
    successRate: number;
    occurrences: number;
  };
  confidence: number;
  sectionTitle: string;
  proposedContent: string;
  affectedFiles: string[];
  typicalCommands: string[];
  reviewedAt?: string;
  reviewNote?: string;
}

// ── File I/O ──────────────────────────────────────────────────────────────────

export function enrichmentProposalsPath(target: string): string {
  return path.join(target, ENRICHMENT_PROPOSALS_REL);
}

export function readEnrichmentProposals(target: string): EnrichmentProposal[] {
  const file = enrichmentProposalsPath(target);
  if (!fs.existsSync(file)) return [];
  const proposals: EnrichmentProposal[] = [];
  try {
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try { proposals.push(JSON.parse(line) as EnrichmentProposal); } catch { /* skip corrupt */ }
    }
  } catch { /* non-fatal */ }
  return proposals;
}

function appendProposal(target: string, proposal: EnrichmentProposal): void {
  const file = enrichmentProposalsPath(target);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(proposal) + "\n", "utf-8");
  } catch { /* non-fatal */ }
}

function rewriteProposals(target: string, proposals: EnrichmentProposal[]): void {
  const file = enrichmentProposalsPath(target);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const content = proposals.map(p => JSON.stringify(p)).join("\n");
    fs.writeFileSync(file, content.length > 0 ? content + "\n" : "", "utf-8");
  } catch { /* non-fatal */ }
}

// ── Phase 6 core ─────────────────────────────────────────────────────────────

/**
 * Creates pending proposals for enrichment candidates that don't yet have
 * an active (pending/approved/applied) proposal. Returns the count of new proposals.
 */
export function generateEnrichmentProposals(target: string, candidates: EnrichmentCandidate[]): number {
  const existing = readEnrichmentProposals(target);
  const now = Date.now();
  const activeKeys = new Set(
    existing
      .filter(p =>
        p.status === "pending" ||
        p.status === "approved" ||
        // Applied proposals must stay a terminal dedup state — re-mining the same
        // successful pattern after it already shipped to SKILL.md previously created
        // a duplicate proposal for identical content (confirmed twice in real data).
        // Rejected proposals are NOT included here: rejection means "not this content,"
        // so re-proposing later if the pattern recurs is fine.
        p.status === "applied" ||
        // Postponed proposals stay active (no duplicate) until their snooze expires.
        (p.status === "postponed" &&
          (!p.postponedUntil || new Date(p.postponedUntil).getTime() > now))
      )
      .map(p => `${p.skill}::${p.patternId}`)
  );

  let created = 0;
  for (const cand of candidates) {
    const key = `${cand.skill}::${cand.patternId}`;
    if (activeKeys.has(key)) continue;

    const proposal: EnrichmentProposal = {
      id: `enrich_${cand.skill}_${cand.patternId}_${Date.now()}_${created}`,
      ts: new Date().toISOString(),
      skill: cand.skill,
      patternId: cand.patternId,
      patternLabel: cand.patternLabel,
      status: "pending",
      evidence: {
        sessions: cand.occurrences,
        successRate: cand.successRate,
        occurrences: cand.occurrences,
      },
      confidence: cand.confidence,
      sectionTitle: cand.sectionTitle,
      proposedContent: cand.proposedContent,
      affectedFiles: cand.affectedFiles,
      typicalCommands: cand.typicalCommands,
    };

    appendProposal(target, proposal);
    activeKeys.add(key);
    created++;
  }
  return created;
}

/**
 * Mark a proposal as approved.
 * Does NOT touch SKILL.md — the user must separately call applyEnrichmentProposal().
 */
export function approveEnrichmentProposal(target: string, proposalId: string): EnrichmentProposal | undefined {
  const proposals = readEnrichmentProposals(target);
  const idx = proposals.findIndex(p => p.id === proposalId);
  if (idx < 0) return undefined;
  proposals[idx] = { ...proposals[idx], status: "approved", reviewedAt: new Date().toISOString() };
  rewriteProposals(target, proposals);
  return proposals[idx];
}

export const POSTPONE_DEFAULT_DAYS = 7;

/**
 * Postpone a pending proposal: it leaves the review queue and automatically
 * returns to "pending" after `days` (applied lazily by resurfacePostponedProposals).
 */
export function postponeEnrichmentProposal(
  target: string,
  proposalId: string,
  days = POSTPONE_DEFAULT_DAYS
): boolean {
  const proposals = readEnrichmentProposals(target);
  const idx = proposals.findIndex(p => p.id === proposalId);
  if (idx < 0) return false;
  if (proposals[idx].status !== "pending") return false;
  proposals[idx] = {
    ...proposals[idx],
    status: "postponed",
    reviewedAt: new Date().toISOString(),
    postponedUntil: new Date(Date.now() + days * 86_400_000).toISOString(),
  };
  rewriteProposals(target, proposals);
  return true;
}

/** Returns expired postponed proposals to "pending". Called before rendering the queue. */
export function resurfacePostponedProposals(target: string, nowMs = Date.now()): number {
  const proposals = readEnrichmentProposals(target);
  let changed = 0;
  const updated = proposals.map(p => {
    if (
      p.status === "postponed" &&
      (!p.postponedUntil || new Date(p.postponedUntil).getTime() <= nowMs)
    ) {
      changed++;
      return { ...p, status: "pending" as ProposalStatus, postponedUntil: undefined };
    }
    return p;
  });
  if (changed > 0) rewriteProposals(target, updated);
  return changed;
}

/** Mark a proposal as rejected with an optional review note. */
export function rejectEnrichmentProposal(target: string, proposalId: string, note?: string): boolean {
  const proposals = readEnrichmentProposals(target);
  const idx = proposals.findIndex(p => p.id === proposalId);
  if (idx < 0) return false;
  proposals[idx] = {
    ...proposals[idx],
    status: "rejected",
    reviewedAt: new Date().toISOString(),
    ...(note ? { reviewNote: note } : {}),
  };
  rewriteProposals(target, proposals);
  return true;
}

/**
 * Apply an APPROVED proposal by appending its content to the skill's SKILL.md.
 *
 * This is the ONLY function that writes to SKILL.md, and it must be called
 * explicitly by the user through a confirmed VS Code command.
 *
 * Search paths for SKILL.md (in priority order):
 *   1. workspaceSkillsDir  (.claude/skills/<skill>/SKILL.md)
 *   2. globalSkillsDir     (~/.claude/skills/<skill>/SKILL.md)
 *   3. libraryDir          (<extension>/skills_library/<skill>/SKILL.md)
 */
export function applyEnrichmentProposal(
  target: string,
  proposalId: string,
  searchDirs: string[]
): { applied: boolean; message: string; path?: string } {
  const proposals = readEnrichmentProposals(target);
  const proposal  = proposals.find(p => p.id === proposalId);

  if (!proposal) {
    return { applied: false, message: `Proposal ${proposalId} not found.` };
  }
  if (proposal.status === "applied") {
    return { applied: false, message: `Proposal already applied (section "${proposal.sectionTitle}" already exists in SKILL.md).` };
  }
  if (proposal.status !== "approved") {
    return { applied: false, message: `Proposal must be approved before applying (current: ${proposal.status}).` };
  }

  // Find SKILL.md in the first matching directory
  let skillMdPath: string | undefined;
  for (const dir of searchDirs) {
    const candidate = path.join(dir, proposal.skill, "SKILL.md");
    if (fs.existsSync(candidate)) { skillMdPath = candidate; break; }
  }

  if (!skillMdPath) {
    return {
      applied: false,
      message: `SKILL.md for "${proposal.skill}" not found in search paths: ${searchDirs.join(", ")}`,
    };
  }

  const current = fs.readFileSync(skillMdPath, "utf-8");
  if (current.includes(proposal.sectionTitle)) {
    return { applied: false, message: `Section "${proposal.sectionTitle}" already exists in ${skillMdPath}` };
  }

  const provenance = `<!-- Enrichment: added from ${proposal.evidence.occurrences} real-world sessions, ${Math.round(proposal.confidence * 100)}% confidence, ${new Date(proposal.ts).toISOString().slice(0, 10)} -->`;
  const addition   = `\n\n${provenance}\n${proposal.proposedContent}\n`;
  fs.appendFileSync(skillMdPath, addition, "utf-8");

  // Update status to "applied"
  const idx = proposals.findIndex(p => p.id === proposalId);
  proposals[idx] = {
    ...proposals[idx],
    status: "applied",
    reviewedAt: new Date().toISOString(),
    reviewNote: `Applied to ${skillMdPath}`,
  };
  rewriteProposals(target, proposals);

  return { applied: true, message: `Appended "${proposal.sectionTitle}" to ${skillMdPath}`, path: skillMdPath };
}

// ── Approved-but-unapplied reminder ─────────────────────────────────────────────
// Approving a proposal never applies it (see the safety contract above) — but nothing
// used to remind anyone the second, manual "Apply to SKILL.md" step was still pending.
// Real workspaces have shown proposals stuck "approved" for 7-17 days as a result.

export interface ApprovedUnappliedSummary {
  count: number;
  bySkill: Record<string, number>;
  oldestAgeDays: number;
}

/** Summarizes proposals stuck in "approved" — shared by the SessionStart reminder and the
 *  dashboard pill so both surfaces always agree on the same count/age. */
export function getApprovedUnappliedSummary(target: string): ApprovedUnappliedSummary | null {
  const approved = readEnrichmentProposals(target).filter(p => p.status === "approved");
  if (approved.length === 0) return null;

  const bySkill: Record<string, number> = {};
  for (const p of approved) bySkill[p.skill] = (bySkill[p.skill] ?? 0) + 1;

  const oldestTs = Math.min(...approved.map(p => new Date(p.reviewedAt ?? p.ts).getTime()));
  const oldestAgeDays = Math.max(0, Math.floor((Date.now() - oldestTs) / 86_400_000));

  return { count: approved.length, bySkill, oldestAgeDays };
}

/** Plain-text SessionStart reminder — kept separate from the dashboard's HTML pill since
 *  the two have unrelated output shapes; only the underlying summary is shared. */
export function formatApprovedEnrichmentReminderText(summary: ApprovedUnappliedSummary): string {
  const lines = [
    `${summary.count} approved skill improvement${summary.count === 1 ? "" : "s"} ${summary.count === 1 ? "is" : "are"} waiting.`,
    "",
    ...Object.entries(summary.bySkill)
      .sort((a, b) => b[1] - a[1])
      .map(([skill, n]) => `- ${skill} (${n})`),
    "",
    "Open enrichment panel.",
  ];
  return lines.join("\n");
}

// ── HTML rendering ────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Renders a full panel of pending enrichment proposals with Approve / Reject buttons. */
export function formatEnrichmentProposalsHtml(proposals: EnrichmentProposal[]): string {
  const pending   = proposals.filter(p => p.status === "pending");
  const approved  = proposals.filter(p => p.status === "approved");
  const applied   = proposals.filter(p => p.status === "applied");
  const rejected  = proposals.filter(p => p.status === "rejected");
  const postponed = proposals.filter(p => p.status === "postponed");

  if (pending.length === 0 && approved.length === 0) {
    return `<div class="panel" style="margin-top:6px">
  <h2 style="margin-top:0">Skill Enrichment Proposals</h2>
  <p class="note">No enrichment proposals yet. They appear once the same pattern is observed
  ≥3 times successfully. Run more DevOps / cloud tasks to generate candidates.</p>
  ${applied.length > 0 || rejected.length > 0
    ? `<p class="note">${applied.length} applied · ${rejected.length} rejected (in history)</p>`
    : ""}
</div>`;
  }

  const pendingRows = pending.map(p => {
    const pct     = Math.round(p.confidence * 100);
    const succPct = Math.round(p.evidence.successRate * 100);
    return `<div class="skill-row" style="margin-bottom:14px;padding:10px 10px 6px;border-left:3px solid var(--vscode-charts-blue,#2196F3)">
  <div class="skill-head">
    <b>${esc(p.skill)}</b>
    <span class="cost roi-high">${pct}% confidence</span>
  </div>
  <div style="font-size:12px;margin:4px 0"><b>Pattern:</b> ${esc(p.patternLabel)}</div>
  <div style="font-size:11px;opacity:.8;margin-bottom:4px">
    Observed ${p.evidence.occurrences}× · ${succPct}% success rate
    · Typical files: <code>${esc(p.affectedFiles.slice(0, 2).join(", "))}</code>
  </div>
  <div style="font-size:11px;margin:4px 0">
    <b>Proposed section:</b> <code>${esc(p.sectionTitle)}</code>
  </div>
  <details style="margin-top:4px">
    <summary style="cursor:pointer;font-size:11px;color:var(--vscode-textLink-foreground)">Preview proposed content</summary>
    <pre style="font-size:10px;overflow:auto;max-height:130px;margin-top:4px;padding:6px;background:var(--vscode-editor-background)">${esc(p.proposedContent)}</pre>
  </details>
  <div style="margin-top:8px;display:flex;gap:8px">
    <button class="enrich-btn"
      onclick="vscode.postMessage({command:'approveEnrichment',id:'${esc(p.id)}'})"
      style="background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:4px 14px;cursor:pointer;border-radius:3px;font-size:11px">
      Approve
    </button>
    <button class="enrich-btn"
      onclick="vscode.postMessage({command:'rejectEnrichment',id:'${esc(p.id)}'})"
      style="background:var(--vscode-button-secondaryBackground,#3a3d41);color:var(--vscode-button-secondaryForeground,#ccc);border:none;padding:4px 14px;cursor:pointer;border-radius:3px;font-size:11px">
      Reject
    </button>
    <button class="enrich-btn"
      onclick="vscode.postMessage({command:'postponeEnrichment',id:'${esc(p.id)}'})"
      style="background:var(--vscode-button-secondaryBackground,#3a3d41);color:var(--vscode-button-secondaryForeground,#ccc);border:none;padding:4px 14px;cursor:pointer;border-radius:3px;font-size:11px">
      Postpone 7d
    </button>
  </div>
</div>`;
  }).join("");

  const approvedRows = approved.map(p =>
    `<div class="skill-row" style="margin-bottom:8px;padding:8px;border-left:3px solid var(--vscode-charts-green,#4CAF50)">
  <div class="skill-head">
    <b>${esc(p.skill)}</b>
    <span style="color:var(--vscode-charts-green,#4CAF50);font-size:11px">✓ approved</span>
  </div>
  <div style="font-size:11px;opacity:.8">${esc(p.patternLabel)} · <code>${esc(p.sectionTitle)}</code></div>
  <div style="margin-top:6px">
    <button class="enrich-btn"
      onclick="vscode.postMessage({command:'applyEnrichment',id:'${esc(p.id)}'})"
      style="background:var(--vscode-charts-green,#4CAF50);color:#fff;border:none;padding:4px 14px;cursor:pointer;border-radius:3px;font-size:11px">
      Apply to SKILL.md
    </button>
  </div>
</div>`
  ).join("");

  const historyNote = (applied.length > 0 || rejected.length > 0 || postponed.length > 0)
    ? `<p class="note" style="margin-top:8px">${applied.length} applied · ${rejected.length} rejected · ${postponed.length} postponed</p>`
    : "";

  return `<div class="panel" style="margin-top:6px">
  <h2 style="margin-top:0">Skill Enrichment Proposals <span style="font-size:12px;font-weight:400">(${pending.length} pending)</span></h2>
  <p class="note" style="margin-bottom:10px">
    Evidence-based proposals to enrich SKILL.md files from real-world usage.
    The system never modifies skills automatically — review each proposal before approving.
  </p>
  ${pendingRows}
  ${approved.length > 0
    ? `<details style="margin-top:6px"><summary style="cursor:pointer;font-size:12px;font-weight:600">Approved — ready to apply (${approved.length})</summary><div style="margin-top:6px">${approvedRows}</div></details>`
    : ""}
  ${historyNote}
</div>`;
}

/** Compact summary for embedding in the main dashboard. */
export function formatEnrichmentSummaryHtml(target: string): string {
  const proposals = readEnrichmentProposals(target);
  const pending  = proposals.filter(p => p.status === "pending").length;
  const applied  = proposals.filter(p => p.status === "applied").length;
  const approvedSummary = getApprovedUnappliedSummary(target);

  if (pending + applied + (approvedSummary?.count ?? 0) === 0) return "";

  // Approved-but-unapplied takes visual priority — it's the actionable-now state,
  // and a passive "N approved" count is exactly what let real proposals sit
  // unapplied for 7-17 days (see the reminder above). Clickable via the
  // .enrichment-apply-now class + data attribute convention costDashboard.ts's
  // dashboardInjectionListenerScript() already uses for other dashboard actions.
  if (approvedSummary) {
    return `<div class="stat-pill" title="Skill Enrichment Proposals">
  <b>Enrichments</b>
  <span class="val roi-medium enrichment-apply-now" data-oldest-days="${approvedSummary.oldestAgeDays}"
        style="cursor:pointer;text-decoration:underline" title="Oldest approved: ${approvedSummary.oldestAgeDays}d ago">
    ${approvedSummary.count} approved — Apply now
  </span>
</div>`;
  }

  return `<div class="stat-pill" title="Skill Enrichment Proposals">
  <b>Enrichments</b>
  <span class="val ${pending > 0 ? "roi-medium" : "roi-high"}">${pending > 0 ? `${pending} pending` : `${applied} applied`}</span>
</div>`;
}
