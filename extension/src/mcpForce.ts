import * as fs from "node:fs";
import * as path from "node:path";
import { readJsonFile, writeJsonAtomic } from "./fileWriteCoordination";
import { checkMcpHealth } from "./mcpHealth";

const MCP_FORCE_DENY = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"];
const FORCE_BLOCK_START = "<!-- claude-skills-mcp-force -->";
const FORCE_BLOCK_END = "<!-- /claude-skills-mcp-force -->";

const FORCE_CLAUDE_MD_BLOCK = `${FORCE_BLOCK_START}
## MCP REQUIRED

Use ONLY MCP filesystem tools for file operations.

❌ Do NOT use: \`Read\`, \`Write\`, \`Edit\`, \`Glob\`, \`Grep\`

✅ Use:
- \`mcp__filesystem__read_file\`
- \`mcp__filesystem__write_file\`
- \`mcp__filesystem__list_directory\`
- \`mcp__filesystem__search_files\`
${FORCE_BLOCK_END}`;

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
 * Avoids agent deadlock: never deny native tools when MCP itself is broken.
 */
export function enableMcpForcePermissions(target: string): McpForceEnableResult {
  const health = checkMcpHealth();
  if (health.status === "config-issue") {
    return {
      ok: false,
      reason: `MCP server is not ready (${health.errors[0] ?? "config-issue"}). Fix MCP setup before enabling force mode.`,
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
  fs.writeFileSync(claudeMd, content, "utf-8");
  return { ok: true };
}

export function removeMcpForceClaudeBlock(target: string): void {
  const claudeMd = path.join(target, "CLAUDE.md");
  if (!fs.existsSync(claudeMd)) return;
  let content = fs.readFileSync(claudeMd, "utf-8");
  const startIdx = content.indexOf(FORCE_BLOCK_START);
  const endIdx = content.indexOf(FORCE_BLOCK_END);
  if (startIdx === -1 || endIdx === -1) return;
  content = (content.slice(0, startIdx) + content.slice(endIdx + FORCE_BLOCK_END.length)).trimStart();
  fs.writeFileSync(claudeMd, content, "utf-8");
}
