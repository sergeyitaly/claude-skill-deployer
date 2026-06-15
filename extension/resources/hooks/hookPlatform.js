#!/usr/bin/env node
// Shared stdin/cwd/platform helpers for cost-control prompt hooks (all agents).

const fs = require("node:fs");

const VALID_PLATFORMS = new Set(["claude", "cursor", "kiro", "copilot"]);

function readStdin() {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function parsePlatform(argv) {
  const raw = (argv[2] || "claude").toLowerCase();
  return VALID_PLATFORMS.has(raw) ? raw : "claude";
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
  return input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function resolveSessionId(input) {
  return (
    input.session_id ||
    input.sessionId ||
    input.conversation_id ||
    input.conversationId ||
    ""
  );
}

/** @param {"systemMessage"|"hookSpecificOutput"} claudeStyle */
function emitPromptOutput(message, platform, claudeStyle = "systemMessage") {
  if (platform === "cursor" || platform === "kiro") {
    return {
      additional_context: message,
      additionalContext: message,
      continue: true,
    };
  }
  if (platform === "copilot" || claudeStyle === "hookSpecificOutput") {
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: message,
      },
    };
  }
  return { systemMessage: message };
}

function writePromptOutput(message, platform, claudeStyle = "systemMessage") {
  process.stdout.write(JSON.stringify(emitPromptOutput(message, platform, claudeStyle)));
}

module.exports = {
  readStdin,
  parsePlatform,
  resolveCwd,
  resolveSessionId,
  emitPromptOutput,
  writePromptOutput,
};
