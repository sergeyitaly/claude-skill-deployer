/**
 * Complex agent-task harness (CI validate + ADX KQL schema) — used by complete-benchmark.mjs.
 *
 * Usage:
 *   node --require ./scripts/vscode-register.cjs scripts/agent-comparison.mjs [extDir] [libraryDir]
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveLibraryDir } from "./resolve-library-dir.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(scriptDir, "..");
const libraryDir = process.argv[3] ? path.resolve(process.argv[3]) : resolveLibraryDir(extensionDir);
const fixtureDir = path.join(scriptDir, "agent-comparison-fixture-complex");
const resultsDir = path.join(scriptDir, "agent-comparison-results");
const taskPrompt = fs.readFileSync(path.join(fixtureDir, "TASK.md"), "utf-8").trim();
const FOCUS_SKILLS = ["adx-schema-check", "ci-pipeline-debug", "ci-preflight"];
const SKILL_HINT =
  "Follow adx-schema-check to cross-check KQL against scripts/adx-schema-setup.kql, and ci-pipeline-debug to locate/reproduce the failing validate job.";

function loadModule(rel) {
  return import(pathToFileURL(path.join(extensionDir, "out", rel)).href);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function rmDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function estimateTokens(chars) {
  return Math.ceil((chars ?? 0) / 4);
}

function readIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
}

function collectInjectedContext(workspace) {
  const parts = [];
  const copilot = path.join(workspace, ".github", "copilot-instructions.md");
  if (fs.existsSync(copilot)) {
    parts.push({ kind: "copilot-bootstrap", chars: fs.readFileSync(copilot, "utf-8").length, path: copilot });
  }
  const instructionsDir = path.join(workspace, ".github", "instructions");
  if (fs.existsSync(instructionsDir)) {
    for (const f of fs.readdirSync(instructionsDir)) {
      if (!f.endsWith(".instructions.md")) continue;
      const p = path.join(instructionsDir, f);
      parts.push({
        kind: "copilot-instruction",
        skill: f.replace(/\.instructions\.md$/, ""),
        chars: fs.readFileSync(p, "utf-8").length,
        path: p,
      });
    }
  }
  const claudeSkills = path.join(workspace, ".claude", "skills");
  if (fs.existsSync(claudeSkills)) {
    for (const name of fs.readdirSync(claudeSkills)) {
      const skillMd = path.join(claudeSkills, name, "SKILL.md");
      if (fs.existsSync(skillMd)) {
        parts.push({ kind: "claude-skill", skill: name, chars: fs.readFileSync(skillMd, "utf-8").length, path: skillMd });
      }
    }
  }
  const proposals = path.join(workspace, ".claude", "learning", "task-skill-proposals.json");
  if (fs.existsSync(proposals)) {
    parts.push({ kind: "task-proposals", chars: fs.readFileSync(proposals, "utf-8").length, path: proposals });
  }
  return { parts, totalChars: parts.reduce((n, p) => n + p.chars, 0) };
}

function gradeComplexFixture(workspace) {
  const assertions = [];
  const add = (name, pass, detail) => assertions.push({ name, pass, detail });

  const schemaPath = path.join(workspace, "scripts", "adx-schema-setup.kql");
  const schema = fs.readFileSync(schemaPath, "utf-8");
  add("schema_unchanged", !/\bErrorLog\b/.test(schema), "canonical schema intact");

  const queryDir = path.join(workspace, "api", "queries");
  const kqlFiles = fs.readdirSync(queryDir).filter((f) => f.endsWith(".kql"));
  add("query_file_present", kqlFiles.length >= 1, `${kqlFiles.length} query file(s)`);

  let anyStale = false;
  for (const f of kqlFiles) {
    const body = fs.readFileSync(path.join(queryDir, f), "utf-8");
    if (/\bErrorLog\b/.test(body) || /\bErrorMessage\b/.test(body)) anyStale = true;
  }
  add("no_stale_names", !anyStale, "no ErrorLog/ErrorMessage in queries");

  const recent = path.join(queryDir, "recentErrors.kql");
  if (fs.existsSync(recent)) {
    const kql = fs.readFileSync(recent, "utf-8");
    add("uses_error_events", /^ErrorEvents\b/m.test(kql), "table is ErrorEvents");
    add("uses_message", /\bMessage\b/.test(kql), "column is Message");
  }

  const validate = spawnSync(process.execPath, [path.join(workspace, "scripts", "validate-kql.mjs")], {
    cwd: workspace,
    encoding: "utf-8",
  });
  add(
    "validate_passes",
    validate.status === 0,
    validate.status === 0 ? "validate-kql OK" : (validate.stderr || validate.stdout || "").trim().slice(0, 200)
  );

  const passed = assertions.filter((a) => a.pass).length;
  const score = Math.round((passed / assertions.length) * 100);
  return { pass: score >= 85 && assertions.find((a) => a.name === "validate_passes")?.pass, score, assertions };
}

async function callAnthropic({ system, user, model = "claude-haiku-4-5-20251001" }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const t0 = performance.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, max_tokens: 2048, system, messages: [{ role: "user", content: user }] }),
  });
  const elapsedMs = performance.now() - t0;
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = await res.json();
  const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const usage = data.usage ?? {};
  return {
    elapsedMs,
    text,
    tokens: {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      total: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    },
  };
}

async function prepareWorkspace(label, { withExtension }) {
  const root = path.join(os.tmpdir(), `claude-skills-complex-${label}-${crypto.randomBytes(4).toString("hex")}`);
  rmDir(root);
  copyDir(fixtureDir, root);

  const { loadManifest, detectRelevantSkills, copySkill, listSkillStatuses, setSkillOverride } =
    await loadModule("skillOps.js");
  const { syncWorkspaceSkillsToAllAgentsAsync, syncCopilotBootstrap } = await loadModule("agentOps.js");
  const { ensureWorkspaceTaskProposals } = await loadModule("taskSkillProposals.js");
  const { buildCopilotInstructionsFile } = await loadModule("copilotTransform.js");

  const manifest = loadManifest(libraryDir);
  const setup = { label, workspace: root, withExtension, timings: {}, context: null, proposals: null };

  if (!withExtension) {
    setup.timings.totalSetupMs = 0;
    setup.context = collectInjectedContext(root);
    return setup;
  }

  let t0 = performance.now();
  const detected = detectRelevantSkills(root, manifest);
  setup.timings.detectRelevantSkillsMs = performance.now() - t0;

  for (const name of FOCUS_SKILLS) {
    if (!manifest.skills[name]) continue;
    setSkillOverride(root, name, "on");
    const dstRoot = path.join(root, ".claude", "skills");
    fs.mkdirSync(dstRoot, { recursive: true });
    copySkill(name, libraryDir, dstRoot, true, false, { libraryDir });
    const githubDir = path.join(root, ".github", "instructions");
    fs.mkdirSync(githubDir, { recursive: true });
    const skillMd = path.join(libraryDir, name, "SKILL.md");
    const globs = manifest.skills[name]?.detect_globs ?? ["**/*"];
    fs.writeFileSync(
      path.join(githubDir, `${name}.instructions.md`),
      buildCopilotInstructionsFile(name, globs, skillMd),
      "utf-8"
    );
  }

  t0 = performance.now();
  await syncWorkspaceSkillsToAllAgentsAsync(libraryDir, root, { force: true, skillNames: FOCUS_SKILLS });
  setup.timings.syncAgentsMs = performance.now() - t0;

  t0 = performance.now();
  syncCopilotBootstrap(root, libraryDir);
  setup.timings.syncCopilotBootstrapMs = performance.now() - t0;

  t0 = performance.now();
  const proposalResult = ensureWorkspaceTaskProposals(root, manifest, taskPrompt);
  setup.timings.taskProposalsMs = performance.now() - t0;
  setup.proposals = proposalResult.file ?? null;
  setup.timings.totalSetupMs =
    (setup.timings.detectRelevantSkillsMs ?? 0) +
    (setup.timings.syncAgentsMs ?? 0) +
    (setup.timings.syncCopilotBootstrapMs ?? 0) +
    (setup.timings.taskProposalsMs ?? 0);

  setup.context = collectInjectedContext(root);
  setup.detected = detected;
  setup.enabledSkills = listSkillStatuses(libraryDir, root).filter((s) => s.effectiveEnabled).map((s) => s.name);
  return setup;
}

function buildBaselineSystemPrompt(workspace) {
  return [
    "You are a coding assistant debugging a failing CI validate job and fixing KQL schema mismatches.",
    "Fix files on disk; re-run node scripts/validate-kql.mjs to verify.",
    "",
    "Workflow:",
    "```yaml",
    readIfExists(path.join(workspace, ".github", "workflows", "validate.yml")),
    "```",
    "",
    "Schema source:",
    "```kql",
    readIfExists(path.join(workspace, "scripts", "adx-schema-setup.kql")),
    "```",
    "",
    "Broken query:",
    "```kql",
    readIfExists(path.join(workspace, "api", "queries", "recentErrors.kql")),
    "```",
  ].join("\n");
}

function buildWithExtensionSystemPrompt(workspace, context) {
  const skillParts = (context?.parts ?? [])
    .filter((p) => p.kind === "claude-skill" || p.kind === "copilot-instruction")
    .map((p) => `### ${p.skill ?? p.kind}\n${readIfExists(p.path)}`);
  return [
    buildBaselineSystemPrompt(workspace),
    "",
    "## Extension-deployed agent context",
    readIfExists(path.join(workspace, ".github", "copilot-instructions.md")),
    readIfExists(path.join(workspace, ".claude", "learning", "task-skill-proposals.json")),
    ...skillParts,
    "",
    SKILL_HINT,
  ].join("\n");
}

async function runArm(arm, setup) {
  const result = {
    arm,
    withExtension: setup.withExtension,
    workspace: setup.workspace,
    setupMs: setup.timings.totalSetupMs ?? 0,
    contextChars: setup.context?.totalChars ?? 0,
    contextTokensEst: estimateTokens(setup.context?.totalChars ?? 0),
    contextParts: setup.context?.parts ?? [],
    proposals: setup.proposals?.proposals?.slice(0, 5) ?? [],
    agentMs: null,
    tokens: null,
    grade: null,
    outputPreview: null,
  };

  const system = setup.withExtension
    ? buildWithExtensionSystemPrompt(setup.workspace, setup.context)
    : buildBaselineSystemPrompt(setup.workspace);
  result.systemChars = system.length;
  result.systemTokensEst = estimateTokens(system.length);

  const api = await callAnthropic({ system, user: taskPrompt });
  if (api) {
    result.agentMs = api.elapsedMs;
    result.tokens = api.tokens;
    result.outputPreview = api.text.slice(0, 500);
    result.grade = gradeComplexFixture(setup.workspace);
    result.apiModel = "claude-haiku-4-5-20251001";
  }
  return result;
}

function formatReport(report) {
  const a = report.arms.without;
  const b = report.arms.with;
  const row = (label, va, vb, fmt = String) => {
    const delta = typeof va === "number" && typeof vb === "number" ? vb - va : "—";
    const deltaStr = typeof delta === "number" ? (delta > 0 ? `+${fmt(delta)}` : fmt(delta)) : delta;
    return `| ${label} | ${fmt(va)} | ${fmt(vb)} | ${deltaStr} |`;
  };
  const lines = [
    "# Complex agent harness (CI + ADX schema)",
    "",
    `**Task:** ${taskPrompt.split("\n")[0]}`,
    `**Generated:** ${report.generatedAt}`,
    "",
    "| Metric | Without | With extension | Delta |",
    "|---|---:|---:|---:|",
    row("Setup (ms)", a.setupMs, b.setupMs, (n) => n.toFixed(1)),
    row("Context (chars)", a.contextChars, b.contextChars),
    row("Est. tokens", a.systemTokensEst, b.systemTokensEst),
  ];
  if (a.grade && b.grade) lines.push(row("Quality (%)", a.grade.score, b.grade.score));
  return lines.join("\n");
}

async function main() {
  if (!fs.existsSync(path.join(extensionDir, "out", "skillOps.js"))) {
    console.error("Extension not compiled. Run: cd extension && npm run compile");
    process.exit(1);
  }
  fs.mkdirSync(resultsDir, { recursive: true });

  console.log("=== Complex agent harness (CI + ADX schema) ===\n");
  const without = await prepareWorkspace("without", { withExtension: false });
  const withExt = await prepareWorkspace("with", { withExtension: true });

  const arms = { without: await runArm("without", without), with: await runArm("with", withExt) };
  if (!process.env.ANTHROPIC_API_KEY) {
    arms.without.grade = gradeComplexFixture(without.workspace);
    arms.with.grade = null;
    arms.without.grade.note = "broken fixture intentionally fails validation";
  }

  const report = {
    generatedAt: new Date().toISOString(),
    scenario: "complex",
    extensionDir,
    libraryDir,
    fixtureDir,
    taskPrompt,
    workspaces: { without: without.workspace, with: withExt.workspace },
    arms,
    apiUsed: Boolean(process.env.ANTHROPIC_API_KEY),
  };

  const stamp = `complex-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const jsonPath = path.join(resultsDir, `comparison-${stamp}.json`);
  const mdPath = path.join(resultsDir, `comparison-${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");
  fs.writeFileSync(mdPath, formatReport(report) + "\n");
  console.log(`Context: without ${without.context.totalChars} chars, with ${withExt.context.totalChars} chars`);
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
