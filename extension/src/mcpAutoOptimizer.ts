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

function copyProxyScript(extensionPath: string): void {
  const src = path.join(extensionPath, "resources", "mcp-lazy-proxy.js");
  if (!fs.existsSync(src)) throw new Error(`Proxy script not found at ${src}`);
  fs.mkdirSync(CLAUDE_HOME, { recursive: true });
  fs.copyFileSync(src, PROXY_SCRIPT_STABLE);
}

function writeSidecarConfig(servers: Record<string, McpServerEntry>): void {
  fs.mkdirSync(path.dirname(PROXY_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(PROXY_CONFIG_PATH, JSON.stringify({ servers }, null, 2) + "\n", "utf-8");
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

export async function activateMcpOptimizer(
  context: vscode.ExtensionContext,
  extensionPath: string,
  log: (msg: string) => void
): Promise<void> {
  const config = readClaudeConfig();
  if (!config) return;

  const servers = config.mcpServers ?? {};
  const keys = Object.keys(servers);

  const proxyActive = keys.some((k) => k === PROXY_SERVER_KEY && isOurProxy(servers[k]));
  const realKeys = keys.filter((k) => !(k === PROXY_SERVER_KEY && isOurProxy(servers[k])));

  if (proxyActive) {
    // Refresh the proxy script on every activation (picks up extension updates)
    try {
      copyProxyScript(extensionPath);
    } catch (e) {
      log(
        `MCP optimizer: could not refresh proxy script — ${e instanceof Error ? e.message : String(e)}`
      );
    }
    // If the user added new servers alongside our proxy entry, absorb them into the sidecar
    if (realKeys.length > 0) {
      const sidecar = readSidecarConfig();
      for (const k of realKeys) sidecar[k] = servers[k];
      writeSidecarConfig(sidecar);
      config.mcpServers = { [PROXY_SERVER_KEY]: servers[PROXY_SERVER_KEY] };
      writeClaudeConfig(config);
      log(`MCP optimizer: absorbed ${realKeys.length} new server(s) into proxy config.`);
    }
    return;
  }

  if (realKeys.length === 0) return;

  const consent = context.globalState.get<string>(STATE_CONSENT);
  if (consent === "declined") return;

  if (consent !== "accepted") {
    const count = realKeys.length;
    const choice = await vscode.window.showInformationMessage(
      `Claude Skills: ${count} MCP server${count > 1 ? "s" : ""} detected. ` +
        `Enable automatic context optimization? (Compresses tool schemas to reduce token usage per session.)`,
      "Enable",
      "Not now"
    );
    if (choice !== "Enable") {
      await context.globalState.update(STATE_CONSENT, "declined");
      return;
    }
    await context.globalState.update(STATE_CONSENT, "accepted");
  }

  try {
    copyProxyScript(extensionPath);
    writeSidecarConfig(servers);
    config.mcpServers = {
      [PROXY_SERVER_KEY]: {
        command: "node",
        args: [PROXY_SCRIPT_STABLE, "--config", PROXY_CONFIG_PATH],
      },
    };
    writeClaudeConfig(config);
    log(
      `MCP optimizer activated — ${realKeys.length} server(s) wrapped. ` +
        `Tool schemas compressed for new sessions.`
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`MCP optimizer: failed to activate — ${msg}`);
    void vscode.window.showWarningMessage(
      `Claude Skills: MCP optimizer could not apply (${msg})`
    );
  }
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
