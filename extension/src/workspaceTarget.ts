import * as path from "node:path";
import * as vscode from "vscode";

let pinnedTarget: string | undefined;

export function isMultiRootWorkspace(): boolean {
  return (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
}

/** Active editor's workspace folder, else pinned pick, else first folder. */
export function resolveWorkspaceTarget(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    return undefined;
  }

  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === "file") {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) {
      return folder.uri.fsPath;
    }
  }

  if (pinnedTarget) {
    const norm = path.normalize(pinnedTarget);
    if (folders.some((f) => path.normalize(f.uri.fsPath) === norm)) {
      return pinnedTarget;
    }
    pinnedTarget = undefined;
  }

  return folders[0].uri.fsPath;
}

export function setPinnedWorkspaceTarget(target: string): void {
  pinnedTarget = target;
}

export async function pickWorkspaceTarget(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0].uri.fsPath;
  }

  const current = resolveWorkspaceTarget();
  const pick = await vscode.window.showQuickPick(
    folders.map((f) => ({
      label: f.name,
      description: f.uri.fsPath,
      path: f.uri.fsPath,
      picked: f.uri.fsPath === current,
    })),
    {
      title: "Claude Skills: active workspace folder",
      placeHolder: "Skills, cost, and profiles apply to the selected folder",
    }
  );
  if (pick) {
    pinnedTarget = pick.path;
    return pick.path;
  }
  return current;
}

export function workspaceFolderLabel(target: string | undefined): string | undefined {
  if (!target || !isMultiRootWorkspace()) {
    return undefined;
  }
  const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.fsPath === target);
  return folder?.name ?? path.basename(target);
}

export function registerWorkspaceTargetListeners(onChange: () => void, context: vscode.ExtensionContext): void {
  const debounced = debounce(onChange, 400);
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      if (isMultiRootWorkspace()) {
        debounced();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => onChange())
  );
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(fn, ms);
  };
}
