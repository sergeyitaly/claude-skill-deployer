/**
 * Feature Benchmark — v1.0.102
 *
 * Practical pass/fail tests for 6 core extension features.
 * All tests call real code against real workspace data or real function inputs.
 * No mocked state, no arithmetic-only assertions, no simulated time overrides.
 *
 * Run: npx vitest run src/features.bench.test.ts
 */

import * as fs   from "node:fs";
import * as path from "node:path";
import * as os   from "node:os";
import { describe, it, expect, beforeAll } from "vitest";

import { analyzePrompt }                                         from "./promptIntelligence";
import { appendRecommendationFeedback, getSuppressedByFeedback,
         getDormantSkills, historicalSuccess }                   from "./proposalOutcome";
import { appendSkillRun }                                        from "./runsStore";
import { recordAdviceShown }                                     from "./coachingLearning";
import { computeTaskSkillProposals }                             from "./taskSkillProposals";
import { Manifest, loadManifest }                                from "./skillOps";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function realTarget(): string {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, ".claude", "learning"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

function loadRealManifest(): Manifest {
  const libraryDir = path.resolve(__dirname, "..", "skills_library");
  if (fs.existsSync(path.join(libraryDir, "manifest.json")))
    return loadManifest(libraryDir, libraryDir);
  return loadManifest(
    path.join(os.homedir(), ".claude", "skills"),
    path.join(os.homedir(), ".claude", "skills"),
  );
}

const VAGUE_PROMPT      = "fix it";
const MULTI_GOAL_PROMPT = "fix the dashboard, update the CI pipeline, refactor authentication, and also add new tests";
const STRUCTURED_PROMPT = `Task: Fix External Secrets synchronization failure
Environment: AKS cluster, Kubernetes 1.29, external-secrets v0.9
Component: ExternalSecret CRD
Error: SecretSyncedError — provider key not found in vault
Current behavior: Secret never syncs, status shows "NotReady"
Expected behavior: Secret syncs within 60s after vault key is restored
Success criteria: kubectl get externalsecret shows "Ready=True"
Constraints: must not restart the operator pod`;

const VITEST_PROMPT = `Run Vitest tests for the extension's Adoption Intelligence module.
Report coverage and list any failing tests.`;

// ---------------------------------------------------------------------------
// Suite 1 — Prompt Intelligence Scoring
// ---------------------------------------------------------------------------

describe("Suite 1 — Prompt Intelligence Scoring", () => {
  it("vague prompt scores below 30", () => {
    const result = analyzePrompt(VAGUE_PROMPT, "bench-s1", 2);
    console.log(`  Vague prompt score: ${result.score}/100`);
    expect(result.score).toBeLessThan(30);
  });

  it("multi-goal prompt (4 goals) scores below 40 and fires high-severity multi_goal anti-pattern", () => {
    const result = analyzePrompt(MULTI_GOAL_PROMPT, "bench-s1", 2);
    const mg = result.antiPatterns.find(ap => ap.type === "multi_goal");
    console.log(`  Multi-goal score: ${result.score}/100  anti-patterns: ${result.antiPatterns.map(a => a.type).join(", ")}`);
    expect(result.score).toBeLessThan(40);
    expect(mg).toBeDefined();
    expect(mg?.severity).toBe("high");
  });

  it("structured prompt scores above 65", () => {
    const result = analyzePrompt(STRUCTURED_PROMPT, "bench-s1", 2);
    console.log(`  Structured prompt score: ${result.score}/100  strengths: ${result.strengths.join(", ")}`);
    expect(result.score).toBeGreaterThan(65);
  });

  it("structured prompt scores at least 40 pts higher than vague prompt", () => {
    const vague      = analyzePrompt(VAGUE_PROMPT,      "bench-s1", 2);
    const structured = analyzePrompt(STRUCTURED_PROMPT, "bench-s1", 2);
    const delta = structured.score - vague.score;
    console.log(`  Score delta (structured − vague): +${delta} pts`);
    expect(delta).toBeGreaterThanOrEqual(40);
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Skill Recommendation Engine (real workspace + manifest)
// ---------------------------------------------------------------------------

describe("Suite 2 — Skill Recommendation Engine", () => {
  let manifest: Manifest;
  let target: string;
  let dormant: Set<string>;

  beforeAll(() => {
    manifest = loadRealManifest();
    target   = realTarget();
    dormant  = getDormantSkills(target);
  });

  it("vague 'fix it' prompt returns no proposal above confidence 70", () => {
    const props    = computeTaskSkillProposals(target, manifest, VAGUE_PROMPT);
    const highConf = props.filter(p => p.confidence >= 70);
    console.log(`  High-confidence proposals for vague prompt: ${highConf.map(p => `${p.name}(${p.confidence})`).join(", ") || "none"}`);
    expect(highConf.length).toBe(0);
  });

  it("vitest prompt surfaces vitest-extension-testing when installed and not dormant", () => {
    const props    = computeTaskSkillProposals(target, manifest, VITEST_PROMPT);
    const hasSkill = manifest.skills["vitest-extension-testing"] !== undefined;
    const isDorm   = dormant.has("vitest-extension-testing");
    console.log(`  vitest installed=${hasSkill}  dormant=${isDorm}  proposals: ${props.map(p => p.name).join(", ")}`);
    if (hasSkill && !isDorm) {
      const hit = props.find(p => p.name === "vitest-extension-testing");
      expect(hit).toBeDefined();
      expect(hit?.confidence).toBeGreaterThanOrEqual(70);
    }
  });

  it("no dormant skill appears in any proposal output", () => {
    const prompts = [VITEST_PROMPT, STRUCTURED_PROMPT, MULTI_GOAL_PROMPT];
    for (const prompt of prompts) {
      for (const p of computeTaskSkillProposals(target, manifest, prompt)) {
        expect(dormant.has(p.name)).toBe(false);
      }
    }
    console.log(`  Dormant skill count: ${dormant.size}. None appeared across 3 prompt types.`);
  });

  it("proposals are returned in descending confidence order with confidence > 0", () => {
    const props = computeTaskSkillProposals(target, manifest, VITEST_PROMPT);
    for (let i = 1; i < props.length; i++) {
      expect(props[i].confidence).toBeLessThanOrEqual(props[i - 1].confidence);
    }
    for (const p of props) expect(p.confidence).toBeGreaterThan(0);
    const range = props.length
      ? `${Math.min(...props.map(p => p.confidence))}–${Math.max(...props.map(p => p.confidence))}`
      : "no proposals";
    console.log(`  ${props.length} proposal(s), confidence range: ${range}`);
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — False Positive Suppression (3-ignore fast-path)
// ---------------------------------------------------------------------------

describe("Suite 3 — False Positive Suppression", () => {
  it("exactly 3 ignores suppresses the skill", () => {
    const tmp = tmpDir("bench-s3-");
    for (let i = 0; i < 3; i++) {
      appendRecommendationFeedback(tmp, {
        ts: new Date().toISOString(), session_id: `s3-${i}`,
        skill: "deployment-practical", proposed: true, accepted: false, reason: "ignored",
      });
    }
    const suppressed = getSuppressedByFeedback(tmp);
    console.log(`  After 3 ignores — suppressed: ${[...suppressed].join(", ")}`);
    expect(suppressed.has("deployment-practical")).toBe(true);
  });

  it("suppressed skill is absent from computeTaskSkillProposals output", () => {
    const tmp = tmpDir("bench-s3-int-");
    for (let i = 0; i < 3; i++) {
      appendRecommendationFeedback(tmp, {
        ts: new Date().toISOString(), session_id: `s3-${i}`,
        skill: "vitest-extension-testing", proposed: true, accepted: false, reason: "ignored",
      });
    }
    const props = computeTaskSkillProposals(tmp, loadRealManifest(), VITEST_PROMPT);
    console.log(`  Proposals after suppression: ${props.map(p => p.name).join(", ") || "none"}`);
    expect(props.find(p => p.name === "vitest-extension-testing")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — Coaching: advice write path
// ---------------------------------------------------------------------------

describe("Suite 4 — Coaching Advice Write Path", () => {
  it("recordAdviceShown writes a typed event to coaching-events.jsonl", () => {
    const tmp        = tmpDir("bench-s4-");
    const shown      = recordAdviceShown(tmp, "promptClarity", 15, "Split multi-goal prompts.");
    const eventsFile = path.join(tmp, ".claude", "learning", "coaching-events.jsonl");
    expect(shown).toBe(true);
    expect(fs.existsSync(eventsFile)).toBe(true);
    const event = JSON.parse(fs.readFileSync(eventsFile, "utf-8").trim().split("\n")[0]);
    expect(event.type).toBe("advice_shown");
    expect(event.metric).toBe("promptClarity");
    expect(event.scoreBefore).toBe(15);
    console.log(`  Event: type=${event.type}, metric=${event.metric}, scoreBefore=${event.scoreBefore}`);
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — Cost Attribution (v2 hook runs)
// ---------------------------------------------------------------------------

describe("Suite 5 — Cost Attribution", () => {
  it("appendSkillRun persists skill, cost, tokens, success to runs.jsonl", () => {
    const tmp = tmpDir("bench-s5-");
    appendSkillRun(tmp, {
      skill: "vitest-extension-testing", action: "skill_invoke",
      tokens: 144_439, cost: 0.04762, success: true, session_id: "bench-sess-1",
      metadata: { source: "skill-invoke-hook-v2", invoked: true, proposed: true, proposal_confidence: 97 },
    });
    const run = JSON.parse(
      fs.readFileSync(path.join(tmp, ".claude", "learning", "runs.jsonl"), "utf-8").trim()
    );
    console.log(`  Persisted: skill=${run.skill}, cost=$${run.cost}, tokens=${run.tokens}, success=${run.success}`);
    expect(run.skill).toBe("vitest-extension-testing");
    expect(run.cost).toBeCloseTo(0.04762, 4);
    expect(run.tokens).toBe(144_439);
    expect(run.success).toBe(true);
  });

  it("historicalSuccess aggregates invocation count and success rate correctly", () => {
    const tmp = tmpDir("bench-s5b-");
    for (let i = 0; i < 3; i++) {
      appendSkillRun(tmp, {
        skill: "skill-feedback-adaptation", action: "skill_invoke",
        tokens: 50_000, cost: 0.064, success: i < 2,
        session_id: `bench-sess-${i}`,
        metadata: { source: "skill-invoke-hook-v2", invoked: true },
      });
    }
    const hist = historicalSuccess(tmp, "skill-feedback-adaptation");
    console.log(`  invocations=${hist.invocations}  successRate=${hist.successRate.toFixed(2)}`);
    expect(hist.invocations).toBe(3);
    expect(hist.successRate).toBeCloseTo(2 / 3, 1);
  });
});

// ---------------------------------------------------------------------------
// Suite 6 — HACE Formula Integrity (live workspace check)
// ---------------------------------------------------------------------------

describe("Suite 6 — HACE Formula Integrity", () => {
  it("promptClarityScore source is prompt-intelligence.jsonl avg (> 9, the old thinking-rate floor)", () => {
    const piFile = path.join(realTarget(), ".claude", "learning", "prompt-intelligence.jsonl");
    if (!fs.existsSync(piFile)) {
      console.log("  No prompt-intelligence.jsonl in workspace — skipping.");
      return;
    }
    const cutoff = Date.now() - 14 * 86_400_000;
    const scores = fs.readFileSync(piFile, "utf-8").split("\n")
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l) as { ts: string; score: number }; } catch { return null; } })
      .filter((r): r is { ts: string; score: number } => !!r && new Date(r.ts).getTime() > cutoff)
      .map(r => r.score);
    const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    console.log(`  PI records (14d): ${scores.length}  avg: ${avg?.toFixed(1) ?? "n/a"}/100`);
    if (avg !== null) expect(avg).toBeGreaterThan(9);
  });
});
