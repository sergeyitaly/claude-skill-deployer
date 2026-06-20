import * as vscode from "vscode";
import { loadManifest } from "./skillOps";
import { readTaskSkillProposals, resolveTaskSkillProposals, ensureWorkspaceTaskProposals } from "./taskSkillProposals";
import { applyProposedSkillsLocally } from "./sessionSkillApply";
import { applyTaskSkillFocusFromProposals } from "./taskSkillFocus";
import { propagateWorkspaceSkillChange } from "./workspaceSkillSync";
import { notifyUserSuccess, notifyUserWarn } from "./userNotify";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface TaskSkillsCommandDeps {
  context: vscode.ExtensionContext;
  libraryDir: string;
  getTarget: () => string | undefined;
  log: (line: string) => void;
  refreshAll: () => void;
  applyProposalSkillNames: (target: string, names: string[]) => Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Command registrations
// ---------------------------------------------------------------------------

export function registerTaskSkillsCommands(deps: TaskSkillsCommandDeps): vscode.Disposable[] {
  const { context, libraryDir, getTarget, log, refreshAll, applyProposalSkillNames } = deps;

  return [
    vscode.commands.registerCommand("claudeSkills.applyTaskSkillProposals", async () => {
      const target = getTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const manifest = loadManifest(libraryDir);
      const proposals = resolveTaskSkillProposals(target, manifest);
      const toInstall = proposals.filter((p) => !p.installed);
      if (toInstall.length === 0) {
        void notifyUserSuccess(
          "Claude Skills: no uninstalled suggested skills — run skill-feedback-adaptation on a new task first."
        );
        return;
      }
      const installed = await applyProposalSkillNames(
        target,
        proposals.map((p) => p.name)
      );
      refreshAll();
      if (installed.length > 0) {
        void notifyUserSuccess(
          `Claude Skills: installed ${installed.length} suggested skill(s): ${installed.join(", ")}.`
        );
      } else {
        void notifyUserSuccess("Claude Skills: could not install suggested skills.");
      }
    }),

    vscode.commands.registerCommand("claudeSkills.chooseTaskSkillSet", async () => {
      const target = getTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      let file = readTaskSkillProposals(target);
      if (!file?.proposals?.length) {
        ensureWorkspaceTaskProposals(target, loadManifest(libraryDir));
        file = readTaskSkillProposals(target);
      }
      if (!file?.proposals?.length) {
        void notifyUserWarn(
          "Claude Skills: no task skill proposals yet — describe a new task in chat or run skill-feedback-adaptation."
        );
        return;
      }
      const focusApply = applyTaskSkillFocusFromProposals(libraryDir, target);
      if (focusApply.applied && focusApply.focus) {
        propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, {
          forceAgentSync: true,
        });
        refreshAll();
        void notifyUserSuccess(
          `Claude Skills: ${focusApply.focus.activeSkills.length} skill(s) active for this task.`
        );
      }
    }),
  ];
}
