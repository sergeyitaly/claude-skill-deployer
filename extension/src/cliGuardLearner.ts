/**
 * Learns self-correcting CLI guard patterns from accumulated failure logs.
 *
 * Reads mcp-usage.jsonl, groups non-zero-exit entries by (cli, exitCode,
 * stderrSignature), and writes new entries to cli-guard-patterns.json when
 * a signature is seen >= MIN_OCCURRENCES times.
 *
 * Known signatures get a concrete hint. Unknown ones get hint: "NEEDS_REVIEW"
 * so the agent can fill them in without any code change.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MCP_USAGE_LOG = path.join(os.homedir(), ".claude", "learning", "mcp-usage.jsonl");
const LEARNED_PATTERNS_PATH = path.join(os.homedir(), ".claude", "learning", "cli-guard-patterns.json");

const MIN_OCCURRENCES = 2;
const SNIPPET_KEY_LEN = 80; // chars used to group similar stderrSnippets

export interface LearnedPattern {
  id: string;
  clis: string[];
  exitCode: number | null;
  stderrSubstring: string;
  hint: string;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  needsReview?: boolean;
}

export interface LearnerResult {
  newPatterns: number;
  updatedPatterns: number;
  needsReview: number;
}

// ---------------------------------------------------------------------------
// Known-signature hints — mirrors CLI_GUARD_PATTERNS logic but for substrings
// ---------------------------------------------------------------------------

interface KnownSignature {
  clis?: string[];
  stderrSubstring: string;
  hint: string;
}

const KNOWN_SIGNATURES: KnownSignature[] = [
  {
    clis: ["terraform"],
    stderrSubstring: "ed25519",
    hint:
      "Azure rejected the ed25519 SSH key. Regenerate with RSA-4096:\n" +
      "  ssh-keygen -t rsa -b 4096 -f <path> -N \"\"",
  },
  {
    stderrSubstring: "AuthorizationFailed",
    hint:
      "Authorization failed (403). The executing identity lacks the required role.\n" +
      "→ Invoke skill: azure-rbac-diagnostics",
  },
  {
    stderrSubstring: "does not have authorization",
    hint:
      "Authorization failed — identity lacks the required RBAC role.\n" +
      "→ Invoke skill: azure-rbac-diagnostics",
  },
  {
    stderrSubstring: "403 Forbidden",
    hint: "403 Forbidden — check IAM/RBAC role assignments for the executing identity.",
  },
  {
    clis: ["kubectl", "helm"],
    stderrSubstring: "connection refused",
    hint:
      "Kubernetes connection refused. Check kubeconfig and cluster API server:\n" +
      "  kubectl config current-context",
  },
  {
    clis: ["kubectl", "helm"],
    stderrSubstring: "Unable to connect",
    hint:
      "Cannot reach Kubernetes cluster. Verify kubeconfig and cluster is running.",
  },
  {
    clis: ["git"],
    stderrSubstring: "CONFLICT",
    hint:
      "Git merge conflict detected. Resolve conflicts in the affected files, then:\n" +
      "  git add <resolved-files> && git commit",
  },
  {
    clis: ["git"],
    stderrSubstring: "index.lock",
    hint:
      "Git index is locked by another process. If no git operation is running:\n" +
      "  Remove-Item .git/index.lock  (PowerShell) or  rm .git/index.lock  (bash)",
  },
  {
    clis: ["gh"],
    stderrSubstring: "not logged in",
    hint: "GitHub CLI not authenticated. Run: gh auth login",
  },
  {
    clis: ["gh"],
    stderrSubstring: "gh auth login",
    hint: "GitHub CLI authentication required. Run: gh auth login",
  },
  {
    stderrSubstring: "timed out",
    hint:
      "Command timed out. Increase the timeout parameter (max 1800000 ms = 30 min) " +
      "or break the operation into smaller steps.",
  },
  {
    stderrSubstring: "ResourceNotFound",
    hint:
      "Azure resource not found. Verify the resource name, resource group, and subscription.\n" +
      "Run: az account show  to confirm the active subscription.",
  },
  {
    stderrSubstring: "InvalidResourceGroupLocation",
    hint:
      "The resource group region doesn't support this resource. " +
      "Check available regions: az account list-locations --output table",
  },
  {
    stderrSubstring: "QuotaExceeded",
    hint:
      "Azure quota exceeded. Request a quota increase in the Azure portal " +
      "or use a different region.",
  },
];

function matchKnownSignature(cli: string, snippet: string): string | null {
  for (const sig of KNOWN_SIGNATURES) {
    if (sig.clis && sig.clis.length > 0 && !sig.clis.includes(cli)) continue;
    if (snippet.toLowerCase().includes(sig.stderrSubstring.toLowerCase())) {
      return sig.hint;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Failure log reader
// ---------------------------------------------------------------------------

interface UsageEntry {
  ts?: string;
  cli?: string;
  exitCode?: number;
  stderrSnippet?: string;
}

function readFailures(logPath: string): UsageEntry[] {
  if (!fs.existsSync(logPath)) return [];
  try {
    return fs
      .readFileSync(logPath, "utf-8")
      .split("\n")
      .filter(Boolean)
      .reduce<UsageEntry[]>((acc, line) => {
        try {
          const e = JSON.parse(line) as UsageEntry;
          if (typeof e.exitCode === "number" && e.exitCode !== 0 && e.cli && e.stderrSnippet) {
            acc.push(e);
          }
        } catch { /* skip malformed lines */ }
        return acc;
      }, []);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Pattern file I/O
// ---------------------------------------------------------------------------

function loadLearnedPatterns(): LearnedPattern[] {
  if (!fs.existsSync(LEARNED_PATTERNS_PATH)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(LEARNED_PATTERNS_PATH, "utf-8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveLearnedPatterns(patterns: LearnedPattern[]): void {
  fs.mkdirSync(path.dirname(LEARNED_PATTERNS_PATH), { recursive: true });
  fs.writeFileSync(LEARNED_PATTERNS_PATH, JSON.stringify(patterns, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Core learner
// ---------------------------------------------------------------------------

export function analyzeCliFailures(): LearnerResult {
  const failures = readFailures(MCP_USAGE_LOG);
  if (failures.length === 0) return { newPatterns: 0, updatedPatterns: 0, needsReview: 0 };

  // Group by (cli, exitCode, stderrKey)
  const groups = new Map<string, UsageEntry[]>();
  for (const f of failures) {
    const stderrKey = f.stderrSnippet!.slice(0, SNIPPET_KEY_LEN).replace(/\s+/g, " ").trim();
    const key = `${f.cli}|${f.exitCode}|${stderrKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }

  const existing = loadLearnedPatterns();
  const existingByKey = new Map<string, LearnedPattern>(existing.map((p) => [p.id, p]));

  let newPatterns = 0;
  let updatedPatterns = 0;

  for (const [key, entries] of groups) {
    if (entries.length < MIN_OCCURRENCES) continue;

    const [cli, exitCodeStr, stderrKey] = key.split("|");
    const exitCode = Number.parseInt(exitCodeStr, 10);
    const patternId = `learned-${Buffer.from(key).toString("base64url").slice(0, 16)}`;

    if (existingByKey.has(patternId)) {
      const p = existingByKey.get(patternId)!;
      if (p.occurrences !== entries.length) {
        p.occurrences = entries.length;
        p.lastSeen = entries[entries.length - 1].ts ?? new Date().toISOString();
        updatedPatterns++;
      }
      continue;
    }

    const snippet = entries[0].stderrSnippet!;
    const knownHint = matchKnownSignature(cli, snippet);
    const stderrSubstring = stderrKey.slice(0, 60);

    const pattern: LearnedPattern = {
      id: patternId,
      clis: [cli],
      exitCode: Number.isNaN(exitCode) ? null : exitCode,
      stderrSubstring,
      hint: knownHint ?? `NEEDS_REVIEW: '${cli}' exited ${exitCodeStr} with stderr matching "${stderrSubstring}". Add a corrective hint here.`,
      occurrences: entries.length,
      firstSeen: entries[0].ts ?? new Date().toISOString(),
      lastSeen: entries[entries.length - 1].ts ?? new Date().toISOString(),
      ...(knownHint == null ? { needsReview: true } : {}),
    };

    existing.push(pattern);
    existingByKey.set(patternId, pattern);
    newPatterns++;
  }

  if (newPatterns > 0 || updatedPatterns > 0) {
    saveLearnedPatterns(existing);
  }

  const needsReview = existing.filter((p) => p.needsReview).length;
  return { newPatterns, updatedPatterns, needsReview };
}

export function loadLearnedPatternsForHook(): LearnedPattern[] {
  return loadLearnedPatterns();
}

export function learnedPatternsPath(): string {
  return LEARNED_PATTERNS_PATH;
}

// ---------------------------------------------------------------------------
// MCP filesystem error learner
// Mirrors the CLI learner but reads entries where `tool` is a filesystem
// tool name and `errorSnippet` is present (written by the filesystem server
// on every failed tool call).
// ---------------------------------------------------------------------------

const MCP_LEARNED_PATTERNS_PATH = path.join(os.homedir(), ".claude", "learning", "mcp-guard-patterns.json");

const FILESYSTEM_TOOL_NAMES = new Set([
  "read_file", "write_file", "list_directory",
  "delete_file", "search_files", "search_in_file",
]);

interface KnownMcpSignature {
  tools?: string[];
  errorSubstring: string;
  hint: string;
}

const KNOWN_MCP_ERROR_SIGNATURES: KnownMcpSignature[] = [
  {
    errorSubstring: "outside allowed directories",
    hint:
      "Path is outside the MCP server's allowed directories.\n" +
      "Pass an absolute path inside the workspace root, or add the directory to allowedDirs in the MCP filesystem config.",
  },
  {
    errorSubstring: "ENOENT",
    hint:
      "File or directory not found (ENOENT). Verify the path exists first.\n" +
      "Use search_files to locate it: mcp__filesystem__search_files({ path: \"<root>\", pattern: \"<filename>\" })",
  },
  {
    errorSubstring: "no such file or directory",
    hint:
      "File or directory not found. Verify the path exists before calling read_file/list_directory.\n" +
      "Use mcp__filesystem__search_files to locate the file first.",
  },
  {
    errorSubstring: "EACCES",
    hint:
      "Permission denied (EACCES). The MCP server process lacks read/write access to this path.\n" +
      "Check file ownership and permissions.",
  },
  {
    errorSubstring: "Access denied",
    hint:
      "MCP filesystem access denied. The requested path is not in the allowed directories list.\n" +
      "Use an absolute path inside the workspace root.",
  },
  {
    errorSubstring: "EISDIR",
    hint: "Path is a directory, not a file. Use list_directory instead of read_file for directories.",
  },
  {
    errorSubstring: "ENOSPC",
    hint: "No space left on device (ENOSPC). Free up disk space before writing.",
  },
  {
    errorSubstring: "EROFS",
    hint: "Read-only filesystem (EROFS). Cannot write — the filesystem is mounted read-only.",
  },
  {
    tools: ["search_in_file"],
    errorSubstring: "Invalid regex",
    hint: String.raw`Invalid regex pattern for search_in_file. Escape special characters (., *, +, ?, (, ), [, ], {, }, ^, $, |, \\) with a backslash.`,
  },
];

function matchKnownMcpSignature(tool: string, error: string): string | null {
  for (const sig of KNOWN_MCP_ERROR_SIGNATURES) {
    if (sig.tools && sig.tools.length > 0 && !sig.tools.includes(tool)) continue;
    if (error.toLowerCase().includes(sig.errorSubstring.toLowerCase())) return sig.hint;
  }
  return null;
}

interface McpUsageErrorEntry {
  ts?: string;
  tool?: string;
  errorSnippet?: string;
  error?: string;
}

function readMcpErrors(logPath: string): McpUsageErrorEntry[] {
  if (!fs.existsSync(logPath)) return [];
  try {
    return fs
      .readFileSync(logPath, "utf-8")
      .split("\n")
      .filter(Boolean)
      .reduce<McpUsageErrorEntry[]>((acc, line) => {
        try {
          const e = JSON.parse(line) as McpUsageErrorEntry;
          const snippet = e.errorSnippet ?? e.error;
          if (
            typeof e.tool === "string" &&
            FILESYSTEM_TOOL_NAMES.has(e.tool) &&
            typeof snippet === "string" &&
            snippet.trim()
          ) {
            acc.push({ ...e, errorSnippet: snippet });
          }
        } catch { /* skip malformed lines */ }
        return acc;
      }, []);
  } catch {
    return [];
  }
}

function loadMcpPatternsFromFile(): LearnedPattern[] {
  if (!fs.existsSync(MCP_LEARNED_PATTERNS_PATH)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(MCP_LEARNED_PATTERNS_PATH, "utf-8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveMcpPatterns(patterns: LearnedPattern[]): void {
  fs.mkdirSync(path.dirname(MCP_LEARNED_PATTERNS_PATH), { recursive: true });
  fs.writeFileSync(MCP_LEARNED_PATTERNS_PATH, JSON.stringify(patterns, null, 2) + "\n", "utf-8");
}

export interface McpLearnerResult {
  newPatterns: number;
  updatedPatterns: number;
  needsReview: number;
}

export function analyzeMcpErrors(): McpLearnerResult {
  const errors = readMcpErrors(MCP_USAGE_LOG);
  if (errors.length === 0) return { newPatterns: 0, updatedPatterns: 0, needsReview: 0 };

  const groups = new Map<string, McpUsageErrorEntry[]>();
  for (const e of errors) {
    const errorKey = e.errorSnippet!.slice(0, SNIPPET_KEY_LEN).replace(/\s+/g, " ").trim();
    const key = `${e.tool}|${errorKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }

  const existing = loadMcpPatternsFromFile();
  const existingByKey = new Map<string, LearnedPattern>(existing.map((p) => [p.id, p]));

  let newPatterns = 0;
  let updatedPatterns = 0;

  for (const [key, entries] of groups) {
    if (entries.length < MIN_OCCURRENCES) continue;

    const [tool, errorKey] = key.split("|");
    const patternId = `mcp-learned-${Buffer.from(key).toString("base64url").slice(0, 16)}`;

    if (existingByKey.has(patternId)) {
      const p = existingByKey.get(patternId)!;
      if (p.occurrences !== entries.length) {
        p.occurrences = entries.length;
        p.lastSeen = entries[entries.length - 1].ts ?? new Date().toISOString();
        updatedPatterns++;
      }
      continue;
    }

    const snippet = entries[0].errorSnippet!;
    const knownHint = matchKnownMcpSignature(tool, snippet);
    const stderrSubstring = errorKey.slice(0, 60);

    const pattern: LearnedPattern = {
      id: patternId,
      clis: [tool],
      exitCode: null,
      stderrSubstring,
      hint: knownHint ?? `NEEDS_REVIEW: '${tool}' failed with error matching "${stderrSubstring}". Add a corrective hint here.`,
      occurrences: entries.length,
      firstSeen: entries[0].ts ?? new Date().toISOString(),
      lastSeen: entries[entries.length - 1].ts ?? new Date().toISOString(),
      ...(knownHint == null ? { needsReview: true } : {}),
    };

    existing.push(pattern);
    existingByKey.set(patternId, pattern);
    newPatterns++;
  }

  if (newPatterns > 0 || updatedPatterns > 0) {
    saveMcpPatterns(existing);
  }

  const needsReview = existing.filter((p) => p.needsReview).length;
  return { newPatterns, updatedPatterns, needsReview };
}

export function loadMcpPatternsForHook(): LearnedPattern[] {
  return loadMcpPatternsFromFile();
}

export function mcpPatternsPath(): string {
  return MCP_LEARNED_PATTERNS_PATH;
}
