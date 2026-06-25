/**
 * Skill Enrichment Intelligence — Phases 1-5, 7, 9
 *
 * Continuously improves skill knowledge from real-world usage:
 *   Phase 1  — Successful run detection (SkillSuccessEvent)
 *   Phase 2  — Session knowledge mining (skill-learning.jsonl)
 *   Phase 3  — Proven examples aggregation per skill
 *   Phase 4  — Skill confidence profile (skill-profile.json)
 *   Phase 5  — Enrichment candidates (pattern count ≥ MIN_PATTERN_OCCURRENCES)
 *   Phase 7  — Skill quality score (0-100)
 *   Phase 9  — DevOps / cloud-native pattern library (K8s, Helm, ArgoCD, Terraform…)
 *
 * SAFETY: This module never modifies SKILL.md.
 * See skillEnrichmentProposal.ts for the user-review workflow (Phase 6).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { readCachedEnrichedRuns, EnrichedRunRecord } from "./runsStore";

// ── Constants ─────────────────────────────────────────────────────────────────

const SKILL_LEARNING_REL   = path.join(".claude", "learning", "skill-learning.jsonl");
const SKILL_PROFILE_REL    = path.join(".claude", "learning", "skill-profile.json");

export const MIN_PATTERN_OCCURRENCES = 3;

// ── Phase 1: Successful Run Detection ────────────────────────────────────────

export interface SkillSuccessEvent {
  skill: string;
  sessionId: string;
  timestamp: string;
  success: boolean;
  tokens: number;
  cost: number;
  agent: string;
}

/**
 * Detects successful skill runs from runs.jsonl.
 * A run is "successful" when success=true AND (cost>0 OR tokens>0 OR metadata.outcome="success").
 */
export function detectSuccessfulRuns(target: string): SkillSuccessEvent[] {
  return readCachedEnrichedRuns(target)
    .filter(r => {
      if (!r.success) return false;
      if (r.cost > 0 || r.tokens > 0) return true;
      if ((r.metadata?.outcome as string) === "success") return true;
      return false;
    })
    .map(r => ({
      skill: r.skill,
      sessionId: r.session_id,
      timestamp: r.ts,
      success: true,
      tokens: r.tokens,
      cost: r.cost,
      agent: r.agent,
    }));
}

// ── Phase 9 & 2: DevOps / Cloud-Native Pattern Library ───────────────────────

export type PatternCategory =
  | "kubernetes" | "argocd" | "helm" | "terraform"
  | "ci-cd" | "cloud" | "general";

export interface KnownPattern {
  id: string;
  label: string;
  category: PatternCategory;
  /** Keywords matched against run context (skill name + metadata fields). */
  keywords: string[];
  /** Skills where this pattern is most commonly observed. */
  affinity: string[];
  typicalCommands: string[];
  typicalFiles: string[];
  /** Proposed section heading for SKILL.md enrichment. */
  sectionTitle: string;
  /** Markdown template used in the enrichment proposal. */
  proposalTemplate: string;
}

export const DEVOPS_PATTERNS: KnownPattern[] = [
  // ── ArgoCD ─────────────────────────────────────────────────────────────────
  {
    id: "argocd-sync-failure",
    label: "ArgoCD Sync Failure",
    category: "argocd",
    keywords: ["argocd", "sync", "failed", "out-of-sync", "argo", "application"],
    affinity: ["deployment-practical", "ci-pipeline-debug"],
    typicalCommands: [
      "argocd app sync <app-name>",
      "argocd app get <app-name>",
      "kubectl describe application <app-name> -n argocd",
      "argocd app history <app-name>",
    ],
    typicalFiles: ["argocd/*", "helm/*", "*.yaml"],
    sectionTitle: "ArgoCD Troubleshooting",
    proposalTemplate: `## ArgoCD Troubleshooting

Common fixes for sync failures:

\`\`\`bash
kubectl describe application <app-name> -n argocd
argocd app sync <app-name>
argocd app get <app-name>
argocd app history <app-name>
\`\`\`

**Root causes:**
- Helm values mismatch between repo and cluster state
- Image tag not found in registry (check imagePullPolicy)
- RBAC permission missing on the ArgoCD service account
- Target namespace does not exist — add \`CreateNamespace=true\` sync option`,
  },

  // ── K3s ────────────────────────────────────────────────────────────────────
  {
    id: "k3s-cluster-setup",
    label: "K3s Cluster Setup",
    category: "kubernetes",
    keywords: ["k3s", "cluster", "install", "node", "k3sup", "lightweight", "server", "agent"],
    affinity: ["deployment-practical"],
    typicalCommands: [
      "k3sup install --ip <server-ip> --user <user>",
      "k3sup join --ip <worker-ip> --server-ip <server-ip> --user <user>",
      "kubectl get nodes",
      "systemctl status k3s",
    ],
    typicalFiles: ["k3s/*", "*.yaml", "install.sh"],
    sectionTitle: "K3s Cluster Deployment",
    proposalTemplate: `## K3s Cluster Deployment

Quick single-node or multi-node cluster:

\`\`\`bash
# Server
k3sup install --ip <server-ip> --user <user>

# Worker node
k3sup join --ip <worker-ip> --server-ip <server-ip> --user <user>

# Verify
export KUBECONFIG=./kubeconfig
kubectl get nodes
\`\`\`

**Common issues:**
- Flannel CNI conflicts — use \`--flannel-backend=none\` for custom CNI (Calico/Cilium)
- Port 6443 blocked — ensure firewall allows K3s API server traffic
- TLS SAN mismatch — pass \`--tls-san <public-ip>\` during install`,
  },

  // ── AKS ────────────────────────────────────────────────────────────────────
  {
    id: "aks-deployment-rollout",
    label: "AKS Deployment Rollout Failure",
    category: "cloud",
    keywords: ["aks", "azure", "kubernetes", "rollout", "crashloop", "deployment", "pod"],
    affinity: ["deployment-practical", "azure-resource-ops"],
    typicalCommands: [
      "az aks get-credentials --resource-group <rg> --name <cluster>",
      "kubectl rollout status deployment/<name> -n <ns>",
      "kubectl describe pod -l app=<name> -n <ns>",
      "kubectl logs -l app=<name> -n <ns> --previous",
    ],
    typicalFiles: ["*.yaml", "*.bicep", "aks/*"],
    sectionTitle: "AKS Deployment Rollout",
    proposalTemplate: `## AKS Deployment Rollout

Diagnose and recover from rollout failures:

\`\`\`bash
az aks get-credentials --resource-group <rg> --name <cluster>
kubectl rollout status deployment/<name> -n <ns>
kubectl describe pod -l app=<name> -n <ns>
kubectl logs -l app=<name> -n <ns> --previous

# Rollback if needed
kubectl rollout undo deployment/<name> -n <ns>
\`\`\`

**CrashLoopBackOff checklist:**
- Verify liveness/readiness probe paths and initial delay
- Check container image tag and registry pull secret
- Inspect resource limits — OOMKilled means memory limit too low
- Review container entrypoint / command override`,
  },

  // ── KubeRocketCI ───────────────────────────────────────────────────────────
  {
    id: "kuberocketci-deploy",
    label: "KubeRocketCI Deployment",
    category: "kubernetes",
    keywords: ["kuberocketci", "krci", "edp", "codebase", "pipelinerun", "tekton"],
    affinity: ["deployment-practical", "ci-pipeline-debug"],
    typicalCommands: [
      "helm install krci epamedp/edp-install -n edp --create-namespace -f values.yaml",
      "kubectl get codebases -n edp",
      "kubectl get pipelineruns -n edp",
    ],
    typicalFiles: ["*.yaml", "values.yaml", "helm/*"],
    sectionTitle: "KubeRocketCI Setup",
    proposalTemplate: `## KubeRocketCI Setup

Deploy KubeRocketCI (KRCI / EDP) with Helm:

\`\`\`bash
helm repo add epamedp https://epam.github.io/edp-helm-charts/stable
helm repo update

helm upgrade --install krci epamedp/edp-install \\
  -n edp --create-namespace \\
  -f values.yaml --wait --timeout 10m

kubectl get codebases -n edp
kubectl get pipelineruns -n edp
\`\`\`

**Common issues:**
- Keycloak / OAuth integration — verify SSO realm and client IDs in values.yaml
- Tekton pipelines stuck — check Tekton operator version compatibility`,
  },

  // ── Helm ───────────────────────────────────────────────────────────────────
  {
    id: "helm-deployment",
    label: "Helm Chart Deployment",
    category: "helm",
    keywords: ["helm", "chart", "release", "upgrade", "values", "install", "repo", "rollback"],
    affinity: ["deployment-practical"],
    typicalCommands: [
      "helm upgrade --install <release> <chart> --namespace <ns> --create-namespace -f values.yaml --wait",
      "helm rollback <release> --namespace <ns>",
      "helm history <release> --namespace <ns>",
      "helm repo add <name> <url>",
    ],
    typicalFiles: ["Chart.yaml", "values.yaml", "helm/*", "templates/*"],
    sectionTitle: "Helm Deployment Patterns",
    proposalTemplate: `## Helm Deployment Patterns

Idempotent install-or-upgrade:

\`\`\`bash
helm repo add <repo-name> <repo-url>
helm repo update

helm upgrade --install <release> <chart> \\
  --namespace <ns> --create-namespace \\
  -f values.yaml \\
  --wait --timeout 5m

# On failure
helm rollback <release> --namespace <ns>
helm history <release> --namespace <ns>
\`\`\`

**Debugging chart errors:**
- \`helm template . | kubectl apply --dry-run=client -f -\` — validate before deploy
- \`helm get values <release>\` — inspect applied values`,
  },

  // ── Terraform ──────────────────────────────────────────────────────────────
  {
    id: "terraform-state-lock",
    label: "Terraform State Lock",
    category: "terraform",
    keywords: ["terraform", "state", "lock", "backend", "locked", "force-unlock", "plan", "apply"],
    affinity: ["deployment-practical"],
    typicalCommands: [
      "terraform force-unlock <lock-id>",
      "terraform init -reconfigure",
      "terraform plan -target=<resource>",
      "terraform apply -target=<resource>",
    ],
    typicalFiles: ["*.tf", "*.tfvars", "main.tf", "backend.tf"],
    sectionTitle: "Terraform State Management",
    proposalTemplate: `## Terraform State Management

Force-unlock a stuck state (safe after verifying no concurrent apply):

\`\`\`bash
terraform force-unlock <lock-id>

# Re-initialize after backend change
terraform init -reconfigure

# Targeted plan / apply for partial rollouts
terraform plan   -target=module.<name>
terraform apply  -target=module.<name>
\`\`\`

**Prevention:**
- AWS: use DynamoDB table for state locking with S3 backend
- GCP: GCS bucket versioning handles concurrent access
- Azure: Storage Account blob lease provides locking automatically`,
  },

  // ── GitHub Actions ─────────────────────────────────────────────────────────
  {
    id: "github-actions-failure",
    label: "GitHub Actions Pipeline Failure",
    category: "ci-cd",
    keywords: ["github", "actions", "workflow", "pipeline", "ci", "publish", "release", "runner"],
    affinity: ["ci-pipeline-debug", "github-actions-ci"],
    typicalCommands: [
      "gh run list --workflow=<workflow-file>",
      "gh run view <run-id> --log-failed",
      "gh run rerun <run-id> --failed",
    ],
    typicalFiles: [".github/workflows/*.yml", ".github/actions/*"],
    sectionTitle: "GitHub Actions Debugging",
    proposalTemplate: `## GitHub Actions Debugging

Inspect and re-run failing workflows:

\`\`\`bash
gh run list --workflow=<workflow.yml>
gh run view <run-id> --log-failed
gh run rerun <run-id> --failed
\`\`\`

**Common failures:**
- Secret unavailable in fork PRs — use environment-level secrets with explicit approval
- \`actions/checkout\` depth insufficient for tag push — set \`fetch-depth: 0\`
- Publish step fails — verify \`NODE_AUTH_TOKEN\` (npm) or \`GITHUB_TOKEN\` scope
- Concurrency lock — check \`concurrency:\` group settings for race conditions`,
  },

  // ── EKS ────────────────────────────────────────────────────────────────────
  {
    id: "eks-setup",
    label: "EKS Cluster Setup",
    category: "cloud",
    keywords: ["eks", "aws", "eksctl", "nodegroup", "fargate", "kube-config", "eks-cluster"],
    affinity: ["deployment-practical"],
    typicalCommands: [
      "eksctl create cluster -f eksctl-config.yaml",
      "aws eks update-kubeconfig --region <region> --name <cluster>",
      "kubectl get nodes",
      "eksctl upgrade nodegroup --name=<ng> --cluster=<cluster>",
    ],
    typicalFiles: ["eksctl-config.yaml", "*.yaml"],
    sectionTitle: "EKS Cluster Operations",
    proposalTemplate: `## EKS Cluster Operations

Create cluster from config file:

\`\`\`bash
eksctl create cluster -f eksctl-config.yaml
aws eks update-kubeconfig --region <region> --name <cluster-name>
kubectl get nodes
\`\`\`

**Managed node group update:**
\`\`\`bash
eksctl upgrade nodegroup --name=<ng> --cluster=<cluster> --kubernetes-version=<ver>
\`\`\`

**Add-ons (IRSA required):**
\`\`\`bash
eksctl create addon --name vpc-cni --cluster <cluster> --service-account-role-arn <arn>
\`\`\``,
  },

  // ── Ingress ────────────────────────────────────────────────────────────────
  {
    id: "ingress-config",
    label: "Kubernetes Ingress Configuration",
    category: "kubernetes",
    keywords: ["ingress", "nginx", "traefik", "cert-manager", "tls", "ssl", "hostname", "gateway"],
    affinity: ["deployment-practical"],
    typicalCommands: [
      "kubectl describe ingress -n <ns>",
      "kubectl get ingress -n <ns>",
      "kubectl logs -n ingress-nginx -l app.kubernetes.io/name=ingress-nginx",
    ],
    typicalFiles: ["ingress.yaml", "*.yaml"],
    sectionTitle: "Kubernetes Ingress Setup",
    proposalTemplate: `## Kubernetes Ingress Setup

Nginx ingress with cert-manager TLS:

\`\`\`yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: app-ingress
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  ingressClassName: nginx
  tls:
    - hosts: [app.example.com]
      secretName: app-tls
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: app-svc
                port: { number: 80 }
\`\`\`

**Debugging:** \`kubectl describe ingress -n <ns>\` — check Address and Events fields`,
  },

  // ── GCP / GKE ──────────────────────────────────────────────────────────────
  {
    id: "gke-setup",
    label: "GKE Cluster Setup",
    category: "cloud",
    keywords: ["gke", "gcp", "google", "gcloud", "cluster", "autopilot", "workload-identity"],
    affinity: ["deployment-practical"],
    typicalCommands: [
      "gcloud container clusters create <name> --region <region>",
      "gcloud container clusters get-credentials <name> --region <region>",
      "kubectl get nodes",
    ],
    typicalFiles: ["*.yaml", "*.tf"],
    sectionTitle: "GKE Cluster Operations",
    proposalTemplate: `## GKE Cluster Operations

Create and connect to a GKE cluster:

\`\`\`bash
gcloud container clusters create <name> \\
  --region <region> --num-nodes 3 \\
  --machine-type e2-standard-4 \\
  --workload-pool=<project-id>.svc.id.goog

gcloud container clusters get-credentials <name> --region <region>
kubectl get nodes
\`\`\`

**Autopilot** (serverless nodes):
\`\`\`bash
gcloud container clusters create-auto <name> --region <region>
\`\`\``,
  },
];

// ── Phase 2: Pattern Detection & Mining ──────────────────────────────────────

export interface PatternMatch {
  patternId: string;
  patternLabel: string;
  category: PatternCategory;
  confidence: number;
  matchedKeywords: string[];
}

export interface SkillLearningEntry {
  ts: string;
  skill: string;
  sessionId: string;
  patternId: string;
  patternLabel: string;
  category: string;
  confidence: number;
  tokens: number;
  cost: number;
  agent: string;
}

/**
 * Detects DevOps patterns from a run record by matching keywords in
 * available metadata fields and the skill name itself.
 */
export function detectPattern(skill: string, metadata: Record<string, unknown>): PatternMatch[] {
  const context = [
    skill,
    String(metadata.task_type ?? ""),
    String(metadata.outcome_signal ?? ""),
    String(metadata.hint ?? ""),
    String(metadata.note ?? ""),
  ].join(" ").toLowerCase();

  const matches: PatternMatch[] = [];

  for (const pattern of DEVOPS_PATTERNS) {
    const hasAffinity = pattern.affinity.some(a => skill === a || skill.startsWith(a.split("-")[0]));
    const matchedKeywords = pattern.keywords.filter(kw => context.includes(kw));

    if (matchedKeywords.length === 0 && !hasAffinity) continue;

    const keywordScore = matchedKeywords.length / pattern.keywords.length;
    const affinityBonus = hasAffinity ? 0.30 : 0;
    const confidence = Math.min(0.99, keywordScore * 0.70 + affinityBonus);

    if (confidence >= 0.15) {
      matches.push({
        patternId: pattern.id,
        patternLabel: pattern.label,
        category: pattern.category,
        confidence,
        matchedKeywords,
      });
    }
  }

  return matches.sort((a, b) => b.confidence - a.confidence);
}

function skillLearningPath(target: string): string {
  return path.join(target, SKILL_LEARNING_REL);
}

export function readSkillLearningEntries(target: string): SkillLearningEntry[] {
  const file = skillLearningPath(target);
  if (!fs.existsSync(file)) return [];
  const entries: SkillLearningEntry[] = [];
  try {
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line) as SkillLearningEntry); } catch { /* skip corrupt lines */ }
    }
  } catch { /* non-fatal */ }
  return entries;
}

function appendSkillLearningEntry(target: string, entry: SkillLearningEntry): void {
  const file = skillLearningPath(target);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
  } catch { /* non-fatal */ }
}

/**
 * Mines patterns from all successful runs not yet processed.
 * Returns the count of new entries written to skill-learning.jsonl.
 */
export function mineSuccessfulRunPatterns(target: string): number {
  const successEvents = detectSuccessfulRuns(target);
  if (successEvents.length === 0) return 0;

  const existing = readSkillLearningEntries(target);
  const existingKeys = new Set(existing.map(e => `${e.skill}::${e.sessionId}::${e.patternId}`));

  // Index all cached runs keyed by (skill, sessionId) for fast lookup
  const runsByKey = new Map<string, EnrichedRunRecord>();
  for (const run of readCachedEnrichedRuns(target)) {
    const k = `${run.skill}::${run.session_id}`;
    if (!runsByKey.has(k)) runsByKey.set(k, run);
  }

  let written = 0;
  for (const evt of successEvents) {
    const run = runsByKey.get(`${evt.skill}::${evt.sessionId}`);
    if (!run) continue;

    for (const match of detectPattern(run.skill, run.metadata ?? {})) {
      const key = `${evt.skill}::${evt.sessionId}::${match.patternId}`;
      if (existingKeys.has(key)) continue;

      const pattern = DEVOPS_PATTERNS.find(p => p.id === match.patternId);
      if (!pattern) continue;

      appendSkillLearningEntry(target, {
        ts: evt.timestamp,
        skill: evt.skill,
        sessionId: evt.sessionId,
        patternId: match.patternId,
        patternLabel: match.patternLabel,
        category: pattern.category,
        confidence: match.confidence,
        tokens: evt.tokens,
        cost: evt.cost,
        agent: evt.agent,
      });
      existingKeys.add(key);
      written++;
    }
  }
  return written;
}

// ── Phase 3: Proven Examples ──────────────────────────────────────────────────

export interface ProvenScenario {
  pattern: string;
  label: string;
  category: string;
  occurrences: number;
  successRate: number;
}

export function computeProvenExamples(target: string, skillName: string): ProvenScenario[] {
  const entries = readSkillLearningEntries(target).filter(e => e.skill === skillName);
  if (entries.length === 0) return [];

  const successSet = new Set(
    detectSuccessfulRuns(target).filter(e => e.skill === skillName).map(e => e.sessionId)
  );

  const byPattern = new Map<string, { count: number; label: string; category: string; successCount: number }>();
  for (const e of entries) {
    const cur = byPattern.get(e.patternId) ?? {
      count: 0, label: e.patternLabel, category: e.category, successCount: 0,
    };
    cur.count++;
    if (successSet.has(e.sessionId)) cur.successCount++;
    byPattern.set(e.patternId, cur);
  }

  return [...byPattern.entries()]
    .map(([patternId, d]) => ({
      pattern: patternId,
      label: d.label,
      category: d.category,
      occurrences: d.count,
      successRate: d.count > 0 ? d.successCount / d.count : 0,
    }))
    .sort((a, b) => b.occurrences - a.occurrences || b.successRate - a.successRate);
}

// ── Phase 4: Skill Confidence Profile ────────────────────────────────────────

export interface SkillProfile {
  skill: string;
  invocations: number;
  successes: number;
  successRate: number;
  avgTokens: number;
  avgCostUsd: number;
  commonScenarios: ProvenScenario[];
  qualityScore: number;
  /** Change in quality score since the previous profile build (0 on first build). */
  qualityDelta: number;
  lastUpdated: string;
}

export interface SkillProfileIndex {
  version: 1;
  computedAt: string;
  profiles: Record<string, SkillProfile>;
}

function skillProfilePath(target: string): string {
  return path.join(target, SKILL_PROFILE_REL);
}

export function readSkillProfileIndex(target: string): SkillProfileIndex | undefined {
  try {
    return JSON.parse(fs.readFileSync(skillProfilePath(target), "utf-8")) as SkillProfileIndex;
  } catch {
    return undefined;
  }
}

export function writeSkillProfileIndex(target: string, index: SkillProfileIndex): void {
  try {
    fs.mkdirSync(path.dirname(skillProfilePath(target)), { recursive: true });
    fs.writeFileSync(skillProfilePath(target), JSON.stringify(index, null, 2), "utf-8");
  } catch { /* non-fatal */ }
}

export function buildSkillProfile(target: string, skillName: string, prev?: SkillProfile): SkillProfile {
  const runs = readCachedEnrichedRuns(target).filter(
    r => r.skill === skillName && r.metadata?.invoked === true
  );
  const invocations = runs.length;
  const successes   = runs.filter(r => r.success).length;
  const successRate = invocations > 0 ? successes / invocations : 0;
  const avgTokens   = invocations > 0 ? Math.round(runs.reduce((s, r) => s + r.tokens, 0) / invocations) : 0;
  const avgCostUsd  = invocations > 0
    ? Math.round(runs.reduce((s, r) => s + r.cost, 0) / invocations * 10000) / 10000
    : 0;
  const commonScenarios = computeProvenExamples(target, skillName);
  const qualityScore    = computeQualityScore(invocations, successRate, runs.length, commonScenarios);
  const qualityDelta    = prev ? qualityScore - prev.qualityScore : 0;

  return {
    skill: skillName, invocations, successes, successRate,
    avgTokens, avgCostUsd, commonScenarios,
    qualityScore, qualityDelta,
    lastUpdated: new Date().toISOString(),
  };
}

export function refreshSkillProfiles(target: string, skillNames: string[]): SkillProfileIndex {
  const prev = readSkillProfileIndex(target);
  const profiles: Record<string, SkillProfile> = {};
  for (const name of skillNames) {
    profiles[name] = buildSkillProfile(target, name, prev?.profiles[name]);
  }
  const index: SkillProfileIndex = { version: 1, computedAt: new Date().toISOString(), profiles };
  writeSkillProfileIndex(target, index);
  return index;
}

// ── Phase 5: Enrichment Candidates ───────────────────────────────────────────

export interface EnrichmentCandidate {
  skill: string;
  patternId: string;
  patternLabel: string;
  occurrences: number;
  successRate: number;
  confidence: number;
  sectionTitle: string;
  proposedContent: string;
  affectedFiles: string[];
  typicalCommands: string[];
}

/**
 * Returns enrichment candidates for the given skills.
 * A candidate is created when the same pattern appears ≥ MIN_PATTERN_OCCURRENCES times.
 */
export function findEnrichmentCandidates(target: string, skillNames: string[]): EnrichmentCandidate[] {
  const candidates: EnrichmentCandidate[] = [];

  for (const skill of skillNames) {
    for (const scenario of computeProvenExamples(target, skill)) {
      if (scenario.occurrences < MIN_PATTERN_OCCURRENCES) continue;

      const pattern = DEVOPS_PATTERNS.find(p => p.id === scenario.pattern);
      if (!pattern) continue;

      // Confidence: base 0.50 + success rate contribution + observation count bonus (capped)
      const confidence = Math.min(
        0.99,
        0.50 + scenario.successRate * 0.30 + Math.min(scenario.occurrences, 10) * 0.04
      );

      candidates.push({
        skill,
        patternId: scenario.pattern,
        patternLabel: scenario.label,
        occurrences: scenario.occurrences,
        successRate: scenario.successRate,
        confidence,
        sectionTitle: pattern.sectionTitle,
        proposedContent: pattern.proposalTemplate,
        affectedFiles: pattern.typicalFiles,
        typicalCommands: pattern.typicalCommands,
      });
    }
  }

  return candidates.sort((a, b) => b.occurrences - a.occurrences || b.confidence - a.confidence);
}

// ── Phase 7: Skill Quality Score ─────────────────────────────────────────────

/**
 * Computes a 0-100 quality score:
 *   Usage            (0-20) — log₂-scaled invocations
 *   Success Rate     (0-25) — successRate × 25
 *   Reuse            (0-20) — reuseCount / invocations
 *   Time Saved       (0-15) — invocations × 1.5 (capped)
 *   Knowledge Growth (0-20) — proven patterns with ≥3 occurrences × 4 pts each (capped at 5)
 */
export function computeQualityScore(
  invocations: number,
  successRate: number,
  reuseCount: number,
  scenarios: ProvenScenario[]
): number {
  const usageScore     = Math.min(20, Math.log2(Math.max(1, invocations)) * 4);
  const successScore   = successRate * 25;
  const reuseScore     = invocations > 0 ? Math.min(20, (reuseCount / invocations) * 20) : 0;
  const timeSavedScore = Math.min(15, invocations * 1.5);
  const knowledgeScore = Math.min(20, scenarios.filter(s => s.occurrences >= MIN_PATTERN_OCCURRENCES).length * 4);

  return Math.round(usageScore + successScore + reuseScore + timeSavedScore + knowledgeScore);
}

// ── Phase 8 support: Skill Evolution ─────────────────────────────────────────

export interface SkillEvolutionEntry {
  skill: string;
  qualityScore: number;
  qualityDelta: number;
  topPattern?: string;
}

/** Returns the top N most-improved skills (by qualityDelta) from the current profile index. */
export function getSkillEvolution(target: string, skillNames: string[], topN = 5): SkillEvolutionEntry[] {
  const index = readSkillProfileIndex(target);
  if (!index) return [];

  return skillNames
    .map(n => index.profiles[n])
    .filter((p): p is SkillProfile => !!p)
    .map(p => ({
      skill: p.skill,
      qualityScore: p.qualityScore,
      qualityDelta: p.qualityDelta,
      topPattern: p.commonScenarios[0]?.label,
    }))
    .filter(e => e.qualityDelta > 0)
    .sort((a, b) => b.qualityDelta - a.qualityDelta)
    .slice(0, topN);
}

// ── Full pipeline convenience ─────────────────────────────────────────────────

/**
 * Run the full enrichment pipeline for a workspace:
 *   1. Mine patterns from successful runs
 *   2. Refresh skill profiles
 *   3. Find enrichment candidates
 *
 * Returns results for downstream use (proposal generation, dashboard).
 */
export function runEnrichmentPipeline(
  target: string,
  skillNames: string[]
): {
  newEntries: number;
  profiles: SkillProfileIndex;
  candidates: EnrichmentCandidate[];
} {
  const newEntries = mineSuccessfulRunPatterns(target);
  const profiles   = refreshSkillProfiles(target, skillNames);
  const candidates = findEnrichmentCandidates(target, skillNames);
  return { newEntries, profiles, candidates };
}
