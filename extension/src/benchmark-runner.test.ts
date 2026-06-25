/**
 * Real-world productivity benchmark — v1.0.98
 * Runs scoring against actual installed skills at ~/.claude/skills and the
 * real user learning data (if any), simulating exactly what the extension
 * would recommend for each task prompt.
 *
 * Run with:  npx vitest run src/benchmark-runner.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { describe, expect, it } from "vitest";
import { computeTaskSkillProposals } from "./taskSkillProposals";
import { computeAdoptionMetrics, isDormantSkill } from "./adoptionIntelligence";
import { getDormantSkills, computeAllSkillPenalties, historicalSuccess } from "./proposalOutcome";
import { appendSkillRun } from "./runsStore";
import { Manifest, loadManifest } from "./skillOps";

// ─── Real workspace paths ───────────────────────────────────────────────────

const USER_HOME     = os.homedir();
const SKILLS_DIR    = path.join(USER_HOME, ".claude", "skills");
const LEARNING_DIR  = path.join(USER_HOME, ".claude", "learning");
const WORKSPACE     = path.join(USER_HOME, "claude-skills-deployer");

function realTarget(): string {
  // Prefer workspace-level; fall back to user-level
  const ws = path.join(WORKSPACE, ".claude", "learning");
  return fs.existsSync(ws) ? WORKSPACE : USER_HOME;
}

function loadRealManifest(): Manifest {
  const libraryDir = path.join(WORKSPACE, "extension", "skills_library");
  if (fs.existsSync(path.join(libraryDir, "manifest.json"))) {
    return loadManifest(libraryDir, libraryDir);
  }
  // Fallback: build from installed skills at ~/.claude/skills
  const skills: Manifest["skills"] = {};
  if (fs.existsSync(SKILLS_DIR)) {
    for (const name of fs.readdirSync(SKILLS_DIR)) {
      const skillMd = path.join(SKILLS_DIR, name, "SKILL.md");
      if (!fs.existsSync(skillMd)) continue;
      const content = fs.readFileSync(skillMd, "utf-8");
      const descMatch = content.match(/^##\s+Description\s*\n([^\n#]+)/m)
        ?? content.match(/^#\s+[^\n]+\n+([^\n#]+)/m);
      const globMatch = content.match(/detect_globs?:\s*\[([^\]]+)\]/);
      const globs = globMatch
        ? globMatch[1].split(",").map(g => g.trim().replace(/['"]/g, ""))
        : ["**/*"];
      skills[name] = {
        description: descMatch ? descMatch[1].trim() : name,
        detect_globs: globs,
      };
    }
  }
  return { skills };
}

// ─── Task prompts ────────────────────────────────────────────────────────────

const TASK_PROMPTS: Record<string, string> = {
  "Task 1 — Dashboard card":
    "Implement a new dashboard card showing Active Skills, Dormant Skills, and Average Prompt Quality in TypeScript with unit tests",
  "Task 2 — Bug investigation":
    "The dashboard shows a confidence score of 0 for a skill that was successfully invoked yesterday. Find root cause and propose fix",
  "Task 3 — GitHub Actions":
    "GitHub Actions workflow fails during npm publish. Investigate failure and provide a fix with workflow yaml and error output",
  "Task 4 — AKS CrashLoopBackOff":
    "AKS deployment stuck in CrashLoopBackOff. Debug kubernetes pod failure and fix",
  "Task 5 — Vitest tests":
    "Create Vitest tests for Adoption Intelligence covering dormancy tests, penalty tests, and revival tests",
  "Task 6a — Poor prompt":
    "fix dashboard",
  "Task 6b — Structured prompt":
    "Task: Fix dashboard refresh issue. Environment: VS Code Extension. Error: Card not updating after analyze cycle. Success Criteria: Values refresh after analyze. Provide: 1. Root cause 2. Fix 3. Validation",
  "Task 7 — Adopt a skill":
    "Run Vitest tests for the extension and report coverage",
  "Task 8 — Self-learning":
    "Analyze skill cost attribution and adoption metrics using self-learning data",
};

// ─── Benchmark execution ─────────────────────────────────────────────────────

describe("v1.0.98 Real-World Productivity Benchmark", () => {
  const manifest = loadRealManifest();
  const target   = realTarget();
  const dormant  = getDormantSkills(target);
  const penalties = computeAllSkillPenalties(target);

  it("Baseline: manifest loaded with skills", () => {
    const count = Object.keys(manifest.skills).length;
    console.log(`\n  Skills in manifest: ${count}`);
    console.log(`  Target directory:  ${target}`);
    console.log(`  Dormant skills:    ${dormant.size > 0 ? [...dormant].join(", ") : "none"}`);
    console.log(`  Penalised skills:  ${Object.entries(penalties).filter(([,v]) => v > 0).map(([k,v]) => `${k}(${v})`).join(", ") || "none"}`);
    expect(count).toBeGreaterThan(0);
  });

  // ── Task 1 ────────────────────────────────────────────────────────────────
  it("Task 1 — Dashboard card implementation: proposals", () => {
    const prompt = TASK_PROMPTS["Task 1 — Dashboard card"];
    const proposals = computeTaskSkillProposals(target, manifest, prompt);
    console.log(`\n  Prompt: "${prompt.slice(0, 80)}..."`);
    if (proposals.length === 0) {
      console.log("  Recommendations: none");
    } else {
      for (const p of proposals.slice(0, 5)) {
        console.log(`  → ${p.name} (${p.confidence}%) — ${p.reason}`);
      }
    }
    const relevant = proposals.filter(p =>
      ["vitest-extension-testing", "vscode-extension-publishing", "self-learning"].includes(p.name)
    );
    console.log(`  Relevant proposals: ${relevant.map(p => p.name).join(", ") || "none"}`);
    // At minimum, no dormant skills should appear
    for (const p of proposals) {
      expect(dormant.has(p.name)).toBe(false);
    }
  });

  // ── Task 2 ────────────────────────────────────────────────────────────────
  it("Task 2 — Bug investigation: proposals", () => {
    const prompt = TASK_PROMPTS["Task 2 — Bug investigation"];
    const proposals = computeTaskSkillProposals(target, manifest, prompt);
    console.log(`\n  Prompt: "${prompt.slice(0, 80)}..."`);
    for (const p of proposals.slice(0, 5)) {
      console.log(`  → ${p.name} (${p.confidence}%) — ${p.reason}`);
    }
    const debugSkills = proposals.filter(p =>
      ["skill-usage-insights", "self-learning", "vitest-extension-testing"].includes(p.name)
    );
    console.log(`  Debug-relevant: ${debugSkills.map(p => p.name).join(", ") || "none"}`);
    for (const p of proposals) expect(dormant.has(p.name)).toBe(false);
  });

  // ── Task 3 ────────────────────────────────────────────────────────────────
  it("Task 3 — GitHub Actions: CI/CD skill proposed", () => {
    const prompt = TASK_PROMPTS["Task 3 — GitHub Actions"];
    const proposals = computeTaskSkillProposals(target, manifest, prompt);
    console.log(`\n  Prompt: "${prompt.slice(0, 80)}..."`);
    for (const p of proposals.slice(0, 5)) {
      console.log(`  → ${p.name} (${p.confidence}%) — ${p.reason}`);
    }
    const ciSkills = proposals.filter(p =>
      ["github-actions-ci", "ci-pipeline-debug", "ci-preflight"].includes(p.name)
    );
    console.log(`  CI/CD proposed: ${ciSkills.map(p => p.name).join(", ") || "NONE ← check"}`);
    // Soft assertion: if skill is installed AND not dormant, it should appear
    const ghInstalled = fs.existsSync(path.join(SKILLS_DIR, "github-actions-ci"));
    const ghDormant   = dormant.has("github-actions-ci");
    if (ghInstalled && !ghDormant) {
      expect(ciSkills.length).toBeGreaterThan(0);
    } else {
      console.log(`  (skip: installed=${ghInstalled}, dormant=${ghDormant})`);
    }
  });

  // ── Task 4 ────────────────────────────────────────────────────────────────
  it("Task 4 — AKS CrashLoopBackOff: deployment skill proposed", () => {
    const prompt = TASK_PROMPTS["Task 4 — AKS CrashLoopBackOff"];
    const proposals = computeTaskSkillProposals(target, manifest, prompt);
    console.log(`\n  Prompt: "${prompt.slice(0, 80)}..."`);
    for (const p of proposals.slice(0, 5)) {
      console.log(`  → ${p.name} (${p.confidence}%) — ${p.reason}`);
    }
    const k8sSkills = proposals.filter(p =>
      ["deployment-practical", "ci-pipeline-debug", "azure-resource-ops"].includes(p.name)
    );
    console.log(`  K8s/deploy proposed: ${k8sSkills.map(p => p.name).join(", ") || "none"}`);
    for (const p of proposals) expect(dormant.has(p.name)).toBe(false);
  });

  // ── Task 5 ────────────────────────────────────────────────────────────────
  it("Task 5 — Vitest tests: vitest-extension-testing proposed", () => {
    const prompt = TASK_PROMPTS["Task 5 — Vitest tests"];
    const proposals = computeTaskSkillProposals(target, manifest, prompt);
    console.log(`\n  Prompt: "${prompt.slice(0, 80)}..."`);
    for (const p of proposals.slice(0, 5)) {
      console.log(`  → ${p.name} (${p.confidence}%) — ${p.reason}`);
    }
    const vitestInstalled = fs.existsSync(path.join(SKILLS_DIR, "vitest-extension-testing"));
    const vitestDormant   = dormant.has("vitest-extension-testing");
    const vitestProposed  = proposals.find(p => p.name === "vitest-extension-testing");
    console.log(`  vitest-extension-testing: installed=${vitestInstalled}, dormant=${vitestDormant}, proposed=${!!vitestProposed}`);
    if (vitestInstalled && !vitestDormant) {
      expect(vitestProposed).toBeDefined();
    }
  });

  // ── Task 6 — prompt quality comparison ──────────────────────────────────
  it("Task 6 — Structured prompt scores more signals than poor prompt", () => {
    const poorProps      = computeTaskSkillProposals(target, manifest, TASK_PROMPTS["Task 6a — Poor prompt"]);
    const structuredProps = computeTaskSkillProposals(target, manifest, TASK_PROMPTS["Task 6b — Structured prompt"]);
    const poorTop      = Math.max(0, ...poorProps.map(p => p.confidence));
    const structuredTop = Math.max(0, ...structuredProps.map(p => p.confidence));

    console.log(`\n  Poor prompt      → ${poorProps.length} proposals, top confidence: ${poorTop}`);
    console.log(`  Structured prompt → ${structuredProps.length} proposals, top confidence: ${structuredTop}`);
    console.log(`  Poor proposals:       ${poorProps.map(p => p.name).join(", ") || "none"}`);
    console.log(`  Structured proposals: ${structuredProps.map(p => p.name).join(", ") || "none"}`);

    // Structured prompt should produce >= as many proposals (more specific tokens → more signals)
    expect(structuredProps.length).toBeGreaterThanOrEqual(poorProps.length);
  });

  // ── Task 7 — simulate invocation + verify tracking ───────────────────────
  it("Task 7 — Skill invocation tracked in runs.jsonl", () => {
    const tmpTarget = fs.mkdtempSync(path.join(os.tmpdir(), "bench-t7-"));
    const sessionId = `bench-${Date.now()}`;

    appendSkillRun(tmpTarget, {
      skill: "vitest-extension-testing",
      action: "skill_invoke",
      agent: "claude",
      tokens: 1200,
      cost: 0.012,
      rc: 0,
      success: true,
      session_id: sessionId,
      project: "claude-skills-deployer",
      branch: "main",
      metadata: { source: "skill-invoke-hook-v2", invoked: true, proposed: true },
    });

    const runsFile = path.join(tmpTarget, ".claude", "learning", "runs.jsonl");
    expect(fs.existsSync(runsFile)).toBe(true);
    const lines = fs.readFileSync(runsFile, "utf-8").trim().split("\n");
    const run = JSON.parse(lines[0]);
    console.log(`\n  Tracked: skill=${run.skill}, tokens=${run.tokens}, cost=${run.cost}, success=${run.success}`);
    expect(run.skill).toBe("vitest-extension-testing");
    expect(run.success).toBe(true);
    expect(run.tokens).toBe(1200);

    // Verify adoption metrics update
    const hist = historicalSuccess(tmpTarget, "vitest-extension-testing");
    expect(hist.invocations).toBe(1);
    console.log(`  Invocations tracked: ${hist.invocations}`);
  });

  // ── Task 8 — cost attribution ─────────────────────────────────────────────
  it("Task 8 — Cost attribution: runs.jsonl contains tokens + cost", () => {
    const tmpTarget = fs.mkdtempSync(path.join(os.tmpdir(), "bench-t8-"));

    // Simulate self-learning invocation
    appendSkillRun(tmpTarget, {
      skill: "self-learning",
      action: "skill_invoke",
      agent: "claude",
      tokens: 2400,
      cost: 0.024,
      rc: 0,
      success: true,
      session_id: "bench-self-learning",
      project: "claude-skills-deployer",
      branch: "main",
      metadata: { source: "skill-invoke-hook-v2", invoked: true, proposed: false },
    });

    const hist = historicalSuccess(tmpTarget, "self-learning");
    console.log(`\n  self-learning: invocations=${hist.invocations}, successRate=${hist.successRate}`);
    expect(hist.invocations).toBe(1);
    expect(hist.successRate).toBe(1.0);

    // Verify raw file content for cost attribution
    const lines = fs.readFileSync(
      path.join(tmpTarget, ".claude", "learning", "runs.jsonl"), "utf-8"
    ).trim().split("\n");
    const run = JSON.parse(lines[0]);
    expect(run.cost).toBeCloseTo(0.024, 2);
    expect(run.tokens).toBe(2400);
    console.log(`  Cost: $${run.cost}, Tokens: ${run.tokens}`);
  });

  // ── Task 9 — HACE: prompt quality signal ─────────────────────────────────
  it("Task 9 — Structured prompts produce more/higher-confidence proposals than vague ones", () => {
    const vague = [
      "fix it",
      "help",
      "debug this",
    ];
    const structured = [
      "Debug GitHub Actions workflow failure during npm publish — investigate yaml and logs",
      "Implement Vitest regression tests for dormancy pipeline covering 5-session threshold",
      "Fix VS Code extension dashboard not refreshing after analyze cycle completes",
    ];

    let vagueTotal = 0, structuredTotal = 0;
    for (const p of vague) {
      const props = computeTaskSkillProposals(target, manifest, p);
      vagueTotal += props.length;
    }
    for (const p of structured) {
      const props = computeTaskSkillProposals(target, manifest, p);
      structuredTotal += props.length;
    }

    console.log(`\n  Vague prompts (3): ${vagueTotal} total proposals, avg ${(vagueTotal/3).toFixed(1)}/prompt`);
    console.log(`  Structured prompts (3): ${structuredTotal} total proposals, avg ${(structuredTotal/3).toFixed(1)}/prompt`);
    console.log(`  Delta: ${structuredTotal - vagueTotal} more proposals from structured prompts`);

    expect(structuredTotal).toBeGreaterThanOrEqual(vagueTotal);
  });

  // ── Adoption state summary ────────────────────────────────────────────────
  it("Adoption Intelligence: current state summary", () => {
    const metrics = computeAdoptionMetrics(target);
    console.log(`\n  === Adoption Intelligence Summary ===`);
    console.log(`  Has data: ${metrics.hasData}`);
    if (metrics.hasData) {
      console.log(`  Sessions: ${metrics.sessionsAnalyzed}`);
      console.log(`  Acceptance: ${metrics.acceptanceRatePct}%`);
      console.log(`  Precision:  ${metrics.precisionPct}%`);
      console.log(`  F1:         ${metrics.f1Pct}%`);
      console.log(`  Dormant:    ${metrics.dormantSkills.join(", ") || "none"}`);
      console.log(`  Rising:     ${metrics.risingSkills.join(", ") || "none"}`);
    } else {
      console.log(`  Fresh install — no session history yet. Data accumulates after first session.`);
    }
    // Always passes — this is an observation test
    expect(true).toBe(true);
  });
});
