import * as path from "node:path";
import { buildWorkspaceSyncFingerprint } from "./agentOps";

const preToggleByTarget = new Map<string, string>();

/** Capture workspace fingerprint before a user toggle (call before disk ops). */
export function markPreToggleFingerprint(target: string): string {
  const fp = buildWorkspaceSyncFingerprint(target);
  preToggleByTarget.set(path.resolve(target), fp);
  return fp;
}

/** After toggle: true when net workspace state equals pre-toggle (rapid on-off before sync). */
export function rapidToggleWouldBeNoOp(target: string): boolean {
  const before = preToggleByTarget.get(path.resolve(target));
  if (!before) {
    return false;
  }
  return before === buildWorkspaceSyncFingerprint(target);
}

export function clearPreToggleFingerprint(target: string): void {
  preToggleByTarget.delete(path.resolve(target));
}

/** @deprecated Use markPreToggleFingerprint + rapidToggleWouldBeNoOp */
export function precomputeSyncFingerprint(target: string): string {
  return markPreToggleFingerprint(target);
}

/** @internal */
export function resetSyncPredictForTests(): void {
  preToggleByTarget.clear();
}
