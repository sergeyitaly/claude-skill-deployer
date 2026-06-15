import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import { CostEstimateTier } from "./skillCost";
import { parseSkillFrontmatter } from "./skillLint";
import { copyFileWithRetry } from "./fileWriteCoordination";
import { shouldCopyPath } from "./fileHash";

export interface SkillRule {
  description: string;
  detect_globs: string[];
  /** Typical session token load when this skill is active (install preview). */
  cost_estimate?: CostEstimateTier;
  /** Semver in manifest — compared to installed copy for upgrade alerts. */
  version?: string;
  /** Short note shown in upgrade suggestions. */
  changelog?: string;
  /** When true, skill is flagged for replacement in lifecycle reports. */
  deprecation?: boolean;
}

export function skillCatalogVersion(rule: SkillRule | undefined): string {
  return rule?.version?.trim() || "1.0.0";
}

export interface Manifest {
  skills: Record<string, SkillRule>;
}

export type CopyStatus =
  | "missing-source"
  | "skipped-exists"
  | "would-install"
  | "installed";

const EXCLUDE_DIRS = new Set([
  ".git",
  "node_modules",
  ".terraform",
  "__pycache__",
  ".venv",
  ".vscode-test",
  "dist",
  "out",
  "build",
  "coverage",
  ".turbo",
  ".next",
  "target",
  "vendor",
  ".cursor",
]);

/** Global skills directory: ~/.claude/skills */
export function globalSkillsDir(): string {
  return path.join(os.homedir(), ".claude", "skills");
}

/** Per-skill override values supported by Claude Code's `skillOverrides`
 * settings key (settings.local.json). */
export type SkillOverrideValue = "on" | "off" | "name-only" | "user-invocable-only";

export function settingsLocalPath(target: string): string {
  return path.join(target, ".claude", "settings.local.json");
}

interface LocalSettings {
  skillOverrides?: Record<string, SkillOverrideValue>;
  [key: string]: unknown;
}

function readLocalSettings(target: string): LocalSettings {
  const file = settingsLocalPath(target);
  if (!fs.existsSync(file)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as LocalSettings;
  } catch {
    return {};
  }
}

/** Reads `skillOverrides` from <target>/.claude/settings.local.json (a
 * personal, gitignored-by-default file) - {} if none are set. */
export function readSkillOverrides(target: string): Record<string, SkillOverrideValue> {
  return readLocalSettings(target).skillOverrides ?? {};
}

/** Appends a path to `.git/info/exclude` (personal, never committed). */
export function ensureGitExcludeEntry(target: string, entry: string): void {
  const gitDir = path.join(target, ".git");
  if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) {
    return;
  }
  const normalized = entry.replace(/\\/g, "/");
  const excludePath = path.join(gitDir, "info", "exclude");
  let existing = "";
  try {
    existing = fs.readFileSync(excludePath, "utf-8");
  } catch {
    existing = "";
  }
  if (existing.split(/\r?\n/).some((line) => line.trim() === normalized)) {
    return;
  }
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(excludePath, `${prefix}${normalized}\n`, "utf-8");
}

/** Ensures `<target>/.claude/settings.local.json` won't be picked up by `git
 * add`/`git status`, without editing the shared (and possibly git-tracked)
 * `.gitignore`. If the project's own ignore rules don't already cover it,
 * appends an entry to the local-only `.git/info/exclude`. No-op if `target`
 * isn't a git repo (no `.git` directory) or the entry is already present. */
function ensureSettingsLocalIgnored(target: string): void {
  ensureGitExcludeEntry(target, ".claude/settings.local.json");
}

/** True when skill files are committed on the current branch HEAD. */
export function isSkillCommittedOnBranch(target: string, skillName: string): boolean {
  try {
    const rel = `.claude/skills/${skillName}`;
    const out = execFileSync("git", ["ls-tree", "-r", "HEAD", "--name-only", "--", rel], {
      cwd: target,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

/** Mark a workspace skill directory as personal-only (not for git commit). */
export function markSkillAsPersonalLocal(target: string, skillName: string): void {
  ensureGitExcludeEntry(target, `.claude/skills/${skillName}/`);
}

export function preferLocalSkillOverrides(): boolean {
  return vscode.workspace
    .getConfiguration("claudeSkills")
    .get<boolean>("preferLocalSkillOverrides", true);
}

/** Installed in workspace and not personally disabled via skillOverrides. */
export function isSkillEffectivelyEnabled(
  installedInWorkspace: boolean,
  localOverride?: SkillOverrideValue
): boolean {
  return installedInWorkspace && localOverride !== "off";
}

/** Names of skills enabled for this user (present and not overridden off). */
export function listEffectiveEnabledSkills(target: string): string[] {
  const skillsDir = path.join(target, ".claude", "skills");
  if (!fs.existsSync(skillsDir)) {
    return [];
  }
  const overrides = readSkillOverrides(target);
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(skillsDir, e.name, "SKILL.md")))
    .map((e) => e.name)
    .filter((name) => overrides[name] !== "off")
    .sort();
}

/** Sets or clears a personal per-skill override in
 * <target>/.claude/settings.local.json without touching the shared
 * <target>/.claude/skills/<name>/ directory - lets a teammate turn a skill
 * off for themselves without that removal being visible to (or merged into)
 * the rest of the team. Pass `undefined` to remove the override (revert to
 * the project default, "on"). */
export function setSkillOverride(target: string, skillName: string, value: SkillOverrideValue | undefined): void {
  const file = settingsLocalPath(target);
  const settings = readLocalSettings(target);
  const overrides: Record<string, SkillOverrideValue> = { ...settings.skillOverrides };
  if (value === undefined) {
    delete overrides[skillName];
  } else {
    overrides[skillName] = value;
  }
  if (Object.keys(overrides).length > 0) {
    settings.skillOverrides = overrides;
  } else {
    delete settings.skillOverrides;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  ensureSettingsLocalIgnored(target);
}

export type WorkspaceSkillToggleAction = "installed" | "local-on" | "local-off" | "removed" | "noop";

/** Enable a skill for this user: install if needed, clear local off override, git-exclude personal adds. */
export function enableWorkspaceSkill(
  target: string,
  skillName: string,
  sourceRoot: string,
  libraryDir?: string
): WorkspaceSkillToggleAction {
  const destRoot = path.join(target, ".claude", "skills");
  const committedBefore = isSkillCommittedOnBranch(target, skillName);
  const status = copySkill(skillName, sourceRoot, destRoot, false, false, libraryDir ? { libraryDir } : undefined);
  setSkillOverride(target, skillName, undefined);
  if (!committedBefore && !isSkillCommittedOnBranch(target, skillName)) {
    markSkillAsPersonalLocal(target, skillName);
  }
  if (status === "installed" || status === "would-install") {
    return "installed";
  }
  return "local-on";
}

/** Disable for this user: local override when skill is on the branch; remove personal-only installs. */
export function disableWorkspaceSkill(target: string, skillName: string): WorkspaceSkillToggleAction {
  const destRoot = path.join(target, ".claude", "skills");
  const skillMd = path.join(destRoot, skillName, "SKILL.md");
  if (!fs.existsSync(skillMd)) {
    return "noop";
  }
  if (preferLocalSkillOverrides() && isSkillCommittedOnBranch(target, skillName)) {
    setSkillOverride(target, skillName, "off");
    return "local-off";
  }
  const removed = removeSkill(destRoot, skillName);
  setSkillOverride(target, skillName, undefined);
  return removed ? "removed" : "noop";
}

export function loadManifest(libraryDir: string): Manifest {
  const file = path.join(libraryDir, "manifest.json");
  if (!fs.existsSync(file)) {
    throw new Error(`Skill manifest not found: ${file}`);
  }
  try {
    const mtimeMs = fs.statSync(file).mtimeMs;
    if (manifestCache && manifestCache.file === file && manifestCache.mtimeMs === mtimeMs) {
      return manifestCache.data;
    }
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as Manifest;
    if (!parsed.skills || typeof parsed.skills !== "object") {
      throw new Error("manifest.json missing skills map");
    }
    manifestCache = { file, mtimeMs, data: parsed };
    return parsed;
  } catch (err) {
    throw new Error(`Could not parse ${file}: ${(err as Error).message}`);
  }
}

export function invalidateManifestCache(): void {
  manifestCache = undefined;
}

let manifestCache: { file: string; mtimeMs: number; data: Manifest } | undefined;

export function discoverBundledSkills(libraryDir: string): string[] {
  if (!fs.existsSync(libraryDir)) {
    return [];
  }
  return fs
    .readdirSync(libraryDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => fs.existsSync(path.join(libraryDir, name, "SKILL.md")))
    .sort();
}

const DETECTION_CACHE_TTL_MS = 60_000;
const SKILL_STATUS_CACHE_TTL_MS = 20_000;

interface DetectionCacheEntry {
  paths: string[];
  detected: Record<string, string[]>;
  at: number;
}

interface SkillStatusCacheEntry {
  key: string;
  statuses: SkillStatus[];
  at: number;
}

const detectionCache = new Map<string, DetectionCacheEntry>();
const skillStatusCache = new Map<string, SkillStatusCacheEntry>();

function skillInstallKey(target: string | undefined, libraryDir: string): string {
  const workspaceDir = target ? path.join(target, ".claude", "skills") : "";
  const globalDir = globalSkillsDir();
  let workspaceMtime = 0;
  let globalMtime = 0;
  let manifestMtime = 0;
  let settingsMtime = 0;
  try {
    if (workspaceDir && fs.existsSync(workspaceDir)) {
      workspaceMtime = fs.statSync(workspaceDir).mtimeMs;
    }
    if (fs.existsSync(globalDir)) {
      globalMtime = fs.statSync(globalDir).mtimeMs;
    }
    const manifestFile = path.join(libraryDir, "manifest.json");
    if (fs.existsSync(manifestFile)) {
      manifestMtime = fs.statSync(manifestFile).mtimeMs;
    }
    if (target) {
      const settingsFile = settingsLocalPath(target);
      if (fs.existsSync(settingsFile)) {
        settingsMtime = fs.statSync(settingsFile).mtimeMs;
      }
    }
  } catch {
    // best-effort fingerprint
  }
  return `${path.normalize(target ?? "")}|${workspaceMtime}|${globalMtime}|${manifestMtime}|${settingsMtime}`;
}

function listSkillNameSet(skillsRoot: string): Set<string> {
  if (!fs.existsSync(skillsRoot)) {
    return new Set();
  }
  try {
    return new Set(
      fs
        .readdirSync(skillsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() && fs.existsSync(path.join(skillsRoot, e.name, "SKILL.md")))
        .map((e) => e.name)
    );
  } catch {
    return new Set();
  }
}

export function invalidateDetectionCache(target?: string): void {
  if (target) {
    const key = path.normalize(target);
    detectionCache.delete(key);
    skillStatusCache.delete(key);
    return;
  }
  detectionCache.clear();
  skillStatusCache.clear();
}

/** One-pass walk of `target`, returning POSIX-style relative file paths,
 * skipping common noise directories. Mirrors generate_skills.py's
 * _collect_relative_paths. */
export function collectRelativePaths(target: string): string[] {
  const results: string[] = [];

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) {
          continue;
        }
        walk(path.join(dir, entry.name));
      } else {
        const rel = path.relative(target, path.join(dir, entry.name));
        results.push(rel.split(path.sep).join("/"));
      }
    }
  }

  walk(target);
  return results;
}

/** Translate a Python fnmatch-style pattern (`*`, `?`, literal chars) into a
 * RegExp, matching fnmatch.translate semantics for the subset of syntax used
 * by skills_library/manifest.json (no `[...]` character classes needed). */
function fnmatchToRegExp(pattern: string): RegExp {
  let regex = "";
  for (const ch of pattern) {
    if (ch === "*") {
      regex += ".*";
    } else if (ch === "?") {
      regex += ".";
    } else if (".+^$()[]{}|\\".includes(ch)) {
      regex += "\\" + ch;
    } else {
      regex += ch;
    }
  }
  return new RegExp("^" + regex + "$");
}

/** Mirrors generate_skills.py's _pattern_matches_any: also tries the pattern
 * with a leading "**\/" stripped, so "**\/*.tf" also matches a top-level
 * "main.tf". */
/** Literal extension suffix from globs (e.g. .tf) — narrows candidate paths before regex. */
function globLiteralExtension(pattern: string): string | null {
  const match = pattern.match(/\.([a-zA-Z0-9_-]+)$/);
  return match ? `.${match[1]}` : null;
}

export function patternMatchesAny(pattern: string, paths: string[]): boolean {
  const candidates = [pattern];
  if (pattern.startsWith("**/")) {
    candidates.push(pattern.slice(3));
  }
  const regexes = candidates.map(fnmatchToRegExp);
  const ext = globLiteralExtension(pattern);
  const scoped = ext ? paths.filter((p) => path.posix.extname(p) === ext) : paths;
  return scoped.some((p) => regexes.some((r) => r.test(p)));
}

/** Returns { skillName: matchedGlobs[] } for skills with >=1 match. */
export function detectRelevantSkills(
  target: string,
  manifest: Manifest
): Record<string, string[]> {
  const key = path.normalize(target);
  const now = Date.now();
  const cached = detectionCache.get(key);
  if (cached && now - cached.at < DETECTION_CACHE_TTL_MS) {
    return cached.detected;
  }

  const paths = collectRelativePaths(target);
  const results: Record<string, string[]> = {};
  for (const [skillName, rule] of Object.entries(manifest.skills)) {
    const matched = rule.detect_globs.filter((g) => patternMatchesAny(g, paths));
    if (matched.length > 0) {
      results[skillName] = matched;
    }
  }
  detectionCache.set(key, { paths, detected: results, at: now });
  return results;
}

function copyRecursive(src: string, dest: string) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    copyFileWithRetry(src, dest);
  }
}

export function copySkill(
  skillName: string,
  sourceRoot: string,
  destRoot: string,
  force: boolean,
  dryRun: boolean,
  opts?: { libraryDir?: string }
): CopyStatus {
  const src = path.join(sourceRoot, skillName);
  const dst = path.join(destRoot, skillName);
  if (!fs.existsSync(path.join(src, "SKILL.md"))) {
    return "missing-source";
  }
  if (fs.existsSync(dst) && !force) {
    if (!shouldCopyPath(src, dst)) {
      return "skipped-exists";
    }
  }
  if (dryRun) {
    return "would-install";
  }
  copyRecursive(src, dst);
  if (opts?.libraryDir) {
    const manifest = loadManifest(opts.libraryDir);
    const rule = manifest.skills[skillName];
    writeSkillVersionSidecar(dst, skillCatalogVersion(rule), rule?.changelog);
  }
  return "installed";
}

export interface SkillVersionSidecar {
  version: string;
  changelog?: string;
  installedAt: string;
}

const SKILL_VERSION_FILE = ".skill-version.json";

/** Persist manifest version beside an installed skill copy. */
export function writeSkillVersionSidecar(skillDir: string, version: string, changelog?: string): void {
  const payload: SkillVersionSidecar = {
    version,
    changelog: changelog?.trim() || undefined,
    installedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(skillDir, SKILL_VERSION_FILE), JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

export function readSkillVersionSidecar(skillDir: string): SkillVersionSidecar | null {
  const file = path.join(skillDir, SKILL_VERSION_FILE);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as SkillVersionSidecar;
  } catch {
    return null;
  }
}

/** Remove `<destRoot>/<skillName>` if present. Returns false if it didn't exist. */
export function removeSkill(destRoot: string, skillName: string): boolean {
  const dir = path.join(destRoot, skillName);
  if (!fs.existsSync(dir)) {
    return false;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

export interface InstallResult {
  skill: string;
  status: CopyStatus | "source-missing";
  reason?: string;
}

/** Copy every bundled library skill into ~/.claude/skills. */
export function installLibraryToGlobal(
  libraryDir: string,
  force: boolean,
  dryRun: boolean
): InstallResult[] {
  const skills = discoverBundledSkills(libraryDir);
  const dest = globalSkillsDir();
  return skills.map((skill) => ({
    skill,
    status: copySkill(skill, libraryDir, dest, force, dryRun),
  }));
}

export interface GenerateOptions {
  all: boolean;
  force: boolean;
  dryRun: boolean;
}

/** Detect relevant skills for `target` and copy them from ~/.claude/skills
 * into <target>/.claude/skills. */
export function generateForWorkspace(
  libraryDir: string,
  target: string,
  opts: GenerateOptions
): InstallResult[] {
  const manifest = loadManifest(libraryDir);
  const detected = opts.all
    ? Object.fromEntries(Object.keys(manifest.skills).map((name) => [name, ["--all"]]))
    : detectRelevantSkills(target, manifest);

  const globalDir = globalSkillsDir();
  const destRoot = path.join(target, ".claude", "skills");
  const results: InstallResult[] = [];

  for (const [skillName, matched] of Object.entries(detected)) {
    if (!fs.existsSync(path.join(globalDir, skillName, "SKILL.md"))) {
      results.push({
        skill: skillName,
        status: "source-missing",
        reason: matched.join(", "),
      });
      continue;
    }
    const status = copySkill(skillName, globalDir, destRoot, opts.force, opts.dryRun);
    results.push({ skill: skillName, status, reason: matched.join(", ") });
  }
  return results;
}

/** Copy an explicit skill list from global/library into the workspace (bootstrap path). */
export function installSkillsToWorkspace(
  libraryDir: string,
  target: string,
  skillNames: string[],
  opts: { force?: boolean; dryRun?: boolean }
): InstallResult[] {
  const globalDir = globalSkillsDir();
  const destRoot = path.join(target, ".claude", "skills");
  const results: InstallResult[] = [];
  const unique = [...new Set(skillNames.filter(Boolean))];

  for (const skillName of unique) {
    const sourceRoot = fs.existsSync(path.join(globalDir, skillName, "SKILL.md"))
      ? globalDir
      : fs.existsSync(path.join(libraryDir, skillName, "SKILL.md"))
        ? libraryDir
        : undefined;
    if (!sourceRoot) {
      results.push({ skill: skillName, status: "source-missing" });
      continue;
    }
    const status = copySkill(skillName, sourceRoot, destRoot, opts.force ?? false, opts.dryRun ?? false, {
      libraryDir,
    });
    results.push({ skill: skillName, status });
  }
  return results;
}

export interface SkillStatus {
  name: string;
  description: string;
  detectGlobs: string[];
  matchedGlobs: string[];
  isRelevant: boolean;
  installedInWorkspace: boolean;
  availableInGlobal: boolean;
  bundledPath: string;
  /** False for skills found in <workspace>/.claude/skills/ that aren't part
   * of the bundled library (project-specific or installed from elsewhere). */
  inLibrary: boolean;
  /** Personal `skillOverrides` entry from .claude/settings.local.json, if
   * any - independent of whether the skill files are present in the
   * (shared, git-tracked) <target>/.claude/skills/ directory. */
  localOverride?: SkillOverrideValue;
}

/** Best-effort extraction of the `description:` field from a SKILL.md's
 * YAML frontmatter, for display only (not validated). */
function extractFrontmatterDescription(skillMdPath: string): string | undefined {
  try {
    const raw = fs.readFileSync(skillMdPath, "utf-8");
    return parseSkillFrontmatter(raw)?.description?.trim();
  } catch {
    return undefined;
  }
}

/** Skills present in <target>/.claude/skills/ that aren't part of the
 * bundled manifest - e.g. project-specific skills, or skills installed from
 * elsewhere before this extension was added to the project. */
function listProjectOnlySkills(
  target: string,
  manifest: Manifest,
  overrides: Record<string, SkillOverrideValue>,
  availableInGlobal: Set<string>
): SkillStatus[] {
  const skillsDir = path.join(target, ".claude", "skills");
  if (!fs.existsSync(skillsDir)) {
    return [];
  }
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !(name in manifest.skills))
    .filter((name) => fs.existsSync(path.join(skillsDir, name, "SKILL.md")))
    .sort()
    .map((name) => {
      const skillMdPath = path.join(skillsDir, name, "SKILL.md");
      return {
        name,
        description: extractFrontmatterDescription(skillMdPath) ?? "Project-local skill (not in library)",
        detectGlobs: [],
        matchedGlobs: [],
        isRelevant: false,
        installedInWorkspace: true,
        availableInGlobal: availableInGlobal.has(name),
        bundledPath: skillMdPath,
        inLibrary: false,
        localOverride: overrides[name],
      };
    });
}

/** Build the full status list used by the tree view: every skill in the
 * bundled library, plus any project-local skills already present in
 * <target>/.claude/skills/ that aren't part of the library. */
export function listSkillStatuses(
  libraryDir: string,
  target: string | undefined
): SkillStatus[] {
  const cacheKey = target ? path.normalize(target) : "";
  const now = Date.now();
  if (cacheKey) {
    const cached = skillStatusCache.get(cacheKey);
    const fingerprint = skillInstallKey(target, libraryDir);
    if (
      cached &&
      now - cached.at < SKILL_STATUS_CACHE_TTL_MS &&
      cached.key === fingerprint
    ) {
      return cached.statuses;
    }
  }

  const manifest = loadManifest(libraryDir);
  const detected = target ? detectRelevantSkills(target, manifest) : {};
  const globalDir = globalSkillsDir();
  const overrides = target ? readSkillOverrides(target) : {};
  const installedInWorkspace = target ? listSkillNameSet(path.join(target, ".claude", "skills")) : new Set<string>();
  const availableInGlobal = listSkillNameSet(globalDir);

  const librarySkills = Object.entries(manifest.skills).map(([name, rule]) => {
    const matched = detected[name] ?? [];
    return {
      name,
      description: rule.description,
      detectGlobs: rule.detect_globs,
      matchedGlobs: matched,
      isRelevant: matched.length > 0,
      installedInWorkspace: installedInWorkspace.has(name),
      availableInGlobal: availableInGlobal.has(name),
      bundledPath: path.join(libraryDir, name, "SKILL.md"),
      inLibrary: true,
      localOverride: overrides[name],
    };
  });

  const projectOnlySkills = target ? listProjectOnlySkills(target, manifest, overrides, availableInGlobal) : [];
  const statuses = [...librarySkills, ...projectOnlySkills];
  if (cacheKey) {
    skillStatusCache.set(cacheKey, {
      key: skillInstallKey(target, libraryDir),
      statuses,
      at: now,
    });
  }
  return statuses;
}
