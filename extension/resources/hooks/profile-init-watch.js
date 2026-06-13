#!/usr/bin/env node
// Profile-init + session skill apply hook for Claude Code (SessionStart), Cursor (sessionStart),
// Kiro IDE (agentSpawn), and GitHub Copilot in VS Code (SessionStart / sessionStart).
// 1. When profile-init is pending, inject context so the agent runs profile-init.
// 2. On every new session, queue proposed/profile skills for local enablement via the extension.

const fs = require("fs");
const path = require("path");

const SESSION_SOURCES = new Set(["startup", "resume", "clear", "new"]);
const REQUEST_REL = ".claude/learning/profile-init-request.json";
const PROFILE_REL = ".claude/profile.local.json";
const PROPOSALS_REL = ".claude/learning/task-skill-proposals.json";
const APPLY_REQUEST_REL = ".claude/learning/session-skill-apply-request.json";
const CLI_CONFIG = ".claude/learning/cli-config.json";
const DEFAULT_REQUIRED_SKILLS = [
  "self-learning",
  "file-style-conventions",
  "skill-creator",
  "skill-usage-insights",
  "skill-feedback-adaptation",
  "skill-official-updater",
];

function readRequiredSkills(cwd) {
  const request = readJsonSafe(path.join(cwd, REQUEST_REL));
  if (request && Array.isArray(request.requiredSkillNames) && request.requiredSkillNames.length) {
    return request.requiredSkillNames;
  }
  return DEFAULT_REQUIRED_SKILLS;
}

function taskProposalsAutoApply(cwd) {
  const cfg = readJsonSafe(path.join(cwd, CLI_CONFIG));
  const features = cfg && cfg.features;
  if (features && features.autoApplyTaskProposals === false) {
    return false;
  }
  if (features && features.sessionSkillAdaptation === false) {
    return false;
  }
  return true;
}

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
    "Learning: refine .claude/learning/task-skill-proposals.json if the extension seed is present.",
    "Proposed skills from the profile seed are being enabled locally for this session.",
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

function resolveSkillsToEnable(cwd) {
  const names = new Set();
  let fromProfile = false;
  let fromProposals = false;

  const profile = readJsonSafe(path.join(cwd, PROFILE_REL));
  if (profile && profile.status === "applied" && Array.isArray(profile.skills) && profile.skills.length) {
    profile.skills.forEach((s) => names.add(s));
    fromProfile = true;
  }

  const proposals = readJsonSafe(path.join(cwd, PROPOSALS_REL));
  if (proposals && Array.isArray(proposals.proposals) && proposals.proposals.length && taskProposalsAutoApply(cwd)) {
    const ranked = proposals.proposals
      .filter((p) => p && typeof p.name === "string")
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    for (const p of ranked) {
      names.add(p.name);
      fromProposals = true;
    }
  } else if (proposals && Array.isArray(proposals.proposals) && proposals.proposals.length) {
    const ranked = proposals.proposals
      .filter((p) => p && typeof p.name === "string")
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    for (const p of ranked) {
      if ((p.confidence ?? 0) >= 50) {
        names.add(p.name);
        fromProposals = true;
      }
    }
    if (names.size === 0) {
      ranked.slice(0, 15).forEach((p) => {
        names.add(p.name);
        fromProposals = true;
      });
    }
  }

  for (const skill of readRequiredSkills(cwd)) {
    names.add(skill);
  }

  const source =
    fromProfile && fromProposals ? "profile+proposals" : fromProfile ? "profile" : fromProposals ? "proposals" : "profile";

  return { skills: [...names], source };
}

function writeSessionApplyRequest(cwd, input, platform, resolved) {
  if (!resolved.skills.length) {
    return;
  }
  const sessionId =
    input.session_id ||
    input.sessionId ||
    input.conversation_id ||
    input.conversationId ||
    `${platform}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const request = {
    version: 1,
    requestedAt: new Date().toISOString(),
    sessionId,
    platform,
    skills: resolved.skills,
    source: resolved.source,
  };
  const dir = path.join(cwd, ".claude", "learning");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(cwd, APPLY_REQUEST_REL), JSON.stringify(request, null, 2) + "\n", "utf-8");
}

function resolvePlatform(input, argvPlatform) {
  if (argvPlatform === "cursor" || argvPlatform === "claude" || argvPlatform === "kiro" || argvPlatform === "copilot") {
    return argvPlatform;
  }
  if (input && (input.hook_event_name === "agentSpawn" || input.event === "agentSpawn")) {
    return "kiro";
  }
  if (
    input &&
    (input.hook_event_name === "SessionStart" ||
      input.hookEventName === "SessionStart" ||
      input.hook_event_name === "sessionStart")
  ) {
    return "copilot";
  }
  if (input && typeof input.session_id === "string") {
    return "cursor";
  }
  if (input && typeof input.cwd === "string") {
    return "claude";
  }
  return "cursor";
}

function resolveCwd(input, platform) {
  if ((platform === "claude" || platform === "copilot") && input.cwd) {
    return input.cwd;
  }
  if (Array.isArray(input.workspace_roots) && input.workspace_roots[0]) {
    return input.workspace_roots[0];
  }
  if (input.workingDirectory || input.working_directory) {
    return input.workingDirectory || input.working_directory;
  }
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function shouldRun(input, platform) {
  if (platform === "claude" || platform === "copilot") {
    const source = input.source || "startup";
    return SESSION_SOURCES.has(source);
  }
  return true;
}

function emitOutput(context, platform) {
  if (platform === "cursor" || platform === "kiro") {
    process.stdout.write(
      JSON.stringify({
        additional_context: context,
        additionalContext: context,
        continue: true,
      })
    );
    return;
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context,
      },
    })
  );
}

function main() {
  const raw = readStdin();
  let input = {};
  try {
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return;
  }

  const platform = resolvePlatform(input, (process.argv[2] || "").toLowerCase());
  const cwd = resolveCwd(input, platform);
  if (!cwd || !shouldRun(input, platform)) {
    return;
  }

  const resolved = resolveSkillsToEnable(cwd);
  writeSessionApplyRequest(cwd, input, platform, resolved);

  try {
    const applyScript = path.join(cwd, ".claude", "hooks", "session-apply.js");
    if (fs.existsSync(applyScript)) {
      require("child_process").spawnSync(process.execPath, [applyScript, cwd], {
        cwd,
        stdio: "ignore",
        timeout: 60000,
      });
    }
  } catch {
    // Non-fatal — extension or CLI can apply later
  }

  if (profileInitComplete(cwd)) {
    return;
  }

  const requestPath = path.join(cwd, REQUEST_REL);
  const request = readJsonSafe(requestPath);
  if (!request || request.status === "completed") {
    return;
  }

  emitOutput(formatContext(request), platform);
}

main();
