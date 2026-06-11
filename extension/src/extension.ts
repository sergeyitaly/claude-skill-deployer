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
} from "./skillOps";
import { SkillItem, SkillsProvider } from "./skillsProvider";
import { computeUsageStats, formatUsageReport, formatUsageReportHtml } from "./usageStats";

let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let usageStatusBarItem: vscode.StatusBarItem;
let usagePanel: vscode.WebviewPanel | undefined;

function getWorkspaceTarget(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function log(line: string) {
  outputChannel.appendLine(line);
}

function refreshStatusBar(libraryDir: string) {
  const target = getWorkspaceTarget();
  if (!target) {
    statusBarItem.hide();
    return;
  }
  const statuses = listSkillStatuses(libraryDir, target);
  const pending = statuses.filter((s) => s.isRelevant && !s.installedInWorkspace);
  if (pending.length === 0) {
    statusBarItem.text = "$(check) Claude Skills";
    statusBarItem.tooltip = "All relevant Claude skills are installed for this workspace";
  } else {
    statusBarItem.text = `$(lightbulb) Claude Skills: ${pending.length} suggested`;
    statusBarItem.tooltip = `${pending.length} relevant skill(s) not yet installed:\n` +
      pending.map((s) => `- ${s.name}`).join("\n") +
      "\n\nClick to install.";
  }
  statusBarItem.command = "claudeSkills.generateForWorkspace";
  statusBarItem.show();
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
          log(`${name}: enabled for workspace (${status})`);
        } else {
          const removed = removeSkill(destRoot, name);
          log(`${name}: disabled for workspace${removed ? "" : " (was not installed)"}`);
        }
      }
      refreshAll();
    })
  );

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBarItem);

  usageStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  context.subscriptions.push(usageStatusBarItem);

  const refreshAll = () => {
    provider.refresh();
    refreshStatusBar(libraryDir);
    refreshUsageStatusBar(libraryDir);
  };
  refreshAll();

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSkills.refresh", refreshAll),

    vscode.commands.registerCommand("claudeSkills.installLibraryToGlobal", async () => {
      const results = installLibraryToGlobal(libraryDir, false, false);
      outputChannel.show(true);
      log(`\n=== Install skill library -> ${globalSkillsDir()} ===`);
      for (const r of results) {
        log(`${r.skill}: ${r.status}`);
      }
      const installed = results.filter((r) => r.status === "installed").length;
      const skipped = results.filter((r) => r.status === "skipped-exists").length;
      vscode.window.showInformationMessage(
        `Claude Skills: installed ${installed}, skipped ${skipped} (already present) -- see "Claude Skills" output for details.`
      );
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.generateForWorkspace", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        vscode.window.showWarningMessage("Claude Skills: open a workspace folder first.");
        return;
      }
      const results = generateForWorkspace(libraryDir, target, {
        all: false,
        force: false,
        dryRun: false,
      });
      outputChannel.show(true);
      log(`\n=== Install relevant skills -> ${path.join(target, ".claude", "skills")} ===`);
      if (results.length === 0) {
        log("No relevant skills detected for this workspace.");
      }
      for (const r of results) {
        const reason = r.reason ? `  (matched: ${r.reason})` : "";
        log(`${r.skill}: ${r.status}${reason}`);
      }
      const installed = results.filter((r) => r.status === "installed").length;
      vscode.window.showInformationMessage(
        `Claude Skills: installed ${installed} skill(s) for this workspace -- see "Claude Skills" output for details.`
      );
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
      outputChannel.show(true);
      log(`\n=== Install ALL skills -> ${path.join(target, ".claude", "skills")} ===`);
      for (const r of results) {
        log(`${r.skill}: ${r.status}`);
      }
      const installed = results.filter((r) => r.status === "installed").length;
      vscode.window.showInformationMessage(
        `Claude Skills: installed ${installed} skill(s) (full library) -- see "Claude Skills" output for details.`
      );
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

      outputChannel.show(true);
      log(`\n=== Install ${item.status.name} -> ${destRoot} ===`);
      log(`${item.status.name}: ${status} (from ${sourceRoot})`);
      vscode.window.showInformationMessage(`Claude Skills: ${item.status.name} -> ${status}`);
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
      const manifest = loadManifest(libraryDir);
      const stats = computeUsageStats(target, manifest);

      outputChannel.show(true);
      log(`\n=== Skill usage report for ${target} ===`);
      log(formatUsageReport(stats, target));

      const html = formatUsageReportHtml(stats, target);
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
    })
  );

  // Re-evaluate detection/status when files change in the workspace.
  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  watcher.onDidCreate(() => refreshAll());
  watcher.onDidDelete(() => refreshAll());
  context.subscriptions.push(watcher);
}

export function deactivate() {
  // no-op
}
