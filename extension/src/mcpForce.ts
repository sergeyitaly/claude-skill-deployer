import * as fs from "node:fs";
import * as path from "node:path";
import { readJsonFile, writeJsonAtomic } from "./fileWriteCoordination";
import { checkMcpHealth } from "./mcpHealth";

const MCP_FORCE_DENY = [
  "Read", "Write", "Edit", "Glob", "Grep", "Bash",
  // PowerShell is a separate tool from Bash on Windows hosts — without denying it too,
  // force mode is leaky there: Bash gets blocked but the agent's primary Windows shell
  // tool doesn't, leaving raw file I/O (and its Windows-only encoding/persistence bugs) reachable.
  "PowerShell",
  // CLI MCP tools — block shell access too so force mode is fully hermetic.
  "mcp__claude-skills-cli__run_command",
  "mcp__claude-skills-cli__list_available_clis",
];
const FORCE_BLOCK_START = "<!-- claude-skills-mcp-force -->";
const FORCE_BLOCK_END = "<!-- /claude-skills-mcp-force -->";

const FORCE_CLAUDE_MD_BLOCK = `${FORCE_BLOCK_START}
## MCP REQUIRED

Use ONLY MCP filesystem tools for file operations.

❌ Do NOT use: \`Read\`, \`Write\`, \`Edit\`, \`Glob\`, \`Grep\`, \`Bash\`, \`PowerShell\`, or CLI MCP (\`run_command\`, \`list_available_clis\`)

✅ Use:
- \`mcp__filesystem__read_file\` (pass \`offset\`/\`limit\` to page through large files)
- \`mcp__filesystem__write_file\`
- \`mcp__filesystem__edit_file\`
- \`mcp__filesystem__list_directory\`
- \`mcp__filesystem__search_files\` (find files by name)
- \`mcp__filesystem__search_in_file\` (search within one file)
- \`mcp__filesystem__search_in_files\` (recursive grep across a directory tree)
${FORCE_BLOCK_END}`;

// Lock files older than this are presumed to belong to a crashed process and are
// removed before a new acquisition attempt. On Windows the OS does not automatically
// release file locks when a process exits abnormally, so without this cleanup a stale
// lock would permanently block future injections until the file is deleted manually.
const LOCK_STALE_MS = 30_000;

interface ClaudeSettings {
  permissions?: {
    deny?: string[];
    allow?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type McpForceEnableResult =
  | { ok: true; permissionsWritten: boolean }
  | { ok: false; reason: string };

export type McpForceInjectResult =
  | { ok: true }
  | { ok: false; reason: string };

function readSettings(file: string): ClaudeSettings {
  return readJsonFile<ClaudeSettings>(file) ?? {};
}

/** Removes a lock file if it is older than LOCK_STALE_MS (best-effort, non-fatal). */
function clearStaleLock(lockFile: string): void {
  try {
    if (Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS) {
      fs.unlinkSync(lockFile);
    }
  } catch {
    // Lock doesn't exist or can't be stat'd — both are fine.
  }
}

export function isMcpForcePermissionsActive(target: string): boolean {
  const settings = readSettings(path.join(target, ".claude", "settings.json"));
  const deny = settings.permissions?.deny ?? [];
  return MCP_FORCE_DENY.every((tool) => deny.includes(tool));
}

export function isMcpForceClaudeMdInjected(target: string): boolean {
  const claudeMd = path.join(target, "CLAUDE.md");
  if (!fs.existsSync(claudeMd)) return false;
  return fs.readFileSync(claudeMd, "utf-8").includes(FORCE_BLOCK_START);
}

export function isMcpForceActive(target: string): boolean {
  return isMcpForcePermissionsActive(target);
}

/**
 * Enables permissions.deny only when MCP health check passes.
 * Avoids agent deadlock: never deny native tools when MCP itself is broken
 * or has not yet been verified to respond (no-activity on a fresh install).
 */
export function enableMcpForcePermissions(target: string): McpForceEnableResult {
  const health = checkMcpHealth();
  if (health.status === "config-issue") {
    return {
      ok: false,
      reason: `MCP server is not ready (${health.errors[0] ?? "config-issue"}). Fix MCP setup before enabling force mode.`,
    };
  }
  if (health.status === "no-activity") {
    return {
      ok: false,
      reason: "MCP server has not been used yet and cannot be verified as working. Use it at least once before enabling force mode.",
    };
  }

  const settingsFile = path.join(target, ".claude", "settings.json");
  const settings = readSettings(settingsFile);
  const existing = settings.permissions?.deny ?? [];
  const merged = Array.from(new Set([...existing, ...MCP_FORCE_DENY]));
  settings.permissions = Object.assign(settings.permissions ?? {}, { deny: merged });
  writeJsonAtomic(settingsFile, settings);
  return { ok: true, permissionsWritten: true };
}

export function revertMcpForcePermissions(target: string): void {
  const settingsFile = path.join(target, ".claude", "settings.json");
  const settings = readSettings(settingsFile);
  if (!settings.permissions?.deny) return;
  const forceSet = new Set(MCP_FORCE_DENY);
  settings.permissions.deny = settings.permissions.deny.filter((t) => !forceSet.has(t));
  if (settings.permissions.deny.length === 0) {
    delete settings.permissions.deny;
  }
  writeJsonAtomic(settingsFile, settings);
}

export function injectMcpForceClaude(target: string): McpForceInjectResult {
  const health = checkMcpHealth();
  if (health.status === "config-issue") {
    return {
      ok: false,
      reason: `MCP server is not ready (${health.errors[0] ?? "config-issue"}). Fix MCP setup before injecting force instructions.`,
    };
  }

  const claudeMd = path.join(target, "CLAUDE.md");

  // Atomic update: write to a temp file then rename so concurrent writes from
  // two VS Code windows targeting the same workspace cannot corrupt CLAUDE.md.
  const lockFile = claudeMd + ".mcpforce.lock";
  clearStaleLock(lockFile); // remove lock left by a previously crashed process
  let lockFd: number | undefined;
  try {
    lockFd = fs.openSync(lockFile, "wx"); // exclusive create — fails if another process holds it
  } catch {
    // Another window is updating concurrently; treat as a transient no-op.
    return { ok: true };
  }

  try {
    let content = fs.existsSync(claudeMd) ? fs.readFileSync(claudeMd, "utf-8") : "";

    const startIdx = content.indexOf(FORCE_BLOCK_START);
    const endIdx = content.indexOf(FORCE_BLOCK_END);

    if (startIdx !== -1 && endIdx !== -1) {
      content =
        content.slice(0, startIdx) +
        FORCE_CLAUDE_MD_BLOCK +
        content.slice(endIdx + FORCE_BLOCK_END.length);
    } else {
      content = FORCE_CLAUDE_MD_BLOCK + (content ? "\n\n" + content : "");
    }

    fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
    // Write via temp-file rename for atomicity.
    const tmp = claudeMd + `.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, content, "utf-8");
    fs.renameSync(tmp, claudeMd);

    return { ok: true };
  } finally {
    fs.closeSync(lockFd!);
    try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
  }
}

export function removeMcpForceClaudeBlock(target: string): void {
  const claudeMd = path.join(target, "CLAUDE.md");
  if (!fs.existsSync(claudeMd)) return;

  const lockFile = claudeMd + ".mcpforce.lock";
  clearStaleLock(lockFile); // remove lock left by a previously crashed process
  let lockFd: number | undefined;
  try {
    lockFd = fs.openSync(lockFile, "wx");
  } catch {
    return; // concurrent update — skip safely
  }

  try {
    let content = fs.readFileSync(claudeMd, "utf-8");
    const startIdx = content.indexOf(FORCE_BLOCK_START);
    const endIdx = content.indexOf(FORCE_BLOCK_END);
    if (startIdx === -1 || endIdx === -1) return;
    content = (content.slice(0, startIdx) + content.slice(endIdx + FORCE_BLOCK_END.length)).trimStart();
    const tmp = claudeMd + `.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, content, "utf-8");
    fs.renameSync(tmp, claudeMd);
  } finally {
    fs.closeSync(lockFd!);
    try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
  }
}
