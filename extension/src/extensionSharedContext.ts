import * as vscode from "vscode";
import { SkillsProvider } from "./skillsProvider";

/**
 * State and callbacks shared across all command-registrar modules.
 * Passed into each registrar function so they do not need to import
 * module-level mutable state directly from extension.ts.
 */
export interface ExtensionSharedContext {
  context: vscode.ExtensionContext;
  libraryDir: string;
  log: (line: string) => void;
  getWorkspaceTarget: () => string | undefined;
  refreshAll: (opts?: { workspaceState?: boolean; forceTree?: boolean }) => void;
  refreshLight: () => void;
  revealOutputPanel: () => void;
  maybeRevealOutputPanel: () => void;
  provider: SkillsProvider;
  refreshMcpStatusBars: () => void;
  refreshCliMcpStatusBar: () => void;
  applyBudgetSettings: (logLines: boolean) => void;
  cleanupExcessAgentMirrorsForTier: (target: string) => void;
  applyProposalSkillNames: (target: string, names: string[]) => Promise<string[]>;
}
