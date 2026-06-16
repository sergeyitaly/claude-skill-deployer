import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

const CLAUDE_HOME = path.join(os.homedir(), ".claude");
const CLAUDE_CONFIG_PATH = path.join(os.homedir(), ".claude.json");
const PROXY_SCRIPT_STABLE = path.join(CLAUDE_HOME, "mcp-proxy.js");
const PROXY_CONFIG_PATH = path.join(CLAUDE_HOME, "learning", "mcp-proxy-config.json");
const PROXY_SERVER_KEY = "claude-skills-mcp-proxy";
const STATE_CONSENT = "claudeSkills.mcpOptimizer.consent";

interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

interface ClaudeConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

function readClaudeConfig(): ClaudeConfig | null {
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_CONFIG_PATH, "utf-8")) as ClaudeConfig;
  } catch {
    return null;
  }
}

function writeClaudeConfig(config: ClaudeConfig): void {
  fs.writeFileSync(CLAUDE_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function isOurProxy(entry: McpServerEntry): boolean {
  return (
    entry.command === "node" &&
    Array.isArray(entry.args) &&
    entry.args[0] === PROXY_SCRIPT_STABLE
  );
}

function readSidecarConfig(): Record<string, McpServerEntry> {
  try {
    const raw = JSON.parse(fs.readFileSync(PROXY_CONFIG_PATH, "utf-8")) as {
      servers: Record<string, McpServerEntry>;
    };
    return raw.servers || {};
  } catch {
    return {};
  }
}

/**
 * Silently migrates away from the proxy if it is currently active.
 * Called on extension activation — no UI, no consent prompt.
 */
export function autoMigrateProxyIfActive(
  context: vscode.ExtensionContext,
  log: (msg: string) => void
): void {
  const config = readClaudeConfig();
  if (!config) return;

  const servers = config.mcpServers ?? {};
  const proxyActive = Object.keys(servers).some(
    (k) => k === PROXY_SERVER_KEY && isOurProxy(servers[k])
  );
  if (!proxyActive) return;

  const original = readSidecarConfig();
  if (Object.keys(original).length > 0) {
    config.mcpServers = original;
  } else {
    delete config.mcpServers;
  }
  writeClaudeConfig(config);

  try { fs.unlinkSync(PROXY_CONFIG_PATH); } catch { /* non-fatal */ }
  try { fs.unlinkSync(PROXY_SCRIPT_STABLE); } catch { /* non-fatal */ }

  void context.globalState.update(STATE_CONSENT, undefined);
  log("MCP optimizer: auto-migrated — proxy removed, direct MCP servers restored.");
}

export function revertMcpOptimizer(
  context: vscode.ExtensionContext,
  log: (msg: string) => void
): void {
  const config = readClaudeConfig();
  if (!config) {
    log("MCP optimizer: ~/.claude.json not found, nothing to revert.");
    return;
  }
  const servers = config.mcpServers ?? {};
  if (!(PROXY_SERVER_KEY in servers) || !isOurProxy(servers[PROXY_SERVER_KEY])) {
    log("MCP optimizer: proxy not active, nothing to revert.");
    void vscode.window.showInformationMessage("Claude Skills: MCP optimizer is not active.");
    return;
  }

  const original = readSidecarConfig();
  if (Object.keys(original).length > 0) {
    config.mcpServers = original;
  } else {
    delete config.mcpServers;
  }
  writeClaudeConfig(config);

  try { fs.unlinkSync(PROXY_CONFIG_PATH); } catch { /* non-fatal */ }
  try { fs.unlinkSync(PROXY_SCRIPT_STABLE); } catch { /* non-fatal */ }

  void context.globalState.update(STATE_CONSENT, undefined);
  log("MCP optimizer: reverted — original server entries restored.");
  void vscode.window.showInformationMessage(
    "Claude Skills: MCP optimizer disabled. Original MCP servers restored."
  );
}
