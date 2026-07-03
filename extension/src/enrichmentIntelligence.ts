/**
 * Skill Enrichment Intelligence v1 — data-driven mining engine.
 *
 * Complements the static pattern library in skillEnrichment.ts with per-skill
 * intelligence mined from real telemetry:
 *
 *   Phase 1  — skill-enrichment.json data model (per-skill enrichment record)
 *   Phase 2  — success pattern extraction (files, commands, technologies)
 *   Phase 3  — technology affinity engine ({technology, frequency, confidence})
 *   Phase 4  — command intelligence (success/failure frequency, secret redaction)
 *   Phase 5  — troubleshooting intelligence (problem, count, successful fixes)
 *   Phase 6  — data-driven update generation (candidates from mined evidence)
 *   Phase 8  — enrichment impact (before/after adoption metric deltas)
 *   Phase 10 — staleness detection (used heavily, not updated 90+ days)
 *   Phase 11 — recommendation boosting from enrichment state
 *
 * SAFETY: never modifies SKILL.md; candidates flow through the Phase 6/7
 * review workflow in skillEnrichmentProposal.ts. Secrets are redacted before
 * any command or error text is persisted.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { readCachedEnrichedRuns } from "./runsStore";
import { readSkillFeedbackRecords } from "./skillFeedback";
import { readMcpUsageLog, workspaceMcpLogPath, McpUsageEntry } from "./mcpUsageLog";
import { readAdoptionEvents } from "./skillAdoption";
import { EnrichmentCandidate } from "./skillEnrichment";
import { readEnrichmentProposals } from "./skillEnrichmentProposal";

// ── Phase 1: Data model ───────────────────────────────────────────────────────

const ENRICHMENT_INDEX_REL = path.join(".claude", "learning", "skill-enrichment.json");
const ENRICHMENT_IMPACT_REL = path.join(".claude", "learning", "enrichment-impact.json");

export interface FileUsageEntry {
  path: string;
  count: number;
}

export interface CommandUsageEntry {
  /** Redacted, normalized command (never contains secrets or private values). */
  command: string;
  successCount: number;
  failureCount: number;
  /** 0-100: success ratio weighted by observation volume. */
  confidence: number;
}

export interface TechnologyAffinity {
  technology: string;
  /** Raw observation count across successful sessions. */
  frequency: number;
  /** 0-100. */
  confidence: number;
}

export interface TroubleshootingEntry {
  problem: string;
  count: number;
  successfulFixes: string[];
}

export interface SkillEnrichmentRecord {
  skill: string;
  usageCount: number;
  successCount: number;
  frequentlyUsedFiles: FileUsageEntry[];
  frequentlyUsedCommands: CommandUsageEntry[];
  commonErrors: string[];
  commonFixes: string[];
  relatedTechnologies: TechnologyAffinity[];
  troubleshooting: TroubleshootingEntry[];
  /** Human-readable summaries of proposed SKILL.md updates (pending proposals). */
  suggestedUpdates: string[];
  lastAnalyzed: string;
  /** Most recent invocation timestamp (staleness input). */
  lastUsed?: string;
  /** SKILL.md mtime when resolvable (staleness input). */
  lastUpdated?: string;
  /** 0-100: how much evidence backs this record. */
  confidence: number;
}

export interface SkillEnrichmentIndex {
  version: 1;
  computedAt: string;
  skills: Record<string, SkillEnrichmentRecord>;
}

export function skillEnrichmentIndexPath(target: string): string {
  return path.join(target, ENRICHMENT_INDEX_REL);
}

export function readSkillEnrichmentIndex(target: string): SkillEnrichmentIndex | undefined {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(skillEnrichmentIndexPath(target), "utf-8")
    ) as SkillEnrichmentIndex;
    if (parsed?.version === 1 && parsed.skills) return parsed;
  } catch {
    /* absent or corrupt — treated as no data */
  }
  return undefined;
}

export function writeSkillEnrichmentIndex(target: string, index: SkillEnrichmentIndex): void {
  try {
    const file = skillEnrichmentIndexPath(target);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(index, null, 2), "utf-8");
  } catch {
    /* non-fatal */
  }
}

// ── Phase 4: Secret redaction ─────────────────────────────────────────────────

const REDACTION_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Flag-value secrets: --password x / --token=x / -p x / --client-secret x
  {
    pattern:
      /((?:--?(?:password|passwd|pwd|token|secret|api-?key|client-secret|access-?key|private-?key|auth|credentials?)[= ]))(?:"[^"]*"|'[^']*'|\S+)/gi,
    replacement: "$1<redacted>",
  },
  // Assignments with secret-ish names (env vars, --from-literal, key=value args)
  {
    pattern: /\b([A-Za-z0-9_.-]*(?:secret|token|password|passwd|apikey|api[_-]key|credential)[A-Za-z0-9_.-]*)=(?:"[^"]*"|'[^']*'|\S+)/gi,
    replacement: "$1=<redacted>",
  },
  // Bearer tokens / JWTs
  { pattern: /\bBearer\s+\S+/gi, replacement: "Bearer <redacted>" },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]+/g, replacement: "<redacted-jwt>" },
  // Well-known credential shapes: AWS access keys, GitHub tokens, Slack tokens
  { pattern: /\bAKIA[A-Z0-9]{12,}/g, replacement: "<redacted-aws-key>" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replacement: "<redacted-gh-token>" },
  { pattern: /\bxox[a-z]-[A-Za-z0-9-]{10,}/g, replacement: "<redacted-slack-token>" },
  // Long opaque blobs (hex >= 32, base64-ish >= 40) — likely keys or hashes of secrets
  { pattern: /\b[0-9a-f]{32,}\b/gi, replacement: "<redacted-hex>" },
  { pattern: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, replacement: "<redacted-blob>" },
];

/** Removes secrets, credentials, and private values from a command or error string. */
export function redactSensitiveText(text: string): string {
  let out = text;
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

const MAX_STORED_COMMAND_LENGTH = 160;

/**
 * Trivial navigation/inspection commands carry no reusable pattern and often
 * embed private local paths — they are excluded from command mining.
 */
const LOW_SIGNAL_COMMANDS = new Set([
  "cd", "ls", "dir", "pwd", "echo", "cat", "type", "head", "tail", "which", "where",
]);

export function isLowSignalCommand(key: string): boolean {
  return LOW_SIGNAL_COMMANDS.has(key.split(" ")[0].toLowerCase());
}

/**
 * Normalizes a raw command for storage: trimmed, whitespace-collapsed,
 * redacted, capped. Leading `cd <dir> &&` / `cd <dir>;` prefixes are stripped
 * so compound commands keep only the meaningful operation (and drop the
 * private local path).
 */
export function normalizeCommand(raw: string): string {
  let collapsed = raw.trim().replace(/\s+/g, " ");
  // Strip chained directory changes: cd "path" && ..., cd path; ...
  for (let i = 0; i < 3; i++) {
    const stripped = collapsed.replace(/^cd (?:"[^"]*"|'[^']*'|\S+) *(?:&&|;) */i, "");
    if (stripped === collapsed) break;
    collapsed = stripped.trim();
  }
  return redactSensitiveText(collapsed).slice(0, MAX_STORED_COMMAND_LENGTH);
}

/**
 * Grouping key for a command: binary + subcommand (e.g. "kubectl get",
 * "terraform apply", "helm upgrade"). Flags and arguments are ignored so
 * variants of the same operation aggregate together.
 */
export function commandKey(normalized: string): string {
  const tokens = normalized.split(" ").filter((t) => t && !t.includes("="));
  if (tokens.length === 0) return normalized;
  const head = tokens[0].replace(/^.*[\\/]/, ""); // strip path prefixes
  const sub = tokens[1] && !tokens[1].startsWith("-") ? ` ${tokens[1]}` : "";
  return `${head}${sub}`;
}

// ── Phase 3: Technology signatures ────────────────────────────────────────────

interface TechnologySignature {
  technology: string;
  pattern: RegExp;
}

export const TECHNOLOGY_SIGNATURES: TechnologySignature[] = [
  { technology: "Kubernetes", pattern: /\bkubectl\b|\bk8s\b|kubernetes|\bkustomize\b/i },
  { technology: "Helm", pattern: /\bhelm\b|Chart\.yaml|values\.yaml/i },
  { technology: "ArgoCD", pattern: /\bargocd\b|\bargo-cd\b|applicationset/i },
  { technology: "Terraform", pattern: /\bterraform\b|\.tfvars?\b|\.tf\b|tfstate/i },
  { technology: "AWS", pattern: /\baws\b|\beks\b|\beksctl\b|cloudformation|\bs3:\/\//i },
  { technology: "AWS IAM", pattern: /\biam\b|\birsa\b|assume-?role|service-account-role/i },
  { technology: "Azure", pattern: /\baz\b |\bazure\b|\baks\b|\bbicep\b/i },
  { technology: "GCP", pattern: /\bgcloud\b|\bgke\b|\bgcp\b/i },
  { technology: "Docker", pattern: /\bdocker\b|Dockerfile|docker-compose/i },
  { technology: "Ingress", pattern: /\bingress\b|externaldns|cert-manager/i },
  { technology: "RBAC", pattern: /\brbac\b|rolebinding|clusterrole|serviceaccount/i },
  { technology: "K3s", pattern: /\bk3s\b|\bk3sup\b/i },
  { technology: "KubeRocketCI", pattern: /kuberocketci|\bkrci\b|\bedp\b|pipelinerun|tekton/i },
  { technology: "GitHub Actions", pattern: /\bgh run\b|github.actions|\.github[\\/]workflows/i },
  { technology: "GitLab CI", pattern: /\bgitlab\b|\.gitlab-ci\.yml/i },
  { technology: "Node.js", pattern: /\bnpm\b|\bnpx\b|\bnode\b|package\.json/i },
  { technology: "Vitest", pattern: /\bvitest\b/i },
  { technology: "TypeScript", pattern: /\btsc\b|tsconfig|\.ts\b/i },
  { technology: "Python", pattern: /\bpython3?\b|\bpip3?\b|\.py\b/i },
  { technology: "Git", pattern: /\bgit\b(?! ?hub)|\.git\b/i },
  { technology: "PowerShell", pattern: /powershell|\bpwsh\b|\.ps1\b/i },
  { technology: "VS Code Extension", pattern: /\bvsce\b|\bvsix\b|\bovsx\b/i },
];

/** Returns the technologies referenced by a text sample (command, path, note). */
export function detectTechnologies(text: string): string[] {
  const found: string[] = [];
  for (const sig of TECHNOLOGY_SIGNATURES) {
    if (sig.pattern.test(text)) found.push(sig.technology);
  }
  return found;
}

// ── Phase 5: Known issue patterns ─────────────────────────────────────────────

interface KnownIssue {
  problem: string;
  pattern: RegExp;
  cannedFixes: string[];
}

export const KNOWN_ISSUES: KnownIssue[] = [
  {
    problem: "ImagePullBackOff",
    pattern: /imagepullbackoff|errimagepull/i,
    cannedFixes: ["kubectl describe pod", "check image tag and registry", "verify imagePullSecrets"],
  },
  {
    problem: "CrashLoopBackOff",
    pattern: /crashloopbackoff/i,
    cannedFixes: ["kubectl describe pod", "check image pull", "verify secrets", "kubectl logs --previous"],
  },
  {
    problem: "OOMKilled",
    pattern: /oomkilled|out of memory/i,
    cannedFixes: ["raise container memory limit", "kubectl top pod"],
  },
  {
    problem: "Helm timeout",
    pattern: /helm.*(timed? ?out|timeout)|context deadline exceeded.*helm|release.*stuck/i,
    cannedFixes: ["helm rollback <release>", "increase --timeout", "kubectl get events -n <ns>"],
  },
  {
    problem: "Helm release conflict",
    pattern: /another operation.*in progress|release.*already exists|helm.*conflict/i,
    cannedFixes: ["helm rollback <release>", "helm history <release>", "delete stuck helm secret"],
  },
  {
    problem: "RBAC forbidden",
    pattern: /\bforbidden\b|rbac.*denied|cannot (get|list|create|delete) resource/i,
    cannedFixes: ["kubectl auth can-i", "check role and rolebinding", "verify serviceaccount"],
  },
  {
    problem: "Terraform provider mismatch",
    pattern: /provider.*(mismatch|version|constraint)|required_providers|terraform init.*failed/i,
    cannedFixes: ["terraform init -upgrade", "pin provider version in required_providers"],
  },
  {
    problem: "Terraform state lock",
    pattern: /state.*lock|lock.*acquire|force-unlock/i,
    cannedFixes: ["terraform force-unlock <lock-id>", "verify no concurrent apply"],
  },
  {
    problem: "ArgoCD sync timeout",
    pattern: /argocd.*(sync.*(fail|timeout)|out.?of.?sync|degraded)/i,
    cannedFixes: ["argocd app get <app>", "kubectl describe application -n argocd", "argocd app sync <app>"],
  },
  {
    problem: "Module resolution failure",
    pattern: /cannot find module|module not found|err_module_not_found/i,
    cannedFixes: ["npm install", "check import path and tsconfig paths"],
  },
  {
    problem: "Port already in use",
    pattern: /eaddrinuse|address already in use|port.*in use/i,
    cannedFixes: ["find and stop the process holding the port", "use a different port"],
  },
  {
    problem: "File or path not found",
    pattern: /\benoent\b|no such file or directory/i,
    cannedFixes: ["verify the path exists", "create parent directories first"],
  },
  {
    problem: "Permission denied",
    pattern: /\beacces\b|permission denied|access is denied/i,
    cannedFixes: ["check file/directory permissions", "run with the required identity"],
  },
  {
    problem: "Test timeout",
    pattern: /test.*(timed? ?out|timeout)|timeout.*exceeded.*test/i,
    cannedFixes: ["raise testTimeout", "check for unresolved promises or missing await"],
  },
];

/** Matches text against the known issue library; returns the problems found. */
export function detectKnownIssues(text: string): string[] {
  const found: string[] = [];
  for (const issue of KNOWN_ISSUES) {
    if (issue.pattern.test(text)) found.push(issue.problem);
  }
  return found;
}

// ── Phase 2: Success pattern extraction ──────────────────────────────────────

interface SessionAttribution {
  /** sessionId -> skills invoked in that session */
  skillsBySession: Map<string, Set<string>>;
  /** skill -> sessionIds where the skill had at least one successful run */
  successSessionsBySkill: Map<string, Set<string>>;
  /** skill -> all sessionIds where the skill ran */
  sessionsBySkill: Map<string, Set<string>>;
}

function buildSessionAttribution(target: string): SessionAttribution {
  const skillsBySession = new Map<string, Set<string>>();
  const successSessionsBySkill = new Map<string, Set<string>>();
  const sessionsBySkill = new Map<string, Set<string>>();

  for (const run of readCachedEnrichedRuns(target)) {
    if (run.metadata?.invoked !== true) continue;
    const bySession = skillsBySession.get(run.session_id) ?? new Set<string>();
    bySession.add(run.skill);
    skillsBySession.set(run.session_id, bySession);

    const sessions = sessionsBySkill.get(run.skill) ?? new Set<string>();
    sessions.add(run.session_id);
    sessionsBySkill.set(run.skill, sessions);

    if (run.success) {
      const ok = successSessionsBySkill.get(run.skill) ?? new Set<string>();
      ok.add(run.session_id);
      successSessionsBySkill.set(run.skill, ok);
    }
  }
  return { skillsBySession, successSessionsBySkill, sessionsBySkill };
}

function isCommandEntry(e: McpUsageEntry): boolean {
  return e.server === "cli" || e.server === "bash" || e.tool.startsWith("cli:") || e.tool.startsWith("bash:");
}

function commandTextOf(e: McpUsageEntry): string | undefined {
  if (typeof e.command === "string" && e.command.trim()) return e.command;
  // CLI server entries carry the binary in `cli`; without args they still count as usage.
  if (typeof e.cli === "string" && e.cli.trim()) return e.cli;
  return undefined;
}

function commandSucceeded(e: McpUsageEntry): boolean {
  if (e.timedOut) return false;
  if (typeof e.exitCode === "number") return e.exitCode === 0;
  return !e.error;
}

const MAX_FILES_PER_SKILL = 10;
const MAX_COMMANDS_PER_SKILL = 10;
const MAX_TECHNOLOGIES_PER_SKILL = 12;
const MAX_TROUBLESHOOTING_PER_SKILL = 8;
export const MIN_EVIDENCE_FOR_SUGGESTION = 3;

function confidenceFromCounts(success: number, failure: number): number {
  const total = success + failure;
  if (total === 0) return 0;
  const ratio = success / total;
  // Volume factor: 1 observation -> 0.4, 5+ observations -> 1.0
  const volume = Math.min(1, 0.4 + total * 0.12);
  return Math.round(ratio * volume * 100);
}

/**
 * Phase 2 core: mine per-skill usage patterns from runs.jsonl, mcp-usage.jsonl,
 * skill-feedback.jsonl, and adoption events. Successful sessions drive file /
 * command / technology extraction; troubleshooting also inspects failures.
 */
export function analyzeSkillEnrichment(
  target: string,
  skillNames: string[]
): SkillEnrichmentIndex {
  const attribution = buildSessionAttribution(target);
  const mcpEntries = readMcpUsageLog(workspaceMcpLogPath(target));
  const feedback = readSkillFeedbackRecords(target);
  const runs = readCachedEnrichedRuns(target);
  const proposals = readEnrichmentProposals(target);

  // Group MCP entries by session once.
  const mcpBySession = new Map<string, McpUsageEntry[]>();
  for (const e of mcpEntries) {
    if (!e.sessionId) continue;
    const arr = mcpBySession.get(e.sessionId) ?? [];
    arr.push(e);
    mcpBySession.set(e.sessionId, arr);
  }

  const skills: Record<string, SkillEnrichmentRecord> = {};

  for (const skill of skillNames) {
    const allSessions = attribution.sessionsBySkill.get(skill) ?? new Set<string>();
    const successSessions = attribution.successSessionsBySkill.get(skill) ?? new Set<string>();
    const skillRuns = runs.filter((r) => r.skill === skill && r.metadata?.invoked === true);
    const usageCount = skillRuns.length;
    const successCount = skillRuns.filter((r) => r.success).length;

    // ── Files + commands + technologies from successful sessions ────────────
    const fileCounts = new Map<string, number>();
    const cmdStats = new Map<string, { command: string; success: number; failure: number }>();
    const techCounts = new Map<string, number>();

    for (const sessionId of successSessions) {
      for (const e of mcpBySession.get(sessionId) ?? []) {
        // Files: filesystem entries with a path
        if (!isCommandEntry(e) && typeof e.path === "string" && e.path.trim()) {
          const p = e.path.replace(/\\/g, "/");
          fileCounts.set(p, (fileCounts.get(p) ?? 0) + 1);
          for (const tech of detectTechnologies(p)) {
            techCounts.set(tech, (techCounts.get(tech) ?? 0) + 1);
          }
          continue;
        }
        // Commands: CLI / bash entries
        if (isCommandEntry(e)) {
          const raw = commandTextOf(e);
          if (!raw) continue;
          const normalized = normalizeCommand(raw);
          if (!normalized) continue;
          const key = commandKey(normalized);
          if (isLowSignalCommand(key)) continue;
          const stat = cmdStats.get(key) ?? { command: normalized, success: 0, failure: 0 };
          if (commandSucceeded(e)) stat.success++;
          else stat.failure++;
          cmdStats.set(key, stat);
          for (const tech of detectTechnologies(normalized)) {
            techCounts.set(tech, (techCounts.get(tech) ?? 0) + 1);
          }
        }
      }
    }

    // Technologies also observable from the skill's own run metadata
    for (const run of skillRuns.filter((r) => r.success)) {
      const context = [run.skill, run.metadata?.task_type, run.hint, run.note]
        .filter(Boolean)
        .join(" ");
      for (const tech of detectTechnologies(String(context))) {
        techCounts.set(tech, (techCounts.get(tech) ?? 0) + 1);
      }
    }

    // ── Troubleshooting: errors from runs + feedback, fixes from recoveries ─
    const issueCounts = new Map<string, number>();
    const issueFixes = new Map<string, Set<string>>();
    const rawErrors = new Map<string, number>();

    const recordIssueSource = (text: string, sessionId?: string) => {
      const redacted = redactSensitiveText(text).slice(0, 200);
      for (const problem of detectKnownIssues(redacted)) {
        issueCounts.set(problem, (issueCounts.get(problem) ?? 0) + 1);
        const fixes = issueFixes.get(problem) ?? new Set<string>();
        // Observed fixes: successful commands later in the same session
        if (sessionId) {
          for (const e of mcpBySession.get(sessionId) ?? []) {
            if (!isCommandEntry(e) || !commandSucceeded(e)) continue;
            const raw = commandTextOf(e);
            if (raw) fixes.add(commandKey(normalizeCommand(raw)));
            if (fixes.size >= 3) break;
          }
        }
        // Canned fixes from the issue library fill remaining slots
        for (const fix of KNOWN_ISSUES.find((i) => i.problem === problem)?.cannedFixes ?? []) {
          if (fixes.size >= 5) break;
          fixes.add(fix);
        }
        issueFixes.set(problem, fixes);
      }
      if (redacted.trim()) rawErrors.set(redacted, (rawErrors.get(redacted) ?? 0) + 1);
    };

    for (const run of skillRuns) {
      if (run.error) recordIssueSource(run.error, run.session_id);
      if (!run.success && run.hint) recordIssueSource(run.hint, run.session_id);
    }
    for (const f of feedback.filter((f) => f.skill === skill)) {
      const text = [f.user_text, f.context].filter(Boolean).join(" ");
      if (text) recordIssueSource(text);
    }

    const troubleshooting: TroubleshootingEntry[] = [...issueCounts.entries()]
      .map(([problem, count]) => ({
        problem,
        count,
        successfulFixes: [...(issueFixes.get(problem) ?? [])].slice(0, 5),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_TROUBLESHOOTING_PER_SKILL);

    const frequentlyUsedCommands: CommandUsageEntry[] = [...cmdStats.values()]
      .map((s) => ({
        command: s.command,
        successCount: s.success,
        failureCount: s.failure,
        confidence: confidenceFromCounts(s.success, s.failure),
      }))
      .sort((a, b) => b.successCount - a.successCount || b.confidence - a.confidence)
      .slice(0, MAX_COMMANDS_PER_SKILL);

    const relatedTechnologies: TechnologyAffinity[] = [...techCounts.entries()]
      .map(([technology, frequency]) => ({
        technology,
        frequency,
        confidence: Math.min(99, Math.round(30 + Math.min(frequency, 10) * 6 + (successCount > 0 ? 10 : 0))),
      }))
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, MAX_TECHNOLOGIES_PER_SKILL);

    // ── Staleness inputs ─────────────────────────────────────────────────────
    const lastUsed = skillRuns.map((r) => r.ts).sort().pop();
    let lastUpdated: string | undefined;
    try {
      const md = path.join(target, ".claude", "skills", skill, "SKILL.md");
      lastUpdated = fs.statSync(md).mtime.toISOString();
    } catch {
      /* not installed in the workspace — leave undefined */
    }

    const suggestedUpdates = proposals
      .filter((p) => p.skill === skill && (p.status === "pending" || p.status === "approved"))
      .map((p) => p.sectionTitle);

    const evidenceVolume =
      frequentlyUsedCommands.length + relatedTechnologies.length + troubleshooting.length;
    const successRate = usageCount > 0 ? successCount / usageCount : 0;
    const confidence = Math.min(
      99,
      Math.round(successRate * 40 + Math.min(usageCount, 20) * 2 + Math.min(evidenceVolume, 10) * 2)
    );

    skills[skill] = {
      skill,
      usageCount,
      successCount,
      frequentlyUsedFiles: [...fileCounts.entries()]
        .map(([p, count]) => ({ path: p, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, MAX_FILES_PER_SKILL),
      frequentlyUsedCommands,
      commonErrors: [...rawErrors.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([text]) => text),
      commonFixes: troubleshooting.flatMap((t) => t.successfulFixes).slice(0, 8),
      relatedTechnologies,
      troubleshooting,
      suggestedUpdates,
      lastAnalyzed: new Date().toISOString(),
      lastUsed,
      lastUpdated,
      confidence,
    };
  }

  const index: SkillEnrichmentIndex = {
    version: 1,
    computedAt: new Date().toISOString(),
    skills,
  };
  writeSkillEnrichmentIndex(target, index);
  return index;
}

// ── Phase 6: Data-driven update generation ───────────────────────────────────

function commandsSectionMarkdown(record: SkillEnrichmentRecord): string {
  const rows = record.frequentlyUsedCommands
    .filter((c) => c.successCount >= 1)
    .slice(0, 8)
    .map((c) => `- \`${c.command}\` — ${c.successCount} successful use(s), ${c.confidence}% confidence`);
  return `## Frequently Used Commands

Commands proven in real sessions with this skill:

${rows.join("\n")}`;
}

function troubleshootingSectionMarkdown(record: SkillEnrichmentRecord): string {
  const rows = record.troubleshooting
    .slice(0, 6)
    .map(
      (t) =>
        `### ${t.problem} (observed ${t.count}x)\n` +
        t.successfulFixes.map((f) => `- ${f}`).join("\n")
    );
  return `## Common Deployment Failures

Recurring issues observed with this skill and fixes that worked:

${rows.join("\n\n")}`;
}

/**
 * Builds enrichment candidates from mined evidence (in addition to the static
 * pattern-library candidates). Never applied automatically — these flow into
 * the same generateEnrichmentProposals review pipeline.
 */
export function buildDataDrivenCandidates(
  target: string,
  index?: SkillEnrichmentIndex
): EnrichmentCandidate[] {
  const idx = index ?? readSkillEnrichmentIndex(target);
  if (!idx) return [];
  const candidates: EnrichmentCandidate[] = [];

  for (const record of Object.values(idx.skills)) {
    const successRate = record.usageCount > 0 ? record.successCount / record.usageCount : 0;

    const provenCommands = record.frequentlyUsedCommands.filter((c) => c.successCount >= 1);
    const commandEvidence = provenCommands.reduce((s, c) => s + c.successCount, 0);
    if (provenCommands.length >= 2 && commandEvidence >= MIN_EVIDENCE_FOR_SUGGESTION) {
      candidates.push({
        skill: record.skill,
        patternId: "mined-commands",
        patternLabel: "Frequently Used Commands (mined)",
        occurrences: commandEvidence,
        successRate,
        confidence: Math.min(0.99, 0.5 + successRate * 0.25 + Math.min(commandEvidence, 10) * 0.02),
        sectionTitle: "Frequently Used Commands",
        proposedContent: commandsSectionMarkdown(record),
        affectedFiles: record.frequentlyUsedFiles.slice(0, 3).map((f) => f.path),
        typicalCommands: provenCommands.slice(0, 5).map((c) => c.command),
      });
    }

    const troubleshootingEvidence = record.troubleshooting.reduce((s, t) => s + t.count, 0);
    if (record.troubleshooting.length >= 1 && troubleshootingEvidence >= MIN_EVIDENCE_FOR_SUGGESTION) {
      candidates.push({
        skill: record.skill,
        patternId: "mined-troubleshooting",
        patternLabel: "Common Deployment Failures (mined)",
        occurrences: troubleshootingEvidence,
        successRate,
        confidence: Math.min(0.99, 0.45 + Math.min(troubleshootingEvidence, 10) * 0.04),
        sectionTitle: "Common Deployment Failures",
        proposedContent: troubleshootingSectionMarkdown(record),
        affectedFiles: record.frequentlyUsedFiles.slice(0, 3).map((f) => f.path),
        typicalCommands: record.commonFixes.slice(0, 5),
      });
    }
  }

  return candidates.sort((a, b) => b.occurrences - a.occurrences);
}

// ── Phase 10: Staleness detection ────────────────────────────────────────────

export const STALENESS_DAYS = 90;
export const STALENESS_MIN_USAGE = 5;
const DAY_MS = 86_400_000;

export interface StaleSkillWarning {
  skill: string;
  usageCount: number;
  lastUsed?: string;
  lastUpdated?: string;
  daysSinceUpdate: number;
  message: string;
}

/**
 * A skill is stale when it is used heavily (>= STALENESS_MIN_USAGE invocations,
 * used within the last 30 days) but its SKILL.md has not changed for 90+ days.
 */
export function detectStaleSkills(
  target: string,
  index?: SkillEnrichmentIndex,
  nowMs = Date.now()
): StaleSkillWarning[] {
  const idx = index ?? readSkillEnrichmentIndex(target);
  if (!idx) return [];
  const warnings: StaleSkillWarning[] = [];

  for (const record of Object.values(idx.skills)) {
    if (record.usageCount < STALENESS_MIN_USAGE) continue;
    if (!record.lastUpdated) continue;
    const daysSinceUpdate = Math.floor((nowMs - new Date(record.lastUpdated).getTime()) / DAY_MS);
    if (daysSinceUpdate < STALENESS_DAYS) continue;
    // Only warn for skills that are actively used — dormant skills are archival's job.
    const recentlyUsed =
      record.lastUsed && nowMs - new Date(record.lastUsed).getTime() <= 30 * DAY_MS;
    if (!recentlyUsed) continue;

    warnings.push({
      skill: record.skill,
      usageCount: record.usageCount,
      lastUsed: record.lastUsed,
      lastUpdated: record.lastUpdated,
      daysSinceUpdate,
      message: `Skill may be outdated: used ${record.usageCount}x but SKILL.md unchanged for ${daysSinceUpdate} days. Consider enrichment.`,
    });
  }
  return warnings.sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate);
}

// ── Phase 8: Enrichment impact (before/after adoption deltas) ────────────────

export interface EnrichmentImpactMetrics {
  acceptancePct: number;
  successPct: number;
  reusePct: number;
}

export interface EnrichmentImpact {
  skill: string;
  enrichedAt: string;
  before: EnrichmentImpactMetrics;
  after: EnrichmentImpactMetrics;
  delta: EnrichmentImpactMetrics;
  /** Adoption events observed after enrichment — low counts mean low-signal deltas. */
  afterEventCount: number;
}

export interface EnrichmentImpactIndex {
  version: 1;
  computedAt: string;
  impacts: EnrichmentImpact[];
}

export function enrichmentImpactPath(target: string): string {
  return path.join(target, ENRICHMENT_IMPACT_REL);
}

function pct(numer: number, denom: number): number {
  return denom > 0 ? Math.round((numer / denom) * 100) : 0;
}

function adoptionMetricsForWindow(
  events: ReturnType<typeof readAdoptionEvents>,
  skill: string,
  fromMs: number,
  toMs: number
): { metrics: EnrichmentImpactMetrics; eventCount: number } {
  const inWindow = events.filter((e) => {
    if (e.skill !== skill) return false;
    const t = new Date(e.timestamp).getTime();
    return t >= fromMs && t < toMs;
  });
  const count = (t: string) => inWindow.filter((e) => e.event === t).length;
  const proposed = count("proposed");
  const accepted = count("accepted");
  const invoked = count("invoked");
  const successful = count("successful");
  const reused = count("reused");
  return {
    metrics: {
      acceptancePct: pct(accepted, proposed),
      successPct: pct(successful, invoked),
      reusePct: pct(reused, successful),
    },
    eventCount: inWindow.length,
  };
}

/**
 * For every applied enrichment proposal, compares adoption metrics before vs
 * after the apply date and stores the deltas (Phase 8 feedback loop).
 */
export function computeEnrichmentImpact(target: string, nowMs = Date.now()): EnrichmentImpactIndex {
  const applied = readEnrichmentProposals(target).filter((p) => p.status === "applied");
  const events = readAdoptionEvents(target);
  const impacts: EnrichmentImpact[] = [];

  // One impact per skill, anchored at its earliest applied enrichment.
  const earliestBySkill = new Map<string, string>();
  for (const p of applied) {
    const at = p.reviewedAt ?? p.ts;
    const cur = earliestBySkill.get(p.skill);
    if (!cur || at < cur) earliestBySkill.set(p.skill, at);
  }

  for (const [skill, enrichedAt] of earliestBySkill.entries()) {
    const anchorMs = new Date(enrichedAt).getTime();
    const before = adoptionMetricsForWindow(events, skill, 0, anchorMs);
    const after = adoptionMetricsForWindow(events, skill, anchorMs, nowMs);
    impacts.push({
      skill,
      enrichedAt,
      before: before.metrics,
      after: after.metrics,
      delta: {
        acceptancePct: after.metrics.acceptancePct - before.metrics.acceptancePct,
        successPct: after.metrics.successPct - before.metrics.successPct,
        reusePct: after.metrics.reusePct - before.metrics.reusePct,
      },
      afterEventCount: after.eventCount,
    });
  }

  const index: EnrichmentImpactIndex = {
    version: 1,
    computedAt: new Date().toISOString(),
    impacts: impacts.sort((a, b) => b.delta.successPct - a.delta.successPct),
  };
  try {
    fs.mkdirSync(path.dirname(enrichmentImpactPath(target)), { recursive: true });
    fs.writeFileSync(enrichmentImpactPath(target), JSON.stringify(index, null, 2), "utf-8");
  } catch {
    /* non-fatal */
  }
  return index;
}

// ── Phase 11: Recommendation boosting ─────────────────────────────────────────

export const ENRICHMENT_BOOST_CAP = 20;
export const RECENT_ENRICHMENT_DAYS = 30;

export interface RecommendationBoost {
  /** +15 when an enrichment was applied to the skill within the last 30 days. */
  enrichmentBonus: number;
  /** Up to +12 from mined success rate (needs >= 3 invocations). */
  successBonus: number;
  /** Up to +10 from adoption reuse events. */
  reuseBonus: number;
  /** -10 when the skill is flagged stale (heavy use, outdated content). */
  stalenessPenalty: number;
  /** Sum of the components, clamped to +/-ENRICHMENT_BOOST_CAP. */
  total: number;
}

/**
 * Full Phase 11 boost breakdown. Ranking integration applies only
 * enrichmentBonus + stalenessPenalty (the success and reuse components are
 * already fed into ranking by the adoption feedback loop in skillAdoption.ts;
 * counting them twice would double-weight the same evidence).
 */
export function computeRecommendationBoost(
  target: string,
  skill: string,
  nowMs = Date.now()
): RecommendationBoost {
  const idx = readSkillEnrichmentIndex(target);
  const record = idx?.skills[skill];

  // Enrichment recency
  let enrichmentBonus = 0;
  const applied = readEnrichmentProposals(target).filter(
    (p) => p.skill === skill && p.status === "applied"
  );
  const latestApplied = applied
    .map((p) => new Date(p.reviewedAt ?? p.ts).getTime())
    .sort((a, b) => b - a)[0];
  if (latestApplied && nowMs - latestApplied <= RECENT_ENRICHMENT_DAYS * DAY_MS) {
    enrichmentBonus = 15;
  }

  // Success (mined profile)
  let successBonus = 0;
  if (record && record.usageCount >= 3) {
    successBonus = Math.round((record.successCount / record.usageCount) * 12);
  }

  // Reuse (adoption events)
  const reuseCount = readAdoptionEvents(target).filter(
    (e) => e.skill === skill && e.event === "reused"
  ).length;
  const reuseBonus = Math.min(10, reuseCount * 3);

  // Staleness
  const stale = detectStaleSkills(target, idx, nowMs).some((w) => w.skill === skill);
  const stalenessPenalty = stale ? -10 : 0;

  const raw = enrichmentBonus + successBonus + reuseBonus + stalenessPenalty;
  const total = Math.max(-ENRICHMENT_BOOST_CAP, Math.min(ENRICHMENT_BOOST_CAP, raw));
  return { enrichmentBonus, successBonus, reuseBonus, stalenessPenalty, total };
}

/**
 * The slice of the Phase 11 boost applied in proposal ranking: enrichment
 * recency and staleness only (see computeRecommendationBoost docs).
 *
 * Ranking calls this once per manifest skill on the prompt hot path, so the
 * inputs (recently-enriched set, stale set) are cached for a few seconds
 * instead of re-reading the learning files per skill.
 */
interface RankingBoostCache {
  expiresAt: number;
  recentlyEnriched: Set<string>;
  stale: Set<string>;
}

const _rankingBoostCache = new Map<string, RankingBoostCache>();
const RANKING_BOOST_CACHE_TTL_MS = 10_000;

/** Test hook: clears the ranking-boost cache. */
export function invalidateEnrichmentRankingCache(target?: string): void {
  if (target) _rankingBoostCache.delete(path.resolve(target));
  else _rankingBoostCache.clear();
}

function rankingBoostInputs(target: string, nowMs: number): RankingBoostCache {
  const key = path.resolve(target);
  const hit = _rankingBoostCache.get(key);
  if (hit && hit.expiresAt > nowMs) return hit;

  const recentlyEnriched = new Set<string>();
  for (const p of readEnrichmentProposals(target)) {
    if (p.status !== "applied") continue;
    const at = new Date(p.reviewedAt ?? p.ts).getTime();
    if (nowMs - at <= RECENT_ENRICHMENT_DAYS * DAY_MS) recentlyEnriched.add(p.skill);
  }
  const stale = new Set(detectStaleSkills(target, undefined, nowMs).map((w) => w.skill));

  const entry: RankingBoostCache = {
    expiresAt: nowMs + RANKING_BOOST_CACHE_TTL_MS,
    recentlyEnriched,
    stale,
  };
  _rankingBoostCache.set(key, entry);
  return entry;
}

export function enrichmentRankingAdjustment(target: string, skill: string, nowMs = Date.now()): number {
  const inputs = rankingBoostInputs(target, nowMs);
  return (inputs.recentlyEnriched.has(skill) ? 15 : 0) + (inputs.stale.has(skill) ? -10 : 0);
}

// ── Phase 9: Dashboard panel ──────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatEnrichmentIntelligencePanelHtml(target: string): string {
  const idx = readSkillEnrichmentIndex(target);
  const proposals = readEnrichmentProposals(target);
  const pending = proposals.filter((p) => p.status === "pending").length;
  const enrichedSkills = new Set(
    proposals.filter((p) => p.status === "applied").map((p) => p.skill)
  );

  if (!idx || Object.keys(idx.skills).length === 0) {
    return `<div class="panel" style="margin-top:6px">
  <h2 style="margin-top:0">Skill Enrichment Intelligence</h2>
  <p class="note">No enrichment analysis yet — run "Claude Skills: Run Skill Enrichment Pipeline" after a few skill invocations.</p>
</div>`;
  }

  const records = Object.values(idx.skills);
  const analyzed = records.length;
  const withUsage = records.filter((r) => r.usageCount > 0);

  const topLearning = [...withUsage]
    .sort(
      (a, b) =>
        b.relatedTechnologies.length + b.frequentlyUsedCommands.length -
        (a.relatedTechnologies.length + a.frequentlyUsedCommands.length)
    )
    .slice(0, 5);

  const impact = computeEnrichmentImpact(target);
  const mostImproved = impact.impacts
    .filter((i) => i.afterEventCount >= 3 && (i.delta.successPct > 0 || i.delta.acceptancePct > 0))
    .slice(0, 5);

  const stale = detectStaleSkills(target, idx);

  const summary = `<div class="stat-grid" style="margin-bottom:10px">
  <div class="stat-pill"><b>Skills Analyzed</b><span class="val">${analyzed}</span></div>
  <div class="stat-pill"><b>Skills Enriched</b><span class="val roi-high">${enrichedSkills.size}</span></div>
  <div class="stat-pill"><b>Pending Suggestions</b><span class="val ${pending > 0 ? "roi-medium" : ""}">${pending}</span></div>
  <div class="stat-pill"><b>Stale Skills</b><span class="val ${stale.length > 0 ? "roi-low" : "roi-high"}">${stale.length}</span></div>
</div>`;

  const learningRows = topLearning
    .map((r) => {
      const successPct = r.usageCount > 0 ? Math.round((r.successCount / r.usageCount) * 100) : 0;
      const techs = r.relatedTechnologies.slice(0, 4).map((t) => esc(t.technology)).join(", ");
      return `<div class="skill-row"><div class="skill-head">
      <b>${esc(r.skill)}</b>
      <span class="cost">Usage: ${r.usageCount}</span>
      <span class="cost">Success: ${successPct}%</span>
      <span class="cost">Suggested Updates: ${r.suggestedUpdates.length}</span>
      <span class="val">${r.confidence}%</span>
      </div>
      ${techs ? `<div class="hint">Technologies: ${techs}</div>` : ""}
      </div>`;
    })
    .join("") || `<p class="note">No skill usage mined yet.</p>`;

  const improvedRows = mostImproved
    .map(
      (i) => `<div class="skill-row"><div class="skill-head">
    <b>${esc(i.skill)}</b>
    <span class="cost roi-high">success ${i.delta.successPct >= 0 ? "+" : ""}${i.delta.successPct}%</span>
    <span class="cost">acceptance ${i.delta.acceptancePct >= 0 ? "+" : ""}${i.delta.acceptancePct}%</span>
    <span class="cost">reuse ${i.delta.reusePct >= 0 ? "+" : ""}${i.delta.reusePct}%</span>
    </div>
    <div class="hint">Enriched ${esc(i.enrichedAt.slice(0, 10))} · before/after adoption comparison</div>
    </div>`
    )
    .join("") || `<p class="note">No measurable post-enrichment improvements yet.</p>`;

  const staleRows = stale
    .slice(0, 5)
    .map(
      (w) => `<div class="skill-row"><div class="skill-head">
    <b>${esc(w.skill)}</b>
    <span class="cost roi-low">${w.daysSinceUpdate}d since update</span>
    <span class="cost">${w.usageCount} uses</span>
    </div>
    <div class="hint">${esc(w.message)}</div>
    </div>`
    )
    .join("") || `<p class="note">No stale skills detected.</p>`;

  const section = (title: string, body: string) => `<details style="margin-bottom:8px">
    <summary style="cursor:pointer;font-size:12px;font-weight:600">${title}</summary>
    <div style="margin-top:6px">${body}</div>
  </details>`;

  return `<div class="panel" style="margin-top:6px">
  <h2 style="margin-top:0">Skill Enrichment Intelligence</h2>
  ${summary}
  ${section("Top Learning Skills", learningRows)}
  ${section("Most Improved Skills", improvedRows)}
  ${section("Most Stale Skills", staleRows)}
</div>`;
}
