import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { costAttributionPath, migrateLegacyCostAttribution } from "./costAttribution";

const COLLECTOR_STATE_PATH = path.join(os.homedir(), ".claude", "learning", "attribution-collector-state.json");
const RUNS_RELATIVE = path.join(".claude", "learning", "runs.jsonl");

export interface ResetResult {
  removedRuns: number;
  keptRuns: number;
  backupAttribution: string | null;
  backupRuns: string | null;
}

function isCollectorTranscriptRun(line: string): boolean {
  try {
    const row = JSON.parse(line) as {
      action?: string;
      metadata?: { source?: string };
    };
    return row.action === "transcript" && row.metadata?.source === "attribution-collector";
  } catch {
    return false;
  }
}

/** Remove mis-attributed collector rows and clear transcriptSkills for re-collection. */
export function resetMisattributedData(target: string): ResetResult {
  const result: ResetResult = {
    removedRuns: 0,
    keptRuns: 0,
    backupAttribution: null,
    backupRuns: null,
  };

  const runsFile = path.join(target, RUNS_RELATIVE);
  if (fs.existsSync(runsFile)) {
    const backup = `${runsFile}.pre-reset-${Date.now()}.bak`;
    fs.copyFileSync(runsFile, backup);
    result.backupRuns = backup;

    const kept: string[] = [];
    for (const line of fs.readFileSync(runsFile, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      if (isCollectorTranscriptRun(trimmed)) {
        result.removedRuns += 1;
      } else {
        kept.push(trimmed);
        result.keptRuns += 1;
      }
    }
    fs.writeFileSync(runsFile, kept.join("\n") + (kept.length ? "\n" : ""), "utf-8");
  }

  migrateLegacyCostAttribution(target);
  const attrPath = costAttributionPath(target);
  if (fs.existsSync(attrPath)) {
    const backup = `${attrPath}.pre-reset-${Date.now()}.bak`;
    fs.copyFileSync(attrPath, backup);
    result.backupAttribution = backup;

    try {
      const raw = JSON.parse(fs.readFileSync(attrPath, "utf-8")) as Record<string, unknown>;
      raw.transcriptSkills = {};
      raw.unattributed = {};
      raw.updatedAt = new Date().toISOString();
      delete raw.skills;
      fs.writeFileSync(attrPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
    } catch {
      fs.writeFileSync(
        attrPath,
        JSON.stringify({ transcriptSkills: {}, unattributed: {}, base_context: {} }, null, 2) + "\n",
        "utf-8"
      );
    }
  }

  if (fs.existsSync(COLLECTOR_STATE_PATH)) {
    const backup = `${COLLECTOR_STATE_PATH}.pre-reset-${Date.now()}.bak`;
    fs.copyFileSync(COLLECTOR_STATE_PATH, backup);
    fs.writeFileSync(
      COLLECTOR_STATE_PATH,
      JSON.stringify({ lastRun: 0, fileMtimes: {}, processedSessions: {} }, null, 2) + "\n",
      "utf-8"
    );
  }

  return result;
}
