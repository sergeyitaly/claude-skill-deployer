import * as vscode from "vscode";

let syncStatusItem: vscode.StatusBarItem | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

export function registerSyncStatusBar(context: vscode.ExtensionContext): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 93);
  item.name = "Claude Skills Sync";
  context.subscriptions.push(item);
  syncStatusItem = item;
  return item;
}

export function showSyncing(skills?: string[]): void {
  const item = syncStatusItem;
  if (!item) {
    return;
  }
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = undefined;
  }
  const suffix = skills?.length === 1 ? ` ${skills[0]}` : skills && skills.length > 1 ? ` (${skills.length})` : "";
  item.text = `$(sync~spin) Skills${suffix}`;
  item.tooltip = "Syncing workspace skills to other agents…";
  item.show();
}

export function flashSyncDone(changed: number): void {
  const item = syncStatusItem;
  if (!item) {
    return;
  }
  if (hideTimer) {
    clearTimeout(hideTimer);
  }
  if (changed <= 0) {
    item.hide();
    return;
  }
  item.text = `$(check) Synced ${changed}`;
  item.tooltip = "Agent mirrors updated";
  item.show();
  hideTimer = setTimeout(() => {
    item.hide();
    hideTimer = undefined;
  }, 1800);
}

export function hideSyncStatus(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = undefined;
  }
  syncStatusItem?.hide();
}

/** @internal */
export function resetSyncFeedbackForTests(): void {
  hideSyncStatus();
  syncStatusItem = undefined;
}
