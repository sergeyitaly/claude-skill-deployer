#!/usr/bin/env node
// Grounding instructions balancing local workspace context vs general knowledge.
// Config from ~/.claude/learning/context-focus.json (synced by the VS Code extension).

const fs = require("fs");
const path = require("path");
const os = require("os");
const { readStdin, parsePlatform, resolveCwd, resolveSessionId, writePromptOutput } = require("./hookPlatform");

const CONFIG_PATH =
  process.env.CLAUDE_SKILLS_CONTEXT_FOCUS_CONFIG ||
  path.join(os.homedir(), ".claude", "learning", "context-focus.json");
const WARN_BYTES = 4 * 1024 * 1024;
const CRITICAL_BYTES = 10 * 1024 * 1024;

const LEVEL_ORDER = ["knowledge", "balanced", "local-first", "strict-local"];

const DEFAULT_CONFIG = {
  enabled: true,
  level: "balanced",
  autoEscalateOnSessionSize: true,
  injectEveryPrompt: true,
  limitSkillCatalogHints: true,
  manySkillsThreshold: 12,
};

const INSTRUCTIONS = {
  knowledge: [
    "Context focus: KNOWLEDGE-FORWARD.",
    "Use broad technical knowledge for concepts and patterns.",
    "For this repository, read files when editing or when the user asks about specific code, paths, or behavior.",
  ],
  balanced: [
    "Context focus: BALANCED.",
    "Verify repo-specific claims (paths, APIs, config, behavior) by reading files before stating them.",
    "Use general knowledge for language/framework concepts, not for undocumented project behavior.",
    "In long sessions, re-read sources instead of relying on stale transcript context.",
  ],
  "local-first": [
    "Context focus: LOCAL-FIRST (reduce hallucination).",
    "Before explaining how this codebase works, read the relevant file(s) and cite paths.",
    "Do not invent file contents, env vars, CLI flags, or APIs for this project.",
    "Load and follow only skills clearly relevant to the current task; avoid broad skill dumps.",
  ],
  "strict-local": [
    "Context focus: STRICT LOCAL (minimal hallucination).",
    "Only assert facts from: (1) files read this session, (2) user messages, (3) explicit tool output.",
    "If unsure about this project, say so and read/search first — do not fill gaps from training data.",
    "Prefer a narrow, verified answer over a speculative comprehensive one.",
    "Use at most the few skills directly required for this task.",
  ],
};

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

function sessionSizeLevel(transcriptPath) {
  if (!transcriptPath) {
    return "ok";
  }
  let size;
  try {
    size = fs.statSync(transcriptPath).size;
  } catch {
    return "ok";
  }
  if (size >= CRITICAL_BYTES) {
    return "critical";
  }
  if (size >= WARN_BYTES) {
    return "warn";
  }
  return "ok";
}

function escalateLevel(base, steps) {
  const idx = LEVEL_ORDER.indexOf(base);
  if (idx < 0) {
    return "balanced";
  }
  return LEVEL_ORDER[Math.min(LEVEL_ORDER.length - 1, idx + steps)];
}

function effectiveLevel(config, sizeLevel) {
  if (!config.enabled || !config.autoEscalateOnSessionSize || sizeLevel === "ok") {
    return config.level;
  }
  if (sizeLevel === "critical") {
    return "strict-local";
  }
  return escalateLevel(config.level, 1);
}

function countInstalledSkills(cwd) {
  const skillsDir = path.join(cwd, ".claude", "skills");
  try {
    return fs.readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
  } catch {
    return 0;
  }
}

function shouldInject(config, sessionId, cwd, sizeLevel) {
  if (!config.enabled) {
    return false;
  }
  if (config.injectEveryPrompt) {
    return true;
  }
  if (sizeLevel === "warn" || sizeLevel === "critical") {
    return true;
  }
  if (!sessionId || !cwd) {
    return true;
  }
  const stateFile = path.join(cwd, ".claude", "learning", "context-focus-state.json");
  const state = readJsonSafe(stateFile, {});
  if (state[sessionId]) {
    return false;
  }
  state[sessionId] = true;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", "utf-8");
  } catch {
    // non-fatal
  }
  return true;
}

function buildContext(config, level, cwd, sizeLevel) {
  const lines = [...(INSTRUCTIONS[level] ?? INSTRUCTIONS.balanced)];

  if (config.limitSkillCatalogHints && (level === "local-first" || level === "strict-local")) {
    const skillCount = countInstalledSkills(cwd);
    const threshold = config.manySkillsThreshold ?? 12;
    if (skillCount >= threshold) {
      lines.push(
        `This workspace has ${skillCount} installed skills — context is bounded. Do not assume all skill instructions are loaded; pick only what this task needs.`
      );
    }
  }

  if (sizeLevel === "warn" || sizeLevel === "critical") {
    lines.push(
      "Session transcript is large — prioritize verified local sources over memory of earlier turns."
    );
  }

  return lines.join("\n");
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
  const sessionId = resolveSessionId(input);
  const transcriptPath = input.transcript_path;
  if (!cwd) {
    return;
  }

  const config = { ...DEFAULT_CONFIG, ...readJsonSafe(CONFIG_PATH, {}) };
  const sizeLevel = sessionSizeLevel(transcriptPath);

  if (!shouldInject(config, sessionId, cwd, sizeLevel)) {
    return;
  }

  const level = effectiveLevel(config, sizeLevel);
  const context = buildContext(config, level, cwd, sizeLevel);

  writePromptOutput(context, platform, "hookSpecificOutput");
}

main();
