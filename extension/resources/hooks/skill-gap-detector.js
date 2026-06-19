#!/usr/bin/env node
/**
 * SessionStart hook: scan the workspace for tech stacks and surface missing skills
 * into Claude's session context so the agent knows what to install before starting work.
 *
 * Outputs plain text to stdout — Claude Code injects this into the session at startup.
 *
 * Register in .claude/settings.json:
 *   "hooks": {
 *     "SessionStart": [{
 *       "matcher": "startup|resume|clear",
 *       "hooks": [{ "type": "command", "command": "node /path/to/skill-gap-detector.js claude", "timeout": 20 }]
 *     }]
 *   }
 */
"use strict";

const fs   = require("node:fs");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Skill rules: each entry maps a detection function to one or more required skills
// ---------------------------------------------------------------------------
const SKILL_RULES = [
  {
    skills: ["terraform-module-ops", "terraform-plan-review"],
    detect: hasTerraformFiles,
    reason: "Terraform (.tf) files detected in workspace",
  },
  {
    skills: ["azure-infra-preflight"],
    detect: hasAzureProvider,
    reason: "Azure provider (azurerm) found in Terraform files",
  },
  {
    skills: ["cross-platform-scripting"],
    detect: hasShellScripts,
    reason: ".ps1 or .sh scripts detected in workspace",
  },
  {
    skills: ["security-review"],
    detect: hasSecurityContext,
    reason: "Security-sensitive patterns detected (auth, secrets, permissions)",
  },
];

// ---------------------------------------------------------------------------
// Detection helpers — all capped at depth 4, skip node_modules / .git
// ---------------------------------------------------------------------------

function hasTerraformFiles(dir) {
  return globExists(dir, ".tf", 4);
}

function hasAzureProvider(dir) {
  const lockFile = path.join(dir, ".terraform.lock.hcl");
  if (fs.existsSync(lockFile)) {
    try { return fs.readFileSync(lockFile, "utf8").includes("azurerm"); } catch {}
  }
  return fileContains(dir, ".tf", "azurerm", 4);
}

function hasShellScripts(dir) {
  return globExists(dir, ".ps1", 3) || globExists(dir, ".sh", 3);
}

function hasSecurityContext(dir) {
  const markers = ["auth", "secret", "password", "credential", "iam", "rbac", "permission", "token"];
  const claudeMd = path.join(dir, "CLAUDE.md");
  if (fs.existsSync(claudeMd)) {
    try {
      const content = fs.readFileSync(claudeMd, "utf8").toLowerCase();
      if (markers.some((m) => content.includes(m))) return true;
    } catch {}
  }
  return false;
}

// ---------------------------------------------------------------------------
// Generic filesystem helpers
// ---------------------------------------------------------------------------

function globExists(dir, ext, maxDepth, depth = 0) {
  if (depth > maxDepth) return false;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "__pycache__") continue;
    if (e.isFile() && e.name.endsWith(ext)) return true;
    if (e.isDirectory() && globExists(path.join(dir, e.name), ext, maxDepth, depth + 1)) return true;
  }
  return false;
}

function fileContains(dir, ext, needle, maxDepth, depth = 0) {
  if (depth > maxDepth) return false;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    if (e.isFile() && e.name.endsWith(ext)) {
      try { if (fs.readFileSync(path.join(dir, e.name), "utf8").includes(needle)) return true; } catch {}
    }
    if (e.isDirectory() && fileContains(path.join(dir, e.name), ext, needle, maxDepth, depth + 1)) return true;
  }
  return false;
}

function getInstalledSkills(projectDir) {
  const skillsDir = path.join(projectDir, ".claude", "skills");
  try {
    return new Set(
      fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    );
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const installed = getInstalledSkills(projectDir);

  const gaps = [];
  for (const rule of SKILL_RULES) {
    const missing = rule.skills.filter((s) => !installed.has(s));
    if (missing.length === 0) continue;
    if (!rule.detect(projectDir)) continue;
    for (const skill of missing) {
      gaps.push({ skill, reason: rule.reason });
    }
  }

  if (gaps.length === 0) return;

  const lines = [
    "[skill-gap-detector] Skills missing for this workspace:",
    ...gaps.map((g) => `  • ${g.skill} — ${g.reason}`),
    "Run the skill-creator skill or: python generate_skills.py install <skill-name>",
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

main();
