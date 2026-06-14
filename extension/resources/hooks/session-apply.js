#!/usr/bin/env node
// Headless session skill apply — runs from SessionStart hook without VS Code.
// Installs missing skills from ~/.claude/skills (or repo skills_library/) and
// clears local skillOverrides "off" for the proposed set.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const SESSION_REQUEST = ".claude/learning/session-skill-apply-request.json";
const SESSION_STATE = ".claude/learning/session-skill-apply-state.json";
const CLI_CONFIG = ".claude/learning/cli-config.json";
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
  const features = cfg?.features;
  if (features && Object.hasOwn(features, key)) {
    return !!features[key];
  }
  if (key === "autoApplyTaskProposals" || key === "sessionSkillAdaptation") {
    return true;
  }
  return false;
}

function readRequiredSkills(cwd) {
  const requestPath = path.join(cwd, ".claude/learning/profile-init-request.json");
  const request = readJsonSafe(requestPath);
  if (request && Array.isArray(request.requiredSkillNames) && request.requiredSkillNames.length) {
    return request.requiredSkillNames;
  }
  return [
    "self-learning",
    "file-style-conventions",
    "skill-creator",
    "skill-usage-insights",
    "skill-feedback-adaptation",
    "skill-official-updater",
  ];
}

function mergeRequired(cwd, skills) {
  const out = new Set(skills);
  for (const s of readRequiredSkills(cwd)) {
    out.add(s);
  }
  return [...out];
}

function readOverrides(cwd) {
  const local = readJsonSafe(path.join(cwd, ".claude", "settings.local.json"));
  return local?.skillOverrides || {};
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

function applySkills(cwd, skillNames) {
  const unique = [...new Set(skillNames.filter(Boolean))];
  if (!unique.length) {
    return { installed: [], skipped: [], overridesApplied: 0 };
  }
  const destRoot = path.join(cwd, ".claude", "skills");
  const installed = new Set(listInstalled(cwd));
  const overrides = { ...readOverrides(cwd) };
  const result = { installed: [], skipped: [], overridesApplied: 0 };

  for (const skill of unique) {
    if (!installed.has(skill)) {
      const source = resolveSource(cwd, skill);
      if (!source) {
        result.skipped.push(skill);
        continue;
      }
      const status = copySkill(skill, source, destRoot);
      if (status === "installed" || status === "skipped-exists") {
        result.installed.push(skill);
        installed.add(skill);
      } else {
        result.skipped.push(skill);
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
  if (!featureEnabled(cwd, "sessionSkillAdaptation")) {
    return;
  }

  const request = readJsonSafe(path.join(cwd, SESSION_REQUEST));
  if (request?.version !== 1 || !Array.isArray(request.skills) || !request.sessionId) {
    return;
  }
  if (!featureEnabled(cwd, "autoApplyTaskProposals") && request.source === "proposals") {
    return;
  }

  const state = readJsonSafe(path.join(cwd, SESSION_STATE)) || { version: 1 };
  if (state.lastSessionId === request.sessionId) {
    return;
  }

  const result = applySkills(cwd, mergeRequired(cwd, request.skills));
  fs.mkdirSync(path.join(cwd, ".claude", "learning"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, SESSION_STATE),
    JSON.stringify(
      {
        version: 1,
        lastSessionId: request.sessionId,
        lastAppliedAt: new Date().toISOString(),
        lastSkillCount: request.skills.length,
      },
      null,
      2
    ) + "\n"
  );

  if (result.installed.length || result.overridesApplied) {
    process.stderr.write(
      `[claude-skills] session-apply: installed ${result.installed.join(", ") || "(none)"}; ` +
        `overrides cleared ${result.overridesApplied}\n`
    );
  }

  try {
    const focusScript = path.join(cwd, ".claude", "hooks", "task-skill-focus.js");
    if (fs.existsSync(focusScript)) {
      require("node:child_process").spawnSync(
        process.execPath,
        [focusScript, cwd, JSON.stringify(mergeRequired(cwd, request.skills))],
        { cwd, stdio: "ignore", timeout: 30000 }
      );
    }
  } catch {
    // non-fatal
  }
}

main();
