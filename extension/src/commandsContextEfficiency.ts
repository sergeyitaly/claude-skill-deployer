/**
 * VS Code commands for Context Efficiency Intelligence (Phases 10, 11).
 *
 * Commands:
 *   claudeSkills.showContextEfficiency    — opens Phase 10 dashboard webview
 *   claudeSkills.runContextAnalysis       — runs analysis, surfaces compact advice
 *   claudeSkills.followCompactAdvice      — user confirmed /compact (Phase 9 tracking)
 *   claudeSkills.dismissCompactAdvice     — user dismissed advisor (Phase 9 tracking)
 *
 * Phase 11 — Auto-Optimize toggle:
 *   Setting: claudeSkills.contextEfficiency.autoOptimize
 *   When true: compact advisor fires automatically on panel open if threshold exceeded.
 *   Never executes /compact automatically — only surfaces the recommendation.
 */
import * as path from "node:path";
import * as vscode from "vscode";

import {
  analyzeContextEfficiency,
  computeAdvisorROI,
  recordAdvisorEvent,
} from "./contextEfficiency";
import {
  evaluateCompactAdvisor,
  buildCoachingMessages,
  formatEfficiencyCoachHtml,
  formatCompactAdvisorHtml,
} from "./contextAdvisor";
import { notifyUserSuccess, notifyUserWarn } from "./userNotify";
import { recordFeatureUse } from "./analytics";

// ── Deps ──────────────────────────────────────────────────────────────────────

export interface ContextEfficiencyCommandDeps {
  context: vscode.ExtensionContext;
  getTarget: () => string | undefined;
  log: (line: string) => void;
  refreshAll: () => void;
}

// ── Webview panel ─────────────────────────────────────────────────────────────

let efficiencyPanel: vscode.WebviewPanel | undefined;
/** Advisor state for the current panel session. */
let currentAdvisorEstimate = 0;
let currentAdvisorReason   = "";

function buildEfficiencyWebviewHtml(
  target: string
): string {
  const analysis = analyzeContextEfficiency(target, 24);
  const advisor  = evaluateCompactAdvisor(analysis);
  const roi      = computeAdvisorROI(target);
  const coaching = buildCoachingMessages(analysis);
  const advisorHtml = formatCompactAdvisorHtml(advisor, roi);
  const coachHtml   = formatEfficiencyCoachHtml(coaching);

  // Save for Phase 9 tracking when user acts from webview
  currentAdvisorEstimate = advisor.estimatedTokensSaved;
  currentAdvisorReason   = advisor.triggerReason;

  const { efficiency, pressure, hotFiles, repeatedReads, directoryScanWaste } = analysis;

  const efficiencyColor = efficiency.score >= 80 ? "var(--vscode-charts-green,#4CAF50)"
    : efficiency.score >= 60 ? "var(--vscode-charts-yellow,#FFC107)"
    : "var(--vscode-charts-red,#F44336)";

  const pressureColor = {
    low: "var(--vscode-charts-green,#4CAF50)",
    medium: "var(--vscode-charts-yellow,#FFC107)",
    high: "var(--vscode-charts-orange,#FF9800)",
    critical: "var(--vscode-charts-red,#F44336)",
  }[pressure.level];

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n);

  // Hot files table
  const hotFilesRows = hotFiles.length === 0
    ? `<p class="note">No hot files detected in the last 24h.</p>`
    : hotFiles.slice(0, 6).map(f => `
  <div class="skill-row">
    <div class="skill-head">
      <code>${esc(path.basename(f.path))}</code>
      <span class="cost roi-low">${f.reads}× reads</span>
      <span class="cost">~${fmt(f.wastedTokens)} wasted</span>
    </div>
    <div class="hint">${esc(f.path.length > 60 ? "…" + f.path.slice(-57) : f.path)}</div>
  </div>`).join("");

  // Repeated reads
  const repeatedRows = repeatedReads.length === 0
    ? `<p class="note">No repeated reads detected in 30-min windows.</p>`
    : repeatedReads.slice(0, 5).map(r => `
  <div class="skill-row">
    <div class="skill-head">
      <code>${esc(path.basename(r.path))}</code>
      <span class="cost roi-low">${r.reads}× in ${r.windowMinutes}min</span>
      <span class="cost">~${fmt(r.estimatedWasteTokens)} wasted</span>
    </div>
    <div class="hint">${esc(r.recommendation)}</div>
  </div>`).join("");

  // Directory scan waste
  const dirRows = directoryScanWaste.length === 0
    ? `<p class="note">No excessive directory scans detected.</p>`
    : directoryScanWaste.slice(0, 5).map(d => `
  <div class="skill-row">
    <div class="skill-head">
      <code>${esc(path.basename(d.path) || d.path)}</code>
      <span class="cost roi-low">${d.scans}× scanned</span>
      <span class="cost">~${fmt(d.estimatedWasteTokens)} wasted</span>
    </div>
    <div class="hint">${d.totalEntries} total entries · last: ${new Date(d.lastScanned).toLocaleTimeString()}</div>
  </div>`).join("");

  // Phase 9 ROI summary
  const roiHtml = roi.shown > 0 ? `
  <div class="panel" style="margin-top:8px">
    <h2 style="margin-top:0">Efficiency Coaching ROI (Phase 9)</h2>
    <div class="stat-grid">
      <div class="stat-pill"><b>Advisor shown</b><span class="val">${roi.shown}</span></div>
      <div class="stat-pill"><b>Followed</b><span class="val roi-high">${roi.followed}</span></div>
      <div class="stat-pill"><b>Dismissed</b><span class="val">${roi.dismissed}</span></div>
      <div class="stat-pill"><b>Follow rate</b><span class="val ${roi.followRate >= 0.5 ? "roi-high" : "roi-medium"}">${Math.round(roi.followRate * 100)}%</span></div>
      <div class="stat-pill"><b>Tokens saved</b><span class="val roi-high">~${fmt(roi.estimatedTokensSaved)}</span></div>
    </div>
  </div>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body { font-family:var(--vscode-font-family); font-size:var(--vscode-font-size); color:var(--vscode-foreground); background:var(--vscode-editor-background); padding:12px 16px; }
  .panel { background:var(--vscode-sideBar-background,#252526); border-radius:6px; padding:12px 14px; margin-bottom:12px; }
  h2 { font-size:13px; font-weight:600; margin-bottom:8px; }
  .stat-grid { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:8px; }
  .stat-pill { background:var(--vscode-badge-background,#4d4d4d); border-radius:4px; padding:4px 10px; font-size:11px; display:flex; flex-direction:column; align-items:center; }
  .val { font-weight:700; font-size:13px; margin-top:2px; }
  .skill-row { padding:4px 0; border-bottom:1px solid var(--vscode-widget-border,#3c3c3c); }
  .skill-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .cost { font-size:11px; opacity:.8; }
  .hint { font-size:11px; opacity:.7; padding-top:2px; }
  .note { font-size:11px; opacity:.7; font-style:italic; }
  .roi-high   { color:var(--vscode-charts-green,#4CAF50); }
  .roi-medium { color:var(--vscode-charts-yellow,#FFC107); }
  .roi-low    { color:var(--vscode-charts-red,#F44336); }
  code { font-family:var(--vscode-editor-font-family,monospace); font-size:10px; background:var(--vscode-badge-background,#333); padding:1px 4px; border-radius:2px; }
  .run-btn { background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none; padding:6px 14px; border-radius:3px; cursor:pointer; font-size:12px; }
  .score-ring { display:inline-flex; align-items:center; justify-content:center; width:64px; height:64px; border-radius:50%; border:4px solid ${efficiencyColor}; font-size:18px; font-weight:700; color:${efficiencyColor}; margin-right:12px; }
</style>
</head>
<body>
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
  <h1 style="margin:0;font-size:14px;font-weight:600">Context Efficiency Intelligence</h1>
  <button class="run-btn" onclick="vscode.postMessage({command:'runAnalysis'})">↻ Re-analyze</button>
</div>

${advisorHtml}

<div class="panel" style="margin-top:0">
  <h2 style="margin-top:0">Context Efficiency Score</h2>
  <div style="display:flex;align-items:center;margin-bottom:10px">
    <div class="score-ring">${efficiency.score}</div>
    <div>
      <div style="font-size:22px;font-weight:700;color:${efficiencyColor}">${efficiency.score}/100 (${efficiency.grade})</div>
      <div class="hint">Target: 80+ &nbsp;|&nbsp; Useful: ~${fmt(efficiency.usefulTokens)} &nbsp;|&nbsp; Wasted: ~${fmt(efficiency.wastedTokens)}</div>
      <div class="hint">Potential savings: ~${fmt(efficiency.potentialSavings)} tokens</div>
    </div>
  </div>
  <div class="stat-grid">
    <div class="stat-pill" title="Context pressure level from real-time MCP signals">
      <b>Context Pressure</b>
      <span class="val" style="color:${pressureColor}">${pressure.level.toUpperCase()} (${pressure.pressureScore})</span>
    </div>
    <div class="stat-pill"><b>Total MCP reads</b><span class="val">${efficiency.totalReadCount}</span></div>
    <div class="stat-pill"><b>Wasted reads</b><span class="val roi-low">${efficiency.wastedReadCount}</span></div>
    <div class="stat-pill"><b>Compact opportunities</b><span class="val ${analysis.compactOpportunities > 0 ? "roi-medium" : "roi-high"}">${analysis.compactOpportunities}</span></div>
  </div>
  ${pressure.reasons.map(r => `<div class="hint" style="margin-top:2px">· ${r}</div>`).join("")}
</div>

<div class="panel">
  <h2 style="margin-top:0">Efficiency Coach</h2>
  ${coachHtml}
</div>

<div class="panel">
  <details open>
    <summary style="cursor:pointer;font-size:12px;font-weight:600">Top Wasteful Files (Hot Files)</summary>
    <div style="margin-top:8px">${hotFilesRows}</div>
  </details>
</div>

<div class="panel">
  <details>
    <summary style="cursor:pointer;font-size:12px;font-weight:600">Repeated Reads (30-min window)</summary>
    <div style="margin-top:8px">${repeatedRows}</div>
  </details>
</div>

<div class="panel">
  <details>
    <summary style="cursor:pointer;font-size:12px;font-weight:600">Directory Scan Waste</summary>
    <div style="margin-top:8px">${dirRows}</div>
  </details>
</div>

${roiHtml}

<p class="note" style="margin-top:8px">
  Analysis window: 24h · Source: <code>mcp-usage.jsonl</code> · No new telemetry added.
  Artifacts: <code>hot-files.json</code>, <code>directory-cache.json</code>.
</p>

<script>
  const vscode = acquireVsCodeApi();
</script>
</body>
</html>`;
}

// ── Command registration ───────────────────────────────────────────────────────

export function registerContextEfficiencyCommands(deps: ContextEfficiencyCommandDeps): vscode.Disposable[] {
  const { context: _ctx, getTarget, log, refreshAll } = deps;

  return [
    // ── Phase 10: Show Context Efficiency Panel ────────────────────────────
    vscode.commands.registerCommand("claudeSkills.showContextEfficiency", async () => {
      recordFeatureUse("contextEfficiency");
      const target = getTarget();
      if (!target) { void notifyUserWarn("Claude Skills: open a workspace folder first."); return; }

      if (!efficiencyPanel) {
        efficiencyPanel = vscode.window.createWebviewPanel(
          "claudeSkillsContextEfficiency",
          "Context Efficiency",
          vscode.ViewColumn.Active,
          { enableScripts: true, retainContextWhenHidden: true }
        );
        efficiencyPanel.onDidDispose(() => { efficiencyPanel = undefined; });
        efficiencyPanel.webview.onDidReceiveMessage(
          async (msg: { command?: string }) => {
            const ws = getTarget();
            if (!ws) return;
            if (msg.command === "runAnalysis") {
              await vscode.commands.executeCommand("claudeSkills.runContextAnalysis");
            } else if (msg.command === "followCompactAdvice") {
              await vscode.commands.executeCommand("claudeSkills.followCompactAdvice");
            } else if (msg.command === "dismissCompactAdvice") {
              await vscode.commands.executeCommand("claudeSkills.dismissCompactAdvice");
            }
            if (efficiencyPanel) {
              efficiencyPanel.webview.html = buildEfficiencyWebviewHtml(ws);
            }
          }
        );
      }
      efficiencyPanel.webview.html = buildEfficiencyWebviewHtml(target);
      efficiencyPanel.reveal(vscode.ViewColumn.Active);

      // Phase 11 — auto-optimize: if enabled, surface advisor automatically
      const cfg = vscode.workspace.getConfiguration("claudeSkills.contextEfficiency");
      if (cfg.get<boolean>("autoOptimize", false)) {
        const analysis = analyzeContextEfficiency(target, 24);
        const advisor  = evaluateCompactAdvisor(analysis);
        if (advisor.shouldShow) {
          const choice = await vscode.window.showInformationMessage(
            `⚠ Context Efficiency: ${advisor.triggerReason}`,
            "Run /compact now", "Dismiss"
          );
          if (choice === "Run /compact now") {
            await vscode.commands.executeCommand("claudeSkills.followCompactAdvice");
          } else {
            await vscode.commands.executeCommand("claudeSkills.dismissCompactAdvice");
          }
        }
      }
    }),

    // ── Run Context Analysis ───────────────────────────────────────────────
    vscode.commands.registerCommand("claudeSkills.runContextAnalysis", async () => {
      const target = getTarget();
      if (!target) { void notifyUserWarn("Claude Skills: open a workspace folder first."); return; }

      const analysis = analyzeContextEfficiency(target, 24);
      const advisor  = evaluateCompactAdvisor(analysis);
      const coaching = buildCoachingMessages(analysis);

      log(`\n=== Context Efficiency Analysis ===`);
      log(`Efficiency score:    ${analysis.efficiency.score}/100 (${analysis.efficiency.grade})`);
      log(`Context pressure:    ${analysis.pressure.level} (${analysis.pressure.pressureScore})`);
      log(`Total MCP tokens:    ~${Math.round(analysis.efficiency.totalTokens / 1_000)}k`);
      log(`Wasted tokens:       ~${Math.round(analysis.efficiency.wastedTokens / 1_000)}k`);
      log(`Potential savings:   ~${Math.round(analysis.efficiency.potentialSavings / 1_000)}k`);
      log(`Hot files:           ${analysis.hotFiles.length}`);
      log(`Repeated reads:      ${analysis.repeatedReads.length}`);
      log(`Dir scan waste:      ${analysis.directoryScanWaste.length}`);
      log(`Compact opps:        ${analysis.compactOpportunities}`);

      if (coaching.length > 0) {
        log(`\nCoaching (${coaching.length} action${coaching.length > 1 ? "s" : ""}):`);
        for (const m of coaching) {
          log(`  [${m.priority.toUpperCase()}] ~${Math.round(m.estimatedSavingsTokens / 1_000)}k — ${m.message}`);
        }
      }

      if (advisor.shouldShow) {
        recordAdvisorEvent(target, "shown", {
          estimatedSavingsTokens: advisor.estimatedTokensSaved,
          triggerReason: advisor.triggerReason,
        });
        currentAdvisorEstimate = advisor.estimatedTokensSaved;
        currentAdvisorReason   = advisor.triggerReason;
        void notifyUserSuccess(
          `Claude Skills: ${analysis.pressure.level.toUpperCase()} context pressure — ${advisor.triggerReason}. Open Context Efficiency for details.`
        );
      } else {
        void notifyUserSuccess(
          `Claude Skills: Context Efficiency ${analysis.efficiency.score}/100 — no compact action needed now.`
        );
      }
      refreshAll();
    }),

    // ── Phase 9: Follow Compact Advice ────────────────────────────────────
    vscode.commands.registerCommand("claudeSkills.followCompactAdvice", async () => {
      const target = getTarget();
      if (!target) return;
      recordAdvisorEvent(target, "followed", {
        estimatedSavingsTokens: currentAdvisorEstimate,
        triggerReason: currentAdvisorReason,
      });
      log(`Context Advisor: user followed /compact recommendation (~${Math.round(currentAdvisorEstimate / 1_000)}k tokens saved estimate)`);
      // Copy /compact to clipboard so user can paste it into Claude
      await vscode.env.clipboard.writeText("/compact");
      void notifyUserSuccess("Claude Skills: /compact copied to clipboard — paste it in your Claude session.");
    }),

    // ── Phase 9: Dismiss Compact Advice ───────────────────────────────────
    vscode.commands.registerCommand("claudeSkills.dismissCompactAdvice", () => {
      const target = getTarget();
      if (!target) return;
      recordAdvisorEvent(target, "dismissed", {
        estimatedSavingsTokens: currentAdvisorEstimate,
        triggerReason: currentAdvisorReason,
      });
      log(`Context Advisor: dismissed (${currentAdvisorReason || "no reason"})`);
    }),
  ];
}
