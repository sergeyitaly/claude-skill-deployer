import * as fs from "node:fs";
import * as path from "node:path";
import {
  branchProfilesFeatureActive,
  BranchSkillProfile,
  getCurrentBranch,
  isGitWorkspace,
  listRepoBranchProfiles,
} from "./branchProfiles";
import { isSkillEffectivelyEnabled, listSkillStatuses, loadManifest, SkillStatus } from "./skillOps";
import { loadTeamSkillsProfile, teamProfileRelativePath } from "./teamBranchProfiles";
import { isFeatureEnabled } from "./featureFlags";
import { compareSkillsForSort, formatRoiDescription, skillRoiMetrics, SkillSortMode } from "./skillRoi";
import { computeUsageStats } from "./usageStats";
import * as vscode from "vscode";

export class BranchProfilesRootItem extends vscode.TreeItem {
  constructor(label: string, count: number) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "branch-profiles-root";
    this.iconPath = new vscode.ThemeIcon("git-branch");
    this.description = `${count} saved`;
    this.tooltip = "Per-branch skill layouts stored in ~/.claude/learning/branch-profiles.json";
  }
}

export class TeamProfilesRootItem extends vscode.TreeItem {
  constructor(label: string, count: number) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "team-profiles-root";
    this.iconPath = new vscode.ThemeIcon("repo");
    this.description = `${count} branch(es)`;
    this.tooltip = "Git-committed team skill layouts (.claude/skills-profile.json)";
  }
}

export class TeamProfileBranchItem extends vscode.TreeItem {
  constructor(branch: string, skillCount: number, isCurrent: boolean, updatedAt?: string) {
    super(branch, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "team-profile-entry";
    this.iconPath = new vscode.ThemeIcon(isCurrent ? "check" : "repo");
    this.description = `${skillCount} skills`;
    this.tooltip = `Team profile for ${branch}${updatedAt ? ` — updated ${updatedAt.slice(0, 16).replace("T", " ")}` : ""}`;
    this.command = {
      command: "claudeSkills.showTeamBranchProfiles",
      title: "Show Team Branch Profiles",
    };
  }
}

export class BranchProfileBranchItem extends vscode.TreeItem {
  constructor(profile: BranchSkillProfile, isCurrent: boolean) {
    super(profile.branch, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "branch-profile-entry";
    this.iconPath = new vscode.ThemeIcon(isCurrent ? "check" : "git-branch");
    this.description = `${profile.skills.length} skills`;
    const overrides = Object.keys(profile.skillOverrides).length;
    this.tooltip = new vscode.MarkdownString(
      `**${profile.branch}**${isCurrent ? " (current)" : ""}\n\n` +
        `Skills: ${profile.skills.length ? profile.skills.join(", ") : "(none)"}\n\n` +
        `Overrides: ${overrides}\n\n` +
        `Updated: ${profile.updatedAt.slice(0, 16).replace("T", " ")}`
    );
    this.command = {
      command: "claudeSkills.showBranchProfiles",
      title: "Show Branch Skill Profiles",
    };
  }
}

export type SkillsTreeNode =
  | SkillItem
  | BranchProfilesRootItem
  | BranchProfileBranchItem
  | TeamProfilesRootItem
  | TeamProfileBranchItem;

export interface SkillUiOverlay {
  syncing?: boolean;
  flashSuccess?: boolean;
  ripple?: boolean;
}

export class SkillItem extends vscode.TreeItem {
  constructor(
    public status: SkillStatus,
    roiLine?: string,
    private ui?: SkillUiOverlay
  ) {
    super(status.name, vscode.TreeItemCollapsibleState.None);
    this.applyPresentation(roiLine);
  }

  get skillId(): string {
    return this.status.name;
  }

  updateFromStatus(status: SkillStatus, roiLine?: string, ui?: SkillUiOverlay): void {
    this.status = status;
    this.ui = ui;
    this.label = status.name;
    this.applyPresentation(roiLine);
  }

  private applyPresentation(roiLine?: string): void {
    this.id = `claudeSkills.skill.${this.status.name}`;
    this.description = SkillItem.buildDescription(this.status, roiLine, this.ui);
    this.tooltip = SkillItem.buildTooltip(this.status);
    this.iconPath = SkillItem.buildIcon(this.status, this.ui);
    this.checkboxState = isSkillEffectivelyEnabled(this.status.installedInWorkspace, this.status.localOverride)
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    this.contextValue = SkillItem.buildContextValue(this.status);
    this.command = {
      command: "claudeSkills.openSkill",
      title: "Open SKILL.md",
      arguments: [this],
    };
  }

  private static buildContextValue(status: SkillStatus): string {
    let base: string;
    if (!status.inLibrary) {
      base = "skill-project-local";
    } else if (status.availableInGlobal) {
      base = "skill-available";
    } else {
      base = "skill-unavailable";
    }
    // Local on/off toggle only makes sense for skills present in the
    // (shared, git-tracked) <workspace>/.claude/skills/ - suffix drives the
    // inline enable/disable command's "when" clause.
    if (status.installedInWorkspace) {
      return `${base}-local-${status.localOverride === "off" ? "off" : "on"}`;
    }
    return base;
  }

  private static localOverrideLabel(status: SkillStatus): string | undefined {
    switch (status.localOverride) {
      case "off":
        return "disabled locally";
      case "name-only":
        return "name-only locally";
      case "user-invocable-only":
        return "user-invocable-only locally";
      default:
        return undefined;
    }
  }

  private static buildDescription(status: SkillStatus, roiLine?: string, ui?: SkillUiOverlay): string {
    const parts: string[] = [];
    if (ui?.syncing) {
      parts.push("syncing…");
    } else if (ui?.flashSuccess) {
      parts.push("synced");
    }
    if (roiLine) {
      parts.push(roiLine);
    }
    if (status.isRelevant) {
      parts.push("relevant");
    }
    if (status.installedInWorkspace) {
      parts.push("installed");
    } else if (status.availableInGlobal) {
      parts.push("available");
    } else {
      parts.push("not in global library");
    }
    if (!status.inLibrary) {
      parts.push("project-only");
    }
    const overrideLabel = SkillItem.localOverrideLabel(status);
    if (overrideLabel) {
      parts.push(overrideLabel);
    }
    return parts.join(" • ");
  }

  private static buildTooltip(status: SkillStatus): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${status.name}**\n\n`);
    md.appendMarkdown(`${status.description}\n\n`);
    if (!status.inLibrary) {
      md.appendMarkdown(`_Project-local skill - not part of the bundled skill library._\n\n`);
    }
    if (status.detectGlobs.length > 0) {
      md.appendMarkdown(`Detect globs: \`${status.detectGlobs.join("`, `")}\`\n\n`);
    }
    if (status.matchedGlobs.length > 0) {
      md.appendMarkdown(`Matched in workspace: \`${status.matchedGlobs.join("`, `")}\`\n\n`);
    }
    const effective = isSkillEffectivelyEnabled(status.installedInWorkspace, status.localOverride);
    md.appendMarkdown(`Enabled for you: ${effective ? "yes" : "no"}\n\n`);
    md.appendMarkdown(`Files in workspace .claude/skills/: ${status.installedInWorkspace ? "yes" : "no"}\n\n`);
    md.appendMarkdown(`In ~/.claude/skills: ${status.availableInGlobal ? "yes" : "no"}`);
    if (status.installedInWorkspace) {
      const overrideValue = status.localOverride ?? "on";
      md.appendMarkdown(
        `\n\nLocal override (.claude/settings.local.json, personal/gitignored): \`${overrideValue}\`\n\n` +
          `Unchecking a branch-committed skill turns it off locally without deleting shared files. ` +
          `Unchecking a personal-only skill removes \`.claude/skills/${status.name}/\` from your machine.`
      );
    } else if (!effective && status.localOverride === "off") {
      md.appendMarkdown(
        `\n\nDisabled locally via skillOverrides — files may still exist on the branch for teammates.`
      );
    }
    return md;
  }

  private static buildIcon(status: SkillStatus, ui?: SkillUiOverlay): vscode.ThemeIcon {
    if (ui?.syncing) {
      return new vscode.ThemeIcon("sync~spin");
    }
    if (ui?.flashSuccess || ui?.ripple) {
      return new vscode.ThemeIcon("check", new vscode.ThemeColor("charts.green"));
    }
    if (status.installedInWorkspace && status.localOverride === "off") {
      return new vscode.ThemeIcon("eye-closed", new vscode.ThemeColor("disabledForeground"));
    }
    if (status.installedInWorkspace) {
      return new vscode.ThemeIcon("check", new vscode.ThemeColor("charts.green"));
    }
    if (status.isRelevant) {
      return new vscode.ThemeIcon("lightbulb", new vscode.ThemeColor("charts.yellow"));
    }
    if (status.availableInGlobal) {
      return new vscode.ThemeIcon("circle-outline");
    }
    return new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("disabledForeground"));
  }

  /** Path to the SKILL.md to open: prefer the workspace copy, then global, then bundled. */
  resolveSkillFilePath(globalSkillsDir: string, workspaceTarget: string | undefined): string {
    if (workspaceTarget) {
      const inWorkspace = path.join(workspaceTarget, ".claude", "skills", this.status.name, "SKILL.md");
      if (fs.existsSync(inWorkspace)) {
        return inWorkspace;
      }
    }
    const inGlobal = path.join(globalSkillsDir, this.status.name, "SKILL.md");
    if (fs.existsSync(inGlobal)) {
      return inGlobal;
    }
    return this.status.bundledPath;
  }
}

export class SkillsProvider implements vscode.TreeDataProvider<SkillsTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SkillsTreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly optimisticEnabled = new Map<string, boolean>();
  private readonly uiShadow = new Map<string, SkillUiOverlay>();
  private readonly skillItemCache = new Map<string, SkillItem>();
  private treeRefreshPending = false;
  private treeRefreshAll = false;
  private treeRefreshSkills = new Set<string>();

  constructor(private readonly libraryDir: string, private readonly getTarget: () => string | undefined) {}

  /** Immediate checkbox feedback before background agent sync completes. */
  setOptimisticEnabled(skillName: string, enabled: boolean): void {
    this.optimisticEnabled.set(skillName, enabled);
    this.uiShadow.set(skillName, { ripple: true });
    this.scheduleTreeRefresh(skillName);
    setTimeout(() => {
      const cur = this.uiShadow.get(skillName);
      if (cur?.ripple && !cur.syncing) {
        this.uiShadow.delete(skillName);
        this.scheduleTreeRefresh(skillName);
      }
    }, 130);
  }

  setSkillSyncing(skillName: string, syncing: boolean): void {
    const prev = this.uiShadow.get(skillName) ?? {};
    if (syncing) {
      this.uiShadow.set(skillName, { syncing: true, flashSuccess: false, ripple: false });
    } else {
      const next = { ...prev, syncing: false };
      if (!next.flashSuccess) {
        this.uiShadow.delete(skillName);
      } else {
        this.uiShadow.set(skillName, next);
      }
    }
    this.scheduleTreeRefresh(skillName);
  }

  flashSkillSynced(skillName: string): void {
    this.uiShadow.set(skillName, { syncing: false, flashSuccess: true });
    this.scheduleTreeRefresh(skillName);
    setTimeout(() => {
      const cur = this.uiShadow.get(skillName);
      if (cur?.flashSuccess) {
        this.uiShadow.delete(skillName);
        this.scheduleTreeRefresh(skillName);
      }
    }, 140);
  }

  clearOptimistic(skillName?: string): void {
    if (skillName) {
      this.optimisticEnabled.delete(skillName);
      this.uiShadow.delete(skillName);
      this.scheduleTreeRefresh(skillName);
    } else {
      this.optimisticEnabled.clear();
      this.uiShadow.clear();
      this.scheduleTreeRefresh();
    }
  }

  refresh(): void {
    this.optimisticEnabled.clear();
    this.uiShadow.clear();
    this.scheduleTreeRefresh();
  }

  private scheduleTreeRefresh(skillId?: string): void {
    if (skillId) {
      this.treeRefreshSkills.add(skillId);
    } else {
      this.treeRefreshAll = true;
    }
    if (this.treeRefreshPending) {
      return;
    }
    this.treeRefreshPending = true;
    queueMicrotask(() => {
      this.treeRefreshPending = false;
      if (this.treeRefreshAll) {
        this.treeRefreshAll = false;
        this.treeRefreshSkills.clear();
        this._onDidChangeTreeData.fire();
        return;
      }
      const ids = [...this.treeRefreshSkills];
      this.treeRefreshSkills.clear();
      for (const id of ids) {
        const item = this.skillItemCache.get(id);
        if (item) {
          this._onDidChangeTreeData.fire(item);
        }
      }
    });
  }

  private applyShadow(status: SkillStatus): { status: SkillStatus; ui?: SkillUiOverlay } {
    const enabledOverlay = this.optimisticEnabled.get(status.name);
    let next = status;
    if (enabledOverlay !== undefined) {
      next = enabledOverlay
        ? { ...status, localOverride: undefined, installedInWorkspace: true }
        : { ...status, localOverride: "off" };
    }
    const shadow = this.uiShadow.get(status.name);
    const ui: SkillUiOverlay | undefined = shadow
      ? { syncing: shadow.syncing, flashSuccess: shadow.flashSuccess, ripple: shadow.ripple }
      : undefined;
    return { status: next, ui };
  }

  private getOrUpdateSkillItem(status: SkillStatus, roiLine?: string): SkillItem {
    const { status: applied, ui } = this.applyShadow(status);
    const cached = this.skillItemCache.get(applied.name);
    if (cached) {
      cached.updateFromStatus(applied, roiLine, ui);
      return cached;
    }
    const item = new SkillItem(applied, roiLine, ui);
    this.skillItemCache.set(applied.name, item);
    return item;
  }

  getTreeItem(element: SkillsTreeNode): vscode.TreeItem {
    return element;
  }

  private teamSection(target: string): SkillsTreeNode[] {
    const team = loadTeamSkillsProfile(target);
    if (!team) {
      return [];
    }
    const branches = Object.keys(team.branches);
    const rel = teamProfileRelativePath();
    const current = getCurrentBranch(target);
    const root = new TeamProfilesRootItem(`Team profiles (${rel})`, branches.length);
    if (branches.length === 0) {
      root.collapsibleState = vscode.TreeItemCollapsibleState.None;
      root.description = "empty — Export Team Branch Profile";
      root.command = { command: "claudeSkills.exportTeamBranchProfile", title: "Export Team Branch Profile" };
      return [root];
    }
    return [root];
  }

  private branchSection(target: string): SkillsTreeNode[] {
    if (!branchProfilesFeatureActive() || !isGitWorkspace(target)) {
      return [];
    }
    const current = getCurrentBranch(target);
    const profiles = listRepoBranchProfiles(target);
    const rootLabel = current ? `Branch profiles (${current})` : "Branch profiles";
    const root = new BranchProfilesRootItem(rootLabel, profiles.length);
    if (profiles.length === 0) {
      root.description = "none saved — use Save Branch Skill Profile";
      root.collapsibleState = vscode.TreeItemCollapsibleState.None;
      root.command = { command: "claudeSkills.saveBranchProfile", title: "Save Branch Skill Profile" };
      return [root];
    }
    return [root];
  }

  getChildren(element?: SkillsTreeNode): SkillsTreeNode[] {
    const target = this.getTarget();

    if (element instanceof TeamProfilesRootItem) {
      if (!target) {
        return [];
      }
      const team = loadTeamSkillsProfile(target);
      if (!team) {
        return [];
      }
      const current = getCurrentBranch(target);
      return Object.entries(team.branches)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(
          ([branch, entry]) =>
            new TeamProfileBranchItem(branch, entry.skills.length, branch === current, entry.updatedAt)
        );
    }

    if (element instanceof BranchProfilesRootItem) {
      if (!target) {
        return [];
      }
      const current = getCurrentBranch(target);
      return listRepoBranchProfiles(target).map(
        (p) => new BranchProfileBranchItem(p, p.branch === current)
      );
    }

    if (element) {
      return [];
    }

    const teamNodes = target ? this.teamSection(target) : [];
    const branchNodes = target ? this.branchSection(target) : [];
    const statuses = listSkillStatuses(this.libraryDir, target);
    const manifest = loadManifest(this.libraryDir);
    const sortMode = vscode.workspace
      .getConfiguration("claudeSkills.search")
      .get<SkillSortMode>("sortBy", "relevance");
    const usageMap = new Map(
      target ? computeUsageStats(target, manifest).map((s) => [s.name, s]) : []
    );

    statuses.sort((a, b) => {
      if (sortMode === "relevance" && a.isRelevant !== b.isRelevant) {
        return a.isRelevant ? -1 : 1;
      }
      if (isFeatureEnabled("costAwareSearch") && sortMode !== "relevance") {
        return compareSkillsForSort(a.name, b.name, sortMode, manifest, usageMap);
      }
      return a.name.localeCompare(b.name);
    });

    const showRoi = isFeatureEnabled("costAwareSearch");
    const skillNodes = statuses.map((s) => {
      let roiLine: string | undefined;
      if (showRoi && s.inLibrary) {
        const metrics = skillRoiMetrics(s.name, manifest, usageMap.get(s.name));
        roiLine = formatRoiDescription(metrics, s.isRelevant);
      }
      return this.getOrUpdateSkillItem(s, roiLine);
    });
    return [...teamNodes, ...branchNodes, ...skillNodes];
  }
}
