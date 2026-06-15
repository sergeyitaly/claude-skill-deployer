#!/usr/bin/env node
// Shifts agent behavior from theoretical advice toward concrete deployment guidance.
// Config from ~/.claude/learning/practical-focus.json (synced by VS Code extension).

const fs = require("fs");
const path = require("path");
const os = require("os");
const { readStdin, parsePlatform, resolveCwd, resolveSessionId, writePromptOutput } = require("./hookPlatform");

const CONFIG_PATH =
  process.env.CLAUDE_SKILLS_PRACTICAL_FOCUS_CONFIG ||
  path.join(os.homedir(), ".claude", "learning", "practical-focus.json");

const DEFAULT_CONFIG = {
  enabled: false,
  level: "architecture-first",
  injectEveryPrompt: true,
  recommendDeploymentSkill: true,
  requireValidationSteps: true,
};

const INSTRUCTIONS = {
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

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

function detectInfraSignals(cwd) {
  const signals = [];
  const checks = [
    ["Terraform", () => globExists(cwd, (p) => p.endsWith(".tf"))],
    ["bicep", () => globExists(cwd, (p) => p.endsWith(".bicep"))],
    ["azure.yaml/azd", () => fileExists(path.join(cwd, "azure.yaml")) || fileExists(path.join(cwd, "azure.yml"))],
    ["Docker", () => fileExists(path.join(cwd, "Dockerfile")) || globExists(cwd, (p) => p.startsWith("Dockerfile."))],
    ["GitLab CI", () => fileExists(path.join(cwd, ".gitlab-ci.yml"))],
    ["GitHub Actions", () => dirHasFiles(path.join(cwd, ".github", "workflows"))],
    ["Kubernetes", () => globExists(cwd, (p) => p.includes("k8s") || (p.endsWith(".yaml") && p.includes("deployment")))],
  ];
  for (const [label, fn] of checks) {
    try {
      if (fn()) {
        signals.push(label);
      }
    } catch {
      // ignore
    }
  }
  return signals;
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function dirHasFiles(dir) {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function globExists(cwd, matchFn, maxDepth = 4) {
  function walk(dir, depth) {
    if (depth > maxDepth) {
      return false;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const ent of entries) {
      if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "skills_library") {
        continue;
      }
      const full = path.join(dir, ent.name);
      const rel = path.relative(cwd, full).replace(/\\/g, "/");
      if (ent.isFile() && matchFn(rel, ent.name)) {
        return true;
      }
      if (ent.isDirectory() && walk(full, depth + 1)) {
        return true;
      }
    }
    return false;
  }
  return walk(cwd, 0);
}

function shouldInject(config, sessionId, cwd) {
  if (!config.enabled) {
    return false;
  }
  if (config.injectEveryPrompt) {
    return true;
  }
  if (!sessionId || !cwd) {
    return true;
  }
  const stateFile = path.join(cwd, ".claude", "learning", "practical-focus-state.json");
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

function buildContext(config, level, cwd) {
  const lines = [...(INSTRUCTIONS[level] ?? INSTRUCTIONS.balanced)];

  const signals = detectInfraSignals(cwd);
  if (signals.length > 0 && (level === "architecture-first" || level === "deploy-ready")) {
    lines.push(`Detected deployment context in repo: ${signals.join(", ")}. Anchor advice to these mechanisms.`);
  }

  if (
    config.recommendDeploymentSkill &&
    (level === "architecture-first" || level === "deploy-ready")
  ) {
    lines.push(
      "If not already loaded, read the deployment-practical skill for the full first-try deployment checklist."
    );
  }

  if (config.requireValidationSteps && level === "deploy-ready") {
    lines.push(
      "Do not mark deployment tasks complete until validation commands have been run or the user confirms they ran them."
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
  if (!cwd) {
    return;
  }

  const config = { ...DEFAULT_CONFIG, ...readJsonSafe(CONFIG_PATH, {}) };
  if (!shouldInject(config, sessionId, cwd)) {
    return;
  }

  const level = config.level;
  const context = buildContext(config, level, cwd);

  writePromptOutput(context, platform, "hookSpecificOutput");
}

main();
