import * as vscode from "vscode";
import {
  installAttributionHooks,
  installCostControlHooks,
} from "./hookOps";
import {
  syncContextFocusConfigToDisk,
} from "./contextFocusConfig";
import {
  syncPracticalFocusConfigToDisk,
} from "./practicalFocusConfig";
import { notifyUserWarn, notifyUserSuccess } from "./userNotify";
import { recordError } from "./analytics";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface HooksCommandDeps {
  context: vscode.ExtensionContext;
  libraryDir: string;
  getTarget: () => string | undefined;
  log: (line: string) => void;
  maybeRevealOutputPanel: () => void;
  applyBudgetSettings: (libraryDir: string, logLines: boolean) => void;
}

// ---------------------------------------------------------------------------
// Command registrations
// ---------------------------------------------------------------------------

export function registerHooksCommands(deps: HooksCommandDeps): vscode.Disposable[] {
  const { context, libraryDir, getTarget, log, maybeRevealOutputPanel, applyBudgetSettings } = deps;

  return [
    vscode.commands.registerCommand("claudeSkills.installSessionWatchHook", async () => {
      await vscode.commands.executeCommand("claudeSkills.installCostControlHooks");
    }),

    vscode.commands.registerCommand("claudeSkills.installAttributionHooks", async () => {
      const target = getTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      try {
        const status = installAttributionHooks(context.extensionPath, target);
        maybeRevealOutputPanel();
        log(`\n=== Attribution v2 hooks (PostToolUse + PreToolUse Skill|Read) -> ${target} ===`);
        log(status);
        void notifyUserSuccess(`Claude Skills: attribution hooks ${status}.`);
      } catch (err) {
        recordError();
        vscode.window.showWarningMessage(`Claude Skills: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("claudeSkills.installCostControlHooks", async () => {
      const target = getTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      try {
        applyBudgetSettings(libraryDir, true);
        syncContextFocusConfigToDisk();
        syncPracticalFocusConfigToDisk();
        const status = installCostControlHooks(context.extensionPath, target);
        maybeRevealOutputPanel();
        log(`\n=== Cost control hooks -> ${target} ===`);
        log(status);
        log(`Budget config synced to ~/.claude/learning/budget.json`);
        log(`Context focus config synced to ~/.claude/learning/context-focus.json`);
        log(`Practical focus config synced to ~/.claude/learning/practical-focus.json`);
        if (status === "installed") {
          void notifyUserSuccess(
            "Claude Skills: cost control hooks enabled (session size, budget, context focus, practical focus) for this workspace."
          );
        } else if (status === "updated") {
          void notifyUserSuccess("Claude Skills: cost control hooks updated for this workspace.");
        } else {
          void notifyUserSuccess("Claude Skills: cost control hooks were already enabled (files refreshed).");
        }
      } catch (err) {
        recordError();
        vscode.window.showWarningMessage(`Claude Skills: could not enable cost control hooks - ${(err as Error).message}`);
      }
    }),
  ];
}
