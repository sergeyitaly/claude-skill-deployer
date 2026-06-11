import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { listSkillStatuses, SkillStatus } from "./skillOps";

export class SkillItem extends vscode.TreeItem {
  constructor(public readonly status: SkillStatus) {
    super(status.name, vscode.TreeItemCollapsibleState.None);

    this.description = SkillItem.buildDescription(status);
    this.tooltip = SkillItem.buildTooltip(status);
    this.iconPath = SkillItem.buildIcon(status);

    // Checkbox = "enabled for this workspace" (installed in <workspace>/.claude/skills/).
    this.checkboxState = status.installedInWorkspace
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;

    // contextValue drives view/item/context "when" clauses (must start with "skill-")
    this.contextValue = status.availableInGlobal ? "skill-available" : "skill-unavailable";

    this.command = {
      command: "claudeSkills.openSkill",
      title: "Open SKILL.md",
      arguments: [this],
    };
  }

  private static buildDescription(status: SkillStatus): string {
    const parts: string[] = [];
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
    return parts.join(" • ");
  }

  private static buildTooltip(status: SkillStatus): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${status.name}**\n\n`);
    md.appendMarkdown(`${status.description}\n\n`);
    md.appendMarkdown(`Detect globs: \`${status.detectGlobs.join("`, `")}\`\n\n`);
    if (status.matchedGlobs.length > 0) {
      md.appendMarkdown(`Matched in workspace: \`${status.matchedGlobs.join("`, `")}\`\n\n`);
    }
    md.appendMarkdown(`Installed in workspace: ${status.installedInWorkspace ? "yes" : "no"}\n\n`);
    md.appendMarkdown(`In ~/.claude/skills: ${status.availableInGlobal ? "yes" : "no"}`);
    return md;
  }

  private static buildIcon(status: SkillStatus): vscode.ThemeIcon {
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

export class SkillsProvider implements vscode.TreeDataProvider<SkillItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SkillItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly libraryDir: string, private readonly getTarget: () => string | undefined) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SkillItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SkillItem): SkillItem[] {
    if (element) {
      return [];
    }
    const target = this.getTarget();
    const statuses = listSkillStatuses(this.libraryDir, target);
    statuses.sort((a, b) => {
      if (a.isRelevant !== b.isRelevant) {
        return a.isRelevant ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    return statuses.map((s) => new SkillItem(s));
  }
}
