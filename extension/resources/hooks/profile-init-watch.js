#!/usr/bin/env node
// Claude Code SessionStart hook: when profile-init is pending for this branch,
// inject context so the agent runs profile-init immediately (no manual prompt).

const fs = require("fs");
const path = require("path");

const SESSION_SOURCES = new Set(["startup", "resume", "clear"]);
const REQUEST_REL = ".claude/learning/profile-init-request.json";
const PROFILE_REL = ".claude/profile.local.json";

function readStdin() {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function profileInitComplete(cwd) {
  const profile = readJsonSafe(path.join(cwd, PROFILE_REL));
  return profile && profile.status === "applied" && Array.isArray(profile.skills) && profile.skills.length > 0;
}

function formatContext(request) {
  const lines = [
    "[Claude Skills] PROFILE INIT REQUIRED — run before any other task.",
    `Branch: ${request.branch}`,
    `Position: ${request.position?.label ?? request.position?.role ?? "unknown"}`,
    `Catalog: ${request.catalogPath ?? ".claude/learning/skills-catalog.json"}`,
    `Output: ${request.outputPath ?? ".claude/profile.local.json"}`,
  ];
  if (request.relevantSkillNames && request.relevantSkillNames.length) {
    lines.push(`Workspace-relevant skills: ${request.relevantSkillNames.join(", ")}.`);
  }
  if (request.agentInstructions) {
    lines.push(request.agentInstructions);
  } else {
    lines.push(
      "Read and follow the profile-init skill now: pick skills from the catalog for this branch and position, write profile.local.json with status pending, then confirm apply."
    );
  }
  return lines.join(" ");
}

function main() {
  let input;
  try {
    input = JSON.parse(readStdin());
  } catch {
    return;
  }

  const cwd = input.cwd;
  const source = input.source || "startup";
  if (!cwd || !SESSION_SOURCES.has(source)) {
    return;
  }

  if (profileInitComplete(cwd)) {
    return;
  }

  const requestPath = path.join(cwd, REQUEST_REL);
  const request = readJsonSafe(requestPath);
  if (!request || request.status === "completed") {
    return;
  }

  const context = formatContext(request);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context,
      },
    })
  );
}

main();
