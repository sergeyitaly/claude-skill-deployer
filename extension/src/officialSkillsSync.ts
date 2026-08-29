import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const OFFICIAL_SKILLS_REPO = "https://github.com/anthropics/skills.git";
export const OFFICIAL_SKILLS_API = "https://api.github.com/repos/anthropics/skills/contents/skills";

export interface OfficialSkillsState {
  repoSha?: string;
  skills?: Record<string, string>;
  /** ISO timestamp of the last time a real network check ran (success or failure) — gates
   *  how often checkOfficialSkillUpdates() actually calls out to GitHub. */
  lastCheckedAt?: string;
}

/** How often checkOfficialSkillUpdates() is allowed to actually hit the network. Confirmed
 *  live: nothing ever wrote this state file, so readOfficialSkillsState() always returned
 *  null, previousSha was always null, and every single SessionStart paid a real
 *  git-ls-remote round trip (avg ~880ms, up to a 15s timeout on a slow/unreachable network)
 *  despite the skill's own docs calling this "a cheap check." */
export const OFFICIAL_SKILLS_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

export interface OfficialSkillCandidate {
  name: string;
  kind: "new" | "updated" | "collision";
}

export interface OfficialSkillsCheckResult {
  libraryDir: string;
  remoteSha: string | null;
  previousSha: string | null;
  unchanged: boolean;
  candidates: OfficialSkillCandidate[];
  checkError?: string;
}

/** Workspace root skills_library/ (this repo and clones that ship the library). */
export function resolveSkillsLibraryDir(cwd: string): string | undefined {
  const libraryDir = path.join(cwd, "skills_library");
  if (fs.existsSync(path.join(libraryDir, "manifest.json"))) {
    return libraryDir;
  }
  return undefined;
}

export function officialSkillsStatePath(libraryDir: string): string {
  return path.join(libraryDir, ".official-skills-state.json");
}

export function writeOfficialSkillsState(libraryDir: string, state: OfficialSkillsState): void {
  try {
    fs.mkdirSync(libraryDir, { recursive: true });
    fs.writeFileSync(officialSkillsStatePath(libraryDir), JSON.stringify(state, null, 2) + "\n", "utf-8");
  } catch {
    /* non-fatal — worst case this SessionStart's check just isn't cached for next time */
  }
}

export function readOfficialSkillsState(libraryDir: string): OfficialSkillsState | null {
  const file = officialSkillsStatePath(libraryDir);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as OfficialSkillsState;
  } catch {
    return null;
  }
}

export function listLocalSkillNames(libraryDir: string): Set<string> {
  const names = new Set<string>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(libraryDir, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (fs.existsSync(path.join(libraryDir, entry.name, "SKILL.md"))) {
      names.add(entry.name);
    }
  }
  return names;
}

export function classifyOfficialSkillCandidates(
  libraryDir: string,
  upstreamNames: string[],
  state: OfficialSkillsState | null
): OfficialSkillCandidate[] {
  const local = listLocalSkillNames(libraryDir);
  const managed = state?.skills ?? {};
  const candidates: OfficialSkillCandidate[] = [];

  for (const name of upstreamNames) {
    if (!local.has(name)) {
      candidates.push({ name, kind: "new" });
      continue;
    }
    if (managed[name]) {
      candidates.push({ name, kind: "updated" });
      continue;
    }
    candidates.push({ name, kind: "collision" });
  }
  return candidates;
}

export function fetchRemoteHeadSha(): string | null {
  try {
    const out = execFileSync("git", ["ls-remote", OFFICIAL_SKILLS_REPO, "HEAD"], {
      encoding: "utf-8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = out.split("\n").find((l) => l.trim().length > 0);
    return line?.split(/\s+/)[0] ?? null;
  } catch {
    return null;
  }
}

export async function fetchUpstreamSkillNames(): Promise<string[]> {
  const res = await fetch(OFFICIAL_SKILLS_API, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "claude-skills-deployer" },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}`);
  }
  const body = (await res.json()) as { name?: string; type?: string }[];
  return body.filter((e) => e.type === "dir" && e.name).map((e) => e.name as string).sort();
}

export async function checkOfficialSkillUpdates(libraryDir: string): Promise<OfficialSkillsCheckResult> {
  const state = readOfficialSkillsState(libraryDir);
  const previousSha = state?.repoSha ?? null;

  // Skip the network entirely inside the TTL window — previousSha alone can never gate
  // this (see OFFICIAL_SKILLS_CHECK_TTL_MS), since a real check is exactly what's needed to
  // learn whether the remote actually moved.
  const lastCheckedMs = state?.lastCheckedAt ? Date.parse(state.lastCheckedAt) : Number.NaN;
  if (!Number.isNaN(lastCheckedMs) && Date.now() - lastCheckedMs < OFFICIAL_SKILLS_CHECK_TTL_MS) {
    return { libraryDir, remoteSha: previousSha, previousSha, unchanged: true, candidates: [] };
  }

  const remoteSha = fetchRemoteHeadSha();

  if (!remoteSha) {
    // Don't cache a failed attempt as "checked" for the full TTL — a transient network
    // blip shouldn't silently suppress every check for the next 24h — but do record the
    // attempt time so a persistently unreachable network doesn't retry every session.
    writeOfficialSkillsState(libraryDir, { ...state, lastCheckedAt: new Date().toISOString() });
    return {
      libraryDir,
      remoteSha: null,
      previousSha,
      unchanged: true,
      candidates: [],
      checkError: "Could not reach github.com/anthropics/skills (git ls-remote failed).",
    };
  }

  if (previousSha && previousSha === remoteSha) {
    writeOfficialSkillsState(libraryDir, { ...state, repoSha: remoteSha, lastCheckedAt: new Date().toISOString() });
    return { libraryDir, remoteSha, previousSha, unchanged: true, candidates: [] };
  }

  try {
    const upstreamNames = await fetchUpstreamSkillNames();
    const candidates = classifyOfficialSkillCandidates(libraryDir, upstreamNames, state);
    const actionable = candidates.filter((c) => c.kind === "new" || c.kind === "updated");
    writeOfficialSkillsState(libraryDir, { ...state, repoSha: remoteSha, lastCheckedAt: new Date().toISOString() });
    return {
      libraryDir,
      remoteSha,
      previousSha,
      unchanged: actionable.length === 0 && previousSha !== null,
      candidates,
    };
  } catch (err) {
    // The GitHub API call failed, but git ls-remote (above) genuinely succeeded — still
    // worth caching that SHA so the next check's string comparison has something real to
    // compare against, even though this run couldn't enumerate candidates.
    writeOfficialSkillsState(libraryDir, { ...state, repoSha: remoteSha, lastCheckedAt: new Date().toISOString() });
    return {
      libraryDir,
      remoteSha,
      previousSha,
      unchanged: true,
      candidates: [],
      checkError: (err as Error).message,
    };
  }
}

export function formatOfficialSkillsSessionContext(result: OfficialSkillsCheckResult): string {
  if (result.checkError) {
    return `[Claude Skills] Official skill update check failed: ${result.checkError}`;
  }
  if (result.unchanged) {
    return "";
  }

  const newSkills = result.candidates.filter((c) => c.kind === "new").map((c) => c.name);
  const updated = result.candidates.filter((c) => c.kind === "updated").map((c) => c.name);
  const collisions = result.candidates.filter((c) => c.kind === "collision").map((c) => c.name);
  const parts: string[] = [
    "[Claude Skills] anthropics/skills has updates.",
    `Remote HEAD: ${result.remoteSha?.slice(0, 12) ?? "unknown"}`,
  ];
  if (result.previousSha) {
    parts.push(`Last synced: ${result.previousSha.slice(0, 12)}`);
  } else {
    parts.push("No local sync state yet (.official-skills-state.json missing or empty).");
  }
  if (newSkills.length) {
    parts.push(`New upstream skills (${newSkills.length}): ${newSkills.join(", ")}.`);
  }
  if (updated.length) {
    parts.push(`Managed skills with upstream changes (${updated.length}): ${updated.join(", ")}.`);
  }
  if (collisions.length) {
    parts.push(`Name collisions (local custom, not auto-touched): ${collisions.join(", ")}.`);
  }
  parts.push(
    "Read and follow the skill-official-updater skill now: automatically pull every new and managed-updated skill (no user prompt). Skip name-collision skills only."
  );
  return parts.join(" ");
}

export function workspaceUsesOfficialSkillUpdater(target: string): boolean {
  if (resolveSkillsLibraryDir(target)) {
    return true;
  }
  return fs.existsSync(path.join(target, ".claude", "skills", "skill-official-updater", "SKILL.md"));
}
