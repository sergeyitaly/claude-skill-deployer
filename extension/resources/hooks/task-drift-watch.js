#!/usr/bin/env node
// Injects once when the extension refreshes task-skill-proposals.json due to
// task scope drift (off-profile skill use or large session transcript).
// Claude Code: UserPromptSubmit (systemMessage)
// Cursor: beforeSubmitPrompt (additional_context)
// Kiro: userPromptSubmit (additional_context)
// Copilot: UserPromptSubmit / userPromptSubmitted (hookSpecificOutput)

const fs = require("fs");
const path = require("path");

const PROMPT_REL = ".claude/learning/task-drift-prompt.json";
const CLI_CONFIG = ".claude/learning/cli-config.json";

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function featureEnabled(cwd) {
  const cfg = readJsonSafe(path.join(cwd, CLI_CONFIG));
  return cfg?.features?.taskDriftReproposal !== false;
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

function markDelivered(promptFile, prompt) {
  try {
    const next = {
      ...prompt,
      shouldInject: false,
      deliveredAt: new Date().toISOString(),
    };
    fs.writeFileSync(promptFile, JSON.stringify(next, null, 2) + "\n", "utf-8");
  } catch {
    // still inject even if we cannot mark delivered
  }
}

function emitOutput(message, platform) {
  if (platform === "cursor" || platform === "kiro") {
    process.stdout.write(
      JSON.stringify({
        additional_context: message,
        additionalContext: message,
        continue: true,
      })
    );
    return;
  }
  if (platform === "copilot") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: message,
        },
      })
    );
    return;
  }
  process.stdout.write(JSON.stringify({ systemMessage: message }));
}

function main() {
  const platform = (process.argv[2] || "claude").toLowerCase();
  let input;
  try {
    input = JSON.parse(readStdin());
  } catch {
    input = {};
  }

  const cwd = resolveCwd(input, platform);
  if (!cwd || !featureEnabled(cwd)) {
    return;
  }

  const promptFile = path.join(cwd, PROMPT_REL);
  const prompt = readJsonSafe(promptFile);
  if (!prompt?.shouldInject || !prompt.message) {
    return;
  }

  markDelivered(promptFile, prompt);
  emitOutput(prompt.message, platform);
}

main();
