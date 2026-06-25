/**
 * Skill Enrichment Intelligence — E2E Benchmark (Phase 10)
 *
 * Validates the full enrichment pipeline against real-world DevOps scenarios:
 *
 *   Task 1  — K3s cluster setup on AWS
 *   Task 2  — KubeRocketCI deployment
 *   Task 3  — ArgoCD installation + application sync
 *   Task 4  — Application deployment
 *   Task 5  — ArgoCD sync failure fix
 *   Task 6  — AKS CrashLoopBackOff
 *   Task 7  — Terraform state lock recovery
 *   Task 8  — GitHub Actions publish failure
 *
 * Each task verifies the full chain:
 *   skill used → success captured → pattern mined → enrichment candidate generated
 *
 * Run with: npx vitest run src/skill-enrichment-e2e.bench.test.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  detectSuccessfulRuns,
  mineSuccessfulRunPatterns,
  readSkillLearningEntries,
  computeProvenExamples,
  findEnrichmentCandidates,
  refreshSkillProfiles,
  getSkillEvolution,
  DEVOPS_PATTERNS,
  MIN_PATTERN_OCCURRENCES,
} from "./skillEnrichment";

import {
  generateEnrichmentProposals,
  approveEnrichmentProposal,
  applyEnrichmentProposal,
  readEnrichmentProposals,
} from "./skillEnrichmentProposal";

import { appendSkillRun } from "./runsStore";

// ── Helpers ───────────────────────────────────────────────────────────────────

function freshWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "enrich-e2e-"));
}

function simulateSuccess(
  target: string,
  skill: string,
  sessionId: string,
  taskKeywords: string
): void {
  appendSkillRun(target, {
    skill,
    agent: "claude",
    tokens: 12000 + Math.floor(Math.random() * 8000),
    cost: 0.12 + Math.random() * 0.08,
    success: true,
    session_id: sessionId,
    metadata: {
      source: "skill-invoke-hook-v2",
      invoked: true,
      proposed: true,
      outcome: "success",
      task_type: taskKeywords,
    },
  });
}

function assertPipelineChain(
  target: string,
  skill: string,
  expectedPatternId: string,
  label: string
): void {
  // Step 1: success captured
  const events = detectSuccessfulRuns(target).filter(e => e.skill === skill);
  console.log(`  [${label}] Successful runs captured: ${events.length}`);
  expect(events.length, `${label}: should have captured success events`).toBeGreaterThan(0);

  // Step 2: pattern mined
  mineSuccessfulRunPatterns(target);
  const entries = readSkillLearningEntries(target).filter(
    e => e.skill === skill && e.patternId === expectedPatternId
  );
  console.log(`  [${label}] Pattern entries mined (${expectedPatternId}): ${entries.length}`);
  expect(entries.length, `${label}: should have mined pattern entries`).toBeGreaterThan(0);

  // Step 3: proven examples aggregate
  const examples = computeProvenExamples(target, skill);
  const hit = examples.find(e => e.pattern === expectedPatternId);
  console.log(`  [${label}] Proven example: ${hit ? `${hit.occurrences}× (${Math.round(hit.successRate * 100)}% success)` : "none"}`);
  expect(hit, `${label}: proven example should exist`).toBeDefined();

  // Step 4: enrichment candidate (requires MIN_PATTERN_OCCURRENCES)
  const cands = findEnrichmentCandidates(target, [skill]);
  const cand  = cands.find(c => c.patternId === expectedPatternId);
  if ((hit?.occurrences ?? 0) >= MIN_PATTERN_OCCURRENCES) {
    console.log(`  [${label}] Enrichment candidate: "${cand?.sectionTitle ?? "NONE"}" (${Math.round((cand?.confidence ?? 0) * 100)}% confidence)`);
    expect(cand, `${label}: enrichment candidate should be created after ${MIN_PATTERN_OCCURRENCES}+ occurrences`).toBeDefined();
  } else {
    console.log(`  [${label}] Pattern count ${hit?.occurrences} < ${MIN_PATTERN_OCCURRENCES} threshold — no candidate yet (expected)`);
  }
}

// ── E2E Benchmark ─────────────────────────────────────────────────────────────

describe("Skill Enrichment E2E Benchmark — Phase 10", () => {

  // ── Task 1: K3s cluster setup on AWS ──────────────────────────────────────
  it("Task 1 — K3s cluster setup: success → pattern → candidate", () => {
    const target = freshWorkspace();
    const skill  = "deployment-practical";
    console.log("\n  === Task 1: K3s cluster setup on AWS ===");

    for (let i = 0; i < MIN_PATTERN_OCCURRENCES; i++) {
      simulateSuccess(target, skill, `k3s-task1-sess-${i}`,
        `k3s cluster install server agent node k3sup aws ec2`);
    }

    assertPipelineChain(target, skill, "k3s-cluster-setup", "Task 1");
    expect(true).toBe(true);
  });

  // ── Task 2: KubeRocketCI deployment ───────────────────────────────────────
  it("Task 2 — KubeRocketCI deployment: success → pattern → candidate", () => {
    const target = freshWorkspace();
    const skill  = "deployment-practical";
    console.log("\n  === Task 2: KubeRocketCI (KRCI/EDP) deployment ===");

    for (let i = 0; i < MIN_PATTERN_OCCURRENCES; i++) {
      simulateSuccess(target, skill, `krci-task2-sess-${i}`,
        `kuberocketci edp helm codebase pipelinerun tekton install`);
    }

    assertPipelineChain(target, skill, "kuberocketci-deploy", "Task 2");
  });

  // ── Task 3: ArgoCD installation ───────────────────────────────────────────
  it("Task 3 — ArgoCD install + application sync: success → pattern → candidate", () => {
    const target = freshWorkspace();
    const skill  = "deployment-practical";
    console.log("\n  === Task 3: ArgoCD install + application sync ===");

    for (let i = 0; i < MIN_PATTERN_OCCURRENCES; i++) {
      simulateSuccess(target, skill, `argocd-install-sess-${i}`,
        `argocd install sync application kubernetes`);
    }

    assertPipelineChain(target, skill, "argocd-sync-failure", "Task 3");
  });

  // ── Task 4: Application deployment (Helm) ─────────────────────────────────
  it("Task 4 — Application deployment via Helm: success → pattern → candidate", () => {
    const target = freshWorkspace();
    const skill  = "deployment-practical";
    console.log("\n  === Task 4: Application deployment (Helm) ===");

    for (let i = 0; i < MIN_PATTERN_OCCURRENCES; i++) {
      simulateSuccess(target, skill, `helm-deploy-sess-${i}`,
        `helm chart upgrade install release values.yaml namespace`);
    }

    assertPipelineChain(target, skill, "helm-deployment", "Task 4");
  });

  // ── Task 5: Fix ArgoCD sync failure ───────────────────────────────────────
  it("Task 5 — Fix ArgoCD sync failure: higher confidence with more sessions", () => {
    const target = freshWorkspace();
    const skill  = "deployment-practical";
    console.log("\n  === Task 5: ArgoCD sync failure fix ===");

    // 6 sessions — significantly above threshold
    for (let i = 0; i < 6; i++) {
      simulateSuccess(target, skill, `argocd-fix-sess-${i}`,
        `argocd sync failed out-of-sync application argo`);
    }
    mineSuccessfulRunPatterns(target);

    const cands = findEnrichmentCandidates(target, [skill]);
    const argocd = cands.find(c => c.patternId === "argocd-sync-failure");
    console.log(`  ArgoCD candidate: ${argocd ? `${argocd.occurrences} sessions, ${Math.round(argocd.confidence * 100)}% confidence` : "none"}`);
    expect(argocd).toBeDefined();
    expect(argocd!.occurrences).toBe(6);
    // Confidence grows with occurrences
    expect(argocd!.confidence).toBeGreaterThan(0.65);
    expect(argocd!.sectionTitle).toBe("ArgoCD Troubleshooting");
  });

  // ── Task 6: AKS CrashLoopBackOff ─────────────────────────────────────────
  it("Task 6 — AKS CrashLoopBackOff: success → pattern → candidate", () => {
    const target = freshWorkspace();
    const skill  = "deployment-practical";
    console.log("\n  === Task 6: AKS CrashLoopBackOff ===");

    for (let i = 0; i < MIN_PATTERN_OCCURRENCES; i++) {
      simulateSuccess(target, skill, `aks-crash-sess-${i}`,
        `aks azure kubernetes crashloop deployment rollout pod`);
    }

    assertPipelineChain(target, skill, "aks-deployment-rollout", "Task 6");
  });

  // ── Task 7: Terraform state lock ──────────────────────────────────────────
  it("Task 7 — Terraform state lock recovery: success → pattern → candidate", () => {
    const target = freshWorkspace();
    const skill  = "deployment-practical";
    console.log("\n  === Task 7: Terraform state lock ===");

    for (let i = 0; i < MIN_PATTERN_OCCURRENCES; i++) {
      simulateSuccess(target, skill, `tf-lock-sess-${i}`,
        `terraform state locked backend apply plan force-unlock`);
    }

    assertPipelineChain(target, skill, "terraform-state-lock", "Task 7");
  });

  // ── Task 8: GitHub Actions publish failure ────────────────────────────────
  it("Task 8 — GitHub Actions publish failure: success → pattern → candidate", () => {
    const target = freshWorkspace();
    const skill  = "ci-pipeline-debug";
    console.log("\n  === Task 8: GitHub Actions publish failure ===");

    for (let i = 0; i < MIN_PATTERN_OCCURRENCES; i++) {
      simulateSuccess(target, skill, `ghactions-sess-${i}`,
        `github actions workflow pipeline publish release runner`);
    }

    assertPipelineChain(target, skill, "github-actions-failure", "Task 8");
  });

  // ── Full pipeline integration ─────────────────────────────────────────────
  it("Full pipeline — proposal generated, approved, and applied to SKILL.md", () => {
    const target = freshWorkspace();
    const skill  = "deployment-practical";
    console.log("\n  === Full pipeline: ArgoCD enrichment proposal lifecycle ===");

    // Seed enough ArgoCD sessions
    for (let i = 0; i < MIN_PATTERN_OCCURRENCES + 1; i++) {
      simulateSuccess(target, skill, `full-pipe-sess-${i}`,
        `argocd sync application failed out-of-sync`);
    }

    // Mine patterns
    const mined = mineSuccessfulRunPatterns(target);
    console.log(`  Mined entries: ${mined}`);
    expect(mined).toBeGreaterThan(0);

    // Find candidates
    const cands = findEnrichmentCandidates(target, [skill]);
    const cand  = cands.find(c => c.patternId === "argocd-sync-failure");
    console.log(`  Enrichment candidate: ${cand ? cand.sectionTitle : "none"}`);
    expect(cand).toBeDefined();

    // Generate proposals
    const created = generateEnrichmentProposals(target, cands);
    console.log(`  Proposals created: ${created}`);
    expect(created).toBeGreaterThan(0);

    // Approve
    const pending = readEnrichmentProposals(target).find(p => p.status === "pending")!;
    expect(pending).toBeDefined();
    const approved = approveEnrichmentProposal(target, pending.id);
    console.log(`  Proposal approved: ${approved?.status}`);
    expect(approved!.status).toBe("approved");

    // Create SKILL.md in a temp dir
    const skillsDir = path.join(target, "skills");
    const skillMdPath = path.join(skillsDir, skill, "SKILL.md");
    fs.mkdirSync(path.dirname(skillMdPath), { recursive: true });
    fs.writeFileSync(skillMdPath, `# ${skill}\n## Description\nDeployment skill.\n`);

    // Apply
    const result = applyEnrichmentProposal(target, pending.id, [skillsDir]);
    console.log(`  Apply result: ${result.applied} — ${result.message}`);
    expect(result.applied).toBe(true);

    const content = fs.readFileSync(skillMdPath, "utf-8");
    expect(content).toContain("ArgoCD Troubleshooting");
    expect(content).toContain("argocd app sync");
    console.log(`  SKILL.md enriched: ${content.length} bytes`);
  });

  // ── Quality score evolution ───────────────────────────────────────────────
  it("Quality score grows as skill accumulates successful patterns", () => {
    const target  = freshWorkspace();
    const skill   = "deployment-practical";
    console.log("\n  === Quality score evolution ===");

    // Baseline profile (no runs)
    const baseline = refreshSkillProfiles(target, [skill]);
    const baseScore = baseline.profiles[skill].qualityScore;
    console.log(`  Baseline quality score: ${baseScore}`);

    // Add successful runs with patterns
    for (const kwds of [
      "argocd sync failed",
      "helm chart upgrade",
      "k3s cluster install",
    ]) {
      for (let i = 0; i < MIN_PATTERN_OCCURRENCES; i++) {
        simulateSuccess(target, skill, `quality-${kwds.replace(/ /g, "-")}-${i}`, kwds);
      }
    }

    mineSuccessfulRunPatterns(target);
    const enriched = refreshSkillProfiles(target, [skill]);
    const enrichedScore = enriched.profiles[skill].qualityScore;
    console.log(`  Enriched quality score: ${enrichedScore} (Δ${enrichedScore - baseScore})`);
    expect(enrichedScore).toBeGreaterThan(baseScore);

    // Check evolution
    const evolution = getSkillEvolution(target, [skill]);
    console.log(`  Evolution entries: ${evolution.length}`);
    if (evolution.length > 0) {
      console.log(`  Top improved: ${evolution[0].skill} +${evolution[0].qualityDelta}`);
      expect(evolution[0].skill).toBe(skill);
    }
  });

  // ── Multi-skill pipeline ──────────────────────────────────────────────────
  it("Multi-skill pipeline — each skill discovers its own patterns", () => {
    const target = freshWorkspace();
    console.log("\n  === Multi-skill: deployment-practical + ci-pipeline-debug ===");

    const scenarios: Array<{ skill: string; keyword: string; pattern: string }> = [
      { skill: "deployment-practical", keyword: "argocd sync failed application",       pattern: "argocd-sync-failure" },
      { skill: "deployment-practical", keyword: "terraform state locked backend",        pattern: "terraform-state-lock" },
      { skill: "ci-pipeline-debug",    keyword: "github actions workflow publish runner", pattern: "github-actions-failure" },
    ];

    for (const { skill, keyword } of scenarios) {
      for (let i = 0; i < MIN_PATTERN_OCCURRENCES; i++) {
        simulateSuccess(target, skill, `multi-${skill}-${keyword.slice(0, 8)}-${i}`, keyword);
      }
    }

    mineSuccessfulRunPatterns(target);

    for (const { skill, pattern } of scenarios) {
      const cands = findEnrichmentCandidates(target, [skill]);
      const hit   = cands.find(c => c.patternId === pattern);
      console.log(`  ${skill} / ${pattern}: ${hit ? `found (${hit.occurrences}×)` : "NOT FOUND"}`);
      expect(hit, `Expected candidate for ${skill}/${pattern}`).toBeDefined();
    }
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  it("Benchmark summary — all DevOps scenarios covered", () => {
    const scenarios = [
      { task: "K3s cluster setup",         pattern: "k3s-cluster-setup" },
      { task: "KubeRocketCI deployment",   pattern: "kuberocketci-deploy" },
      { task: "ArgoCD sync failure",       pattern: "argocd-sync-failure" },
      { task: "Helm deployment",           pattern: "helm-deployment" },
      { task: "AKS CrashLoopBackOff",     pattern: "aks-deployment-rollout" },
      { task: "Terraform state lock",      pattern: "terraform-state-lock" },
      { task: "GitHub Actions failure",    pattern: "github-actions-failure" },
      { task: "EKS setup",                 pattern: "eks-setup" },
      { task: "Ingress configuration",     pattern: "ingress-config" },
      { task: "GKE cluster",               pattern: "gke-setup" },
    ];

    console.log("\n  === Phase 10 Coverage Summary ===");
    console.log(`  Pattern library size: ${scenarios.length} DevOps/cloud patterns`);
    console.log(`  MIN_PATTERN_OCCURRENCES threshold: ${MIN_PATTERN_OCCURRENCES}`);
    console.log("\n  Pattern → Section mapping:");
    for (const { task, pattern } of scenarios) {
      const p = DEVOPS_PATTERNS.find((dp: { id: string }) => dp.id === pattern);
      console.log(`    ${task.padEnd(30)} → ${p?.sectionTitle ?? "MISSING"}`);
      expect(p, `Pattern ${pattern} must exist in DEVOPS_PATTERNS`).toBeDefined();
    }
    console.log(`\n  All ${scenarios.length} DevOps scenarios have corresponding enrichment patterns.`);
  });
});
