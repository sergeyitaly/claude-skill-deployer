import * as vscode from "vscode";
import { agentCapabilityLines } from "./agentOps";
import {
  detectHostAgentId,
  formatAgentSkillSetsReport,
  hostAgentLabel,
  maybeSaveHostAgentSetWithBranchProfile,
  promptSwitchAgentSkillSet,
  saveAgentSkillSet,
} from "./agentSkillProfiles";
import {
  applyBranchProfile,
  branchProfilesFeatureActive,
  formatBranchProfilesReport,
  getCurrentBranch,
  loadBranchProfile,
  saveBranchProfile,
} from "./branchProfiles";
import {
  applyTeamBranchProfile,
  exportTeamBranchProfile,
  formatTeamProfileReport,
} from "./teamBranchProfiles";
import {
  buildProjectProfile,
  buildProjectProfileWithRemoteProbe,
  effectiveLockedTier,
  PROFILE_TYPE_LABELS,
  ProjectProfileFile,
  projectProfileApplyTierEnabled,
  readProjectProfile,
  refreshProjectProfileContext,
  setLockedProjectProfileTier,
  writeProjectProfile,
} from "./projectProfile";
import {
  formatProjectProfileNotifyMessage,
  formatProjectProfileSummaryBlock,
  formatProjectProfileTierComparisonTable,
} from "./projectProfile";
import {
  applyUserProjectPlan,
  buildProjectPlanQuickPickItems,
  formatDetectedTierSummary,
} from "./projectProfilePrompt";
import { setActiveProjectProfileContext } from "./activeProjectProfile";
import { propagateWorkspaceSkillChange } from "./workspaceSkillSync";
import {
  applyLocalProfileInit,
  promptForPosition,
  readUserPosition,
  startProfileInitFlow,
} from "./profileInit";
import { formatPrepareClaudeCliSummary, prepareForClaudeCli } from "./prepareClaudeCli";
import { notifySuggestion, notifyUserSuccess, notifyUserWarn } from "./userNotify";
import { recordError } from "./analytics";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface ProfileCommandDeps {
  context: vscode.ExtensionContext;
  libraryDir: string;
  getTarget: () => string | undefined;
  log: (line: string) => void;
  refreshAll: (opts?: { workspaceState?: boolean; forceTree?: boolean }) => void;
  revealOutputPanel: () => void;
  maybeRevealOutputPanel: () => void;
  refreshProjectTierStatusBar: (target: string | undefined) => void;
  cleanupExcessAgentMirrorsForTier: (target: string) => void;
}

// ---------------------------------------------------------------------------
// Command registrations
// ---------------------------------------------------------------------------

export function registerProfileCommands(deps: ProfileCommandDeps): vscode.Disposable[] {
  const {
    context,
    libraryDir,
    getTarget,
    log,
    refreshAll,
    revealOutputPanel,
    maybeRevealOutputPanel,
    refreshProjectTierStatusBar,
    cleanupExcessAgentMirrorsForTier,
  } = deps;

  return [
    vscode.commands.registerCommand("claudeSkills.saveBranchProfile", async () => {
      const target = getTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const profile = saveBranchProfile(target, libraryDir);
      maybeRevealOutputPanel();
      if (!profile) {
        log("\n=== Save branch profile ===\nNot a git repo or branch profiles disabled.");
        vscode.window.showWarningMessage("Claude Skills: could not save branch profile (git branch required).");
        return;
      }
      log(`\n=== Save branch profile -> ${profile.branch} ===`);
      log(`${profile.skills.length} skill(s), ${Object.keys(profile.skillOverrides).length} override(s)`);
      maybeSaveHostAgentSetWithBranchProfile(target);
      void notifyUserSuccess(
        `Claude Skills: saved skill profile for branch "${profile.branch}" (${profile.skills.length} skills).`
      );
    }),

    vscode.commands.registerCommand("claudeSkills.saveAgentSkillSet", async () => {
      const target = getTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const agent = detectHostAgentId();
      const saved = saveAgentSkillSet(target, agent);
      maybeRevealOutputPanel();
      if (!saved) {
        log("\n=== Save IDE skill set ===\nGit branch required or agent profiles disabled.");
        vscode.window.showWarningMessage("Claude Skills: could not save IDE skill set.");
        return;
      }
      log(`\n=== Save IDE skill set -> ${hostAgentLabel(agent)} (${saved.branch}) ===`);
      log(`${saved.skills.length} skill(s), ${Object.keys(saved.skillOverrides).length} override(s)`);
      void notifyUserSuccess(
        `Claude Skills: saved ${hostAgentLabel(agent)} skill set for "${saved.branch}" (${saved.skills.length} skills).`
      );
    }),

    vscode.commands.registerCommand("claudeSkills.switchAgentSkillSet", async () => {
      const target = getTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const result = await promptSwitchAgentSkillSet(libraryDir, target, log);
      if (!result) {
        return;
      }
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, {
        saveBranchProfile: false,
      });
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.showAgentSkillSets", async () => {
      const target = getTarget();
      if (!target) {
        return;
      }
      revealOutputPanel();
      log(`\n=== IDE / agent skill sets ===\n${formatAgentSkillSetsReport(target)}`);
    }),

    vscode.commands.registerCommand("claudeSkills.exportTeamBranchProfile", async () => {
      const target = getTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const profile = exportTeamBranchProfile(target, libraryDir);
      if (!profile) {
        vscode.window.showWarningMessage("Claude Skills: not on a git branch or could not capture profile.");
        return;
      }
      maybeRevealOutputPanel();
      log(`\n=== Export team branch profile ===\n${formatTeamProfileReport(target)}`);
      void notifyUserSuccess(
        `Claude Skills: wrote team profile (.claude/skills-profile.json) — commit to git.`
      );
    }),

    vscode.commands.registerCommand("claudeSkills.applyTeamBranchProfile", async () => {
      const target = getTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const result = applyTeamBranchProfile(libraryDir, target);
      if (!result) {
        vscode.window.showWarningMessage("Claude Skills: no team profile entry for this branch.");
        return;
      }
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, { forceAgentSync: true });
      refreshAll();
      void notifyUserSuccess(
        `Claude Skills: applied team profile (+${result.installed.length}, -${result.removed.length}).`
      );
    }),

    vscode.commands.registerCommand("claudeSkills.showTeamBranchProfiles", async () => {
      const target = getTarget();
      if (!target) {
        return;
      }
      revealOutputPanel();
      log(`\n=== Team branch profiles (git) ===\n${formatTeamProfileReport(target)}`);
    }),

    vscode.commands.registerCommand("claudeSkills.setPosition", async () => {
      const target = getTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const position = await promptForPosition(target);
      if (position) {
        void notifyUserSuccess(`Claude Skills: position saved as ${position.label} (local only).`);
      }
    }),

    vscode.commands.registerCommand("claudeSkills.initProfile", async () => {
      const target = getTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const branch = getCurrentBranch(target);
      if (!branch) {
        vscode.window.showWarningMessage("Claude Skills: init profile requires a git branch.");
        return;
      }
      maybeRevealOutputPanel();
      await startProfileInitFlow(context.extensionPath, libraryDir, target, branch, log);
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, {
        saveBranchProfile: false,
      });
      refreshAll();
    }),

    vscode.commands.registerCommand("claudeSkills.prepareForClaudeCli", async () => {
      const target = getTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      try {
        const result = await prepareForClaudeCli(context.extensionPath, libraryDir, target);
        maybeRevealOutputPanel();
        const summary = formatPrepareClaudeCliSummary(result);
        log(`\n=== Prepare for Claude CLI ===\n${summary}`);
        void notifyUserSuccess(
          "Claude Skills: workspace ready for Claude CLI — you can close the IDE and use `claude` in the terminal."
        );
        refreshAll();
      } catch (err) {
        recordError();
        vscode.window.showWarningMessage(`Claude Skills: prepare for Claude CLI failed — ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand("claudeSkills.applyLocalProfile", async () => {
      const target = getTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      const { result, init, invalid, hostAgentSkillSet } = applyLocalProfileInit(libraryDir, target);
      if (!init || !result) {
        const pending = readUserPosition(target);
        vscode.window.showWarningMessage(
          pending
            ? "Claude Skills: no pending profile.local.json with skills to apply."
            : "Claude Skills: write .claude/profile.local.json first (use profile-init skill)."
        );
        return;
      }
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, { forceAgentSync: true });
      refreshAll();
      maybeRevealOutputPanel();
      log(
        `\n=== Applied local profile ===\nBranch: ${init.branch}, role: ${init.roleLabel}\n` +
          `Installed: ${result.installed.join(", ") || "(none)"}\n` +
          (hostAgentSkillSet
            ? `IDE skill set (${hostAgentLabel(hostAgentSkillSet.agent)}): ${hostAgentSkillSet.skills.length} skill(s) saved.\n`
            : "") +
          (invalid.length ? `Skipped unknown: ${invalid.join(", ")}\n` : "")
      );
      void notifyUserSuccess(
        `Claude Skills: applied profile for ${init.branch} (+${result.installed.length} skill(s)).`
      );
    }),

    vscode.commands.registerCommand("claudeSkills.applyBranchProfile", async () => {
      const target = getTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
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
      maybeRevealOutputPanel();
      log(`\n=== Apply branch profile -> ${branch} ===`);
      log(`Installed: ${result.installed.join(", ") || "(none)"}`);
      log(`Removed: ${result.removed.join(", ") || "(none)"}`);
      log(`Overrides applied: ${result.overridesApplied}`);
      propagateWorkspaceSkillChange(context.extensionPath, target, libraryDir, log, { forceAgentSync: true });
      refreshAll();
      void notifyUserSuccess(
        `Claude Skills: applied "${branch}" profile (+${result.installed.length}, -${result.removed.length}).`
      );
    }),

    vscode.commands.registerCommand("claudeSkills.showAgentCapabilities", async () => {
      revealOutputPanel();
      log("\n=== Enabled AI agent targets ===");
      log(agentCapabilityLines(libraryDir).join("\n"));
      log("\nConfigure via Settings -> claudeSkills.agents.enabled");
      log("Agent paths defined in skills_library/agents.json");
    }),

    vscode.commands.registerCommand("claudeSkills.showBranchProfiles", async () => {
      const target = getTarget();
      if (!target) {
        void notifyUserWarn("Claude Skills: open a workspace folder first.");
        return;
      }
      if (!branchProfilesFeatureActive()) {
        vscode.window.showWarningMessage("Claude Skills: branch profiles are disabled in feature toggles.");
        return;
      }
      const report = formatBranchProfilesReport(target);
      revealOutputPanel();
      log(`\n=== Branch skill profiles ===`);
      log(report);
      const preview = report.split("\n").slice(0, 6).join("\n");
      void notifySuggestion(
        preview.length > 120 ? `${preview.slice(0, 117)}...` : preview,
        ["Open Output"],
        { log }
      ).then((choice) => {
        if (choice === "Open Output") {
          revealOutputPanel();
        }
      });
    }),

    vscode.commands.registerCommand("claudeSkills.showProjectProfile", async () => {
      const target = getTarget();
      if (!target) {
        return;
      }
      const profile = readProjectProfile(target) ?? buildProjectProfile(target);
      revealOutputPanel();
      log(`\n${formatProjectProfileTierComparisonTable(target, profile.profileType)}`);
      log(`\n${formatProjectProfileSummaryBlock(profile)}`);
      const view = formatProjectProfileNotifyMessage(profile);
      const pick = await vscode.window.showInformationMessage(view, "Change tier");
      if (pick === "Change tier") {
        void vscode.commands.executeCommand("claudeSkills.chooseProjectProfile");
      }
    }),

    vscode.commands.registerCommand("claudeSkills.detectProjectProfile", async () => {
      const target = getTarget();
      if (!target) {
        return;
      }
      const existing = readProjectProfile(target);
      const locked = effectiveLockedTier(existing, target);
      if (locked) {
        const action = await vscode.window.showWarningMessage(
          `Project tier is locked to ${PROFILE_TYPE_LABELS[locked]}. Re-detect will clear your manual plan.`,
          "Change tier",
          "Re-detect anyway",
          "Cancel"
        );
        if (action === "Change tier") {
          void vscode.commands.executeCommand("claudeSkills.chooseProjectProfile");
          return;
        }
        if (action !== "Re-detect anyway") {
          return;
        }
        await setLockedProjectProfileTier(target, "");
      }
      const profile = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Claude Skills: probing remote git for tier estimate",
          cancellable: false,
        },
        async () => buildProjectProfileWithRemoteProbe(target)
      );
      const detectedProfile: ProjectProfileFile = {
        ...profile,
        userPlan: "accept-detected",
        manualOverride: undefined,
      };
      writeProjectProfile(target, detectedProfile);
      refreshProjectProfileContext(target);
      refreshAll();
      revealOutputPanel();
      log(`\n=== Project profile detected ===\n${formatProjectProfileTierComparisonTable(target, detectedProfile.profileType)}`);
      log(`\n${formatProjectProfileSummaryBlock(detectedProfile)}`);
      void notifySuggestion(formatProjectProfileNotifyMessage(detectedProfile), ["View details"], {
        dedupeKey: `detect-profile|${target}`,
        log,
      });
    }),

    vscode.commands.registerCommand("claudeSkills.chooseProjectProfile", async () => {
      const target = getTarget();
      if (!target) {
        return;
      }
      const current = readProjectProfile(target);
      const detected = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Claude Skills: probing remote git (extension-only tier estimate)",
          cancellable: false,
        },
        async () => buildProjectProfileWithRemoteProbe(target)
      );
      log(`\n${formatProjectProfileTierComparisonTable(target, current?.profileType ?? detected.profileType)}`);
      const pick = await vscode.window.showQuickPick(
        buildProjectPlanQuickPickItems(detected, current?.userPlan),
        {
          title: "Choose project plan (remote git + local repo analyzed)",
          placeHolder: formatDetectedTierSummary(detected).replace(/\n/g, " · "),
          ignoreFocusOut: true,
        }
      );
      if (!pick) {
        return;
      }
      let lockedProfile: ProjectProfileFile;
      if (pick.id === "accept-detected") {
        await setLockedProjectProfileTier(target, "");
        lockedProfile = {
          ...detected,
          userPlan: "accept-detected",
          manualOverride: undefined,
          appliedAt: new Date().toISOString(),
        };
        writeProjectProfile(target, lockedProfile);
      } else {
        lockedProfile = await applyUserProjectPlan(target, detected, pick.id);
      }
      setActiveProjectProfileContext(
        lockedProfile.enabledFeatures,
        projectProfileApplyTierEnabled(target)
      );
      cleanupExcessAgentMirrorsForTier(target);
      refreshProjectTierStatusBar(target);
      refreshAll({ workspaceState: false, forceTree: true });
      if (lockedProfile) {
        revealOutputPanel();
        log(`\n=== Project profile plan confirmed ===\n${formatProjectProfileSummaryBlock(lockedProfile)}`);
        void vscode.window.showInformationMessage(
          `Claude Skills: project tier set to ${PROFILE_TYPE_LABELS[lockedProfile.profileType]}.`,
          "View details"
        ).then((action) => {
          if (action === "View details") {
            void vscode.commands.executeCommand("claudeSkills.showProjectProfile");
          }
        });
      }
    }),
  ];
}
