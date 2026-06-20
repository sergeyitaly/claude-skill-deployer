#!/usr/bin/env node
// Merged prompt-time hook: context grounding + practical focus + session size warning.
// Replaces context-focus-watch.js, practical-focus-watch.js, and session-size-watch.js.
// One composed message per UserPromptSubmit instead of three separate hook firings.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { sumTranscriptUsageCached, sumSessionRunsUsage, formatTokenCount, formatUsd } = require("./usageParse");
const { readStdin, parsePlatform, resolveCwd, resolveSessionId, writePromptOutput } = require("./hookPlatform");

// ─── Shared size thresholds ───────────────────────────────────────────────────
const WARN_BYTES = 4 * 1024 * 1024;
const CRITICAL_BYTES = 10 * 1024 * 1024;
const WARN_TOKENS = 100_000;
const CRITICAL_TOKENS = 200_000;
const PROJECTED_TOKEN_CEILING = 200_000;
const BLENDED_USD_PER_TOKEN = 0.000009;
const LEVEL_RANK = { ok: 0, warn: 1, critical: 2 };

// ─── Context Focus config & instructions ─────────────────────────────────────
const CF_CONFIG_PATH =
  process.env.CLAUDE_SKILLS_CONTEXT_FOCUS_CONFIG ||
  path.join(os.homedir(), ".claude", "learning", "context-focus.json");

const CF_DEFAULT = {
  enabled: true,
  level: "balanced",
  autoEscalateOnSessionSize: true,
  injectEveryPrompt: true,
  limitSkillCatalogHints: true,
  manySkillsThreshold: 12,
};

const CF_LEVEL_ORDER = ["knowledge", "balanced", "local-first", "strict-local"];

const CF_INSTRUCTIONS = {
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

// ─── Practical Focus config & instructions ────────────────────────────────────
const PF_CONFIG_PATH =
  process.env.CLAUDE_SKILLS_PRACTICAL_FOCUS_CONFIG ||
  path.join(os.homedir(), ".claude", "learning", "practical-focus.json");

const PF_DEFAULT = {
  enabled: false,
  level: "architecture-first",
  injectEveryPrompt: true,
  recommendDeploymentSkill: true,
  requireValidationSteps: true,
};

const PF_INSTRUCTIONS = {
  exploratory: [
    "Practical focus: EXPLORATORY.",
    "Trade-offs, options, and high-level theory are appropriate.",
    "Still note major deployment risks if the user mentions production or deploy.",
  ],
  balanced: [
    "Practical focus: BALANCED.",
    "Pair explanations with concrete next steps tied to this repository.",
    "Read existing infra/CI files before suggesting a new pattern.",
  ],
  "architecture-first": [
    "Practical focus: ARCHITECTURE-FIRST (not hand-wavy theory).",
    "Before advising, read this repo's IaC, CI/CD, and deployment docs (terraform/, .gitlab-ci.yml, azure.yaml, Dockerfile, etc.).",
    "Propose concrete architecture: resource names, modules, pipelines, and how they connect — aligned with patterns already in the repo.",
    "Avoid generic 'you could use X or Y' without picking the default for THIS project and stating why.",
    "Prefer provisioned infrastructure (Terraform/Bicep/ARM/pipelines) over prose-only recommendations.",
    "Call out first-deploy blockers: RBAC, quotas, region availability, secrets, backend state, and identity wiring.",
  ],
  "deploy-ready": [
    "Practical focus: DEPLOY-READY (must work on first attempt).",
    "Every recommendation must be executable: exact CLI/API commands, file paths, and prerequisite checks.",
    "Run or specify validation before claiming success: terraform fmt/validate/plan, npm test, docker build, az deployment group validate, CI preflight, etc.",
    "Include rollback or safe undo steps for destructive changes.",
    "Do not skip permission/identity setup — surface the exact role assignment or az command an admin must run.",
    "If something was tried before and failed, check .claude/learning/ and project docs for known fixes before retrying.",
    "Prefer proven project patterns over novel greenfield designs unless the user explicitly asks to redesign.",
  ],
};

// ─── Shared helpers ───────────────────────────────────────────────────────────
function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback ?? {};
  }
}

function writeJsonSafe(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf-8");
  } catch {
    // non-fatal
  }
}

// ─── Session size ─────────────────────────────────────────────────────────────
function levelForBytes(bytes) {
  if (bytes >= CRITICAL_BYTES) return "critical";
  if (bytes >= WARN_BYTES) return "warn";
  return "ok";
}

function levelForTokens(tokens) {
  if (tokens >= CRITICAL_TOKENS) return "critical";
  if (tokens >= WARN_TOKENS) return "warn";
  return "ok";
}

function resolveSessionUsage(transcriptPath, cwd, sessionId, sizeWatchCacheFile) {
  if (transcriptPath) {
    let size;
    try { size = fs.statSync(transcriptPath).size; } catch { return null; }
    const usage = sumTranscriptUsageCached(transcriptPath, sizeWatchCacheFile);
    if (usage.totalTokens > 0) {
      return { tokens: usage.totalTokens, cost: usage.totalCostUsd, level: levelForBytes(size) };
    }
    const tokens = Math.round(size / 4);
    return { tokens, cost: tokens * BLENDED_USD_PER_TOKEN, level: levelForBytes(size) };
  }
  const { totalTokens, totalCostUsd } = sumSessionRunsUsage(cwd, sessionId);
  if (totalTokens === 0) return null;
  return { tokens: totalTokens, cost: totalCostUsd, level: levelForTokens(totalTokens) };
}

function savingsHint(tokens, cost) {
  const projectedCost = PROJECTED_TOKEN_CEILING * BLENDED_USD_PER_TOKEN;
  const saveUsd = Math.max(0, projectedCost - cost);
  if (saveUsd < 0.01) return " /compact frees context; /clear resets completely.";
  return ` /compact now may save ~${formatUsd(saveUsd)} vs letting the session grow; /clear resets completely.`;
}

const MCP_OPTIMIZER_TIP =
  " For permanent context reduction across sessions: lazy-mcp (90%+ token cut via on-demand tool loading)," +
  " mcp-compressor from Atlassian Labs (70–97% schema compression for large MCP servers like GitHub/Jira)," +
  " or jmunch-mcp (efficient proxy for data-heavy MCP servers). Run \"Claude Skills: Setup MCP Context Optimizer\" in the VS Code command palette.";

function sessionSizeMessage(usage) {
  const suffix = ` Session at ${formatTokenCount(usage.tokens)} tokens (~${formatUsd(usage.cost)} est.).${savingsHint(usage.tokens, usage.cost)}`;
  if (usage.level === "critical") {
    return `[Claude Skills] This session's transcript is very large.${suffix}${MCP_OPTIMIZER_TIP}`;
  }
  return `[Claude Skills] This session's transcript is getting large.${suffix}`;
}

function checkSessionSizeEscalated(usage, cwd, sessionId) {
  if (!usage || (usage.level !== "warn" && usage.level !== "critical")) return false;
  const stateFile = path.join(cwd, ".claude", "learning", "session-watch.json");
  const state = readJsonSafe(stateFile, {});
  const previous = state[sessionId] || "ok";
  state[sessionId] = usage.level;
  const keys = Object.keys(state);
  const toWrite = keys.length > 50
    ? Object.fromEntries(keys.slice(-50).map((k) => [k, state[k]]))
    : state;
  writeJsonSafe(stateFile, toWrite);
  return LEVEL_RANK[usage.level] > LEVEL_RANK[previous];
}

// ─── Context Focus ────────────────────────────────────────────────────────────
function escalateLevel(base, steps) {
  const idx = CF_LEVEL_ORDER.indexOf(base);
  if (idx < 0) return "balanced";
  return CF_LEVEL_ORDER[Math.min(CF_LEVEL_ORDER.length - 1, idx + steps)];
}

function effectiveCfLevel(config, sizeLevel) {
  if (!config.enabled || !config.autoEscalateOnSessionSize || sizeLevel === "ok") {
    return config.level;
  }
  if (sizeLevel === "critical") return "strict-local";
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

function shouldCfInject(config, sessionId, cwd, sizeLevel) {
  if (!config.enabled) return false;
  if (config.injectEveryPrompt) return true;
  if (sizeLevel === "warn" || sizeLevel === "critical") return true;
  if (!sessionId || !cwd) return true;
  const stateFile = path.join(cwd, ".claude", "learning", "context-focus-state.json");
  const state = readJsonSafe(stateFile, {});
  if (state[sessionId]) return false;
  state[sessionId] = true;
  writeJsonSafe(stateFile, state);
  return true;
}

function buildCfContext(config, level, cwd, sizeLevel) {
  const lines = [...(CF_INSTRUCTIONS[level] ?? CF_INSTRUCTIONS.balanced)];
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
    lines.push("Session transcript is large — prioritize verified local sources over memory of earlier turns.");
  }
  return lines.join("\n");
}

// ─── Practical Focus ──────────────────────────────────────────────────────────
function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function dirHasFiles(dir) {
  try { return fs.readdirSync(dir).length > 0; } catch { return false; }
}

function globExists(cwd, matchFn, maxDepth = 4) {
  function walk(dir, depth) {
    if (depth > maxDepth) return false;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const ent of entries) {
      if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "skills_library") continue;
      const full = path.join(dir, ent.name);
      const rel = path.relative(cwd, full).replace(/\\/g, "/");
      if (ent.isFile() && matchFn(rel, ent.name)) return true;
      if (ent.isDirectory() && walk(full, depth + 1)) return true;
    }
    return false;
  }
  return walk(cwd, 0);
}

function detectInfraSignals(cwd) {
  const checks = [
    ["Terraform", () => globExists(cwd, (p) => p.endsWith(".tf"))],
    ["bicep", () => globExists(cwd, (p) => p.endsWith(".bicep"))],
    ["azure.yaml/azd", () => fileExists(path.join(cwd, "azure.yaml")) || fileExists(path.join(cwd, "azure.yml"))],
    ["Docker", () => fileExists(path.join(cwd, "Dockerfile")) || globExists(cwd, (p) => p.startsWith("Dockerfile."))],
    ["GitLab CI", () => fileExists(path.join(cwd, ".gitlab-ci.yml"))],
    ["GitHub Actions", () => dirHasFiles(path.join(cwd, ".github", "workflows"))],
    ["Kubernetes", () => globExists(cwd, (p) => p.includes("k8s") || (p.endsWith(".yaml") && p.includes("deployment")))],
  ];
  const signals = [];
  for (const [label, fn] of checks) {
    try { if (fn()) signals.push(label); } catch { /* ignore */ }
  }
  return signals;
}

function shouldPfInject(config, sessionId, cwd) {
  if (!config.enabled) return false;
  if (config.injectEveryPrompt) return true;
  if (!sessionId || !cwd) return true;
  const stateFile = path.join(cwd, ".claude", "learning", "practical-focus-state.json");
  const state = readJsonSafe(stateFile, {});
  if (state[sessionId]) return false;
  state[sessionId] = true;
  writeJsonSafe(stateFile, state);
  return true;
}

function buildPfContext(config, level, cwd) {
  const lines = [...(PF_INSTRUCTIONS[level] ?? PF_INSTRUCTIONS.balanced)];
  const signals = detectInfraSignals(cwd);
  if (signals.length > 0 && (level === "architecture-first" || level === "deploy-ready")) {
    lines.push(`Detected deployment context in repo: ${signals.join(", ")}. Anchor advice to these mechanisms.`);
  }
  if (config.recommendDeploymentSkill && (level === "architecture-first" || level === "deploy-ready")) {
    lines.push("If not already loaded, read the deployment-practical skill for the full first-try deployment checklist.");
  }
  if (config.requireValidationSteps && level === "deploy-ready") {
    lines.push("Do not mark deployment tasks complete until validation commands have been run or the user confirms they ran them.");
  }
  return lines.join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────
function main() {
  const platform = parsePlatform(process.argv);
  let input;
  try { input = JSON.parse(readStdin()); } catch { input = {}; }

  const cwd = resolveCwd(input, platform);
  const sessionId = resolveSessionId(input);
  const transcriptPath = input.transcript_path;

  if (!cwd) return;

  const sizeWatchCacheFile = path.join(cwd, ".claude", "learning", "session-watch-size.json");
  const usage = sessionId ? resolveSessionUsage(transcriptPath, cwd, sessionId, sizeWatchCacheFile) : null;
  const sizeLevel = usage?.level ?? "ok";

  const parts = [];

  // Session size warning (only when level escalates)
  if (sessionId && checkSessionSizeEscalated(usage, cwd, sessionId)) {
    parts.push(sessionSizeMessage(usage));
  }

  // Context focus grounding
  const cfConfig = { ...CF_DEFAULT, ...readJsonSafe(CF_CONFIG_PATH, {}) };
  if (shouldCfInject(cfConfig, sessionId, cwd, sizeLevel)) {
    const level = effectiveCfLevel(cfConfig, sizeLevel);
    parts.push(buildCfContext(cfConfig, level, cwd, sizeLevel));
  }

  // Practical focus
  const pfConfig = { ...PF_DEFAULT, ...readJsonSafe(PF_CONFIG_PATH, {}) };
  if (shouldPfInject(pfConfig, sessionId, cwd)) {
    parts.push(buildPfContext(pfConfig, pfConfig.level, cwd));
  }

  if (parts.length > 0) {
    writePromptOutput(parts.join("\n\n"), platform, "hookSpecificOutput");
  }
}

main();
