import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listTranscriptFiles } from "./transcriptParsers";
import { CreditUsageSummary, computeCreditUsageFromRoots } from "./usageCost";
import { isCursorTranscriptRoot } from "./workspaceTranscripts";
import { transcriptFileMatchesWorkspace } from "./workspaceTranscripts";

interface TranscriptFingerprint {
  maxMtimeMs: number;
  fileCount: number;
}

interface TranscriptCacheEntry {
  fingerprint: TranscriptFingerprint;
  rootsKey: string;
  daysBack: number;
  workspaceKey: string;
  data: CreditUsageSummary;
}

const transcriptCache = new Map<string, TranscriptCacheEntry>();

function expandTranscriptRoot(root: string): string {
  return root.startsWith("~/") ? path.join(os.homedir(), root.slice(2)) : root;
}

function cacheKey(roots: string[], daysBack: number, workspaceTarget?: string): string {
  const normalizedRoots = [...roots].map(expandTranscriptRoot).sort().join("|");
  const ws = workspaceTarget ? path.resolve(workspaceTarget) : "";
  return `${ws}|${daysBack}|${normalizedRoots}`;
}

/** Stat-only scan — avoids reading transcript bodies when checking cache validity. */
export function fingerprintTranscriptRoots(
  roots: string[],
  daysBack: number,
  workspaceTarget?: string
): TranscriptFingerprint {
  const cutoffMs = Date.now() - (daysBack + 1) * 24 * 60 * 60 * 1000;
  let maxMtimeMs = 0;
  let fileCount = 0;

  for (const root of roots) {
    const dir = expandTranscriptRoot(root);
    const cursorFormat = isCursorTranscriptRoot(dir);
    for (const file of listTranscriptFiles(dir)) {
      if (workspaceTarget && !transcriptFileMatchesWorkspace(file, workspaceTarget)) {
        continue;
      }
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (st.mtimeMs < cutoffMs) {
        continue;
      }
      fileCount += 1;
      if (st.mtimeMs > maxMtimeMs) {
        maxMtimeMs = st.mtimeMs;
      }
      void cursorFormat;
    }
  }

  return { maxMtimeMs, fileCount };
}

function fingerprintMatches(a: TranscriptFingerprint, b: TranscriptFingerprint): boolean {
  return a.maxMtimeMs === b.maxMtimeMs && a.fileCount === b.fileCount;
}

/** Cached transcript credit usage — invalidated when transcript mtimes change. */
export function readCachedCreditUsageFromRoots(
  roots: string[],
  daysBack = 14,
  workspaceTarget?: string
): CreditUsageSummary {
  const key = cacheKey(roots, daysBack, workspaceTarget);
  const fp = fingerprintTranscriptRoots(roots, daysBack, workspaceTarget);
  const hit = transcriptCache.get(key);
  if (hit && hit.rootsKey === key && hit.daysBack === daysBack && fingerprintMatches(hit.fingerprint, fp)) {
    return hit.data;
  }

  const data = computeCreditUsageFromRoots(roots, daysBack, workspaceTarget);
  transcriptCache.set(key, {
    fingerprint: fp,
    rootsKey: key,
    daysBack,
    workspaceKey: workspaceTarget ? path.resolve(workspaceTarget) : "",
    data,
  });
  return data;
}

export function invalidateTranscriptUsageCache(target?: string): void {
  if (!target) {
    transcriptCache.clear();
    return;
  }
  const resolved = path.resolve(target);
  for (const key of [...transcriptCache.keys()]) {
    if (key.startsWith(`${resolved}|`)) {
      transcriptCache.delete(key);
    }
  }
}

/** Test helper — number of warm transcript cache entries. */
export function transcriptCacheSize(): number {
  return transcriptCache.size;
}
