import * as fs from "node:fs";
import * as path from "node:path";
import { CollectorState } from "./collectorState";
import { invalidateLearningCache } from "./runsStore";

const DEFAULT_RUNS_RETENTION_DAYS = 90;
const MAX_PROCESSED_SESSIONS = 2000;
const MAX_FILE_MTIMES = 500;
const MAX_BACKUP_FILES = 5;

export function pruneCollectorState(state: CollectorState): CollectorState {
  const processed = state.processedSessions ?? {};
  const entries = Object.entries(processed).sort((a, b) => b[1] - a[1]);
  if (entries.length > MAX_PROCESSED_SESSIONS) {
    state.processedSessions = Object.fromEntries(entries.slice(0, MAX_PROCESSED_SESSIONS));
  }

  const mtimes = state.fileMtimes ?? {};
  const mtimeEntries = Object.entries(mtimes).sort((a, b) => b[1] - a[1]);
  if (mtimeEntries.length > MAX_FILE_MTIMES) {
    state.fileMtimes = Object.fromEntries(mtimeEntries.slice(0, MAX_FILE_MTIMES));
  }

  return state;
}

export function pruneRunsJsonl(filePath: string, retentionDays = DEFAULT_RUNS_RETENTION_DAYS): number {
  if (!fs.existsSync(filePath)) {
    return 0;
  }
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const kept: string[] = [];
  let removed = 0;
  for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const row = JSON.parse(trimmed) as { ts?: string };
      const ts = row.ts ? new Date(row.ts).getTime() : NaN;
      if (!Number.isNaN(ts) && ts < cutoff) {
        removed += 1;
        continue;
      }
      kept.push(trimmed);
    } catch {
      kept.push(trimmed);
    }
  }
  if (removed > 0) {
    fs.writeFileSync(filePath, kept.join("\n") + (kept.length ? "\n" : ""), "utf-8");
    const learningDir = path.dirname(filePath);
    const claudeDir = path.dirname(learningDir);
    const target = path.dirname(claudeDir);
    invalidateLearningCache(target);
  }
  return removed;
}

/** Keep only the newest N `*.pre-reset-*.bak` / `*.bak-*` siblings in a directory. */
export function pruneBackupFiles(dir: string, prefix: string, maxKeep = MAX_BACKUP_FILES): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  const matches = fs
    .readdirSync(dir)
    .filter((name) => name.includes(prefix) && (name.endsWith(".bak") || name.includes(".bak-")))
    .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const extra of matches.slice(maxKeep)) {
    try {
      fs.rmSync(path.join(dir, extra.name), { force: true });
    } catch {
      // ignore
    }
  }
}
