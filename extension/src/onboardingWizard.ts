import * as fs from "node:fs";
import * as vscode from "vscode";
import { globalSkillsDir, listSkillStatuses } from "./skillOps";
import { getWorkspaceHookStatus } from "./hookOps";
import { formatHookStatusPlain } from "./workspaceHookStatus";
import { DASHBOARD_WIZARD_EXTRA_STYLES, wrapDashboardHtml } from "./dashboardStyles";

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
  hookStatusText?: string,
  nonce?: string
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

  const body = `
  <p class="lead">Install the right skills for this repo across Claude, Cursor, Kiro, and Copilot. Cost tracking is optional and needs a few sessions of data.</p>

  <div class="step ${step1Done ? "done" : ""}">
    <h2>1. Global skill library</h2>
    <div class="status">${escapeHtml(step1Status)}</div>
    <div class="actions"><button type="button" id="btn-install-global" ${step1Done ? "disabled" : ""}>Install library</button></div>
  </div>

  <div class="step ${step2Done ? "done" : ""}">
    <h2>2. Workspace skills</h2>
    <div class="status">${escapeHtml(step2Status)}</div>
    <div class="actions">
      <button type="button" id="btn-install-workspace" ${!target ? "disabled" : ""}>Install relevant skills</button>
      <button type="button" class="secondary" id="btn-preview">Preview detection</button>
    </div>
  </div>

  <div class="step ${hookStatusText && hookStatusText.includes("Attribution v2: enabled") ? "done" : ""}">
    <h2>3. Hooks &amp; notifications</h2>
    <div class="status">${escapeHtml(hookStatusText ?? "Open a workspace folder to inspect hook status.")}</div>
    <div class="actions">
      <button type="button" class="secondary" id="btn-attribution-hooks">Install attribution hooks</button>
      <button type="button" class="secondary" id="btn-budget">Budget settings</button>
      <button type="button" class="secondary" id="btn-hooks">Enable session/budget hooks</button>
    </div>
  </div>

  <div class="step">
    <h2>4. Optional: cost dashboard (beta)</h2>
    <div class="status">Per-skill costs need transcript data. Agent totals may show before per-skill breakdown.</div>
    <div class="actions"><button type="button" class="secondary" id="btn-dashboard" ${!step1Done || !step2Done ? "disabled" : ""}>Open dashboard</button></div>
  </div>

  <div class="actions">
    <button type="button" id="btn-done" ${!step1Done || !step2Done ? "disabled" : ""}>Mark setup complete</button>
    <button type="button" class="secondary" id="btn-close">Close</button>
  </div>
  <div class="note">Core value: steps 1–2. Steps 3–4 are power-user features (estimates only, not your API invoice).</div>`;

  const scriptHtml = nonce
    ? `<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const run = (cmd) => vscode.postMessage({ command: cmd });
    document.getElementById("btn-install-global")?.addEventListener("click", () => run("installGlobal"));
    document.getElementById("btn-install-workspace")?.addEventListener("click", () => run("installWorkspace"));
    document.getElementById("btn-preview")?.addEventListener("click", () => run("preview"));
    document.getElementById("btn-attribution-hooks")?.addEventListener("click", () => run("attributionHooks"));
    document.getElementById("btn-budget")?.addEventListener("click", () => run("budget"));
    document.getElementById("btn-hooks")?.addEventListener("click", () => run("hooks"));
    document.getElementById("btn-dashboard")?.addEventListener("click", () => run("dashboard"));
    document.getElementById("btn-done")?.addEventListener("click", () => run("done"));
    document.getElementById("btn-close")?.addEventListener("click", () => run("close"));
  </script>`
    : `<script>
    const vscode = acquireVsCodeApi();
    const run = (cmd) => vscode.postMessage({ command: cmd });
    document.getElementById("btn-install-global")?.addEventListener("click", () => run("installGlobal"));
    document.getElementById("btn-install-workspace")?.addEventListener("click", () => run("installWorkspace"));
    document.getElementById("btn-preview")?.addEventListener("click", () => run("preview"));
    document.getElementById("btn-attribution-hooks")?.addEventListener("click", () => run("attributionHooks"));
    document.getElementById("btn-budget")?.addEventListener("click", () => run("budget"));
    document.getElementById("btn-hooks")?.addEventListener("click", () => run("hooks"));
    document.getElementById("btn-dashboard")?.addEventListener("click", () => run("dashboard"));
    document.getElementById("btn-done")?.addEventListener("click", () => run("done"));
    document.getElementById("btn-close")?.addEventListener("click", () => run("close"));
  </script>`;

  return wrapDashboardHtml({
    title: "Claude Skills — Setup",
    headerHtml: "",
    extraStyles: DASHBOARD_WIZARD_EXTRA_STYLES,
    body,
    nonce,
    scriptHtml,
  });
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
  const nonce = String(Date.now());

  const render = () => {
    const currentTarget = getTarget();
    const hookStatusText = currentTarget ? formatHookStatusPlain(getWorkspaceHookStatus(currentTarget, libraryDir)) : undefined;
    panel.webview.html = wizardHtml(
      currentTarget,
      libraryDir,
      globalSkillCount(),
      currentTarget ? workspaceSkillSummary(currentTarget, libraryDir) : { installed: 0, suggested: 0 },
      hookStatusText,
      nonce
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
