#!/usr/bin/env node
// Apply task skill focus — skillOverrides off for installed skills outside the active task set.

const fs = require("node:fs");
const path = require("node:path");

const PROPOSALS_REL = ".claude/learning/task-skill-proposals.json";
const ACTIVE_REL = ".claude/learning/task-active-skills.json";
const CLI_CONFIG = ".claude/learning/cli-config.json";
const SETTINGS_REL = ".claude/settings.local.json";

const DEFAULT_REQUIRED = [
  "self-learning",
  "file-style-conventions",
  "skill-creator",
  "skill-usage-insights",
  "skill-feedback-adaptation",
  "skill-official-updater",
];

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function featureEnabled(cwd, key) {
  const cfg = readJsonSafe(path.join(cwd, CLI_CONFIG));
  const features = cfg?.features;
  if (features && Object.hasOwn(features, key)) {
    return !!features[key];
  }
  if (key === "taskSkillFocus") {
    return true;
  }
  return false;
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

function readOverrides(cwd) {
  const local = readJsonSafe(path.join(cwd, SETTINGS_REL));
  return local?.skillOverrides || {};
}

function writeOverrides(cwd, overrides) {
  const file = path.join(cwd, SETTINGS_REL);
  const local = readJsonSafe(file) || {};
  if (Object.keys(overrides).length) {
    local.skillOverrides = overrides;
  } else {
    delete local.skillOverrides;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(local, null, 2) + "\n");
}

function mergeRequired(names) {
  const out = new Set(names);
  for (const s of DEFAULT_REQUIRED) {
    out.add(s);
  }
  return [...out];
}

function readTaskFocusLimits(cwd) {
  const cfg = readJsonSafe(path.join(cwd, CLI_CONFIG));
  const tf = cfg?.taskFocus;
  return {
    enabled: tf?.enabled !== false,
    maxActiveSkills: Math.max(4, Math.min(30, tf?.maxActiveSkills ?? 12)),
  };
}

function capActiveNames(names, limits) {
  const required = [...DEFAULT_REQUIRED];
  const requiredSet = new Set(required);
  const seen = new Set();
  const active = [];
  for (const name of required) {
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    active.push(name);
  }
  const optional = [...new Set(names.filter((n) => n && !requiredSet.has(n)))];
  for (const name of optional) {
    if (active.length >= limits.maxActiveSkills) {
      break;
    }
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    active.push(name);
  }
  return active;
}

function applyFocus(cwd, activeNames, source, proposalsGeneratedAt) {
  const limits = readTaskFocusLimits(cwd);
  const capped = limits.enabled ? capActiveNames(activeNames, limits) : mergeRequired(activeNames);
  const active = capped;
  const activeSet = new Set(active);
  const installed = listInstalled(cwd);
  const overrides = { ...readOverrides(cwd) };
  const ignored = [];
  let applied = 0;

  for (const name of installed) {
    if (activeSet.has(name)) {
      if (overrides[name] === "off") {
        delete overrides[name];
        applied++;
      }
      continue;
    }
    if (overrides[name] !== "off") {
      overrides[name] = "off";
      applied++;
    }
    ignored.push(name);
  }

  writeOverrides(cwd, overrides);
  const dir = path.join(cwd, ".claude", "learning");
  fs.mkdirSync(dir, { recursive: true });
  ignored.sort((a, b) => a.localeCompare(b));
  fs.writeFileSync(
    path.join(cwd, ACTIVE_REL),
    JSON.stringify(
      {
        version: 1,
        generatedAt: new Date().toISOString(),
        proposalsGeneratedAt,
        source,
        activeSkills: active,
        ignoredSkills: ignored,
      },
      null,
      2
    ) + "\n",
    "utf-8"
  );

  return { active, ignored, applied };
}

function main() {
  const cwd = path.resolve(process.argv[2] || process.cwd());
  if (!featureEnabled(cwd, "taskSkillFocus")) {
    return;
  }

  const explicit = process.argv[3];
  if (explicit) {
    try {
      const names = JSON.parse(explicit);
      if (Array.isArray(names) && names.length) {
        const result = applyFocus(cwd, names, "session-apply");
        if (result.applied) {
          process.stderr.write(
            `[claude-skills] task-focus: ${result.active.length} active, ${result.ignored.length} ignored\n`
          );
        }
      }
    } catch {
      // ignore bad argv
    }
    return;
  }

  const proposals = readJsonSafe(path.join(cwd, PROPOSALS_REL));
  if (!proposals || !Array.isArray(proposals.proposals) || !proposals.proposals.length) {
    return;
  }
  const state = readJsonSafe(path.join(cwd, ACTIVE_REL));
  if (state && state.proposalsGeneratedAt === proposals.generatedAt) {
    return;
  }
  const names = proposals.proposals.map((p) => p?.name).filter(Boolean);
  const limits = readTaskFocusLimits(cwd);
  const cappedNames = limits.enabled ? capActiveNames(names, limits) : names;
  const result = applyFocus(cwd, cappedNames, "task-skill-proposals", proposals.generatedAt);
  if (result.applied || result.ignored.length) {
    process.stderr.write(
      `[claude-skills] task-focus: ${result.active.length} active, ${result.ignored.length} ignored\n`
    );
  }
}

main();
