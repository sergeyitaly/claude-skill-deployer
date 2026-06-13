import * as vscode from "vscode";

const USER_ACTIVE_MS = 800;
const TYPING_QUIET_MS = 1500;
const DEFER_POLL_MS = 500;

let userActiveUntil = 0;
let lastTypingAt = 0;
let lastDocumentEditAt = 0;
let lastCommandAt = 0;
let clickingUntil = 0;

export function markUserInteraction(): void {
  userActiveUntil = Date.now() + USER_ACTIVE_MS;
}

export function markClick(): void {
  clickingUntil = Date.now() + USER_ACTIVE_MS;
  markUserInteraction();
}

export function markTypingActivity(): void {
  lastTypingAt = Date.now();
  markUserInteraction();
}

export function markDocumentEdit(): void {
  lastDocumentEditAt = Date.now();
  markTypingActivity();
}

export function markCommandExecution(): void {
  lastCommandAt = Date.now();
  markUserInteraction();
}

export function isUserActive(now = Date.now()): boolean {
  return now < userActiveUntil || now < clickingUntil;
}

export function isTypingQuiet(now = Date.now()): boolean {
  return now - lastTypingAt < TYPING_QUIET_MS;
}

export function isEditorBusy(now = Date.now()): boolean {
  return now - lastDocumentEditAt < TYPING_QUIET_MS || now - lastCommandAt < USER_ACTIVE_MS;
}

/** True when background work should defer (clicks, typing, editor focus). */
export function shouldDeferBackgroundWork(now = Date.now()): boolean {
  return isUserActive(now) || isTypingQuiet(now) || isEditorBusy(now);
}

/** Run when the user is idle; polls until quiet mode ends. */
export function runWhenIdle(run: () => void, pollMs = DEFER_POLL_MS): void {
  if (!shouldDeferBackgroundWork()) {
    run();
    return;
  }
  setTimeout(() => runWhenIdle(run, pollMs), pollMs);
}

/** Wire VS Code editor hooks for activity-aware deferral. */
export function registerUserActivityListeners(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(() => markDocumentEdit()),
    vscode.window.onDidChangeTextEditorSelection(() => markTypingActivity()),
    vscode.window.onDidChangeActiveTextEditor(() => markUserInteraction())
  );
}

/** @internal */
export function resetUserInteractionForTests(): void {
  userActiveUntil = 0;
  lastTypingAt = 0;
  lastDocumentEditAt = 0;
  lastCommandAt = 0;
  clickingUntil = 0;
}
