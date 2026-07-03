/**
 * VS Code commands for the Skill Enrichment review workflow (Phase 6).
 *
 * Commands registered here:
 *   claudeSkills.showEnrichmentProposals  — opens the enrichment review webview
 *   claudeSkills.runEnrichmentPipeline    — mines patterns + refreshes profiles + generates proposals
 *   claudeSkills.approveEnrichmentProposal — mark proposal approved (no SKILL.md change)
 *   claudeSkills.rejectEnrichmentProposal  — mark proposal rejected
 *   claudeSkills.applyEnrichmentProposal   — apply approved proposal to SKILL.md (user-confirmed)
 */
import * as path from "node:path";
import * as vscode from "vscode";
import {
  runEnrichmentPipeline,
  getSkillEvolution,
  readSkillProfileIndex,
} from "./skillEnrichment";
import {
  readEnrichmentProposals,
  generateEnrichmentProposals,
  approveEnrichmentProposal,
  rejectEnrichmentProposal,
  postponeEnrichmentProposal,
  resurfacePostponedProposals,
  applyEnrichmentProposal,
  formatEnrichmentProposalsHtml,
} from "./skillEnrichmentProposal";
import {
  analyzeSkillEnrichment,
  buildDataDrivenCandidates,
  computeEnrichmentImpact,
  detectStaleSkills,
  formatEnrichmentIntelligencePanelHtml,
} from "./enrichmentIntelligence";
import { listInstalledSkills } from "./usageStats";
import { globalSkillsDir } from "./skillOps";
import { notifyUserSuccess, notifyUserWarn } from "./userNotify";
import { recordFeatureUse } from "./analytics";

// ── Deps ──────────────────────────────────────────────────────────────────────

export interface EnrichmentCommandDeps {
  context: vscode.ExtensionContext;
  libraryDir: string;
  getTarget: () => string | undefined;
  log: (line: string) => void;
  refreshAll: () => void;
}

// ── Webview panel ─────────────────────────────────────────────────────────────

let enrichmentPanel: vscode.WebviewPanel | undefined;

function buildEnrichmentWebviewHtml(
  target: string,
  webview: vscode.Webview,
  libraryDir: string
): string {
  resurfacePostponedProposals(target);
  const proposals = readEnrichmentProposals(target);
  const proposalsHtml = formatEnrichmentProposalsHtml(proposals);
  const intelligenceHtml = formatEnrichmentIntelligencePanelHtml(target);

  const installed = listInstalledSkills(target);
  const profileIndex = readSkillProfileIndex(target);
  const evolution = getSkillEvolution(target, installed);

  const evolutionHtml = evolution.length > 0
    ? evolution.map(e => {
        const deltaStr = e.qualityDelta > 0 ? `+${e.qualityDelta}` : `${e.qualityDelta}`;
        return `<div class="skill-row">
  <div class="skill-head">
    <b>${esc(e.skill)}</b>
    <span class="cost roi-high">${deltaStr} quality</span>
    <span class="val">${e.qualityScore}/100</span>
  </div>
  ${e.topPattern ? `<div class="hint">New proven pattern: ${esc(e.topPattern)}</div>` : ""}
</div>`;
      }).join("")
    : `<p class="note">No quality improvements recorded yet. Quality scores update after skills are used successfully.</p>`;

  const profileSummary = profileIndex
    ? Object.values(profileIndex.profiles)
        .filter(p => p.invocations > 0)
        .sort((a, b) => b.qualityScore - a.qualityScore)
        .slice(0, 6)
        .map(p => `<div class="skill-row">
  <div class="skill-head">
    <b>${esc(p.skill)}</b>
    <span class="cost">${p.invocations} invocations</span>
    <span class="val">${p.qualityScore}/100</span>
  </div>
  <div class="hint">${Math.round(p.successRate * 100)}% success · avg ${p.avgTokens.toLocaleString()} tokens</div>
  ${p.commonScenarios.slice(0, 2).map(s =>
    `<div style="font-size:10px;opacity:.7;margin-left:8px">↳ ${esc(s.label)} (${s.occurrences}×, ${Math.round(s.successRate * 100)}%)</div>`
  ).join("")}
</div>`).join("")
    : `<p class="note">No skill profiles yet — profiles build after skills are invoked.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px 16px; }
  .panel { background: var(--vscode-sideBar-background,#252526); border-radius:6px; padding:12px 14px; margin-bottom:12px; }
  h2 { font-size:13px; font-weight:600; color:var(--vscode-foreground); margin-bottom:8px; }
  .stat-grid { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:8px; }
  .stat-pill { background:var(--vscode-badge-background,#4d4d4d); border-radius:4px; padding:4px 10px; font-size:11px; display:flex; flex-direction:column; align-items:center; }
  .val { font-weight:700; font-size:13px; margin-top:2px; }
  .skill-row { padding:4px 0; border-bottom:1px solid var(--vscode-widget-border,#3c3c3c); }
  .skill-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .cost { font-size:11px; opacity:.8; }
  .hint { font-size:11px; opacity:.7; margin-left:2px; padding-top:2px; }
  .note { font-size:11px; opacity:.7; font-style:italic; }
  .roi-high   { color:var(--vscode-charts-green,#4CAF50); }
  .roi-medium { color:var(--vscode-charts-yellow,#FFC107); }
  .roi-low    { color:var(--vscode-charts-red,#F44336); }
  code { font-family:var(--vscode-editor-font-family,monospace); font-size:10px; background:var(--vscode-badge-background,#333); padding:1px 4px; border-radius:2px; }
  pre  { font-family:var(--vscode-editor-font-family,monospace); white-space:pre-wrap; }
  details > summary { user-select:none; }
  .run-btn { margin-bottom:10px; background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none; padding:6px 14px; border-radius:3px; cursor:pointer; font-size:12px; }
</style>
</head>
<body>
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
  <h1 style="margin:0;font-size:14px;font-weight:600">Skill Enrichment Intelligence</h1>
  <button class="run-btn" onclick="vscode.postMessage({command:'runPipeline'})">
    ↻ Run Enrichment Pipeline
  </button>
</div>

${proposalsHtml}

${intelligenceHtml}

<div class="panel" style="margin-top:8px">
  <h2 style="margin-top:0">Most Improved Skills (quality score)</h2>
  ${evolutionHtml}
</div>

<div class="panel" style="margin-top:8px">
  <h2 style="margin-top:0">Skill Confidence Profiles</h2>
  <p class="note" style="margin-bottom:8px">Quality score = Usage + Success Rate + Reuse + Time Saved + Knowledge Growth (0-100)</p>
  ${profileSummary}
</div>

<script>
  const vscode = acquireVsCodeApi();
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Command registration ──────────────────────────────────────────────────────

export function registerEnrichmentCommands(deps: EnrichmentCommandDeps): vscode.Disposable[] {
  const { context, libraryDir, getTarget, log, refreshAll } = deps;

  return [
    // ── Show Enrichment Proposals webview ──────────────────────────────────
    vscode.commands.registerCommand("claudeSkills.showEnrichmentProposals", async () => {
      recordFeatureUse("enrichmentProposals");
      const target = getTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }

      if (!enrichmentPanel) {
        enrichmentPanel = vscode.window.createWebviewPanel(
          "claudeSkillsEnrichment",
          "Skill Enrichment Intelligence",
          vscode.ViewColumn.Active,
          { enableScripts: true, retainContextWhenHidden: true }
        );
        enrichmentPanel.onDidDispose(() => { enrichmentPanel = undefined; });
        enrichmentPanel.webview.onDidReceiveMessage(
          async (msg: { command?: string; id?: string }) => {
            const ws = getTarget();
            if (!ws) return;

            if (msg.command === "runPipeline") {
              await vscode.commands.executeCommand("claudeSkills.runEnrichmentPipeline");
            } else if (msg.command === "approveEnrichment" && msg.id) {
              await vscode.commands.executeCommand("claudeSkills.approveEnrichmentProposal", msg.id);
            } else if (msg.command === "rejectEnrichment" && msg.id) {
              await vscode.commands.executeCommand("claudeSkills.rejectEnrichmentProposal", msg.id);
            } else if (msg.command === "postponeEnrichment" && msg.id) {
              await vscode.commands.executeCommand("claudeSkills.postponeEnrichmentProposal", msg.id);
            } else if (msg.command === "applyEnrichment" && msg.id) {
              await vscode.commands.executeCommand("claudeSkills.applyEnrichmentProposal", msg.id);
            }

            // Refresh panel after any action
            if (enrichmentPanel) {
              enrichmentPanel.webview.html = buildEnrichmentWebviewHtml(ws, enrichmentPanel.webview, libraryDir);
            }
          }
        );
      }

      enrichmentPanel.webview.html = buildEnrichmentWebviewHtml(target, enrichmentPanel.webview, libraryDir);
      enrichmentPanel.reveal(vscode.ViewColumn.Active);
    }),

    // ── Run Enrichment Pipeline ────────────────────────────────────────────
    vscode.commands.registerCommand("claudeSkills.runEnrichmentPipeline", async () => {
      const target = getTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }

      const installed = listInstalledSkills(target);
      if (installed.length === 0) {
        void notifyUserWarn("Claude Skills: no skills installed — install skills first.");
        return;
      }

      const result = runEnrichmentPipeline(target, installed);

      // Phase 1-5: mine per-skill files / commands / technologies / troubleshooting
      // into skill-enrichment.json, then add data-driven candidates (Phase 6)
      // to the static pattern-library ones.
      const enrichmentIndex = analyzeSkillEnrichment(target, installed);
      const minedCandidates = buildDataDrivenCandidates(target, enrichmentIndex);
      const allCandidates = [...result.candidates, ...minedCandidates];
      const resurfaced = resurfacePostponedProposals(target);
      const newProposals = generateEnrichmentProposals(target, allCandidates);

      // Phase 8 + 10: refresh impact deltas and staleness warnings
      const impact = computeEnrichmentImpact(target);
      const stale = detectStaleSkills(target, enrichmentIndex);

      log(`\n=== Enrichment Pipeline ===`);
      log(`Skills analyzed:     ${installed.length}`);
      log(`New pattern entries: ${result.newEntries}`);
      log(`Enrichment candidates: ${allCandidates.length} (${minedCandidates.length} mined from telemetry)`);
      log(`New proposals:       ${newProposals}`);
      if (resurfaced > 0) log(`Resurfaced postponed proposals: ${resurfaced}`);
      if (impact.impacts.length > 0) log(`Enrichment impact records: ${impact.impacts.length}`);

      if (allCandidates.length > 0) {
        log(`\nCandidates:`);
        for (const c of allCandidates) {
          log(`  ${c.skill} / ${c.patternLabel} — ${c.occurrences}× observed, ${Math.round(c.confidence * 100)}% confidence`);
        }
      }
      if (stale.length > 0) {
        log(`\nStale skills:`);
        for (const w of stale) log(`  ${w.skill} — ${w.message}`);
      }

      if (newProposals > 0) {
        void notifyUserSuccess(
          `Claude Skills: ${newProposals} new enrichment proposal(s) generated — open Enrichment Intelligence to review.`
        );
      } else if (result.candidates.length > 0) {
        void notifyUserSuccess(
          `Claude Skills: ${result.candidates.length} candidate(s) found — all already have pending proposals.`
        );
      } else {
        void notifyUserSuccess(
          `Claude Skills: enrichment pipeline complete — ${result.newEntries} pattern entries processed. No new candidates yet (≥3 occurrences required).`
        );
      }

      refreshAll();
    }),

    // ── Approve Proposal ──────────────────────────────────────────────────
    vscode.commands.registerCommand("claudeSkills.approveEnrichmentProposal", async (proposalId?: string) => {
      const target = getTarget();
      if (!target) return;

      // If not called from webview, show quick pick
      if (!proposalId) {
        const pending = readEnrichmentProposals(target).filter(p => p.status === "pending");
        if (pending.length === 0) {
          void notifyUserWarn("Claude Skills: no pending enrichment proposals.");
          return;
        }
        const pick = await vscode.window.showQuickPick(
          pending.map(p => ({ label: `${p.skill} — ${p.patternLabel}`, description: `${Math.round(p.confidence * 100)}% confidence`, id: p.id })),
          { title: "Approve enrichment proposal" }
        );
        if (!pick) return;
        proposalId = pick.id;
      }

      const approved = approveEnrichmentProposal(target, proposalId);
      if (approved) {
        void notifyUserSuccess(
          `Claude Skills: approved enrichment for "${approved.skill}" — "${approved.sectionTitle}". Open Enrichment Intelligence to apply it to SKILL.md.`
        );
        log(`Enrichment approved: ${approved.skill} / ${approved.patternLabel}`);
      }
    }),

    // ── Reject Proposal ───────────────────────────────────────────────────
    vscode.commands.registerCommand("claudeSkills.rejectEnrichmentProposal", async (proposalId?: string) => {
      const target = getTarget();
      if (!target) return;

      if (!proposalId) {
        const pending = readEnrichmentProposals(target).filter(p => p.status === "pending");
        if (pending.length === 0) {
          void notifyUserWarn("Claude Skills: no pending enrichment proposals.");
          return;
        }
        const pick = await vscode.window.showQuickPick(
          pending.map(p => ({ label: `${p.skill} — ${p.patternLabel}`, id: p.id })),
          { title: "Reject enrichment proposal" }
        );
        if (!pick) return;
        proposalId = pick.id;
      }

      const ok = rejectEnrichmentProposal(target, proposalId);
      if (ok) {
        void notifyUserSuccess("Claude Skills: enrichment proposal rejected.");
        log(`Enrichment rejected: ${proposalId}`);
      }
    }),

    // ── Postpone Proposal ─────────────────────────────────────────────────
    vscode.commands.registerCommand("claudeSkills.postponeEnrichmentProposal", async (proposalId?: string) => {
      const target = getTarget();
      if (!target) return;

      if (!proposalId) {
        const pending = readEnrichmentProposals(target).filter(p => p.status === "pending");
        if (pending.length === 0) {
          void notifyUserWarn("Claude Skills: no pending enrichment proposals.");
          return;
        }
        const pick = await vscode.window.showQuickPick(
          pending.map(p => ({ label: `${p.skill} — ${p.patternLabel}`, id: p.id })),
          { title: "Postpone enrichment proposal (7 days)" }
        );
        if (!pick) return;
        proposalId = pick.id;
      }

      const ok = postponeEnrichmentProposal(target, proposalId);
      if (ok) {
        void notifyUserSuccess("Claude Skills: proposal postponed for 7 days.");
        log(`Enrichment postponed: ${proposalId}`);
      } else {
        void notifyUserWarn("Claude Skills: only pending proposals can be postponed.");
      }
    }),

    // ── Apply Approved Proposal to SKILL.md ───────────────────────────────
    vscode.commands.registerCommand("claudeSkills.applyEnrichmentProposal", async (proposalId?: string) => {
      const target = getTarget();
      if (!target) return;

      if (!proposalId) {
        const approved = readEnrichmentProposals(target).filter(p => p.status === "approved");
        if (approved.length === 0) {
          void notifyUserWarn("Claude Skills: no approved proposals to apply. Approve a proposal first.");
          return;
        }
        const pick = await vscode.window.showQuickPick(
          approved.map(p => ({ label: `${p.skill} — ${p.sectionTitle}`, id: p.id })),
          { title: "Apply enrichment to SKILL.md" }
        );
        if (!pick) return;
        proposalId = pick.id;
      }

      // Confirmation dialog — this is the ONLY place SKILL.md gets modified
      const proposal = readEnrichmentProposals(target).find(p => p.id === proposalId);
      if (!proposal) {
        void notifyUserWarn(`Claude Skills: proposal ${proposalId} not found.`);
        return;
      }

      const confirmed = await vscode.window.showWarningMessage(
        `Append "${proposal.sectionTitle}" to ${proposal.skill}/SKILL.md?`,
        { modal: true, detail: `Evidence: ${proposal.evidence.occurrences} sessions · ${Math.round(proposal.evidence.successRate * 100)}% success rate · ${Math.round(proposal.confidence * 100)}% confidence` },
        "Apply to SKILL.md",
        "Cancel"
      );
      if (confirmed !== "Apply to SKILL.md") return;

      const workspaceSkillsDir = path.join(target, ".claude", "skills");
      const result = applyEnrichmentProposal(target, proposalId, [
        workspaceSkillsDir,
        globalSkillsDir(),
        path.join(libraryDir, ".."),  // skills_library parent
      ]);

      if (result.applied) {
        void notifyUserSuccess(`Claude Skills: ${result.message}`);
        log(`Enrichment applied: ${result.message}`);
        if (result.path) {
          const doc = await vscode.workspace.openTextDocument(result.path);
          await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
        }
        refreshAll();
      } else {
        vscode.window.showWarningMessage(`Claude Skills: ${result.message}`);
        log(`Enrichment apply failed: ${result.message}`);
      }
    }),
  ];
}
