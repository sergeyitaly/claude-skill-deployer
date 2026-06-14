import * as vscode from "vscode";

export type NotificationLevel = "silent" | "minimal" | "normal";

/** What triggered the toast — drives level gating and dedupe TTL. */
export type NotifyCategory = "background" | "suggestion" | "user-action" | "important";

const DEDUPE_TTL_MS: Record<NotifyCategory, number> = {
  background: 30 * 60 * 1000,
  suggestion: 6 * 60 * 60 * 1000,
  "user-action": 2 * 60 * 1000,
  important: 60 * 60 * 1000,
};

const recentToasts = new Map<string, number>();

export function notificationLevel(): NotificationLevel {
  const raw = vscode.workspace.getConfiguration("claudeSkills").get<string>("notificationLevel", "minimal");
  if (raw === "silent" || raw === "normal") {
    return raw;
  }
  return "minimal";
}

export function shouldShowToast(category: NotifyCategory): boolean {
  const level = notificationLevel();
  if (level === "normal") {
    return true;
  }
  if (category === "important") {
    return true;
  }
  return false;
}

function dedupeAllows(key: string, category: NotifyCategory): boolean {
  const now = Date.now();
  const prev = recentToasts.get(key);
  if (prev !== undefined && now - prev < DEDUPE_TTL_MS[category]) {
    return false;
  }
  recentToasts.set(key, now);
  return true;
}

export function notifyInfo(
  message: string,
  options?: { category?: NotifyCategory; dedupeKey?: string; items?: string[]; log?: (line: string) => void }
): Thenable<string | undefined> {
  const category = options?.category ?? "user-action";
  options?.log?.(message);
  if (!shouldShowToast(category)) {
    return Promise.resolve(undefined);
  }
  const key = options?.dedupeKey ?? `${category}|${message}`;
  if (!dedupeAllows(key, category)) {
    return Promise.resolve(undefined);
  }
  const items = options?.items ?? [];
  return items.length > 0
    ? vscode.window.showInformationMessage(message, ...items)
    : vscode.window.showInformationMessage(message);
}

export function notifyWarn(
  message: string,
  options?: {
    category?: NotifyCategory;
    dedupeKey?: string;
    modal?: boolean;
    items?: string[];
    log?: (line: string) => void;
  }
): Thenable<string | undefined> {
  const category = options?.category ?? "important";
  options?.log?.(message);
  if (notificationLevel() === "silent" && category !== "important") {
    return Promise.resolve(undefined);
  }
  if (!shouldShowToast(category) && category !== "important") {
    return Promise.resolve(undefined);
  }
  const key = options?.dedupeKey ?? `${category}|warn|${message}`;
  if (category !== "important" && !dedupeAllows(key, category)) {
    return Promise.resolve(undefined);
  }
  const items = options?.items ?? [];
  if (items.length > 0) {
    return options?.modal
      ? vscode.window.showWarningMessage(message, { modal: true }, ...items)
      : vscode.window.showWarningMessage(message, ...items);
  }
  return options?.modal
    ? vscode.window.showWarningMessage(message, { modal: true })
    : vscode.window.showWarningMessage(message);
}

/** Background work (auto-apply, schedulers, hooks): log only unless notification level is normal. */
export function notifyBackground(message: string, log?: (line: string) => void): void {
  log?.(message);
  void notifyInfo(message, { category: "background", dedupeKey: `bg|${message}` });
}

/** Opt-in prompts (updates, tier hints, outdated skills): quieter by default. */
export function notifySuggestion(
  message: string,
  items: string[],
  options?: { dedupeKey?: string; log?: (line: string) => void }
): Thenable<string | undefined> {
  return notifyInfo(message, {
    category: "suggestion",
    dedupeKey: options?.dedupeKey,
    items,
    log: options?.log,
  });
}

/** Result of a command the user ran — suppressed in minimal/silent (log elsewhere). */
export function notifyUserSuccess(message: string, log?: (line: string) => void): Thenable<string | undefined> {
  log?.(message);
  if (!shouldShowToast("user-action")) {
    return Promise.resolve(undefined);
  }
  return vscode.window.showInformationMessage(message);
}

/** Blockers and validation — always shown except optional dedupe on repeats. */
export function notifyUserWarn(
  message: string,
  items?: string[],
  modal?: boolean
): Thenable<string | undefined> {
  return notifyWarn(message, { category: "important", items, modal });
}
