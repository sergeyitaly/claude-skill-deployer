import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { ensureLearningDir } from "./usageStats";
import { readJsonFile, writeJsonAtomic } from "./fileWriteCoordination";

const REMOTE_PROBE_CACHE_MS = 60 * 60 * 1000;

export interface RemoteRepoProbe {
  originUrl: string;
  reachable: boolean;
  remoteBranchCount: number;
  remoteAuthors30d: number;
  upstreamAhead: number;
  upstreamBehind: number;
  source: "ls-remote" | "remote-tracking" | "cache" | "none";
  probedAt: string;
  error?: string;
}

export interface RemoteGitSignals {
  remoteReachable: boolean;
  remoteOriginUrl: string;
  remoteBranchCount: number;
  remoteAuthors30d: number;
  upstreamAhead: number;
  upstreamBehind: number;
  remoteProbeSource: RemoteRepoProbe["source"];
}

const EMPTY_REMOTE: RemoteGitSignals = {
  remoteReachable: false,
  remoteOriginUrl: "",
  remoteBranchCount: 0,
  remoteAuthors30d: 0,
  upstreamAhead: 0,
  upstreamBehind: 0,
  remoteProbeSource: "none",
};

export function projectProfileProbeRemoteGitEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("claudeSkills.projectProfile")
    .get<boolean>("probeRemoteGit", true);
}

export function remoteProbeTimeoutMs(): number {
  const ms = vscode.workspace
    .getConfiguration("claudeSkills.projectProfile")
    .get<number>("remoteProbeTimeoutMs", 8000);
  return Number.isFinite(ms) && ms > 0 ? ms : 8000;
}

function remoteProbeCachePath(target: string): string {
  return path.join(target, ".claude", "learning", "remote-repo-probe.json");
}

function gitCommand(root: string, args: string[], timeoutMs = 5000): string | undefined {
  try {
    const out = execFileSync("git", ["-C", root, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function gitRoot(target: string): string | undefined {
  return gitCommand(target, ["rev-parse", "--show-toplevel"]);
}

function resolveOriginUrl(root: string): string {
  return gitCommand(root, ["remote", "get-url", "origin"]) ?? "";
}

function countRemoteTrackingBranches(root: string): number {
  const out = gitCommand(root, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]);
  if (!out) {
    return 0;
  }
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line !== "origin" && line !== "origin/HEAD")
    .length;
}

function countLsRemoteHeads(root: string, originUrl: string, timeoutMs: number): number | undefined {
  const out = gitCommand(root, ["ls-remote", "--heads", originUrl], timeoutMs);
  if (out === undefined) {
    return undefined;
  }
  if (!out) {
    return 0;
  }
  return out.split(/\r?\n/).filter(Boolean).length;
}

function detectUpstreamDivergence(root: string): { ahead: number; behind: number } {
  const out = gitCommand(root, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
  if (!out) {
    return { ahead: 0, behind: 0 };
  }
  const parts = out.split(/\s+/).map((n) => parseInt(n, 10));
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
    return { ahead: 0, behind: 0 };
  }
  return { behind: parts[0], ahead: parts[1] };
}

function detectRemoteAuthors30d(root: string): number {
  const refs = [
    "@{upstream}",
    "origin/HEAD",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
    "refs/remotes/origin/master",
  ];
  for (const ref of refs) {
    const out = gitCommand(root, ["log", ref, "--since=30 days ago", "--format=%ae"]);
    if (!out) {
      continue;
    }
    const count = new Set(out.split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter(Boolean)).size;
    if (count > 0) {
      return count;
    }
  }
  const remoteOut = gitCommand(root, ["log", "--since=30 days ago", "--format=%ae", "refs/remotes/origin"]);
  if (!remoteOut) {
    return 0;
  }
  return new Set(remoteOut.split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter(Boolean)).size;
}

function readCachedProbe(target: string, originUrl: string): RemoteRepoProbe | undefined {
  const cached = readJsonFile<RemoteRepoProbe>(remoteProbeCachePath(target));
  if (!cached) {
    return undefined;
  }
  if (cached.originUrl !== originUrl) {
    return undefined;
  }
  const age = Date.now() - new Date(cached.probedAt).getTime();
  if (age > REMOTE_PROBE_CACHE_MS) {
    return undefined;
  }
  return { ...cached, source: "cache" };
}

function writeCachedProbe(target: string, probe: RemoteRepoProbe): void {
  ensureLearningDir(target);
  writeJsonAtomic(remoteProbeCachePath(target), probe);
}

export function probeRemoteGitRepo(
  target: string,
  opts: { network?: boolean; useCache?: boolean } = {}
): RemoteRepoProbe {
  const network = opts.network ?? true;
  const useCache = opts.useCache ?? true;
  const root = gitRoot(target);
  if (!root) {
    return {
      originUrl: "",
      reachable: false,
      remoteBranchCount: 0,
      remoteAuthors30d: 0,
      upstreamAhead: 0,
      upstreamBehind: 0,
      source: "none",
      probedAt: new Date().toISOString(),
      error: "not a git repository",
    };
  }

  const originUrl = resolveOriginUrl(root);
  if (!originUrl) {
    return {
      originUrl: "",
      reachable: false,
      remoteBranchCount: 0,
      remoteAuthors30d: 0,
      upstreamAhead: 0,
      upstreamBehind: 0,
      source: "none",
      probedAt: new Date().toISOString(),
      error: "no origin remote",
    };
  }

  if (useCache) {
    const cached = readCachedProbe(target, originUrl);
    if (cached) {
      return cached;
    }
  }

  const trackingCount = countRemoteTrackingBranches(root);
  const divergence = detectUpstreamDivergence(root);
  const remoteAuthors30d = detectRemoteAuthors30d(root);

  let remoteBranchCount = trackingCount;
  let source: RemoteRepoProbe["source"] = trackingCount > 0 ? "remote-tracking" : "none";
  let reachable = trackingCount > 0;
  let error: string | undefined;

  if (network && projectProfileProbeRemoteGitEnabled()) {
    const lsCount = countLsRemoteHeads(root, originUrl, remoteProbeTimeoutMs());
    if (lsCount !== undefined) {
      reachable = true;
      remoteBranchCount = Math.max(remoteBranchCount, lsCount);
      source = "ls-remote";
    } else if (!reachable) {
      error = "origin unreachable (ls-remote failed)";
    }
  }

  const probe: RemoteRepoProbe = {
    originUrl,
    reachable,
    remoteBranchCount,
    remoteAuthors30d,
    upstreamAhead: divergence.ahead,
    upstreamBehind: divergence.behind,
    source,
    probedAt: new Date().toISOString(),
    error,
  };
  writeCachedProbe(target, probe);
  return probe;
}

export function remoteGitSignalsFromProbe(probe: RemoteRepoProbe): RemoteGitSignals {
  return {
    remoteReachable: probe.reachable,
    remoteOriginUrl: probe.originUrl,
    remoteBranchCount: probe.remoteBranchCount,
    remoteAuthors30d: probe.remoteAuthors30d,
    upstreamAhead: probe.upstreamAhead,
    upstreamBehind: probe.upstreamBehind,
    remoteProbeSource: probe.source,
  };
}

export function probeRemoteGitSignals(
  target: string,
  opts: { network?: boolean; useCache?: boolean } = {}
): RemoteGitSignals {
  if (!projectProfileProbeRemoteGitEnabled()) {
    return { ...EMPTY_REMOTE };
  }
  return remoteGitSignalsFromProbe(probeRemoteGitRepo(target, opts));
}

export function formatRemoteGitEvidence(remote: RemoteGitSignals): string | undefined {
  if (!remote.remoteOriginUrl) {
    return undefined;
  }
  if (!remote.remoteReachable && remote.remoteBranchCount === 0) {
    return "Remote origin not probed (offline or no fetch yet).";
  }
  const parts = [
    `${remote.remoteBranchCount} remote branch${remote.remoteBranchCount === 1 ? "" : "es"}`,
    `${remote.remoteAuthors30d} remote author${remote.remoteAuthors30d === 1 ? "" : "s"} (30d)`,
    `via ${remote.remoteProbeSource}`,
  ];
  if (remote.upstreamAhead > 0 || remote.upstreamBehind > 0) {
    parts.push(`ahead ${remote.upstreamAhead} / behind ${remote.upstreamBehind} vs upstream`);
  }
  return `Remote git (${remote.remoteOriginUrl}): ${parts.join(", ")}.`;
}
