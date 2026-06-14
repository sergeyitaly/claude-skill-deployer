import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { readJsonFile, writeJsonAtomic } from "./fileWriteCoordination";
import { readPipelineCycle } from "./pipelineCycle";
import { readWorkspaceSystemState } from "./workspaceSystemState";
import { CostPipelineResult } from "./costPipeline";
import {
  buildTeamEconomicsCacheFingerprint,
  TeamEconomicsCacheFingerprint,
} from "./teamEconomicsCache";

export const DASHBOARD_SNAPSHOT_REL = path.join(".claude", "learning", "dashboard-snapshot.json");
export const DASHBOARD_MAIN_SLOT_ID = "dashboard-main-slot";

export interface DashboardSnapshotFingerprint extends TeamEconomicsCacheFingerprint {
  pipelineIndexedAt: string;
  pipelineAnalyzedAt: string;
  systemStateAt: string;
}

export interface DashboardSnapshotPayload {
  mainBodyHtml: string;
  canApplyOptimizations: boolean;
}

interface DashboardSnapshotFile {
  version: 1;
  computedAt: string;
  fingerprint: DashboardSnapshotFingerprint;
  mainBodyHtml: string;
  canApplyOptimizations: boolean;
}

export function dashboardSnapshotPath(target: string): string {
  return path.join(target, DASHBOARD_SNAPSHOT_REL);
}

export function buildDashboardSnapshotFingerprint(
  target: string,
  pipeline?: CostPipelineResult
): DashboardSnapshotFingerprint {
  const base = buildTeamEconomicsCacheFingerprint(target);
  const cycle = pipeline?.cycle ?? readPipelineCycle(target);
  const state = readWorkspaceSystemState(target);
  return {
    ...base,
    pipelineIndexedAt: cycle.indexedAt ?? "",
    pipelineAnalyzedAt: cycle.analyzedAt ?? "",
    systemStateAt: state?.updatedAt ?? "",
  };
}

function fingerprintMatches(a: DashboardSnapshotFingerprint, b: DashboardSnapshotFingerprint): boolean {
  return (
    a.gitHead === b.gitHead &&
    a.skillsHash === b.skillsHash &&
    a.attributionHash === b.attributionHash &&
    a.pipelineIndexedAt === b.pipelineIndexedAt &&
    a.pipelineAnalyzedAt === b.pipelineAnalyzedAt &&
    a.systemStateAt === b.systemStateAt
  );
}

export function readDashboardSnapshot(target: string): DashboardSnapshotFile | undefined {
  return readJsonFile<DashboardSnapshotFile>(dashboardSnapshotPath(target));
}

export function writeDashboardSnapshot(
  target: string,
  fingerprint: DashboardSnapshotFingerprint,
  payload: DashboardSnapshotPayload
): void {
  const file: DashboardSnapshotFile = {
    version: 1,
    computedAt: new Date().toISOString(),
    fingerprint,
    mainBodyHtml: payload.mainBodyHtml,
    canApplyOptimizations: payload.canApplyOptimizations,
  };
  writeJsonAtomic(dashboardSnapshotPath(target), file);
}

/** Disk hit for dashboard fast-phase — no attribution/transcript work. */
export function tryReadValidDashboardSnapshot(
  target: string,
  pipeline?: CostPipelineResult
): DashboardSnapshotPayload | undefined {
  const raw = readDashboardSnapshot(target);
  if (!raw || raw.version !== 1 || !raw.mainBodyHtml) {
    return undefined;
  }
  const current = buildDashboardSnapshotFingerprint(target, pipeline);
  if (!fingerprintMatches(raw.fingerprint, current)) {
    return undefined;
  }
  return {
    mainBodyHtml: raw.mainBodyHtml,
    canApplyOptimizations: raw.canApplyOptimizations,
  };
}

export function invalidateDashboardSnapshot(target?: string): void {
  if (!target) {
    return;
  }
  try {
    fs.unlinkSync(dashboardSnapshotPath(target));
  } catch {
    // missing is fine
  }
}

/** Test helper — stable hash of fingerprint parts. */
export function fingerprintDigest(fp: DashboardSnapshotFingerprint): string {
  return crypto.createHash("sha256").update(JSON.stringify(fp)).digest("hex");
}
