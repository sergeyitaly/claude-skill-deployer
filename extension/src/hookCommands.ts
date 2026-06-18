import * as vscode from "vscode";
import {
  installAttributionHooks,
  installCostControlHooks,
} from "./hookOps";
import { installGitPostCommitHook } from "./commitCost";
import { isFeatureEnabled } from "./featureFlags";
import { syncContextFocusConfigToDisk } from "./contextFocusConfig";
import { syncPracticalFocusConfigToDisk } from "./practicalFocusConfig";
import { notifyUserSuccess, notifyUserWarn } from "./userNotify";
import { recordError } from "./analytics";
import { ExtensionSharedContext } from "./extensionSharedContext";

export function registerHookCommands(shared: ExtensionSharedContext): void {
  const { context, log, getWorkspaceTarget, maybeRevealOutputPanel, applyBudgetSettings } = shared;

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSkills.installSessionWatchHook", async () => {
      await vscode.commands.executeCommand("claudeSkills.installCostControlHooks");
    }),

    vscode.commands.registerCommand("claudeSkills.installAttributionHooks", async () => {
      const target = getWorkspaceTarget();
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
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      try {
        applyBudgetSettings(true);
        if (isFeatureEnabled("contextFocus")) {
          syncContextFocusConfigToDisk();
        }
        if (isFeatureEnabled("practicalFocus")) {
          syncPracticalFocusConfigToDisk();
        }
        const status = installCostControlHooks(context.extensionPath, target);
        maybeRevealOutputPanel();
        log(`\n=== Cost control hooks -> ${target} ===`);
        log(status);
        log(`Budget config synced to ~/.claude/learning/budget.json`);
        if (isFeatureEnabled("contextFocus")) {
          log(`Context focus config synced to ~/.claude/learning/context-focus.json`);
        }
        if (isFeatureEnabled("practicalFocus")) {
          log(`Practical focus config synced to ~/.claude/learning/practical-focus.json`);
        }
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

    vscode.commands.registerCommand("claudeSkills.installCommitCostHook", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      try {
        const status = installGitPostCommitHook(target, context.extensionPath);
        void notifyUserSuccess(`Claude Skills: commit cost hook ${status}.`);
      } catch (err) {
        recordError();
        vscode.window.showWarningMessage(`Claude Skills: ${(err as Error).message}`);
      }
    })
  );
}
