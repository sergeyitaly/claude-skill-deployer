import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeSkillEnrichment,
  buildDataDrivenCandidates,
  commandKey,
  computeEnrichmentImpact,
  computeRecommendationBoost,
  detectKnownIssues,
  detectStaleSkills,
  detectTechnologies,
  enrichmentRankingAdjustment,
  formatEnrichmentIntelligencePanelHtml,
  isLowSignalCommand,
  normalizeCommand,
  readSkillEnrichmentIndex,
  redactSensitiveText,
  skillEnrichmentIndexPath,
  STALENESS_DAYS,
} from "./enrichmentIntelligence";
import { appendAdoptionEvents } from "./skillAdoption";
import {
  generateEnrichmentProposals,
  postponeEnrichmentProposal,
  readEnrichmentProposals,
  resurfacePostponedProposals,
  EnrichmentProposal,
} from "./skillEnrichmentProposal";

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enrich-intel-"));
  fs.mkdirSync(path.join(dir, ".claude", "learning"), { recursive: true });
  return dir;
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function writeRuns(
  target: string,
  runs: Array<{
    skill: string;
    session_id: string;
    success: boolean;
    ts?: string;
    error?: string;
    hint?: string;
  }>
): void {
  const lines = runs.map((r) =>
    JSON.stringify({
      ts: r.ts ?? new Date().toISOString(),
      timestamp: r.ts ?? new Date().toISOString(),
      skill: r.skill,
      action: "skill_invoke",
      agent: "claude",
      tokens: 100,
      cost: 0.001,
      rc: r.success ? 0 : 1,
      success: r.success,
      session_id: r.session_id,
      project: target,
      branch: null,
      metadata: { source: "skill-invoke-hook-v2", invoked: true },
      ...(r.error ? { error: r.error } : {}),
      ...(r.hint ? { hint: r.hint } : {}),
    })
  );
  fs.writeFileSync(
    path.join(target, ".claude", "learning", "runs.jsonl"),
    lines.join("\n") + "\n",
    "utf-8"
  );
}

function writeMcpUsage(
  target: string,
  entries: Array<Record<string, unknown>>
): void {
  fs.writeFileSync(
    path.join(target, ".claude", "mcp-usage.jsonl"),
    entries.map((e) => JSON.stringify({ ts: new Date().toISOString(), durationMs: 5, path: "", ...e })).join("\n") + "\n",
    "utf-8"
  );
}

function writeAppliedProposal(target: string, skill: string, reviewedAt: string): void {
  const proposal: EnrichmentProposal = {
    id: `enrich_${skill}_test_1`,
    ts: reviewedAt,
    skill,
    patternId: "test-pattern",
    patternLabel: "Test Pattern",
    status: "applied",
    evidence: { sessions: 3, successRate: 1, occurrences: 3 },
    confidence: 0.9,
    sectionTitle: "Test Section",
    proposedContent: "## Test Section",
    affectedFiles: [],
    typicalCommands: [],
    reviewedAt,
  };
  fs.appendFileSync(
    path.join(target, ".claude", "learning", "skill-enrichment-proposals.jsonl"),
    JSON.stringify(proposal) + "\n",
    "utf-8"
  );
}

// ---------------------------------------------------------------------------
// Phase 4: redaction and command normalization
// ---------------------------------------------------------------------------

describe("secret redaction", () => {
  it("redacts flag-value secrets", () => {
    const out = redactSensitiveText("helm upgrade app chart --password hunter2 --token=abc123xyz");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("abc123xyz");
    expect(out).toContain("--password <redacted>");
  });

  it("redacts assignments with secret-ish names", () => {
    const out = redactSensitiveText(
      "kubectl create secret generic s --from-literal=password=hunter2 AWS_SECRET_ACCESS_KEY=AAAA1111"
    );
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("AAAA1111");
  });

  it("redacts bearer tokens, JWTs, AWS keys, and GitHub tokens", () => {
    const out = redactSensitiveText(
      "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload-part' " +
        "AKIAIOSFODNN7EXAMPLE ghp_abcdefghijklmnopqrst123456"
    );
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("ghp_abcdefghijklmnopqrst123456");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("keeps ordinary commands intact", () => {
    expect(redactSensitiveText("kubectl get pods -A")).toBe("kubectl get pods -A");
    expect(redactSensitiveText("terraform plan -out=tfplan")).toBe("terraform plan -out=tfplan");
  });
});

describe("command normalization", () => {
  it("collapses whitespace and caps length", () => {
    const norm = normalizeCommand("  kubectl   get pods    -A  ");
    expect(norm).toBe("kubectl get pods -A");
    expect(normalizeCommand("x".repeat(500)).length).toBeLessThanOrEqual(160);
  });

  it("strips leading cd prefixes so private paths are not stored", () => {
    expect(normalizeCommand('cd "c:\\Users\\someone\\repo" && npx vitest run')).toBe("npx vitest run");
    expect(normalizeCommand("cd /home/user/app; terraform plan")).toBe("terraform plan");
    expect(normalizeCommand('cd "a b" && cd sub && npm test')).toBe("npm test");
  });

  it("flags trivial navigation commands as low-signal", () => {
    expect(isLowSignalCommand("cd")).toBe(true);
    expect(isLowSignalCommand("ls -la")).toBe(true);
    expect(isLowSignalCommand("kubectl get")).toBe(false);
  });

  it("groups command variants under binary + subcommand", () => {
    expect(commandKey("kubectl get pods -A")).toBe("kubectl get");
    expect(commandKey("kubectl get svc -n edp")).toBe("kubectl get");
    expect(commandKey("terraform apply -auto-approve")).toBe("terraform apply");
    expect(commandKey("/usr/local/bin/helm upgrade --install x")).toBe("helm upgrade");
    expect(commandKey("ls")).toBe("ls");
  });
});

// ---------------------------------------------------------------------------
// Phase 3: technology detection
// ---------------------------------------------------------------------------

describe("technology detection", () => {
  it("detects technologies from commands", () => {
    expect(detectTechnologies("kubectl get pods")).toContain("Kubernetes");
    expect(detectTechnologies("helm upgrade --install x -f values.yaml")).toContain("Helm");
    expect(detectTechnologies("terraform plan")).toContain("Terraform");
    expect(detectTechnologies("argocd app sync my-app")).toContain("ArgoCD");
    expect(detectTechnologies("aws eks update-kubeconfig")).toContain("AWS");
    expect(detectTechnologies("check the IRSA policy for the serviceaccount")).toContain("AWS IAM");
  });

  it("detects technologies from file paths", () => {
    expect(detectTechnologies(".github/workflows/ci.yml")).toContain("GitHub Actions");
    expect(detectTechnologies("main.tf")).toContain("Terraform");
    expect(detectTechnologies("src/extension.ts")).toContain("TypeScript");
  });

  it("returns empty for unrelated text", () => {
    expect(detectTechnologies("hello world plain text")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 5: troubleshooting detection
// ---------------------------------------------------------------------------

describe("known issue detection", () => {
  it("detects recurring DevOps issues", () => {
    expect(detectKnownIssues("pod stuck in CrashLoopBackOff")).toContain("CrashLoopBackOff");
    expect(detectKnownIssues("Back-off pulling image: ImagePullBackOff")).toContain("ImagePullBackOff");
    expect(detectKnownIssues("Error: UPGRADE FAILED: helm timed out waiting")).toContain("Helm timeout");
    expect(detectKnownIssues('pods is forbidden: User "x" cannot list resource')).toContain("RBAC forbidden");
    expect(detectKnownIssues("Error: Failed to query available provider packages: provider version constraint")).toContain(
      "Terraform provider mismatch"
    );
    expect(detectKnownIssues("Error: cannot find module './foo'")).toContain("Module resolution failure");
  });

  it("returns empty for clean output", () => {
    expect(detectKnownIssues("deployment successful")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phases 1+2: analysis pipeline and data model
// ---------------------------------------------------------------------------

function seedWorkspace(target: string): void {
  writeRuns(target, [
    { skill: "deployment-practical", session_id: "s1", success: true },
    { skill: "deployment-practical", session_id: "s2", success: true },
    { skill: "deployment-practical", session_id: "s3", success: false, error: "pod in CrashLoopBackOff" },
    { skill: "vitest-extension-testing", session_id: "s4", success: true },
  ]);
  writeMcpUsage(target, [
    { tool: "cli:kubectl", server: "cli", cli: "kubectl", command: "kubectl get pods -A", exitCode: 0, sessionId: "s1" },
    { tool: "cli:kubectl", server: "cli", cli: "kubectl", command: "kubectl get svc -n edp", exitCode: 0, sessionId: "s2" },
    { tool: "cli:helm", server: "cli", cli: "helm", command: "helm upgrade --install app ./chart --token=supersecret99", exitCode: 0, sessionId: "s1" },
    { tool: "cli:helm", server: "cli", cli: "helm", command: "helm upgrade --install app ./chart", exitCode: 1, sessionId: "s2" },
    { tool: "read_file", path: "helm/values.yaml", sessionId: "s1" },
    { tool: "read_file", path: "helm/values.yaml", sessionId: "s2" },
    { tool: "read_file", path: "k8s/ingress.yaml", sessionId: "s1" },
    // Fix command in the failing session (s3) — session had no successful run,
    // so it must NOT contribute to frequentlyUsedCommands.
    { tool: "cli:kubectl", server: "cli", cli: "kubectl", command: "kubectl describe pod app-1", exitCode: 0, sessionId: "s3" },
  ]);
}

describe("analyzeSkillEnrichment", () => {
  it("builds per-skill records and writes skill-enrichment.json", () => {
    const target = makeWorkspace();
    seedWorkspace(target);
    const index = analyzeSkillEnrichment(target, ["deployment-practical", "vitest-extension-testing"]);

    expect(fs.existsSync(skillEnrichmentIndexPath(target))).toBe(true);
    const record = index.skills["deployment-practical"];
    expect(record.usageCount).toBe(3);
    expect(record.successCount).toBe(2);
    expect(record.lastAnalyzed).toBeTruthy();
    expect(record.confidence).toBeGreaterThan(0);

    // Round-trips through the reader
    const reread = readSkillEnrichmentIndex(target);
    expect(reread?.skills["deployment-practical"].usageCount).toBe(3);
  });

  it("extracts frequently used files and commands from successful sessions only", () => {
    const target = makeWorkspace();
    seedWorkspace(target);
    const record = analyzeSkillEnrichment(target, ["deployment-practical"]).skills["deployment-practical"];

    const files = record.frequentlyUsedFiles.map((f) => f.path);
    expect(files[0]).toBe("helm/values.yaml"); // 2 uses, top of list
    expect(files).toContain("k8s/ingress.yaml");

    const cmds = record.frequentlyUsedCommands;
    const kubectlGet = cmds.find((c) => c.command.startsWith("kubectl get"));
    expect(kubectlGet).toBeDefined();
    expect(kubectlGet!.successCount).toBe(2);
    const helm = cmds.find((c) => c.command.startsWith("helm upgrade"));
    expect(helm!.successCount).toBe(1);
    expect(helm!.failureCount).toBe(1);
    // s3 had no successful deployment-practical run — its command is excluded
    expect(cmds.find((c) => c.command.includes("describe"))).toBeUndefined();
  });

  it("never stores secrets in mined commands", () => {
    const target = makeWorkspace();
    seedWorkspace(target);
    const raw = fs.readFileSync(skillEnrichmentIndexPath(makeSeededTarget(target)), "utf-8");
    expect(raw).not.toContain("supersecret99");
    expect(raw).toContain("<redacted>");

    function makeSeededTarget(t: string): string {
      analyzeSkillEnrichment(t, ["deployment-practical"]);
      return t;
    }
  });

  it("builds technology affinity with frequency and confidence", () => {
    const target = makeWorkspace();
    seedWorkspace(target);
    const record = analyzeSkillEnrichment(target, ["deployment-practical"]).skills["deployment-practical"];

    const techs = Object.fromEntries(record.relatedTechnologies.map((t) => [t.technology, t]));
    expect(techs["Kubernetes"]).toBeDefined();
    expect(techs["Helm"]).toBeDefined();
    expect(techs["Helm"].frequency).toBeGreaterThanOrEqual(3); // 1 command + 2 values.yaml + chart
    for (const t of record.relatedTechnologies) {
      expect(t.confidence).toBeGreaterThan(0);
      expect(t.confidence).toBeLessThanOrEqual(99);
    }
  });

  it("extracts troubleshooting entries with observed fixes from the same session", () => {
    const target = makeWorkspace();
    seedWorkspace(target);
    const record = analyzeSkillEnrichment(target, ["deployment-practical"]).skills["deployment-practical"];

    const crash = record.troubleshooting.find((t) => t.problem === "CrashLoopBackOff");
    expect(crash).toBeDefined();
    expect(crash!.count).toBe(1);
    // Observed fix: the successful kubectl describe in the same session (s3)
    expect(crash!.successfulFixes.some((f) => f.includes("kubectl describe"))).toBe(true);
    expect(record.commonErrors.some((e) => e.includes("CrashLoopBackOff"))).toBe(true);
    expect(record.commonFixes.length).toBeGreaterThan(0);
  });

  it("handles skills with no telemetry", () => {
    const target = makeWorkspace();
    const record = analyzeSkillEnrichment(target, ["unused-skill"]).skills["unused-skill"];
    expect(record.usageCount).toBe(0);
    expect(record.frequentlyUsedCommands).toEqual([]);
    expect(record.relatedTechnologies).toEqual([]);
    expect(record.confidence).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 6: data-driven proposal generation
// ---------------------------------------------------------------------------

describe("buildDataDrivenCandidates", () => {
  it("generates a Frequently Used Commands candidate when evidence is sufficient", () => {
    const target = makeWorkspace();
    seedWorkspace(target);
    const index = analyzeSkillEnrichment(target, ["deployment-practical"]);
    const candidates = buildDataDrivenCandidates(target, index);

    const cmd = candidates.find((c) => c.patternId === "mined-commands");
    expect(cmd).toBeDefined();
    expect(cmd!.skill).toBe("deployment-practical");
    expect(cmd!.sectionTitle).toBe("Frequently Used Commands");
    expect(cmd!.proposedContent).toContain("kubectl get");
    expect(cmd!.proposedContent).not.toContain("supersecret99");
  });

  it("respects the minimum-evidence threshold", () => {
    const target = makeWorkspace();
    writeRuns(target, [{ skill: "deployment-practical", session_id: "s1", success: true }]);
    writeMcpUsage(target, [
      { tool: "cli:kubectl", server: "cli", cli: "kubectl", command: "kubectl get pods", exitCode: 0, sessionId: "s1" },
    ]);
    const index = analyzeSkillEnrichment(target, ["deployment-practical"]);
    const candidates = buildDataDrivenCandidates(target, index);
    expect(candidates.find((c) => c.patternId === "mined-commands")).toBeUndefined();
  });

  it("feeds mined candidates into the proposal review pipeline", () => {
    const target = makeWorkspace();
    seedWorkspace(target);
    const index = analyzeSkillEnrichment(target, ["deployment-practical"]);
    const created = generateEnrichmentProposals(target, buildDataDrivenCandidates(target, index));
    expect(created).toBeGreaterThan(0);
    const pending = readEnrichmentProposals(target).filter((p) => p.status === "pending");
    expect(pending.some((p) => p.patternId === "mined-commands")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 7: postpone workflow
// ---------------------------------------------------------------------------

describe("postpone workflow", () => {
  function seedProposal(target: string): string {
    const index = analyzeSkillEnrichment(target, ["deployment-practical"]);
    generateEnrichmentProposals(target, buildDataDrivenCandidates(target, index));
    return readEnrichmentProposals(target).find((p) => p.status === "pending")!.id;
  }

  it("postpones a pending proposal and blocks duplicates while snoozed", () => {
    const target = makeWorkspace();
    seedWorkspace(target);
    const id = seedProposal(target);

    expect(postponeEnrichmentProposal(target, id)).toBe(true);
    const postponed = readEnrichmentProposals(target).find((p) => p.id === id)!;
    expect(postponed.status).toBe("postponed");
    expect(new Date(postponed.postponedUntil!).getTime()).toBeGreaterThan(Date.now());

    // Regenerating does not duplicate the snoozed proposal
    const index = readSkillEnrichmentIndex(target)!;
    const created = generateEnrichmentProposals(target, buildDataDrivenCandidates(target, index));
    const sameKey = readEnrichmentProposals(target).filter(
      (p) => p.skill === postponed.skill && p.patternId === postponed.patternId
    );
    expect(sameKey).toHaveLength(1);
    expect(created).toBeLessThan(2);
  });

  it("resurfaces expired postponed proposals to pending", () => {
    const target = makeWorkspace();
    seedWorkspace(target);
    const id = seedProposal(target);
    postponeEnrichmentProposal(target, id, 7);

    // Not yet expired
    expect(resurfacePostponedProposals(target)).toBe(0);
    // Expired
    const future = Date.now() + 8 * 86_400_000;
    expect(resurfacePostponedProposals(target, future)).toBe(1);
    expect(readEnrichmentProposals(target).find((p) => p.id === id)!.status).toBe("pending");
  });

  it("only pending proposals can be postponed", () => {
    const target = makeWorkspace();
    writeAppliedProposal(target, "deployment-practical", new Date().toISOString());
    const applied = readEnrichmentProposals(target)[0];
    expect(postponeEnrichmentProposal(target, applied.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 10: staleness detection
// ---------------------------------------------------------------------------

describe("staleness detection", () => {
  function installSkillMd(target: string, skill: string, mtimeDaysAgo: number): void {
    const dir = path.join(target, ".claude", "skills", skill);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "SKILL.md");
    fs.writeFileSync(file, `# ${skill}\n`, "utf-8");
    const old = new Date(Date.now() - mtimeDaysAgo * 86_400_000);
    fs.utimesSync(file, old, old);
  }

  it("warns for heavily used skills with SKILL.md unchanged for 90+ days", () => {
    const target = makeWorkspace();
    installSkillMd(target, "deployment-practical", 120);
    writeRuns(
      target,
      Array.from({ length: 6 }, (_, i) => ({
        skill: "deployment-practical",
        session_id: `s${i}`,
        success: true,
      }))
    );
    const index = analyzeSkillEnrichment(target, ["deployment-practical"]);
    const warnings = detectStaleSkills(target, index);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].skill).toBe("deployment-practical");
    expect(warnings[0].daysSinceUpdate).toBeGreaterThanOrEqual(STALENESS_DAYS);
    expect(warnings[0].message).toContain("may be outdated");
  });

  it("does not warn for recently updated or lightly used skills", () => {
    const target = makeWorkspace();
    // Recently updated, heavy use
    installSkillMd(target, "fresh-skill", 5);
    // Old content but only 1 use
    installSkillMd(target, "light-skill", 200);
    writeRuns(target, [
      ...Array.from({ length: 6 }, (_, i) => ({
        skill: "fresh-skill",
        session_id: `f${i}`,
        success: true,
      })),
      { skill: "light-skill", session_id: "l1", success: true },
    ]);
    const index = analyzeSkillEnrichment(target, ["fresh-skill", "light-skill"]);
    expect(detectStaleSkills(target, index)).toHaveLength(0);
  });

  it("does not warn for stale skills that are no longer used", () => {
    const target = makeWorkspace();
    installSkillMd(target, "abandoned", 200);
    writeRuns(
      target,
      Array.from({ length: 6 }, (_, i) => ({
        skill: "abandoned",
        session_id: `a${i}`,
        success: true,
        ts: isoDaysAgo(60),
      }))
    );
    const index = analyzeSkillEnrichment(target, ["abandoned"]);
    expect(detectStaleSkills(target, index)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 8: enrichment impact
// ---------------------------------------------------------------------------

describe("enrichment impact", () => {
  it("compares adoption metrics before and after enrichment", () => {
    const target = makeWorkspace();
    const enrichedAt = isoDaysAgo(10);
    writeAppliedProposal(target, "deployment-practical", enrichedAt);

    // Before enrichment: 4 proposed, 1 accepted, 2 invoked, 1 successful
    appendAdoptionEvents(target, [
      ...Array.from({ length: 4 }, (_, i) => ({
        taskId: `b${i}`, skill: "deployment-practical", event: "proposed" as const, source: "auto" as const, timestamp: isoDaysAgo(20),
      })),
      { taskId: "b0", skill: "deployment-practical", event: "accepted" as const, source: "auto" as const, timestamp: isoDaysAgo(20) },
      { taskId: "b0", skill: "deployment-practical", event: "invoked" as const, source: "auto" as const, timestamp: isoDaysAgo(19) },
      { taskId: "b1", skill: "deployment-practical", event: "invoked" as const, source: "auto" as const, timestamp: isoDaysAgo(18) },
      { taskId: "b0", skill: "deployment-practical", event: "successful" as const, source: "auto" as const, timestamp: isoDaysAgo(19) },
    ]);
    // After enrichment: 2 proposed, 2 accepted, 2 invoked, 2 successful
    appendAdoptionEvents(target, [
      ...Array.from({ length: 2 }, (_, i) => ({
        taskId: `a${i}`, skill: "deployment-practical", event: "proposed" as const, source: "auto" as const, timestamp: isoDaysAgo(5),
      })),
      { taskId: "a0", skill: "deployment-practical", event: "accepted" as const, source: "auto" as const, timestamp: isoDaysAgo(5) },
      { taskId: "a1", skill: "deployment-practical", event: "accepted" as const, source: "auto" as const, timestamp: isoDaysAgo(4) },
      { taskId: "a0", skill: "deployment-practical", event: "invoked" as const, source: "auto" as const, timestamp: isoDaysAgo(4) },
      { taskId: "a1", skill: "deployment-practical", event: "invoked" as const, source: "auto" as const, timestamp: isoDaysAgo(3) },
      { taskId: "a0", skill: "deployment-practical", event: "successful" as const, source: "auto" as const, timestamp: isoDaysAgo(4) },
      { taskId: "a1", skill: "deployment-practical", event: "successful" as const, source: "auto" as const, timestamp: isoDaysAgo(3) },
    ]);

    const impact = computeEnrichmentImpact(target);
    expect(impact.impacts).toHaveLength(1);
    const i = impact.impacts[0];
    expect(i.skill).toBe("deployment-practical");
    expect(i.before.acceptancePct).toBe(25); // 1/4
    expect(i.after.acceptancePct).toBe(100); // 2/2
    expect(i.delta.acceptancePct).toBe(75);
    expect(i.before.successPct).toBe(50); // 1/2
    expect(i.after.successPct).toBe(100); // 2/2
    expect(i.delta.successPct).toBe(50);
    expect(i.afterEventCount).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(target, ".claude", "learning", "enrichment-impact.json"))).toBe(true);
  });

  it("returns no impacts without applied enrichments", () => {
    const target = makeWorkspace();
    expect(computeEnrichmentImpact(target).impacts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 11: recommendation boosting
// ---------------------------------------------------------------------------

describe("recommendation boosting", () => {
  it("grants +15 for recently enriched skills", () => {
    const target = makeWorkspace();
    writeAppliedProposal(target, "deployment-practical", isoDaysAgo(3));
    const boost = computeRecommendationBoost(target, "deployment-practical");
    expect(boost.enrichmentBonus).toBe(15);
    expect(boost.total).toBeGreaterThanOrEqual(15);
    expect(enrichmentRankingAdjustment(target, "deployment-practical")).toBe(15);
  });

  it("does not grant the enrichment bonus after 30 days", () => {
    const target = makeWorkspace();
    writeAppliedProposal(target, "deployment-practical", isoDaysAgo(45));
    expect(computeRecommendationBoost(target, "deployment-practical").enrichmentBonus).toBe(0);
  });

  it("adds success and reuse bonuses to the full breakdown", () => {
    const target = makeWorkspace();
    writeRuns(
      target,
      Array.from({ length: 4 }, (_, i) => ({
        skill: "deployment-practical",
        session_id: `s${i}`,
        success: true,
      }))
    );
    analyzeSkillEnrichment(target, ["deployment-practical"]);
    appendAdoptionEvents(target, [
      { taskId: "r1", skill: "deployment-practical", event: "reused", source: "auto" },
      { taskId: "r2", skill: "deployment-practical", event: "reused", source: "auto" },
    ]);
    const boost = computeRecommendationBoost(target, "deployment-practical");
    expect(boost.successBonus).toBe(12); // 100% success rate
    expect(boost.reuseBonus).toBe(6); // 2 reuses x 3
    // Ranking slice excludes success/reuse (owned by the adoption feedback loop)
    expect(enrichmentRankingAdjustment(target, "deployment-practical")).toBe(0);
  });

  it("penalizes stale skills and clamps the total", () => {
    const target = makeWorkspace();
    const dir = path.join(target, ".claude", "skills", "stale-skill");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "# stale\n", "utf-8");
    const old = new Date(Date.now() - 120 * 86_400_000);
    fs.utimesSync(path.join(dir, "SKILL.md"), old, old);
    writeRuns(
      target,
      Array.from({ length: 6 }, (_, i) => ({
        skill: "stale-skill",
        session_id: `s${i}`,
        success: true,
      }))
    );
    analyzeSkillEnrichment(target, ["stale-skill"]);
    const boost = computeRecommendationBoost(target, "stale-skill");
    expect(boost.stalenessPenalty).toBe(-10);
    expect(enrichmentRankingAdjustment(target, "stale-skill")).toBe(-10);
    expect(Math.abs(boost.total)).toBeLessThanOrEqual(20);
  });

  it("returns a zero boost with no data", () => {
    const target = makeWorkspace();
    const boost = computeRecommendationBoost(target, "unknown");
    expect(boost.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 9: dashboard rendering
// ---------------------------------------------------------------------------

describe("dashboard panel", () => {
  it("renders an empty state without analysis", () => {
    const target = makeWorkspace();
    expect(formatEnrichmentIntelligencePanelHtml(target)).toContain("No enrichment analysis yet");
  });

  it("renders summary tiles and sections with data", () => {
    const target = makeWorkspace();
    seedWorkspace(target);
    analyzeSkillEnrichment(target, ["deployment-practical", "vitest-extension-testing"]);
    const html = formatEnrichmentIntelligencePanelHtml(target);
    for (const label of [
      "Skill Enrichment Intelligence",
      "Skills Analyzed",
      "Skills Enriched",
      "Pending Suggestions",
      "Top Learning Skills",
      "Most Improved Skills",
      "Most Stale Skills",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("deployment-practical");
    expect(html).toContain("Usage: 3");
  });

  it("escapes HTML in mined content", () => {
    const target = makeWorkspace();
    writeRuns(target, [{ skill: "<img src=x>", session_id: "s1", success: true }]);
    analyzeSkillEnrichment(target, ["<img src=x>"]);
    const html = formatEnrichmentIntelligencePanelHtml(target);
    expect(html).not.toContain("<img src=x>");
  });
});
