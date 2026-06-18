import * as path from "node:path";
import * as crypto from "node:crypto";
import * as vscode from "vscode";
import {
  buildCostAttribution,
  formatAttributionReport,
  persistCostAttribution,
  resolveDisplayAttribution,
} from "./costAttribution";
import { getOptimalAgent, formatRoutingSuggestion } from "./costRouter";
import { computeEnabledAgentsCreditUsage } from "./agentOps";
import { agentCapabilityLines } from "./agentOps";
import {
  computeSuggestedSkills,
  enrichUsageStatsWithAttribution,
  ensureLearningDir,
  formatUsageReport,
  formatUsageReportHtml,
  listInstalledSkills,
} from "./usageStats";
import { mirrorLearningArtifacts } from "./agentOps";
import { computeSkillInefficiencyStats } from "./skillFeedback";
import { readTaskSkillProposals, resolveTaskSkillProposals } from "./taskSkillProposals";
import { assessAttributionHealth } from "./attributionHealth";
import { buildGlobalTrustBadge } from "./attributionTrust";
import { buildUsageSkillConfidenceMap } from "./attributionConfidence";
import { listSkillVersionStatuses } from "./skillLifecycle";
import { readSkillStatsIndex } from "./runsIndex";
import { generateLatestSessionBreakdown } from "./sessionBreakdown";
import { computeEfficiencyMetrics, formatEfficiencyReport, TelemetryScope } from "./efficiencyMetrics";
import { generateOptimizationSuggestions, formatSuggestionsReport, OptimizationType } from "./costOptimizer";
import { applyOptimizationSuggestions, applySingleOptimizationSuggestion } from "./autoOptimizer";
import {
  formatCostDashboardHtml,
  formatCostDashboardText,
  formatTeamEconomicsPanelsHtml,
  getOrBuildDashboardMainBody,
} from "./costDashboard";
import {
  buildDashboardSnapshotFingerprint,
  tryReadValidDashboardSnapshot,
} from "./dashboardSnapshotCache";
import { runCostPipeline, runCostPipelineSync } from "./costPipeline";
import { readPipelineCycle } from "./pipelineCycle";
import { buildSystemModeContext } from "./systemMode";
import { resetMisattributedData } from "./attributionReset";
import { AttributionCollector } from "./attributionCollector";
import { updateLocalBenchmarks, uploadAnonymizedStats } from "./communityBenchmarks";
import { getOrComputeTeamEconomicsBundle } from "./teamEconomicsCache";
import { propagateWorkspaceSkillChange } from "./workspaceSkillSync";
import { formatHookStatusPlain } from "./workspaceHookStatus";
import { getWorkspaceHookStatus } from "./hookOps";
import { autoReconcileCursorCostsFromDownloads, reconcileCursorCosts } from "./cursorUsageImport";
import { formatCompactUsd } from "./skillCost";
import { loadManifest } from "./skillOps";
import { isFeatureEnabled } from "./featureFlags";
import { checkEmergencyCutoff, resetEmergencyCutoff } from "./emergencyCutoff";
import { estimateAndCommentPR } from "./prCostEstimate";
import { configureWeeklyReportEmail, deliverWeeklyReport } from "./weeklyReport";
import { scheduleCostPipelineSync } from "./costPipelineScheduler";
import { yieldToEventLoop } from "./eventLoop";
import { recordError, recordFeatureUse } from "./analytics";
import { notifyUserSuccess, notifyUserWarn } from "./userNotify";
import { CostPipelineResult } from "./costPipeline";
import { ExtensionSharedContext } from "./extensionSharedContext";

// Panel state is local to this module — only cost commands open/manage these panels.
let usagePanel: vscode.WebviewPanel | undefined;
let costDashboardPanel: vscode.WebviewPanel | undefined;
let costDashboardMessageSub: vscode.Disposable | undefined;

async function enhanceCostDashboardPanel(
  target: string,
  libraryDir: string,
  pipeline: CostPipelineResult,
  panel: vscode.WebviewPanel,
  hadMainSnapshot: boolean
): Promise<void> {
  if (!hadMainSnapshot) {
    await yieldToEventLoop();
    const main = getOrBuildDashboardMainBody(target, libraryDir, pipeline);
    panel.webview.postMessage({ command: "dashboardMainHtml", html: main.mainBodyHtml });
  }
  await pushTeamEconomicsToDashboard(target, libraryDir, panel);
}

async function pushTeamEconomicsToDashboard(
  target: string,
  libraryDir: string,
  panel: vscode.WebviewPanel
): Promise<void> {
  const built = buildCostAttribution(target, libraryDir);
  const { attribution, staleEqualSplit } = resolveDisplayAttribution(built, target);
  const health = assessAttributionHealth(target, libraryDir);
  const modeCtx = buildSystemModeContext(health, target, readPipelineCycle(target));
  if (!modeCtx.canShowPerSkillCosts || staleEqualSplit || !isFeatureEnabled("teamCostSharing")) {
    panel.webview.postMessage({ command: "teamEconomicsHtml", html: "" });
    return;
  }
  await yieldToEventLoop();
  const manifest = loadManifest(libraryDir);
  const bundle = getOrComputeTeamEconomicsBundle(target, libraryDir, manifest, attribution);
  panel.webview.postMessage({
    command: "teamEconomicsHtml",
    html: formatTeamEconomicsPanelsHtml(bundle, true),
  });
}

export function registerCostCommands(shared: ExtensionSharedContext): void {
  const {
    context, libraryDir, log, getWorkspaceTarget,
    refreshAll, revealOutputPanel, maybeRevealOutputPanel,
  } = shared;

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSkills.showUsageStats", async () => {
      const target = getWorkspaceTarget();
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
      const skillConfidence = buildUsageSkillConfidenceMap(target, stats.map((s) => s.name));
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
      const effScope = vscode.workspace
        .getConfiguration("claudeSkills.telemetry")
        .get<TelemetryScope>("scope", "hybrid");
      log(formatEfficiencyReport(computeEfficiencyMetrics(target, 14, effScope)));
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
      const target = getWorkspaceTarget();
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
        const { readFileSync } = await import("node:fs");
        const csvContent = readFileSync(file.fsPath, "utf-8");
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

    vscode.commands.registerCommand("claudeSkills.showCostDashboard", async () => {
      recordFeatureUse("costDashboard");
      if (!isFeatureEnabled("costIntelligence")) {
        vscode.window.showWarningMessage("Claude Skills: cost intelligence is disabled (claudeSkills.features.costIntelligence).");
        return;
      }
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      ensureLearningDir(target);
      const pipeline = await runCostPipeline(target, libraryDir, {
        collect: isFeatureEnabled("attributionCollector"),
        forceCollect: true,
      });
      persistCostAttribution(target, libraryDir);
      const built = buildCostAttribution(target, libraryDir);
      const merged = { ...built.skills, ...built.transcriptSkills };
      updateLocalBenchmarks(merged);
      void uploadAnonymizedStats(merged);
      const dashboardNonce = crypto.randomBytes(16).toString("base64");
      const hadMainSnapshot = Boolean(tryReadValidDashboardSnapshot(target, pipeline));
      const html = formatCostDashboardHtml(target, libraryDir, dashboardNonce, pipeline, {
        fastPhase: true,
        includeTeamEconomics: false,
      });
      if (!costDashboardPanel) {
        costDashboardPanel = vscode.window.createWebviewPanel(
          "claudeSkillsCostDashboard",
          "Claude Skills Cost Intelligence",
          vscode.ViewColumn.Active,
          { enableScripts: true, retainContextWhenHidden: true }
        );
        costDashboardMessageSub?.dispose();
        costDashboardMessageSub = costDashboardPanel.webview.onDidReceiveMessage(
          async (msg: { command?: string; skill?: string; type?: string }) => {
            const ws = getWorkspaceTarget();
            if (!ws) return;
            if (msg.command === "applyOptimizations") {
              const health = assessAttributionHealth(ws, libraryDir);
              const modeCtx = buildSystemModeContext(health, ws, readPipelineCycle(ws));
              if (!modeCtx.canApplyOptimizations) {
                vscode.window.showWarningMessage(
                  modeCtx.banner ?? "Claude Skills: optimizations paused until attribution pipeline is ready."
                );
                return;
              }
              await vscode.commands.executeCommand("claudeSkills.applyOptimizations");
            } else if (msg.command === "applySuggestion" && msg.skill && msg.type) {
              const health = assessAttributionHealth(ws, libraryDir);
              const modeCtx = buildSystemModeContext(health, ws, readPipelineCycle(ws));
              if (!modeCtx.canApplyOptimizations) {
                vscode.window.showWarningMessage(
                  modeCtx.banner ?? "Claude Skills: optimizations paused until attribution pipeline is ready."
                );
                return;
              }
              const result = await applySingleOptimizationSuggestion(
                ws, libraryDir, msg.skill, msg.type as OptimizationType
              );
              if (result.applied.length > 0) {
                propagateWorkspaceSkillChange(context.extensionPath, ws, libraryDir, log);
                refreshAll();
                const refreshNonce = crypto.randomBytes(16).toString("base64");
                const refreshPipeline = runCostPipelineSync(ws, libraryDir);
                const hadSnap = Boolean(tryReadValidDashboardSnapshot(ws, refreshPipeline));
                costDashboardPanel!.webview.html = formatCostDashboardHtml(
                  ws, libraryDir, refreshNonce, refreshPipeline,
                  { fastPhase: true, includeTeamEconomics: false }
                );
                void enhanceCostDashboardPanel(ws, libraryDir, refreshPipeline, costDashboardPanel!, hadSnap);
                void notifyUserSuccess(`Claude Skills: ${result.applied[0]}`);
              } else {
                vscode.window.showWarningMessage(`Claude Skills: could not apply suggestion for ${msg.skill}.`);
              }
            } else if (msg.command === "exportReport") {
              await vscode.commands.executeCommand("claudeSkills.exportCostReport");
            } else if (msg.command === "openBudget") {
              await vscode.commands.executeCommand("claudeSkills.openBudgetSettings");
            } else if (msg.command === "clearMcpLogs") {
              await vscode.commands.executeCommand("claudeSkills.clearMcpLogs");
            } else if (msg.command === "applyMcpAutoFixes") {
              await vscode.commands.executeCommand("claudeSkills.applyMcpAutoFixes");
            }
          }
        );
        costDashboardPanel.onDidDispose(() => {
          costDashboardMessageSub?.dispose();
          costDashboardMessageSub = undefined;
          costDashboardPanel = undefined;
        });
      }
      costDashboardPanel.webview.html = html;
      costDashboardPanel.reveal(vscode.ViewColumn.Active);
      void enhanceCostDashboardPanel(target, libraryDir, pipeline, costDashboardPanel, hadMainSnapshot);
      log(`\n${formatCostDashboardText(target, libraryDir)}`);
    }),

    vscode.commands.registerCommand("claudeSkills.showOptimizationSuggestions", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const suggestions = generateOptimizationSuggestions(target, libraryDir);
      revealOutputPanel();
      log("\n=== Cost optimization suggestions ===");
      log(formatSuggestionsReport(suggestions).join("\n"));
      if (suggestions.length === 0) {
        void notifyUserSuccess("Claude Skills: no optimization suggestions yet.");
      } else {
        const apply = await vscode.window.showInformationMessage(
          `${suggestions.length} optimization suggestion(s) — apply selected?`,
          "Apply",
          "Dismiss"
        );
        if (apply === "Apply") {
          await vscode.commands.executeCommand("claudeSkills.applyOptimizations");
        }
      }
    }),

    vscode.commands.registerCommand("claudeSkills.applyOptimizations", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const health = assessAttributionHealth(target, libraryDir);
      const modeCtx = buildSystemModeContext(health, target, readPipelineCycle(target));
      if (!modeCtx.canApplyOptimizations) {
        vscode.window.showWarningMessage(modeCtx.banner ?? `Claude Skills: ${health.summary}`);
        return;
      }
      const suggestions = generateOptimizationSuggestions(target, libraryDir);
      const result = await applyOptimizationSuggestions(target, libraryDir, suggestions);
      maybeRevealOutputPanel();
      log("\n=== Apply optimizations ===");
      log(result.applied.join("\n") || "(none applied)");
      if (result.skipped.length > 0) {
        log(`Skipped: ${result.skipped.join(", ")}`);
      }
      refreshAll();
      void notifyUserSuccess(`Claude Skills: applied ${result.applied.length} optimization(s).`);
    }),

    vscode.commands.registerCommand("claudeSkills.exportCostReport", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        return;
      }
      const health = assessAttributionHealth(target, libraryDir);
      const text = [
        formatCostDashboardText(target, libraryDir),
        "",
        ...formatSuggestionsReport(generateOptimizationSuggestions(target, libraryDir), {
          attributionSummary: health.reliable
            ? undefined
            : `Per-skill attribution not reliable yet: ${health.summary}`,
        }),
      ].join("\n");
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(target, "claude-skills-cost-report.txt")),
        filters: { Text: ["txt", "md"] },
      });
      if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf-8"));
        void notifyUserSuccess(`Cost report saved to ${uri.fsPath}`);
      }
    }),

    vscode.commands.registerCommand("claudeSkills.resetEmergencyCutoff", async () => {
      await resetEmergencyCutoff(getWorkspaceTarget());
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.estimatePRCost", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        return;
      }
      const pr = await vscode.window.showInputBox({ prompt: "PR number", placeHolder: "42" });
      if (!pr) {
        return;
      }
      await estimateAndCommentPR(target, libraryDir, parseInt(pr, 10));
    }),

    vscode.commands.registerCommand("claudeSkills.configureWeeklyReportEmail", async () => {
      const target = getWorkspaceTarget();
      const message = await configureWeeklyReportEmail(context, target);
      maybeRevealOutputPanel();
      log(`\n=== Configure weekly report email ===\n${message}`);
      void notifyUserSuccess(message.split("\n")[0] ?? message);
    }),

    vscode.commands.registerCommand("claudeSkills.sendWeeklyReport", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      maybeRevealOutputPanel();
      log("\n=== Send weekly AI usage report ===");
      const result = await deliverWeeklyReport(context, target, libraryDir);
      if (result.email.ok) {
        log(`Email sent to ${result.email.to}`);
        void notifyUserSuccess(`Claude Skills: weekly report emailed to ${result.email.to}.`);
      } else {
        log(`Email failed: ${result.email.error ?? "n/a"}`);
        vscode.window.showWarningMessage(
          result.email.error ?? "Weekly report could not be sent. Run Configure Weekly Report Email."
        );
      }
    }),

    vscode.commands.registerCommand("claudeSkills.resetAttribution", async () => {
      const target = getWorkspaceTarget();
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
      await AttributionCollector.getInstance(target, libraryDir).collect(true);
      runCostPipelineSync(target, libraryDir);
      persistCostAttribution(target, libraryDir);
      refreshAll();
      void notifyUserSuccess(
        `Claude Skills: removed ${result.removedRuns} transcript estimate row(s); kept ${result.keptRuns} hook/self-learning run(s). Reopen Usage Report to refresh.`
      );
    })
  );
}
