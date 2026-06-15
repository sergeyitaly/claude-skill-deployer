#!/usr/bin/env node
// Injects once when the extension refreshes task-skill-proposals.json due to
// task scope drift (off-profile skill use or large session transcript).

const fs = require("fs");
const path = require("path");
const { readStdin, parsePlatform, resolveCwd, writePromptOutput } = require("./hookPlatform");

const PROMPT_REL = ".claude/learning/task-drift-prompt.json";
const CLI_CONFIG = ".claude/learning/cli-config.json";

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function featureEnabled(cwd) {
  const cfg = readJsonSafe(path.join(cwd, CLI_CONFIG));
  return cfg?.features?.taskDriftReproposal !== false;
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

function main() {
  const platform = parsePlatform(process.argv);
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
  writePromptOutput(prompt.message, platform, "systemMessage");
}

main();
