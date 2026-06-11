import * as vscode from "vscode";
import * as path from "node:path";
import {
  copySkill,
  generateForWorkspace,
  globalSkillsDir,
  installLibraryToGlobal,
  listSkillStatuses,
  loadManifest,
  removeSkill,
  setSkillOverride,
} from "./skillOps";
import { SkillItem, SkillsProvider } from "./skillsProvider";
import { computeSuggestedSkills, computeUsageStats, ensureLearningDir, formatUsageReport, formatUsageReportHtml } from "./usageStats";
import {
  agentCapabilityLines,
  formatAgentInstallSummary,
  generateForAllAgents,
  installLibraryToAllAgents,
  mirrorLearningArtifacts,
  computeEnabledAgentsCreditUsage,
} from "./agentOps";
import { computeCreditUsage } from "./usageCost";
import { formatCompactUsd, sumInstallCostEstimate, tierForSkill } from "./skillCost";
import { formatTokenCount } from "./usageStats";
import { BudgetMode, budgetUsagePercent, configFromVsCodeSettings, syncBudgetConfigToDisk } from "./budgetConfig";
import { clearBudgetTrackingForSkill, syncAndApplyBudgetMode } from "./budgetOps";
import {
  applyBranchProfile,
  formatBranchProfilesReport,
  getCurrentBranch,
  handleBranchChange,
  initBranchTracking,
  loadBranchProfile,
  saveBranchProfile,
} from "./branchProfiles";
import { installCostControlHooks, installSessionWatchHook } from "./hookOps";

let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let usageStatusBarItem: vscode.StatusBarItem;
let creditStatusBarItem: vscode.StatusBarItem;
let budgetModeStatusBarItem: vscode.StatusBarItem;
let usagePanel: vscode.WebviewPanel | undefined;

const BUDGET_MODE_CYCLE: BudgetMode[] = ["economy", "normal", "unlimited"];
const BUDGET_MODE_LABEL: Record<BudgetMode, string> = {
  economy: "Economy",
  normal: "Normal",
  unlimited: "Unlimited",
};

function getWorkspaceTarget(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function log(line: string) {
  outputChannel.appendLine(line);
}

function persistBranchProfile(target: string | undefined): void {
  if (!target) {
    return;
  }
  saveBranchProfile(target);
}

function refreshStatusBar(libraryDir: string) {
  const target = getWorkspaceTarget();
  if (!target) {
    statusBarItem.hide();
    return;
  }
  const statuses = listSkillStatuses(libraryDir, target);
  const pending = statuses.filter((s) => s.isRelevant && !s.installedInWorkspace);
  const branch = getCurrentBranch(target);
  const branchSuffix = branch ? ` [${branch}]` : "";
  if (pending.length === 0) {
    statusBarItem.text = `$(check) Claude Skills${branchSuffix}`;
    statusBarItem.tooltip =
      `All relevant Claude skills are installed for this workspace${branch ? ` (branch: ${branch})` : ""}.`;
  } else {
    statusBarItem.text = `$(lightbulb) Claude Skills: ${pending.length} suggested${branchSuffix}`;
    statusBarItem.tooltip =
      `${pending.length} relevant skill(s) not yet installed:\n` +
      pending.map((s) => `- ${s.name}`).join("\n") +
      (branch ? `\n\nBranch: ${branch} (skill profile stored in ~/.claude/learning/branch-profiles.json).` : "") +
      "\n\nClick to install.";
  }
  statusBarItem.command = "claudeSkills.generateForWorkspace";
  statusBarItem.show();
}

function refreshCreditStatusBar(libraryDir: string) {
  const manifest = loadManifest(libraryDir);
  const config = configFromVsCodeSettings(manifest);
  const summary = computeEnabledAgentsCreditUsage(libraryDir, 1);
  const today = new Date().toISOString().slice(0, 10);
  const todayRow = summary.byDay.find((d) => d.date === today);
  const totalTokens = todayRow
    ? todayRow.inputTokens + todayRow.outputTokens + todayRow.cacheCreationTokens + todayRow.cacheReadTokens
    : 0;
  const totalCost = todayRow?.cost ?? 0;
  const pct = budgetUsagePercent(totalCost, config);

  if (totalTokens === 0) {
    creditStatusBarItem.text = "$(credit-card) Claude: no usage today";
    creditStatusBarItem.tooltip =
      "No recorded Claude Code token usage today. Estimates use published API rates for reference (Pro/Max plans are flat-rate).\n\nClick for the full usage report.";
  } else {
    const budgetSuffix =
      config.dailyBudgetUsd > 0 && pct !== null ? ` (${Math.round(pct)}% of ${formatCompactUsd(config.dailyBudgetUsd)} budget)` : "";
    creditStatusBarItem.text = `$(credit-card) ${formatCompactUsd(totalCost)} today | ${formatTokenCount(totalTokens)}`;
    creditStatusBarItem.tooltip =
      `Estimated Claude usage today: ${formatTokenCount(totalTokens)} tokens (~${formatCompactUsd(totalCost)})${budgetSuffix}. Based on session transcripts, not an actual bill.\n\nClick for the full usage report.`;
  }
  creditStatusBarItem.command = "claudeSkills.showUsageStats";
  creditStatusBarItem.show();
}

function refreshBudgetModeStatusBar(libraryDir: string) {
  const manifest = loadManifest(libraryDir);
  const config = configFromVsCodeSettings(manifest);
  const mode = config.mode;
  const icon = mode === "economy" ? "$(leaf)" : mode === "unlimited" ? "$(rocket)" : "$(shield)";
  budgetModeStatusBarItem.text = `${icon} ${BUDGET_MODE_LABEL[mode]}`;
  budgetModeStatusBarItem.tooltip =
    `Budget mode: ${BUDGET_MODE_LABEL[mode]}. Daily cap: ${config.dailyBudgetUsd > 0 ? formatCompactUsd(config.dailyBudgetUsd) : "off"}. ` +
    `${config.highTierSkills.length} high-tier skill(s) tracked.\n\nClick to cycle mode (Economy -> Normal -> Unlimited).`;
  budgetModeStatusBarItem.command = "claudeSkills.cycleBudgetMode";
  budgetModeStatusBarItem.show();
}

function applyBudgetSettings(libraryDir: string, logLines: boolean): void {
  const target = getWorkspaceTarget();
  const manifest = loadManifest(libraryDir);
  const mode = configFromVsCodeSettings(manifest).mode;
  syncBudgetConfigToDisk(manifest);
  const { disabled, restored } = syncAndApplyBudgetMode(libraryDir, target, mode);
  if (logLines) {
    if (disabled.length > 0) {
      log(`Budget: disabled ${disabled.length} high-tier skill(s) locally (${disabled.join(", ")})`);
    }
    if (restored.length > 0) {
      log(`Budget: restored ${restored.length} skill(s) (${restored.join(", ")})`);
    }
  }
}

function refreshUsageStatusBar(libraryDir: string) {
  const target = getWorkspaceTarget();
  if (!target) {
    usageStatusBarItem.hide();
    return;
  }
  const manifest = loadManifest(libraryDir);
  const stats = computeUsageStats(target, manifest);
  const tracked = stats.filter((s) => s.runs > 0);
  const issues = stats.filter((s) => s.rating === "needs-attention" || s.rating === "unused").length;

  if (tracked.length === 0) {
    usageStatusBarItem.text = "$(graph) Skill usage: no data";
    usageStatusBarItem.tooltip =
      "No recorded skill runs yet (.claude/learning/runs.jsonl). Use the self-learning skill to start tracking outcomes.\n\nClick for the full report.";
  } else {
    const active = stats.filter((s) => s.rating === "active").length;
    const issuesSuffix = issues > 0 ? `, ${issues} to review` : "";
    usageStatusBarItem.text = `$(graph) Skill usage: ${active} active${issuesSuffix}`;
    usageStatusBarItem.tooltip = "Click for the per-skill usage and KPI report.";
  }
  usageStatusBarItem.command = "claudeSkills.showUsageStats";
  usageStatusBarItem.show();
}

export function activate(context: vscode.ExtensionContext) {
  const libraryDir = path.join(context.extensionPath, "skills_library");

  outputChannel = vscode.window.createOutputChannel("Claude Skills");
  context.subscriptions.push(outputChannel);

  const provider = new SkillsProvider(libraryDir, getWorkspaceTarget);
  const treeView = vscode.window.createTreeView("claudeSkillsView", {
    treeDataProvider: provider,
  });
  // Checkbox = "enabled for this workspace": check it to install the skill
  // into <workspace>/.claude/skills/, uncheck to remove it from there.
  context.subscriptions.push(
    treeView,
    treeView.onDidChangeCheckboxState(async (e) => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        refreshAll();
        return;
      }
      const destRoot = path.join(target, ".claude", "skills");
      for (const [item, state] of e.items) {
        const name = item.status.name;
        if (state === vscode.TreeItemCheckboxState.Checked) {
          const sourceRoot = item.status.availableInGlobal ? globalSkillsDir() : libraryDir;
          const status = copySkill(name, sourceRoot, destRoot, false, false);
          ensureLearningDir(target);
          log(`${name}: enabled for workspace (${status})`);
        } else {
          const removed = removeSkill(destRoot, name);
          log(`${name}: disabled for workspace${removed ? "" : " (was not installed)"}`);
        }
      }
      persistBranchProfile(target);
      refreshAll();
    })
  );

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBarItem);

  usageStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  context.subscriptions.push(usageStatusBarItem);

  creditStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  context.subscriptions.push(creditStatusBarItem);

  budgetModeStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
  context.subscriptions.push(budgetModeStatusBarItem);

  const refreshAll = () => {
    provider.refresh();
    refreshStatusBar(libraryDir);
    refreshUsageStatusBar(libraryDir);
    refreshCreditStatusBar(libraryDir);
    refreshBudgetModeStatusBar(libraryDir);
  };

  applyBudgetSettings(libraryDir, false);
  const initialTarget = getWorkspaceTarget();
  initBranchTracking(initialTarget);
  refreshAll();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeSkills.budget")) {
        applyBudgetSettings(libraryDir, true);
        refreshAll();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSkills.refresh", refreshAll),

    vscode.commands.registerCommand("claudeSkills.installLibraryToGlobal", async () => {
      const syncAll = vscode.workspace.getConfiguration("claudeSkills.agents").get<boolean>("syncGlobalToAll", false);
      outputChannel.show(true);
      if (syncAll) {
        const results = installLibraryToAllAgents(libraryDir, false, false);
        log(`\n=== Install skill library -> all enabled agents ===`);
        log(formatAgentInstallSummary(results));
        const installed = results.filter((r) => r.status === "installed" || r.status === "written").length;
        vscode.window.showInformationMessage(
          `Claude Skills: installed ${installed} skill(s) across enabled agents -- see output for details.`
        );
      } else {
        const results = installLibraryToGlobal(libraryDir, false, false);
        log(`\n=== Install skill library -> ${globalSkillsDir()} ===`);
        for (const r of results) {
          log(`${r.skill}: ${r.status}`);
        }
        const installed = results.filter((r) => r.status === "installed").length;
        const skipped = results.filter((r) => r.status === "skipped-exists").length;
        vscode.window.showInformationMessage(
          `Claude Skills: installed ${installed}, skipped ${skipped} (already present) -- see "Claude Skills" output for details.`
        );
      }
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.installLibraryToAllAgents", async () => {
      const results = installLibraryToAllAgents(libraryDir, false, false);
      outputChannel.show(true);
      log(`\n=== Install skill library -> all enabled agents ===`);
      log(formatAgentInstallSummary(results));
      const installed = results.filter((r) => r.status === "installed" || r.status === "written").length;
      vscode.window.showInformationMessage(
        `Claude Skills: installed ${installed} skill(s) across enabled agents.`
      );
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.generateForWorkspace", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      const syncAll = vscode.workspace.getConfiguration("claudeSkills.agents").get<boolean>("syncWorkspaceToAll", false);
      ensureLearningDir(target);
      outputChannel.show(true);
      let installed = 0;
      if (syncAll) {
        const results = generateForAllAgents(libraryDir, target, { all: false, force: false, dryRun: false });
        log(`\n=== Install relevant skills -> all enabled agents ===`);
        if (results.length === 0) {
          log("No relevant skills detected for this workspace.");
        } else {
          log(formatAgentInstallSummary(results));
        }
        installed = results.filter((r) => r.status === "installed" || r.status === "written").length;
      } else {
        const results = generateForWorkspace(libraryDir, target, {
          all: false,
          force: false,
          dryRun: false,
        });
        log(`\n=== Install relevant skills -> ${path.join(target, ".claude", "skills")} ===`);
        if (results.length === 0) {
          log("No relevant skills detected for this workspace.");
        }
        for (const r of results) {
          const reason = r.reason ? `  (matched: ${r.reason})` : "";
          log(`${r.skill}: ${r.status}${reason}`);
        }
        installed = results.filter((r) => r.status === "installed").length;
      }
      vscode.window.showInformationMessage(
        `Claude Skills: installed ${installed} skill(s) for this workspace -- see "Claude Skills" output for details.`
      );
      persistBranchProfile(target);
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.generateAllForWorkspace", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      const results = generateForWorkspace(libraryDir, target, {
        all: true,
        force: false,
        dryRun: false,
      });
      ensureLearningDir(target);
      outputChannel.show(true);
      log(`\n=== Install ALL skills -> ${path.join(target, ".claude", "skills")} ===`);
      for (const r of results) {
        log(`${r.skill}: ${r.status}`);
      }
      const installed = results.filter((r) => r.status === "installed").length;
      vscode.window.showInformationMessage(
        `Claude Skills: installed ${installed} skill(s) (full library) -- see "Claude Skills" output for details.`
      );
      persistBranchProfile(target);
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.previewForWorkspace", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      const results = generateForWorkspace(libraryDir, target, {
        all: false,
        force: false,
        dryRun: true,
      });
      outputChannel.show(true);
      log(`\n=== Preview (dry run) for ${target} ===`);
      if (results.length === 0) {
        log("No relevant skills detected for this workspace.");
      }
      for (const r of results) {
        const reason = r.reason ? `  (matched: ${r.reason})` : "";
        log(`${r.skill}: ${r.status}${reason}`);
      }
      if (results.length > 0) {
        const manifest = loadManifest(libraryDir);
        const tiers = results.map((r) => tierForSkill(manifest.skills[r.skill]?.cost_estimate));
        const { totalTokens, totalCostUsd } = sumInstallCostEstimate(tiers);
        log(
          `\nEstimated context impact: ${results.length} skill(s) -> ~${formatTokenCount(totalTokens)} tokens/session (~${formatCompactUsd(totalCostUsd)} at Sonnet-class API rates).`
        );
      }
    }),

    vscode.commands.registerCommand("claudeSkills.installSkillToWorkspace", async (item?: SkillItem) => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      if (!item) {
        return;
      }
      const destRoot = path.join(target, ".claude", "skills");
      const sourceRoot = item.status.availableInGlobal ? globalSkillsDir() : libraryDir;
      let status = copySkill(item.status.name, sourceRoot, destRoot, false, false);

      if (status === "skipped-exists") {
        const choice = await vscode.window.showWarningMessage(
          `${item.status.name} is already installed in this workspace. Overwrite?`,
          "Overwrite",
          "Cancel"
        );
        if (choice !== "Overwrite") {
          return;
        }
        status = copySkill(item.status.name, sourceRoot, destRoot, true, false);
      }

      ensureLearningDir(target);
      outputChannel.show(true);
      log(`\n=== Install ${item.status.name} -> ${destRoot} ===`);
      log(`${item.status.name}: ${status} (from ${sourceRoot})`);
      vscode.window.showInformationMessage(`Claude Skills: ${item.status.name} -> ${status}`);
      persistBranchProfile(target);
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.disableSkillLocally", async (item?: SkillItem) => {
      const target = getWorkspaceTarget();
      if (!target || !item) {
        return;
      }
      setSkillOverride(target, item.status.name, "off");
      log(`${item.status.name}: disabled locally (.claude/settings.local.json) - shared .claude/skills/ unchanged`);
      persistBranchProfile(target);
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.enableSkillLocally", async (item?: SkillItem) => {
      const target = getWorkspaceTarget();
      if (!target || !item) {
        return;
      }
      setSkillOverride(target, item.status.name, undefined);
      clearBudgetTrackingForSkill(target, item.status.name);
      log(`${item.status.name}: re-enabled locally (removed override from .claude/settings.local.json)`);
      persistBranchProfile(target);
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.openSkill", async (item?: SkillItem) => {
      if (!item) {
        return;
      }
      const target = getWorkspaceTarget();
      const filePath = item.resolveSkillFilePath(globalSkillsDir(), target);
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc, { preview: true });
    }),

    vscode.commands.registerCommand("claudeSkills.showUsageStats", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      ensureLearningDir(target);
      const manifest = loadManifest(libraryDir);
      const stats = computeUsageStats(target, manifest);
      const suggested = computeSuggestedSkills(target, manifest);
      const creditUsage = computeEnabledAgentsCreditUsage(libraryDir);
      const mirrored = mirrorLearningArtifacts(target, libraryDir);

      outputChannel.show(true);
      log(`\n=== Skill usage report for ${target} ===`);
      log(formatUsageReport(stats, suggested, target, creditUsage));
      if (mirrored.length > 0) {
        log(`\nMirrored learning artifacts to: ${mirrored.join(", ")}`);
      }
      log("\n## Enabled AI agents\n");
      log(agentCapabilityLines(libraryDir).join("\n"));

      const html = formatUsageReportHtml(stats, suggested, target, creditUsage);
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

    vscode.commands.registerCommand("claudeSkills.installSessionWatchHook", async () => {
      await vscode.commands.executeCommand("claudeSkills.installCostControlHooks");
    }),

    vscode.commands.registerCommand("claudeSkills.installCostControlHooks", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      try {
        applyBudgetSettings(libraryDir, true);
        const status = installCostControlHooks(context.extensionPath, target);
        outputChannel.show(true);
        log(`\n=== Cost control hooks -> ${target} ===`);
        log(status);
        log(`Budget config synced to ~/.claude/learning/budget.json`);
        if (status === "installed") {
          vscode.window.showInformationMessage(
            "Claude Skills: cost control hooks enabled (session size + daily budget) for this workspace."
          );
        } else if (status === "updated") {
          vscode.window.showInformationMessage("Claude Skills: cost control hooks updated for this workspace.");
        } else {
          vscode.window.showInformationMessage("Claude Skills: cost control hooks were already enabled (files refreshed).");
        }
      } catch (err) {
        vscode.window.showWarningMessage(`Claude Skills: could not enable cost control hooks - ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("claudeSkills.cycleBudgetMode", async () => {
      const cfg = vscode.workspace.getConfiguration("claudeSkills.budget");
      const current = cfg.get<BudgetMode>("mode", "normal");
      const next = BUDGET_MODE_CYCLE[(BUDGET_MODE_CYCLE.indexOf(current) + 1) % BUDGET_MODE_CYCLE.length];
      await cfg.update("mode", next, vscode.ConfigurationTarget.Global);
      applyBudgetSettings(libraryDir, true);
      refreshAll();
      outputChannel.show(true);
      log(`\n=== Budget mode -> ${BUDGET_MODE_LABEL[next]} ===`);
      vscode.window.showInformationMessage(`Claude Skills: budget mode set to ${BUDGET_MODE_LABEL[next]}.`);
    }),

    vscode.commands.registerCommand("claudeSkills.openBudgetSettings", async () => {
      await vscode.commands.executeCommand("workbench.action.openSettings", "claudeSkills.budget");
    }),

    vscode.commands.registerCommand("claudeSkills.saveBranchProfile", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      const profile = saveBranchProfile(target);
      outputChannel.show(true);
      if (!profile) {
        log("\n=== Save branch profile ===\nNot a git repo or branch profiles disabled.");
        vscode.window.showWarningMessage("Claude Skills: could not save branch profile (git branch required).");
        return;
      }
      log(`\n=== Save branch profile -> ${profile.branch} ===`);
      log(`${profile.skills.length} skill(s), ${Object.keys(profile.skillOverrides).length} override(s)`);
      vscode.window.showInformationMessage(
        `Claude Skills: saved skill profile for branch "${profile.branch}" (${profile.skills.length} skills).`
      );
    }),

    vscode.commands.registerCommand("claudeSkills.applyBranchProfile", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      const branch = getCurrentBranch(target);
      if (!branch) {
        vscode.window.showWarningMessage("Claude Skills: not on a named git branch.");
        return;
      }
      const profile = loadBranchProfile(target, branch);
      if (!profile) {
        vscode.window.showWarningMessage(`Claude Skills: no saved profile for branch "${branch}".`);
        return;
      }
      const result = applyBranchProfile(libraryDir, target, profile);
      outputChannel.show(true);
      log(`\n=== Apply branch profile -> ${branch} ===`);
      log(`Installed: ${result.installed.join(", ") || "(none)"}`);
      log(`Removed: ${result.removed.join(", ") || "(none)"}`);
      log(`Overrides applied: ${result.overridesApplied}`);
      persistBranchProfile(target);
      refreshAll();
      vscode.window.showInformationMessage(
        `Claude Skills: applied "${branch}" profile (+${result.installed.length}, -${result.removed.length}).`
      );
    }),

    vscode.commands.registerCommand("claudeSkills.showAgentCapabilities", async () => {
      outputChannel.show(true);
      log("\n=== Enabled AI agent targets ===");
      log(agentCapabilityLines(libraryDir).join("\n"));
      log("\nConfigure via Settings -> claudeSkills.agents.enabled");
      log("Agent paths defined in skills_library/agents.json");
    }),

    vscode.commands.registerCommand("claudeSkills.showBranchProfiles", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      outputChannel.show(true);
      log(`\n=== Branch skill profiles ===`);
      log(formatBranchProfilesReport(target));
    })
  );

  // Re-evaluate detection/status when files change in the workspace.
  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  watcher.onDidCreate(() => refreshAll());
  watcher.onDidDelete(() => refreshAll());
  context.subscriptions.push(watcher);

  const skillsWatcher = vscode.workspace.createFileSystemWatcher("**/.claude/skills/**");
  const debouncedSave = debounce(() => {
    persistBranchProfile(getWorkspaceTarget());
  }, 1500);
  skillsWatcher.onDidCreate(debouncedSave);
  skillsWatcher.onDidDelete(debouncedSave);
  context.subscriptions.push(skillsWatcher);

  const gitExt = vscode.extensions.getExtension("vscode.git");
  if (gitExt) {
    const subscribeGit = () => {
      try {
        const api = gitExt.exports.getAPI(1);
        for (const repo of api.repositories) {
          repo.state.onDidChange(async () => {
            const target = getWorkspaceTarget();
            if (!target || !target.startsWith(repo.rootUri.fsPath)) {
              return;
            }
            await handleBranchChange(libraryDir, target, log);
            refreshAll();
          });
        }
        api.onDidOpenRepository((repo: { state: { onDidChange: (cb: () => void) => void }; rootUri: { fsPath: string } }) => {
          repo.state.onDidChange(async () => {
            const target = getWorkspaceTarget();
            if (!target || !target.startsWith(repo.rootUri.fsPath)) {
              return;
            }
            await handleBranchChange(libraryDir, target, log);
            refreshAll();
          });
        });
      } catch {
        // git API unavailable
      }
    };
    const runInitialBranchSync = () => {
      subscribeGit();
      const target = getWorkspaceTarget();
      if (target) {
        void handleBranchChange(libraryDir, target, log);
      }
    };
    if (gitExt.isActive) {
      runInitialBranchSync();
    } else {
      gitExt.activate().then(runInitialBranchSync);
    }
  }
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(fn, ms);
  };
}

export function deactivate() {
  // no-op
}
