import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SkillAttributionMap, costAttributionPath } from "./costAttribution";
import { readJsonFile, writeJsonAtomic } from "./fileWriteCoordination";
import { yieldToEventLoop } from "./eventLoop";
import { loadManifest, Manifest } from "./skillOps";
import { runsFilePath } from "./runsStore";
import { buildCostAttribution, resolveDisplayAttribution } from "./costAttribution";
import { buildTeamEconomicsSnapshot, TeamEconomicsSnapshot } from "./teamEconomics";
import { computeAuthorAttribution, SkillAuthorAttribution } from "./teamCostSharing";
import { readPipelineCycle } from "./pipelineCycle";
import { readWorkspaceSystemState } from "./workspaceSystemState";
import { CostPipelineResult } from "./costPipeline";
import { encodeWorkspacePath } from "./workspaceTranscripts";

// ── Team Economics Cache ──────────────────────────────────────────────────────

export const TEAM_ECONOMICS_CACHE_REL = path.join(".claude", "learning", "team-economics-cache.json");
export const TEAM_ECONOMICS_SLOT_ID = "team-economics-slot";

export interface TeamEconomicsCacheFingerprint {
  gitHead: string;
  skillsHash: string;
  attributionHash: string;
}

export interface TeamEconomicsCachePayload {
  skillAuthors: SkillAuthorAttribution[];
  teamEconomics: TeamEconomicsSnapshot;
}

interface TeamEconomicsCacheFile {
  version: 1;
  computedAt: string;
  fingerprint: TeamEconomicsCacheFingerprint;
  skillAuthors: SkillAuthorAttribution[];
  teamEconomics: TeamEconomicsSnapshot;
}

const gitHeadMem = new Map<string, { head: string; at: number }>();
const inflightPrecompute = new Map<string, Promise<void>>();

export function teamEconomicsCachePath(target: string): string {
  return path.join(target, TEAM_ECONOMICS_CACHE_REL);
}

function fileStatToken(filePath: string): string {
  try {
    const st = fs.statSync(filePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "missing";
  }
}

export function workspaceSkillsHash(target: string): string {
  const skillsDir = path.join(target, ".claude", "skills");
  if (!fs.existsSync(skillsDir)) return "none";
  const parts: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return "none";
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
    parts.push(`${entry.name}:${fileStatToken(skillMd)}`);
  }
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}

export function readGitHead(target: string): string {
  const key = path.normalize(target);
  const mem = gitHeadMem.get(key);
  if (mem && Date.now() - mem.at < 30_000) return mem.head;
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: target,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    gitHeadMem.set(key, { head, at: Date.now() });
    return head;
  } catch {
    gitHeadMem.set(key, { head: "", at: Date.now() });
    return "";
  }
}

export function buildTeamEconomicsCacheFingerprint(target: string): TeamEconomicsCacheFingerprint {
  return {
    gitHead: readGitHead(target),
    skillsHash: workspaceSkillsHash(target),
    attributionHash: `${fileStatToken(costAttributionPath(target))}|${fileStatToken(runsFilePath(target))}`,
  };
}

function teamFingerprintMatches(a: TeamEconomicsCacheFingerprint, b: TeamEconomicsCacheFingerprint): boolean {
  return a.gitHead === b.gitHead && a.skillsHash === b.skillsHash && a.attributionHash === b.attributionHash;
}

export function readTeamEconomicsCache(target: string): TeamEconomicsCacheFile | undefined {
  return readJsonFile<TeamEconomicsCacheFile>(teamEconomicsCachePath(target));
}

export function writeTeamEconomicsCache(
  target: string,
  fingerprint: TeamEconomicsCacheFingerprint,
  payload: TeamEconomicsCachePayload
): void {
  const file: TeamEconomicsCacheFile = {
    version: 1,
    computedAt: new Date().toISOString(),
    fingerprint,
    skillAuthors: payload.skillAuthors,
    teamEconomics: payload.teamEconomics,
  };
  writeJsonAtomic(teamEconomicsCachePath(target), file);
}

export function tryReadValidTeamEconomicsCache(target: string): TeamEconomicsCachePayload | undefined {
  const raw = readTeamEconomicsCache(target);
  if (!raw || raw.version !== 1 || !raw.fingerprint) return undefined;
  const current = buildTeamEconomicsCacheFingerprint(target);
  if (!teamFingerprintMatches(raw.fingerprint, current)) return undefined;
  return { skillAuthors: raw.skillAuthors, teamEconomics: raw.teamEconomics };
}

function computeTeamEconomicsBundle(
  target: string,
  libraryDir: string,
  manifest: Manifest,
  attribution: SkillAttributionMap
): TeamEconomicsCachePayload {
  const skillAuthors = computeAuthorAttribution(target, attribution);
  const teamEconomics = buildTeamEconomicsSnapshot(target, libraryDir, manifest, attribution, skillAuthors);
  return { skillAuthors, teamEconomics };
}

export function getOrComputeTeamEconomicsBundle(
  target: string,
  libraryDir: string,
  manifest: Manifest,
  attribution: SkillAttributionMap,
  opts?: { force?: boolean }
): TeamEconomicsCachePayload {
  if (!opts?.force) {
    const hit = tryReadValidTeamEconomicsCache(target);
    if (hit) return hit;
  }
  const payload = computeTeamEconomicsBundle(target, libraryDir, manifest, attribution);
  writeTeamEconomicsCache(target, buildTeamEconomicsCacheFingerprint(target), payload);
  return payload;
}

export function invalidateTeamEconomicsCache(target?: string): void {
  if (!target) {
    gitHeadMem.clear();
    return;
  }
  const key = path.normalize(target);
  gitHeadMem.delete(key);
  try {
    fs.unlinkSync(teamEconomicsCachePath(target));
  } catch {
    // missing cache is fine
  }
}

export function queueTeamEconomicsPrecompute(target: string, libraryDir: string): void {
  const key = path.normalize(target);
  if (inflightPrecompute.has(key)) return;
  if (tryReadValidTeamEconomicsCache(target)) return;
  const job = (async () => {
    await yieldToEventLoop();
    try {
      const manifest = loadManifest(libraryDir);
      const built = buildCostAttribution(target, libraryDir);
      const { attribution } = resolveDisplayAttribution(built, target);
      getOrComputeTeamEconomicsBundle(target, libraryDir, manifest, attribution);
    } finally {
      inflightPrecompute.delete(key);
    }
  })();
  inflightPrecompute.set(key, job);
}

// ── Dashboard Snapshot Cache ──────────────────────────────────────────────────

export const DASHBOARD_SNAPSHOT_REL = path.join(".claude", "learning", "dashboard-snapshot.json");
export const DASHBOARD_MAIN_SLOT_ID = "dashboard-main-slot";

export interface DashboardSnapshotFingerprint extends TeamEconomicsCacheFingerprint {
  pipelineIndexedAt: string;
  pipelineAnalyzedAt: string;
  systemStateAt: string;
  haceSessionsMtimeMs: string;
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

function latestHaceSessionMtimeMs(target: string): string {
  try {
    const encoded = encodeWorkspacePath(target).toLowerCase();
    const dir = path.join(os.homedir(), ".claude", "projects", encoded);
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"));
    const latest = files.reduce((max, f) => {
      try { return Math.max(max, fs.statSync(path.join(dir, f)).mtimeMs); } catch { return max; }
    }, 0);
    return String(latest);
  } catch {
    return "";
  }
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
    haceSessionsMtimeMs: latestHaceSessionMtimeMs(target),
  };
}

function dashboardFingerprintMatches(a: DashboardSnapshotFingerprint, b: DashboardSnapshotFingerprint): boolean {
  return (
    a.gitHead === b.gitHead &&
    a.skillsHash === b.skillsHash &&
    a.attributionHash === b.attributionHash &&
    a.pipelineIndexedAt === b.pipelineIndexedAt &&
    a.pipelineAnalyzedAt === b.pipelineAnalyzedAt &&
    a.systemStateAt === b.systemStateAt &&
    a.haceSessionsMtimeMs === b.haceSessionsMtimeMs
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

export function tryReadValidDashboardSnapshot(
  target: string,
  pipeline?: CostPipelineResult
): DashboardSnapshotPayload | undefined {
  const raw = readDashboardSnapshot(target);
  if (!raw || raw.version !== 1 || !raw.mainBodyHtml) return undefined;
  const current = buildDashboardSnapshotFingerprint(target, pipeline);
  if (!dashboardFingerprintMatches(raw.fingerprint, current)) return undefined;
  return { mainBodyHtml: raw.mainBodyHtml, canApplyOptimizations: raw.canApplyOptimizations };
}

export function invalidateDashboardSnapshot(target?: string): void {
  if (!target) return;
  try {
    fs.unlinkSync(dashboardSnapshotPath(target));
  } catch {
    // missing is fine
  }
}

export function fingerprintDigest(fp: DashboardSnapshotFingerprint): string {
  return crypto.createHash("sha256").update(JSON.stringify(fp)).digest("hex");
}
