import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { loadManifest } from "./skillOps";
import {
  AttributionCollector,
} from "./attributionCollector";
import {
  buildCostAttribution,
  formatAttributionReport,
  persistCostAttribution,
  resolveDisplayAttribution,
} from "./costAttribution";
import { assessAttributionHealth } from "./attributionQuality";
import {
  computeSuggestedSkills,
  enrichUsageStatsWithAttribution,
  ensureLearningDir,
  formatUsageReport,
  formatUsageReportHtml,
  formatTokenCount,
  listInstalledSkills,
} from "./usageStats";
import { computeSkillInefficiencyStats } from "./skillFeedback";
import { readTaskSkillProposals, resolveTaskSkillProposals } from "./taskSkillProposals";
import { computeEnabledAgentsCreditUsage, agentCapabilityLines, mirrorLearningArtifacts } from "./agentOps";
import { buildUsageSkillConfidenceMap } from "./attributionQuality";
import { getWorkspaceHookStatus } from "./hookOps";
import { buildGlobalTrustBadge } from "./attributionQuality";
import { listSkillVersionStatuses } from "./skillLifecycle";
import { readSkillStatsIndex } from "./runsStore";
import { getOptimalAgent, formatRoutingSuggestion } from "./costRouter";
import { generateLatestSessionBreakdown } from "./sessionBreakdown";
import { computeEfficiencyMetrics, formatEfficiencyReport } from "./efficiencyMetrics";
import { formatAdoptionReport } from "./skillAdoption";
import { reconcileCursorCosts } from "./cursorUsageImport";
import { formatCompactUsd } from "./skillCost";
import { notifyUserSuccess, notifyUserWarn } from "./userNotify";
import { formatHookStatusPlain } from "./workspaceHookStatus";

import { resetMisattributedData } from "./costAttribution";
import { runCostPipelineSync } from "./costPipeline";
import { recordError } from "./analytics";
import { appendAdaptationEvent } from "./adaptationLog";

// ---------------------------------------------------------------------------
// Panel state
// ---------------------------------------------------------------------------

let usagePanel: vscode.WebviewPanel | undefined;

export function getUsagePanel(): vscode.WebviewPanel | undefined {
  return usagePanel;
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface UsageCommandDeps {
  context: vscode.ExtensionContext;
  libraryDir: string;
  getTarget: () => string | undefined;
  log: (line: string) => void;
  refreshAll: () => void;
  revealOutputPanel: () => void;
  maybeRevealOutputPanel: () => void;
}

// ---------------------------------------------------------------------------
// Command registrations
// ---------------------------------------------------------------------------

export function registerUsageCommands(deps: UsageCommandDeps): vscode.Disposable[] {
  const { context, libraryDir, getTarget, log, refreshAll, revealOutputPanel, maybeRevealOutputPanel } = deps;

  return [
    vscode.commands.registerCommand("claudeSkills.showUsageStats", async () => {
      const target = getTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      ensureLearningDir(target);
      const manifest = loadManifest(libraryDir);
      const mirrored = mirrorLearningArtifacts(target, libraryDir);
      await AttributionCollector.getInstance(target, libraryDir).collect(true);
      persistCostAttribution(target, libraryDir);
      const built = buildCostAttribution(target, libraryDir);
      const { attribution } = resolveDisplayAttribution(built, target);
      const health = assessAttributionHealth(target, libraryDir);
      const stats = enrichUsageStatsWithAttribution(readSkillStatsIndex(target, manifest), attribution);
      const suggested = computeSuggestedSkills(target, manifest);
      const installedNames = listInstalledSkills(target);
      const inefficiency = computeSkillInefficiencyStats(target, installedNames);
      const savedProposals = readTaskSkillProposals(target);
      const taskProposals = resolveTaskSkillProposals(target, manifest);
      const creditUsage = computeEnabledAgentsCreditUsage(libraryDir, 14, target);
      const skillConfidence = buildUsageSkillConfidenceMap(
        target,
        stats.map((s) => s.name)
      );
      const hookStatus = getWorkspaceHookStatus(target, libraryDir);
      const globalTrust = buildGlobalTrustBadge(health, hookStatus);
      const versionStatuses = listSkillVersionStatuses(libraryDir, target);
      const reportOpts = {
        skillConfidence,
        workspaceConfidence: {
          score: health.confidenceScore,
          level: health.confidenceLevel,
          summary: health.summary,
          v2Coverage: 0,
        },
        globalTrust,
        versionStatuses,
        manifest,
        inefficiency,
        taskProposals,
        taskSummary: savedProposals?.taskSummary,
      };

      revealOutputPanel();
      log(`\n=== Skill usage report for ${target} ===`);
      log(formatUsageReport(stats, suggested, target, creditUsage, reportOpts));
      log(
        formatAttributionReport(
          built.skills,
          built.agentTotals,
          built.base_context,
          built.transcriptSkills,
          built.unattributed,
          target
        ).join("\n")
      );
      const sessionBreakdown = generateLatestSessionBreakdown(target);
      if (sessionBreakdown) {
        log("\n## Session cost breakdown (latest)\n");
        log(sessionBreakdown);
      }
      log(formatEfficiencyReport(computeEfficiencyMetrics(target, 14)));
      log(formatAdoptionReport(target));
      const topSkill = stats.filter((s) => s.runs > 0).sort((a, b) => b.runs - a.runs)[0];
      if (topSkill) {
        const agent = getOptimalAgent(topSkill.name, attribution);
        log(formatRoutingSuggestion(topSkill.name, attribution, agent));
      }
      if (mirrored.length > 0) {
        log(`\nMirrored learning artifacts to: ${mirrored.join(", ")}`);
      }
      log("\n## Enabled AI agents\n");
      log(agentCapabilityLines(libraryDir).join("\n"));
      log("\n## Workspace hooks\n");
      log(formatHookStatusPlain(getWorkspaceHookStatus(target, libraryDir)));

      const html = formatUsageReportHtml(
        stats,
        suggested,
        target,
        creditUsage,
        hookStatus,
        reportOpts
      );
      if (usagePanel) {
        usagePanel.webview.html = html;
        usagePanel.reveal(vscode.ViewColumn.Active);
      } else {
        usagePanel = vscode.window.createWebviewPanel(
          "claudeSkillsUsage",
          "Claude Skills Usage",
          vscode.ViewColumn.Active,
          {}
        );
        usagePanel.webview.html = html;
        usagePanel.onDidDispose(() => {
          usagePanel = undefined;
        });
      }
    }),

    vscode.commands.registerCommand("claudeSkills.importCursorUsageCsv", async () => {
      const target = getTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const picked = await vscode.window.showOpenDialog({
        title: "Import Cursor usage CSV (Settings -> Usage -> Export) to reconcile costs",
        canSelectMany: false,
        filters: { "CSV files": ["csv"] },
        openLabel: "Reconcile costs",
      });
      const file = picked?.[0];
      if (!file) {
        return;
      }
      try {
        const csvContent = fs.readFileSync(file.fsPath, "utf-8");
        const result = reconcileCursorCosts(target, csvContent);
        maybeRevealOutputPanel();
        log(`\n=== Cursor usage CSV reconciliation (${path.basename(file.fsPath)}) ===`);
        log(
          `CSV: ${result.csvRows} row(s) totaling ${formatCompactUsd(result.csvTotalUsd)} across ${result.matchedDates.length + result.unmatchedCsvDates.length} day(s).`
        );
        if (result.rowsUpdated > 0) {
          log(
            `Reconciled ${result.rowsUpdated} cursor run(s) on ${result.matchedDates.join(", ")}: estimate ${formatCompactUsd(result.estimatedTotalUsd)} -> actual ${formatCompactUsd(result.reconciledTotalUsd)}.`
          );
        }
        if (result.unmatchedCsvDates.length > 0) {
          log(`No matching cursor runs in runs.jsonl for: ${result.unmatchedCsvDates.join(", ")}.`);
        }
        if (result.rowsUpdated === 0) {
          void notifyUserWarn(
            "Claude Skills: no matching Cursor runs found in runs.jsonl for the dates in this CSV — costs were not changed."
          );
        } else {
          void notifyUserSuccess(
            `Claude Skills: reconciled ${result.rowsUpdated} Cursor run(s) against actual billing (${formatCompactUsd(result.estimatedTotalUsd)} -> ${formatCompactUsd(result.reconciledTotalUsd)}).`
          );
        }
      } catch (err) {
        recordError();
        vscode.window.showWarningMessage(`Claude Skills: could not reconcile Cursor usage CSV - ${(err as Error).message}`);
      }
    }),



    vscode.commands.registerCommand("claudeSkills.resetAttribution", async () => {
      const target = getTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        "Reset mis-attributed cost data? This removes collector-generated transcript rows and clears transcriptSkills so attribution can be re-collected.",
        { modal: true },
        "Reset"
      );
      if (confirm !== "Reset") {
        return;
      }
      const result = resetMisattributedData(target);
      appendAdaptationEvent(target, {
        type: "attribution_reset",
        description: `Attribution data reset — removed ${result.removedRuns} transcript estimate row(s), kept ${result.keptRuns} hook/self-learning run(s)`,
      });
      await AttributionCollector.getInstance(target, libraryDir).collect(true);
      runCostPipelineSync(target, libraryDir);
      persistCostAttribution(target, libraryDir);
      refreshAll();
      void notifyUserSuccess(
        `Claude Skills: removed ${result.removedRuns} transcript estimate row(s); kept ${result.keptRuns} hook/self-learning run(s). Reopen Usage Report to refresh.`
      );
    }),
  ];
}

