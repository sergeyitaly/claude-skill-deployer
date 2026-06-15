#!/usr/bin/env node
// Profile-init + session skill apply hook for Claude Code (SessionStart), Cursor (sessionStart),
// Kiro IDE (sessionStart), and GitHub Copilot in VS Code (SessionStart / sessionStart).
// 1. When profile-init is pending, inject context so the agent runs profile-init.
// 2. On every new session, queue proposed/profile skills for local enablement via the extension.

const fs = require("node:fs");
const path = require("node:path");

const SESSION_SOURCES = new Set(["startup", "resume", "clear", "new"]);
const REQUEST_REL = ".claude/learning/profile-init-request.json";
const PROFILE_REL = ".claude/profile.local.json";
const PROPOSALS_REL = ".claude/learning/task-skill-proposals.json";
const ACTIVE_REL = ".claude/learning/task-active-skills.json";
const APPLY_REQUEST_REL = ".claude/learning/session-skill-apply-request.json";
const TRUST_REL = ".claude/learning/attribution-trust.json";
const DRIFT_REL = ".claude/learning/task-drift-prompt.json";
const CLI_CONFIG = ".claude/learning/cli-config.json";
const DEFAULT_REQUIRED_SKILLS = [
  "self-learning",
  "file-style-conventions",
  "skill-creator",
  "skill-usage-insights",
  "skill-feedback-adaptation",
  "skill-official-updater",
];

const PROPOSALS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function readRequiredSkills(cwd) {
  const request = readJsonSafe(path.join(cwd, REQUEST_REL));
  if (request && Array.isArray(request.requiredSkillNames) && request.requiredSkillNames.length) {
    return request.requiredSkillNames;
  }
  return DEFAULT_REQUIRED_SKILLS;
}

function sessionSkillAdaptationEnabled(cwd) {
  const cfg = readJsonSafe(path.join(cwd, CLI_CONFIG));
  const features = cfg?.features;
  return features?.sessionSkillAdaptation !== false;
}

function taskSkillSetApprovalEnabled(cwd) {
  const cfg = readJsonSafe(path.join(cwd, CLI_CONFIG));
  return cfg?.taskFocus?.approveSkillSets !== false;
}

function minProposalConfidence(cwd) {
  const cfg = readJsonSafe(path.join(cwd, CLI_CONFIG));
  const raw = cfg?.taskFocus?.minProposalConfidence;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.min(100, Math.max(0, Math.round(raw)));
  }
  return 50;
}

function taskProposalsPendingApproval(cwd) {
  if (!taskSkillSetApprovalEnabled(cwd)) {
    return false;
  }
  const proposals = readJsonSafe(path.join(cwd, PROPOSALS_REL));
  return proposals?.approvalStatus === "pending" && Array.isArray(proposals?.options) && proposals.options.length > 0;
}

function resolveProposalSkillNamesFromFile(proposals, cwd) {
  if (!proposals || !Array.isArray(proposals.proposals)) {
    return [];
  }
  const minConf = minProposalConfidence(cwd);
  const required = new Set(readRequiredSkills(cwd));
  const filtered = proposals.proposals.filter(
    (p) => p && typeof p.name === "string" && (required.has(p.name) || (p.confidence ?? 0) >= minConf)
  );
  const allowed = new Set(filtered.map((p) => p.name));
  if (proposals.selectedOptionId && Array.isArray(proposals.options)) {
    const selected = proposals.options.find((o) => o && o.id === proposals.selectedOptionId);
    if (selected && Array.isArray(selected.skills) && selected.skills.length) {
      return selected.skills.filter((name) => required.has(name) || allowed.has(name));
    }
  }
  return filtered.map((p) => p.name);
}

function taskProposalsAutoApply(cwd) {
  if (!sessionSkillAdaptationEnabled(cwd)) {
    return false;
  }
  const cfg = readJsonSafe(path.join(cwd, CLI_CONFIG));
  const features = cfg?.features;
  if (features?.autoApplyTaskProposals === false) {
    return false;
  }
  return true;
}

function deterministicTaskProposalsEnabled(cwd) {
  const cfg = readJsonSafe(path.join(cwd, CLI_CONFIG));
  return cfg?.features?.deterministicTaskProposals !== false;
}

function taskProposalsFresh(cwd) {
  const proposals = readJsonSafe(path.join(cwd, PROPOSALS_REL));
  if (!proposals?.generatedAt || !Array.isArray(proposals?.proposals) || !proposals.proposals.length) {
    return false;
  }
  const ageMs = Date.now() - new Date(proposals.generatedAt).getTime();
  return ageMs >= 0 && ageMs < PROPOSALS_MAX_AGE_MS;
}

function formatLowTrustPrompt(cwd) {
  const trust = readJsonSafe(path.join(cwd, TRUST_REL));
  if (!trust?.enabled || !trust.shouldInject) {
    return "";
  }
  const score = typeof trust.scorePct === "number" ? trust.scorePct : null;
  const threshold = typeof trust.thresholdPct === "number" ? trust.thresholdPct : 50;
  if (score === null || score >= threshold) {
    return "";
  }
  return [
    `[Claude Skills] Cost attribution trust is ${score}% (below your ${threshold}% threshold).`,
    "Dashboard per-skill costs and ROI are unreliable until Attribution v2 hooks log more invocations.",
    "Do not optimize skill choices from cost rankings alone — read SKILL.md for task-relevant skills.",
    trust.summary ? `Status: ${trust.summary}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function formatTaskDriftPrompt(cwd) {
  const cfg = readJsonSafe(path.join(cwd, CLI_CONFIG));
  if (cfg?.features?.taskDriftReproposal === false) {
    return "";
  }
  const prompt = readJsonSafe(path.join(cwd, DRIFT_REL));
  if (!prompt?.shouldInject || !prompt.message) {
    return "";
  }
  try {
    fs.writeFileSync(
      path.join(cwd, DRIFT_REL),
      JSON.stringify(
        {
          ...prompt,
          shouldInject: false,
          deliveredAt: new Date().toISOString(),
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );
  } catch {
    // non-fatal
  }
  return prompt.message;
}

function joinSessionContext(cwd, base) {
  const lowTrust = formatLowTrustPrompt(cwd);
  const drift = formatTaskDriftPrompt(cwd);
  const parts = [base, lowTrust, drift].filter(Boolean);
  return parts.join("\n\n");
}

function formatFreshSessionContext(cwd) {
  const active = readJsonSafe(path.join(cwd, ACTIVE_REL));
  if (active && Array.isArray(active.activeSkills) && active.activeSkills.length) {
    const list = active.activeSkills.slice(0, 12).join(", ");
    const ignored =
      Array.isArray(active.ignoredSkills) && active.ignoredSkills.length
        ? ` Ignored for this task (${active.ignoredSkills.length}): ${active.ignoredSkills.slice(0, 8).join(", ")}${active.ignoredSkills.length > 8 ? ", ..." : ""}.`
        : "";
    return [
      "[Claude Skills] Task skill focus ON — use only the active skill set below; other installed skills are on your ignore list (skillOverrides off).",
      `Active skills: ${list}.`,
      ignored,
      "Do not load or read SKILL.md for ignored skills unless the user explicitly asks.",
    ]
      .filter(Boolean)
      .join(" ");
  }

  const proposals = readJsonSafe(path.join(cwd, PROPOSALS_REL));
  const top = (proposals?.proposals ?? [])
    .filter((p) => p && typeof p.name === "string")
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .slice(0, 8)
    .map((p) => `${p.name} (${p.confidence ?? "?"}%)`)
    .join(", ");
  return [
    "[Claude Skills] Session ready — task skills set by the extension (auto-apply on).",
    top ? `Enabled proposals: ${top}.` : "",
    "Skip skill-feedback-adaptation section 3 unless the user starts a clearly new task.",
    "Do not read SKILL.md files unless the task needs a skill you have not used before.",
  ]
    .filter(Boolean)
    .join(" ");
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
  return profile?.status === "applied" && Array.isArray(profile.skills) && profile.skills.length > 0;
}

function formatNewSessionTaskContext() {
  return [
    "[Claude Skills] NEW SESSION — update task skills before other work.",
    "Read and follow skill-feedback-adaptation section 3 (Propose skills for a new task) immediately — do not wait for the user to ask.",
    "Use the user's first message (or latest task scope) to overwrite .claude/learning/task-skill-proposals.json.",
    "Existing proposals may be a stale profile-init seed — replace them when the user starts a new task.",
    "Propose only skills that match this task (typically 3–8, not the whole library). Read and apply the top proposed skills, then answer the user.",
  ].join(" ");
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
  if (request.relevantSkillNames?.length) {
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
  if (profile?.status === "applied" && Array.isArray(profile.skills) && profile.skills.length) {
    profile.skills.forEach((s) => names.add(s));
    fromProfile = true;
  }

  const proposals = readJsonSafe(path.join(cwd, PROPOSALS_REL));
  if (proposals && Array.isArray(proposals.proposals) && proposals.proposals.length && taskProposalsAutoApply(cwd)) {
    if (!taskProposalsPendingApproval(cwd)) {
      for (const name of resolveProposalSkillNamesFromFile(proposals, cwd)) {
        names.add(name);
        fromProposals = true;
      }
    }
  } else if (proposals && Array.isArray(proposals.proposals) && proposals.proposals.length) {
    const resolved = resolveProposalSkillNamesFromFile(proposals, cwd);
    for (const name of resolved) {
      names.add(name);
      fromProposals = true;
    }
    if (names.size === 0) {
      proposals.proposals
        .filter((p) => p && typeof p.name === "string")
        .slice(0, 15)
        .forEach((p) => {
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
  if (
    input &&
    (input.hook_event_name === "sessionStart" ||
      input.event === "sessionStart" ||
      input.hook_event_name === "agentSpawn" ||
      input.event === "agentSpawn")
  ) {
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

function emitSessionStartContext(cwd, platform) {
  let base = "";
  if (sessionSkillAdaptationEnabled(cwd)) {
    base =
      deterministicTaskProposalsEnabled(cwd) && taskProposalsFresh(cwd)
        ? formatFreshSessionContext(cwd)
        : formatNewSessionTaskContext();
  }
  const context = joinSessionContext(cwd, base);
  if (!context) {
    return;
  }
  emitOutput(context, platform);
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
      require("node:child_process").spawnSync(process.execPath, [applyScript, cwd], {
        cwd,
        stdio: "ignore",
        timeout: 60000,
      });
    }
    const focusScript = path.join(cwd, ".claude", "hooks", "task-skill-focus.js");
    if (fs.existsSync(focusScript)) {
      require("node:child_process").spawnSync(
        process.execPath,
        [focusScript, cwd, JSON.stringify(resolved.skills)],
        { cwd, stdio: "ignore", timeout: 30000 }
      );
    }
  } catch {
    // Non-fatal — extension or CLI can apply later
  }

  if (profileInitComplete(cwd)) {
    emitSessionStartContext(cwd, platform);
    return;
  }

  const requestPath = path.join(cwd, REQUEST_REL);
  const request = readJsonSafe(requestPath);
  if (!request || request.status === "completed") {
    emitSessionStartContext(cwd, platform);
    return;
  }

  emitOutput(joinSessionContext(cwd, formatContext(request)), platform);
}

main();
