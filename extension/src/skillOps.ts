import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SkillRule {
  description: string;
  detect_globs: string[];
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
]);

/** Global skills directory: ~/.claude/skills */
export function globalSkillsDir(): string {
  return path.join(os.homedir(), ".claude", "skills");
}

export function loadManifest(libraryDir: string): Manifest {
  const raw = fs.readFileSync(path.join(libraryDir, "manifest.json"), "utf-8");
  return JSON.parse(raw) as Manifest;
}

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
export function patternMatchesAny(pattern: string, paths: string[]): boolean {
  const candidates = [pattern];
  if (pattern.startsWith("**/")) {
    candidates.push(pattern.slice(3));
  }
  const regexes = candidates.map(fnmatchToRegExp);
  return paths.some((p) => regexes.some((r) => r.test(p)));
}

/** Returns { skillName: matchedGlobs[] } for skills with >=1 match. */
export function detectRelevantSkills(
  target: string,
  manifest: Manifest
): Record<string, string[]> {
  const paths = collectRelativePaths(target);
  const results: Record<string, string[]> = {};
  for (const [skillName, rule] of Object.entries(manifest.skills)) {
    const matched = rule.detect_globs.filter((g) => patternMatchesAny(g, paths));
    if (matched.length > 0) {
      results[skillName] = matched;
    }
  }
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
    fs.copyFileSync(src, dest);
  }
}

export function copySkill(
  skillName: string,
  sourceRoot: string,
  destRoot: string,
  force: boolean,
  dryRun: boolean
): CopyStatus {
  const src = path.join(sourceRoot, skillName);
  const dst = path.join(destRoot, skillName);
  if (!fs.existsSync(path.join(src, "SKILL.md"))) {
    return "missing-source";
  }
  if (fs.existsSync(dst) && !force) {
    return "skipped-exists";
  }
  if (dryRun) {
    return "would-install";
  }
  copyRecursive(src, dst);
  return "installed";
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

export interface SkillStatus {
  name: string;
  description: string;
  detectGlobs: string[];
  matchedGlobs: string[];
  isRelevant: boolean;
  installedInWorkspace: boolean;
  availableInGlobal: boolean;
  bundledPath: string;
}

/** Build the full status list used by the tree view. */
export function listSkillStatuses(
  libraryDir: string,
  target: string | undefined
): SkillStatus[] {
  const manifest = loadManifest(libraryDir);
  const detected = target ? detectRelevantSkills(target, manifest) : {};
  const globalDir = globalSkillsDir();

  return Object.entries(manifest.skills).map(([name, rule]) => {
    const matched = detected[name] ?? [];
    const installedInWorkspace = target
      ? fs.existsSync(path.join(target, ".claude", "skills", name, "SKILL.md"))
      : false;
    const availableInGlobal = fs.existsSync(path.join(globalDir, name, "SKILL.md"));
    return {
      name,
      description: rule.description,
      detectGlobs: rule.detect_globs,
      matchedGlobs: matched,
      isRelevant: matched.length > 0,
      installedInWorkspace,
      availableInGlobal,
      bundledPath: path.join(libraryDir, name, "SKILL.md"),
    };
  });
}
