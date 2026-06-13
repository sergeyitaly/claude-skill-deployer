#!/usr/bin/env node
// Apply saved branch skill profile on git checkout — headless (no VS Code).
// Invoked from .git/hooks/post-checkout or: node .claude/hooks/branch-sync.js <workspace>

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execSync } = require("child_process");

const CLI_CONFIG = ".claude/learning/cli-config.json";
const BRANCH_PROFILES = path.join(os.homedir(), ".claude", "learning", "branch-profiles.json");
const GLOBAL_SKILLS = path.join(os.homedir(), ".claude", "skills");

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function featureEnabled(cwd, key) {
  const cfg = readJsonSafe(path.join(cwd, CLI_CONFIG));
  const features = cfg && cfg.features;
  if (features && Object.prototype.hasOwnProperty.call(features, key)) {
    return !!features[key];
  }
  return key === "branchProfiles";
}

function gitBranch(cwd) {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf-8", timeout: 10000 }).trim();
  } catch {
    return null;
  }
}

function gitOrigin(cwd) {
  try {
    return execSync("git remote get-url origin", { cwd, encoding: "utf-8", timeout: 10000 }).trim();
  } catch {
    return null;
  }
}

function repoKey(cwd) {
  const origin = gitOrigin(cwd);
  const basis = origin || path.resolve(cwd);
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

function readOverrides(cwd) {
  const local = readJsonSafe(path.join(cwd, ".claude", "settings.local.json"));
  return (local && local.skillOverrides) || {};
}

function writeOverrides(cwd, overrides) {
  const file = path.join(cwd, ".claude", "settings.local.json");
  const local = readJsonSafe(file) || {};
  if (Object.keys(overrides).length) {
    local.skillOverrides = overrides;
  } else {
    delete local.skillOverrides;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(local, null, 2) + "\n");
}

function listInstalled(cwd) {
  const dir = path.join(cwd, ".claude", "skills");
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "SKILL.md")))
    .map((e) => e.name);
}

function resolveSource(cwd, skill) {
  if (fs.existsSync(path.join(GLOBAL_SKILLS, skill, "SKILL.md"))) {
    return GLOBAL_SKILLS;
  }
  const library = path.join(cwd, "skills_library", skill, "SKILL.md");
  if (fs.existsSync(library)) {
    return path.join(cwd, "skills_library");
  }
  return null;
}

function copySkill(skill, sourceRoot, destRoot) {
  const src = path.join(sourceRoot, skill);
  const dst = path.join(destRoot, skill);
  if (!fs.existsSync(path.join(src, "SKILL.md"))) {
    return "missing-source";
  }
  if (fs.existsSync(path.join(dst, "SKILL.md"))) {
    return "skipped-exists";
  }
  fs.mkdirSync(destRoot, { recursive: true });
  fs.cpSync(src, dst, { recursive: true, force: true });
  return "installed";
}

function loadBranchProfile(cwd, branch) {
  const store = readJsonSafe(BRANCH_PROFILES);
  if (!store || !store.repos) {
    return null;
  }
  const key = repoKey(cwd);
  const profile = store.repos[key] && store.repos[key].branches && store.repos[key].branches[branch];
  return profile || null;
}

function applyProfile(cwd, profile) {
  const skills = profile.skills || [];
  if (!skills.length) {
    return { installed: [], overridesApplied: 0 };
  }
  const destRoot = path.join(cwd, ".claude", "skills");
  const installed = new Set(listInstalled(cwd));
  const overrides = { ...readOverrides(cwd) };
  const result = { installed: [], overridesApplied: 0 };

  for (const skill of skills) {
    if (!installed.has(skill)) {
      const source = resolveSource(cwd, skill);
      if (!source) {
        continue;
      }
      const status = copySkill(skill, source, destRoot);
      if (status === "installed" || status === "skipped-exists") {
        result.installed.push(skill);
        installed.add(skill);
      }
    }
    if (overrides[skill] === "off") {
      delete overrides[skill];
      result.overridesApplied++;
    }
  }
  writeOverrides(cwd, overrides);
  return result;
}

function main() {
  const cwd = path.resolve(process.argv[2] || process.cwd());
  if (!featureEnabled(cwd, "branchProfiles")) {
    return;
  }
  const branch = gitBranch(cwd);
  if (!branch || branch === "HEAD") {
    return;
  }
  const profile = loadBranchProfile(cwd, branch);
  if (!profile) {
    return;
  }
  const result = applyProfile(cwd, profile);
  if (result.installed.length || result.overridesApplied) {
    process.stderr.write(
      `[claude-skills] branch-sync (${branch}): installed ${result.installed.join(", ") || "(none)"}; ` +
        `overrides cleared ${result.overridesApplied}\n`
    );
  }
}

main();
