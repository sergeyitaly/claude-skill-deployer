import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
export interface CollectorState {
  lastRun: number;
  fileMtimes: Record<string, number>;
  /** sessionId|filePath -> mtime when runs.jsonl row was written (prevents double count). */
  processedSessions?: Record<string, number>;
  workspacePath?: string;
}

export const LEGACY_COLLECTOR_STATE_PATH = path.join(
  os.homedir(),
  ".claude",
  "learning",
  "attribution-collector-state.json"
);

export function collectorStatePath(target: string): string {
  return path.join(target, ".claude", "learning", "attribution-collector-state.json");
}

export function migrateLegacyCollectorState(target: string): boolean {
  const wsPath = collectorStatePath(target);
  if (fs.existsSync(wsPath)) {
    return false;
  }
  if (!fs.existsSync(LEGACY_COLLECTOR_STATE_PATH)) {
    return false;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(LEGACY_COLLECTOR_STATE_PATH, "utf-8")) as {
      workspacePath?: string;
    };
    const legacyWs = raw.workspacePath;
    if (legacyWs && path.resolve(legacyWs) !== path.resolve(target)) {
      return false;
    }
    fs.mkdirSync(path.dirname(wsPath), { recursive: true });
    fs.copyFileSync(LEGACY_COLLECTOR_STATE_PATH, wsPath);
    return true;
  } catch {
    return false;
  }
}

export function readCollectorState(target: string): CollectorState {
  migrateLegacyCollectorState(target);
  try {
    return JSON.parse(fs.readFileSync(collectorStatePath(target), "utf-8")) as CollectorState;
  } catch {
    return { lastRun: 0, fileMtimes: {}, processedSessions: {} };
  }
}

export function writeCollectorState(target: string, state: CollectorState): void {
  const file = collectorStatePath(target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n", "utf-8");
}
