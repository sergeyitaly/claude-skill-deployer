import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  copySkill,
  generateForWorkspace,
  globalSkillsDir,
  installLibraryToGlobal,
  loadManifest,
  disableWorkspaceSkill,
  enableWorkspaceSkill,
  isSkillCommittedOnBranch,
  setSkillOverride,
} from "./skillOps";
import { SkillItem } from "./skillsProvider";
import {
  ensureLearningDir,
  formatTokenCount,
  listInstalledSkills,
} from "./usageStats";
import { computeSkillInefficiencyStats } from "./skillFeedback";
import {
  formatAgentInstallSummary,
  generateForAllAgents,
  installLibraryToAllAgents,
  installSkillToAllWorkspaceAgents,
  invalidateWorkspaceSyncFingerprint,
  shouldSyncGlobalToAll,
  shouldSyncWorkspaceToAll,
} from "./agentOps";
import { propagateWorkspaceSkillChange } from "./workspaceSkillSync";
import { clearBudgetTrackingForSkill } from "./budgetOps";
import { readTaskSkillProposals, resolveTaskSkillProposals, ensureWorkspaceTaskProposals } from "./taskSkillProposals";
import { applyProposedSkillsLocally, applyTaskProposalsIfPending } from "./sessionSkillApply";
import { applyTaskSkillFocusFromProposals } from "./taskSkillFocus";
import { promptTaskSkillSetApproval } from "./taskSkillSetApproval";
import { listOutdatedSkills, upgradeOutdatedSkills } from "./skillLifecycle";
import { refreshSkillsCatalog } from "./profileInit";
import {
  planSkillSetResolution,
  formatSkillSetResolverPlan,
  executeSkillSetResolution,
} from "./skillSetResolver";
import { listArchivedSkills, restoreArchivedSkill } from "./skillArchival";
import { formatCompactUsd, sumInstallCostEstimate, tierForSkill } from "./skillCost";
import { notifyUserSuccess, notifyUserWarn } from "./userNotify";
import { recordError } from "./analytics";
import { ExtensionSharedContext } from "./extensionSharedContext";

export function registerSkillCommands(shared: ExtensionSharedContext): void {
  const {
    context, libraryDir, log, getWorkspaceTarget,
    refreshAll, maybeRevealOutputPanel, revealOutputPanel,
    applyProposalSkillNames,
  } = shared;

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSkills.installLibraryToGlobal", async () => {
      const syncAll = shouldSyncGlobalToAll();
      maybeRevealOutputPanel();
      if (syncAll) {
        const results = installLibraryToAllAgents(libraryDir, false, false);
        log(`\n=== Install skill library -> all enabled agents ===`);
        log(formatAgentInstallSummary(results));
        const installed = results.filter((r) => r.status === "installed" || r.status === "written").length;
        void notifyUserSuccess(
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
        void notifyUserSuccess(
          `Claude Skills: installed ${installed}, skipped ${skipped} (already present) -- see "Claude Skills" output for details.`
        );
      }
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.installLibraryToAllAgents", async () => {
      const results = installLibraryToAllAgents(libraryDir, false, false);
      maybeRevealOutputPanel();
      log(`\n=== Install skill library -> all enabled agents ===`);
      log(formatAgentInstallSummary(results));
      const installed = results.filter((r) => r.status === "installed" || r.status === "written").length;
      void notifyUserSuccess(`Claude Skills: installed ${installed} skill(s) across enabled agents.`);
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.generateForWorkspace", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      ensureLearningDir(target);
      maybeRevealOutputPanel();
      let installed = 0;
      if (shouldSyncWorkspaceToAll()) {
        const results = generateForAllAgents(libraryDir, target, { all: false, force: false, dryRun: false });
        log(`\n=== Install relevant skills -> all enabled agents ===`);
        if (results.length === 0) {
          log("No relevant skills detected for this workspace.");
        } else {
          log(formatAgentInstallSummary(results));
        }
        installed = results.filter((r) => r.status === "installed" || r.status === "written").length;
      } else {
        const results = generateForWorkspace(libraryDir, target, { all: false, force: false, dryRun: false });
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
      void notifyUserSuccess(
        `Claude Skills: installed ${installed} skill(s) for this workspace -- see "Claude Skills" output for details.`
      );
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, { forceAgentSync: true });
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.generateAllForWorkspace", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      ensureLearningDir(target);
      maybeRevealOutputPanel();
      let installed = 0;
      if (shouldSyncWorkspaceToAll()) {
        const results = generateForAllAgents(libraryDir, target, { all: true, force: false, dryRun: false });
        log(`\n=== Install ALL skills -> all enabled agents ===`);
        log(formatAgentInstallSummary(results));
        installed = results.filter((r) => r.status === "installed" || r.status === "written").length;
      } else {
        const results = generateForWorkspace(libraryDir, target, { all: true, force: false, dryRun: false });
        log(`\n=== Install ALL skills -> ${path.join(target, ".claude", "skills")} ===`);
        for (const r of results) {
          log(`${r.skill}: ${r.status}`);
        }
        installed = results.filter((r) => r.status === "installed").length;
      }
      void notifyUserSuccess(
        `Claude Skills: installed ${installed} skill(s) (full library) -- see "Claude Skills" output for details.`
      );
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, { forceAgentSync: true });
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.previewForWorkspace", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const results = generateForWorkspace(libraryDir, target, { all: false, force: false, dryRun: true });
      revealOutputPanel();
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
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      if (!item) {
        return;
      }
      const sourceRoot = item.status.availableInGlobal ? globalSkillsDir() : libraryDir;
      const skillName = item.status.name;
      let force = false;

      if (shouldSyncWorkspaceToAll()) {
        const claudeDest = path.join(target, ".claude", "skills", skillName);
        if (fs.existsSync(claudeDest)) {
          const choice = await vscode.window.showWarningMessage(
            `${skillName} is already installed in this workspace. Overwrite?`,
            "Overwrite",
            "Cancel"
          );
          if (choice !== "Overwrite") {
            return;
          }
          force = true;
        }
        ensureLearningDir(target);
        maybeRevealOutputPanel();
        const results = installSkillToAllWorkspaceAgents(libraryDir, target, skillName, sourceRoot, force, false);
        log(`\n=== Install ${skillName} -> all enabled agents ===`);
        log(formatAgentInstallSummary(results));
        const installed = results.filter((r) => r.status === "installed" || r.status === "written").length;
        void notifyUserSuccess(`Claude Skills: ${skillName} installed to ${installed} agent path(s).`);
      } else {
        const destRoot = path.join(target, ".claude", "skills");
        let status = copySkill(skillName, sourceRoot, destRoot, false, false, { libraryDir });
        if (status === "skipped-exists") {
          const choice = await vscode.window.showWarningMessage(
            `${skillName} is already installed in this workspace. Overwrite?`,
            "Overwrite",
            "Cancel"
          );
          if (choice !== "Overwrite") {
            return;
          }
          status = copySkill(skillName, sourceRoot, destRoot, true, false, { libraryDir });
        }
        ensureLearningDir(target);
        maybeRevealOutputPanel();
        log(`\n=== Install ${skillName} -> ${destRoot} ===`);
        log(`${skillName}: ${status} (from ${sourceRoot})`);
        void notifyUserSuccess(`Claude Skills: ${skillName} -> ${status}`);
      }
      try {
        propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, { forceAgentSync: true });
      } catch (err) {
        const msg = (err as Error).message;
        log(`Workspace sync warning (hooks/mirrors): ${msg}`);
        vscode.window.showWarningMessage(
          `Claude Skills: ${skillName} installed, but hook sync hit a file lock. Reload the window and retry if needed.`
        );
      }
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.disableSkillLocally", async (item?: SkillItem) => {
      const target = getWorkspaceTarget();
      if (!target || !item) {
        return;
      }
      setSkillOverride(target, item.status.name, "off");
      log(`${item.status.name}: disabled locally (.claude/settings.local.json) - shared .claude/skills/ unchanged`);
      invalidateWorkspaceSyncFingerprint(target);
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, {
        userTriggered: true,
        skillNames: [item.status.name],
      });
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
      invalidateWorkspaceSyncFingerprint(target);
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, {
        userTriggered: true,
        skillNames: [item.status.name],
      });
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

    vscode.commands.registerCommand("claudeSkills.applyTaskSkillProposals", async () => {
      const target = getWorkspaceTarget();
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
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      let file = readTaskSkillProposals(target);
      if (!file?.options?.length) {
        ensureWorkspaceTaskProposals(target, loadManifest(libraryDir));
        file = readTaskSkillProposals(target);
      }
      if (!file?.options?.length) {
        void notifyUserWarn(
          "Claude Skills: no task skill options yet — describe a new task in chat or run skill-feedback-adaptation."
        );
        return;
      }
      const approved = await promptTaskSkillSetApproval(target, log, { force: true });
      if (!approved) {
        return;
      }
      const focusApply = applyTaskSkillFocusFromProposals(libraryDir, target);
      if (focusApply.applied && focusApply.focus) {
        propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, { forceAgentSync: true });
        refreshAll();
        void notifyUserSuccess(
          `Claude Skills: ${focusApply.focus.activeSkills.length} skill(s) active for this task.`
        );
      }
    }),

    vscode.commands.registerCommand("claudeSkills.upgradeOutdatedSkills", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const outdated = listOutdatedSkills(libraryDir, target);
      if (outdated.length === 0) {
        void notifyUserSuccess("Claude Skills: all installed skills match the library catalog version.");
        return;
      }
      const upgraded = await upgradeOutdatedSkills(libraryDir, target);
      if (upgraded.length > 0) {
        propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, {
          saveBranchProfile: true,
          forceAgentSync: true,
        });
        refreshAll();
        void notifyUserSuccess(
          `Claude Skills: upgraded ${upgraded.length} skill(s): ${upgraded.join(", ")}.`
        );
      } else {
        void notifyUserSuccess("Claude Skills: no skills were upgraded (cancelled or missing from library).");
      }
    }),

    vscode.commands.registerCommand("claudeSkills.refreshSkillCatalog", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const catalog = refreshSkillsCatalog(target, libraryDir);
      maybeRevealOutputPanel();
      log(`\n=== Skill catalog refreshed ===\n${catalog.skills.length} skill(s) -> .claude/learning/skills-catalog.json`);
      void notifyUserSuccess(`Claude Skills: refreshed skill catalog (${catalog.skills.length} skills).`);
    }),

    vscode.commands.registerCommand("claudeSkills.previewSkillSetResolver", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const plan = planSkillSetResolution(target, libraryDir);
      revealOutputPanel();
      log("\n=== Skill set resolver preview ===");
      log(formatSkillSetResolverPlan(plan).join("\n"));
      void notifyUserSuccess(
        `Claude Skills: would install ${plan.toInstall.length}, remove ${plan.toRemove.length}, archive ${plan.toArchive.length} — see output.`
      );
    }),

    vscode.commands.registerCommand("claudeSkills.runSkillSetResolver", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const plan = planSkillSetResolution(target, libraryDir);
      if (plan.toInstall.length === 0 && plan.toRemove.length === 0 && plan.toArchive.length === 0) {
        void notifyUserSuccess("Claude Skills: skill set already matches this workspace.");
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Install ${plan.toInstall.length}, remove ${plan.toRemove.length}, archive ${plan.toArchive.length} skill(s)?`,
        { modal: true },
        "Run"
      );
      if (confirm !== "Run") {
        return;
      }
      maybeRevealOutputPanel();
      log("\n=== Skill set resolver ===");
      const result = executeSkillSetResolution(target, libraryDir);
      log(formatSkillSetResolverPlan(result.plan).join("\n"));
      if (result.installed.length > 0) {
        log(`Installed: ${result.installed.join(", ")}`);
      }
      if (result.removed.length > 0) {
        log(`Removed: ${result.removed.join(", ")}`);
      }
      if (result.archived.length > 0) {
        log(`Archived: ${result.archived.join(", ")}`);
      }
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, { forceAgentSync: true });
      refreshAll();
      void notifyUserSuccess(
        `Claude Skills: installed ${result.installed.length}, removed ${result.removed.length}, archived ${result.archived.length}.`
      );
    }),

    vscode.commands.registerCommand("claudeSkills.restoreArchivedSkill", async () => {
      const target = getWorkspaceTarget();
      if (!target) {
        return;
      }
      const archived = listArchivedSkills(target);
      if (archived.length === 0) {
        void notifyUserSuccess("No archived skills to restore.");
        return;
      }
      const pick = await vscode.window.showQuickPick(archived, { title: "Restore archived skill" });
      if (pick && restoreArchivedSkill(target, pick, libraryDir)) {
        refreshAll();
        void notifyUserSuccess(`Restored skill: ${pick}`);
      }
    })
  );
}
