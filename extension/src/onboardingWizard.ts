import * as fs from "node:fs";
import * as vscode from "vscode";
import { discoverBundledSkills, globalSkillsDir, listSkillStatuses } from "./skillOps";
import { getWorkspaceHookStatus } from "./hookOps";
import { formatHookStatusPlain } from "./workspaceHookStatus";

function escapeHtml(v: string): string {
  return v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function globalSkillCount(): number {
  const dir = globalSkillsDir();
  if (!fs.existsSync(dir)) {
    return 0;
  }
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
}

function workspaceSkillSummary(target: string, libraryDir: string): { installed: number; suggested: number } {
  const statuses = listSkillStatuses(libraryDir, target);
  const installed = statuses.filter((s) => s.installedInWorkspace).length;
  const suggested = statuses.filter((s) => s.isRelevant && !s.installedInWorkspace).length;
  return { installed, suggested };
}

function wizardHtml(
  target: string | undefined,
  libraryDir: string,
  globalCount: number,
  ws: { installed: number; suggested: number },
  hookStatusText?: string
): string {
  const step1Done = globalCount > 0;
  const step2Done = target !== undefined && ws.installed > 0;
  const step1Status = step1Done ? `Installed (${globalCount} skills in ~/.claude/skills/)` : "Not installed yet";
  const step2Status = !target
    ? "Open a workspace folder first"
    : step2Done
      ? `${ws.installed} skill(s) in workspace${ws.suggested > 0 ? `, ${ws.suggested} more suggested` : ""}`
      : ws.suggested > 0
        ? `${ws.suggested} relevant skill(s) detected — not installed`
        : "No workspace skills installed yet";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 20px; max-width: 640px; }
  h1 { font-size: 1.2em; margin: 0 0 8px; }
  p.lead { color: var(--vscode-descriptionForeground); margin: 0 0 16px; font-size: 0.9em; }
  .step { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; }
  .step.done { border-color: var(--vscode-testing-iconPassed); }
  .step h2 { font-size: 0.95em; margin: 0 0 6px; }
  .status { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  .actions { margin-top: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:disabled { opacity: 0.5; cursor: default; }
  .note { margin-top: 14px; font-size: 0.8em; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <h1>Claude Skills — Setup</h1>
  <p class="lead">Install the right skills for this repo across Claude, Cursor, Kiro, and Copilot. Cost tracking is optional and needs a few sessions of data.</p>

  <div class="step ${step1Done ? "done" : ""}">
    <h2>1. Global skill library</h2>
    <div class="status">${escapeHtml(step1Status)}</div>
    <div class="actions"><button onclick="run('installGlobal')" ${step1Done ? "disabled" : ""}>Install library</button></div>
  </div>

  <div class="step ${step2Done ? "done" : ""}">
    <h2>2. Workspace skills</h2>
    <div class="status">${escapeHtml(step2Status)}</div>
    <div class="actions">
      <button onclick="run('installWorkspace')" ${!target ? "disabled" : ""}>Install relevant skills</button>
      <button class="secondary" onclick="run('preview')">Preview detection</button>
    </div>
  </div>

  <div class="step ${hookStatusText && hookStatusText.includes("Attribution v2: enabled") ? "done" : ""}">
    <h2>3. Hooks &amp; notifications</h2>
    <div class="status">${escapeHtml(hookStatusText ?? "Open a workspace folder to inspect hook status.")}</div>
    <div class="actions">
      <button class="secondary" onclick="run('attributionHooks')">Install attribution hooks</button>
      <button class="secondary" onclick="run('budget')">Budget settings</button>
      <button class="secondary" onclick="run('hooks')">Enable session/budget hooks</button>
    </div>
  </div>

  <div class="step">
    <h2>4. Optional: cost dashboard (beta)</h2>
    <div class="status">Per-skill costs need transcript data. Agent totals may show before per-skill breakdown.</div>
    <div class="actions"><button class="secondary" onclick="run('dashboard')" ${!step1Done || !step2Done ? "disabled" : ""}>Open dashboard</button></div>
  </div>

  <div class="actions">
    <button onclick="run('done')" ${!step1Done || !step2Done ? "disabled" : ""}>Mark setup complete</button>
    <button class="secondary" onclick="run('close')">Close</button>
  </div>
  <div class="note">Core value: steps 1–2. Steps 3–4 are power-user features (estimates only, not your API invoice).</div>
  <script>
    const vscode = acquireVsCodeApi();
    function run(cmd) { vscode.postMessage({ command: cmd }); }
  </script>
</body>
</html>`;
}

export async function showOnboardingWizard(
  context: vscode.ExtensionContext,
  libraryDir: string,
  getTarget: () => string | undefined,
  refresh: () => void
): Promise<void> {
  const target = getTarget();
  const panel = vscode.window.createWebviewPanel(
    "claudeSkillsOnboarding",
    "Claude Skills Setup",
    vscode.ViewColumn.Active,
    { enableScripts: true }
  );

  const render = () => {
    const currentTarget = getTarget();
    const hookStatusText = currentTarget ? formatHookStatusPlain(getWorkspaceHookStatus(currentTarget, libraryDir)) : undefined;
    panel.webview.html = wizardHtml(
      currentTarget,
      libraryDir,
      globalSkillCount(),
      currentTarget ? workspaceSkillSummary(currentTarget, libraryDir) : { installed: 0, suggested: 0 },
      hookStatusText
    );
  };
  render();

  panel.webview.onDidReceiveMessage(async (msg: { command?: string }) => {
    try {
      switch (msg.command) {
        case "installGlobal":
          await vscode.commands.executeCommand("claudeSkills.installLibraryToGlobal");
          refresh();
          render();
          break;
        case "installWorkspace":
          await vscode.commands.executeCommand("claudeSkills.generateForWorkspace");
          refresh();
          render();
          break;
        case "preview":
          await vscode.commands.executeCommand("claudeSkills.previewForWorkspace");
          break;
        case "budget":
          await vscode.commands.executeCommand("claudeSkills.openBudgetSettings");
          break;
        case "attributionHooks":
          await vscode.commands.executeCommand("claudeSkills.installAttributionHooks");
          render();
          break;
        case "hooks":
          await vscode.commands.executeCommand("claudeSkills.installCostControlHooks");
          render();
          break;
        case "dashboard":
          await vscode.commands.executeCommand("claudeSkills.showCostDashboard");
          break;
        case "done":
          await context.globalState.update("claudeSkills.onboardingTourCompleted", true);
          await context.globalState.update("claudeSkills.hasRunBefore", true);
          panel.dispose();
          vscode.window.showInformationMessage("Claude Skills setup complete. Use the activity bar to manage skills.");
          break;
        case "close":
          panel.dispose();
          break;
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Claude Skills setup: ${(err as Error).message}`);
    }
  });
}
