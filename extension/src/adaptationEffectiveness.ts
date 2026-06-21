import * as fs from "node:fs";
import { adaptationLogPath, ApiSnapshot } from "./adaptationLog";

const RESOLVE_AFTER_DAYS = 7;

export type AeiVerdict = "effective" | "mixed" | "neutral" | "harmful";

export interface AeiRecord {
  ts: string;
  type: string;
  description: string;
  adaptation_id?: string;
  pre_snapshot?: ApiSnapshot & { dailyCostUsd?: number; precision?: number };
  resolve_after_days?: number;
  resolved_at?: string;
  post_snapshot?: ApiSnapshot & { dailyCostUsd?: number; precision?: number };
  impact_delta?: { apiScore?: number; costReductionPct?: number };
  verdict?: AeiVerdict;
  [key: string]: unknown;
}

function classifyVerdict(delta: { apiScore?: number; costReductionPct?: number }): AeiVerdict {
  const score = delta.apiScore ?? 0;
  const costPct = delta.costReductionPct ?? 0;
  if (score >= 5 || costPct >= 10) return "effective";
  if (score >= 1 || (score >= -2 && costPct >= 0)) return "mixed";
  if (score >= -3) return "neutral";
  return "harmful";
}

/**
 * Called in the pipeline analyze phase. Finds unresolved adaptations ≥7 days old,
 * writes resolved post-snapshot and verdict in-place.
 */
export function resolveAdaptations(
  target: string,
  currentSnapshot: ApiSnapshot & { dailyCostUsd?: number; precision?: number }
): void {
  const file = adaptationLogPath(target);
  if (!fs.existsSync(file)) return;

  let raw: string;
  try { raw = fs.readFileSync(file, "utf-8"); } catch { return; }

  const lines = raw.split("\n");
  let changed = false;

  const updated = lines.map((line) => {
    if (!line.trim()) return line;
    try {
      const event = JSON.parse(line) as AeiRecord;
      if (event.resolved_at) return line;
      if (!event.pre_snapshot) return line;
      const age = Date.now() - new Date(event.ts).getTime();
      if (age < (event.resolve_after_days ?? RESOLVE_AFTER_DAYS) * 86_400_000) return line;

      const pre = event.pre_snapshot;
      const impact_delta: { apiScore?: number; costReductionPct?: number } = {
        apiScore: currentSnapshot.apiScore - pre.apiScore,
      };
      if (pre.dailyCostUsd && pre.dailyCostUsd > 0 && currentSnapshot.dailyCostUsd != null) {
        impact_delta.costReductionPct = Math.round(
          ((pre.dailyCostUsd - currentSnapshot.dailyCostUsd) / pre.dailyCostUsd) * 100
        );
      }

      changed = true;
      return JSON.stringify({
        ...event,
        resolved_at: new Date().toISOString(),
        post_snapshot: currentSnapshot,
        impact_delta,
        verdict: classifyVerdict(impact_delta),
      });
    } catch { return line; }
  });

  if (changed) {
    try { fs.writeFileSync(file, updated.join("\n"), "utf-8"); } catch { /* non-fatal */ }
  }
}
