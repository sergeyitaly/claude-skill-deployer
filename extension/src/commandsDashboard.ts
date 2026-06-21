import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { assessAttributionHealth } from "./attributionQuality";
import {
  buildCostAttribution,
  formatAttributionReport,
  persistCostAttribution,
  resolveDisplayAttribution,
} from "./costAttribution";
import {
  formatCostDashboardHtml,
  formatCostDashboardText,
  formatTeamEconomicsPanelsHtml,
  getOrBuildDashboardMainBody,
} from "./costDashboard";
import { generateOptimizationSuggestions, formatSuggestionsReport, OptimizationType } from "./costOptimizer";
import { applyOptimizationSuggestions, applySingleOptimizationSuggestion } from "./autoOptimizer";
import { runCostPipeline, runCostPipelineSync } from "./costPipeline";
import { readPipelineCycle } from "./pipelineCycle";
import { tryReadValidDashboardSnapshot } from "./dashboardPrecompute";
import { recordFeatureUse } from "./analytics";
import { getOrComputeTeamEconomicsBundle } from "./dashboardPrecompute";
import { buildSystemModeContext } from "./attributionQuality";
import { notifyUserSuccess, notifyUserWarn } from "./userNotify";
import { loadManifest } from "./skillOps";
import { propagateWorkspaceSkillChange } from "./workspaceSkillSync";
import { ensureLearningDir } from "./usageStats";
import { yieldToEventLoop } from "./eventLoop";

// ---------------------------------------------------------------------------
// Panel state
// ---------------------------------------------------------------------------

let costDashboardPanel: vscode.WebviewPanel | undefined;
let costDashboardMessageSub: vscode.Disposable | undefined;

export function getCostDashboardPanel(): vscode.WebviewPanel | undefined {
  return costDashboardPanel;
}

// ---------------------------------------------------------------------------
// Phase-2 helpers
// ---------------------------------------------------------------------------

async function enhanceCostDashboardPanel(
  target: string,
  libraryDir: string,
  pipeline: import("./costPipeline").CostPipelineResult,
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
  if (!modeCtx.canShowPerSkillCosts || staleEqualSplit) {
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

// ---------------------------------------------------------------------------
// Exported deps type
// ---------------------------------------------------------------------------

export interface DashboardCommandDeps {
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

export function registerDashboardCommands(deps: DashboardCommandDeps): vscode.Disposable[] {
  const { context, libraryDir, getTarget, log, refreshAll, revealOutputPanel, maybeRevealOutputPanel } = deps;

  return [
    vscode.commands.registerCommand("claudeSkills.showCostDashboard", async () => {
      recordFeatureUse("costDashboard");
      const target = getTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      ensureLearningDir(target);
      // GAP 8: only force-collect when attribution has changed since last cycle —
      // avoids invalidating the dashboard snapshot fingerprint on every open.
      const lastCycle = readPipelineCycle(target);
      const { attributionFileFingerprint } = await import("./pipelineCycle.js");
      const attrNow = attributionFileFingerprint(target);
      const attrChanged = attrNow.mtimeMs !== (lastCycle.attributionMtime ?? 0);
      const pipeline = await runCostPipeline(target, libraryDir, {
        collect: true,
        forceCollect: attrChanged,
      });
      persistCostAttribution(target, libraryDir);
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
            const ws = getTarget();
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
      const target = getTarget();
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
          "Apply", "Dismiss"
        );
        if (apply === "Apply") {
          await vscode.commands.executeCommand("claudeSkills.applyOptimizations");
        }
      }
    }),

    vscode.commands.registerCommand("claudeSkills.applyOptimizations", async () => {
      const target = getTarget();
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
      if (result.skipped.length > 0) log(`Skipped: ${result.skipped.join(", ")}`);
      refreshAll();
      void notifyUserSuccess(`Claude Skills: applied ${result.applied.length} optimization(s).`);
    }),

    vscode.commands.registerCommand("claudeSkills.exportCostReport", async () => {
      const target = getTarget();
      if (!target) return;
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
        void notifyUserSuccess(`Cost report saved to ${uri.fsPath}`, log);
      }
    }),
  ];
}
