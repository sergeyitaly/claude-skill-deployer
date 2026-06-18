import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { readJsonFile, writeJsonAtomic } from "./fileWriteCoordination";

export type CliMcpAgentId = "claude" | "cursor" | "kiro";

const CLAUDE_HOME = path.join(os.homedir(), ".claude");
const CLAUDE_CONFIG_PATH = path.join(os.homedir(), ".claude.json");
const MCP_SERVERS_HOME = path.join(CLAUDE_HOME, "mcp-servers");
const CLI_SERVER_DIR = path.join(MCP_SERVERS_HOME, "cli");
const CLI_SERVER_PATH = path.join(CLI_SERVER_DIR, "index.js");
const CLI_CONFIG_PATH = path.join(CLI_SERVER_DIR, "cli-config.json");
const CLI_SERVER_KEY = "claude-skills-cli";

const AGENT_DISPLAY_NAMES: Record<CliMcpAgentId, string> = {
  claude: "Claude Code",
  cursor: "Cursor",
  kiro: "Kiro",
};

const AGENT_CONFIG_PATHS: Record<CliMcpAgentId, string> = {
  claude: CLAUDE_CONFIG_PATH,
  cursor: path.join(os.homedir(), ".cursor", "mcp.json"),
  kiro: path.join(os.homedir(), ".kiro", "settings", "mcp.json"),
};

interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

interface AgentMcpConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

export interface CliEnableResult {
  agentIds: CliMcpAgentId[];
  serverPath: string;
  configPath: string;
  enabled: CliMcpAgentId[];
  skipped: CliMcpAgentId[];
  errors: { agentId: CliMcpAgentId; message: string }[];
}

function enabledCliMcpAgentIds(): CliMcpAgentId[] {
  const configured = vscode.workspace
    .getConfiguration("claudeSkills.agents")
    .get<string[]>("enabled", ["claude", "cursor", "kiro"]);
  return configured.filter((id): id is CliMcpAgentId =>
    id === "claude" || id === "cursor" || id === "kiro"
  );
}

function fileHash(p: string): string {
  return crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex");
}

function copyCliServer(extensionPath: string): string {
  const bundledDir = path.join(extensionPath, "resources", "mcp-servers", "cli");
  if (!fs.existsSync(bundledDir)) {
    throw new Error("Bundled CLI MCP server not found in extension resources");
  }
  const sourceFile = path.join(bundledDir, "index.js");
  fs.mkdirSync(CLI_SERVER_DIR, { recursive: true });
  fs.copyFileSync(sourceFile, CLI_SERVER_PATH);
  fs.chmodSync(CLI_SERVER_PATH, 0o755); // NOSONAR — executable needs rx for group/others on Unix
  return CLI_SERVER_PATH;
}

/**
 * Ensures the deployed CLI server binary matches the bundled one.
 * Called on every extension activation — fast no-op when hashes match,
 * re-copies when the extension has been updated or the binary is missing.
 * Returns true if the binary was (re-)deployed.
 */
export function syncCliServerBinary(
  extensionPath: string,
  log: (msg: string) => void
): boolean {
  const bundledFile = path.join(extensionPath, "resources", "mcp-servers", "cli", "index.js");
  if (!fs.existsSync(bundledFile)) {
    log("CLI MCP server: bundled binary not found — skipping sync.");
    return false;
  }
  try {
    const deployedExists = fs.existsSync(CLI_SERVER_PATH);
    // Fast path: compare file sizes before computing SHA-1. For typical server files
    // (tens of KB) this avoids two full readFileSync calls on every activation.
    const needsCopy =
      !deployedExists ||
      fs.statSync(bundledFile).size !== fs.statSync(CLI_SERVER_PATH).size ||
      fileHash(bundledFile) !== fileHash(CLI_SERVER_PATH);

    if (!needsCopy) return false;

    fs.mkdirSync(CLI_SERVER_DIR, { recursive: true });
    fs.copyFileSync(bundledFile, CLI_SERVER_PATH);
    fs.chmodSync(CLI_SERVER_PATH, 0o755); // NOSONAR — executable needs rx for group/others on Unix
    log("CLI MCP server: binary updated to latest version.");
    return true;
  } catch (e) {
    log(`CLI MCP server: binary sync failed — ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

function writeCliConfig(workspaceDirs: string[], extraClis: string[] = []): void {
  const defaultClis = [
    "az", "aws", "git", "kubectl", "helm", "terraform",
    "gcloud", "docker", "gh", "dotnet", "node", "npm",
  ];
  const allowedClis = [...new Set([...defaultClis, ...extraClis])];

  const config: Record<string, unknown> = { allowedClis, timeout: 300000 };
  if (workspaceDirs.length > 0) {
    config.workspaceLogPath = path.join(
      path.resolve(workspaceDirs[0]),
      ".claude",
      "mcp-usage.jsonl"
    );
  }
  fs.mkdirSync(path.dirname(CLI_CONFIG_PATH), { recursive: true });
  writeJsonAtomic(CLI_CONFIG_PATH, config);
}

function cliServerEntry(): McpServerEntry {
  return { command: "node", args: [CLI_SERVER_PATH, "--config", CLI_CONFIG_PATH] };
}

function upsertCliEntry(config: AgentMcpConfig): boolean {
  const entry = cliServerEntry();
  const previous = JSON.stringify(config.mcpServers?.[CLI_SERVER_KEY]);
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers[CLI_SERVER_KEY] = entry;
  return previous !== JSON.stringify(config.mcpServers[CLI_SERVER_KEY]);
}

function enableAgentCliMcp(agentId: CliMcpAgentId): void {
  const configFile = AGENT_CONFIG_PATHS[agentId];
  const config = readJsonFile<AgentMcpConfig>(configFile) ?? {};
  if (upsertCliEntry(config)) {
    writeJsonAtomic(configFile, config);
  }
}

function disableAgentCliMcp(agentId: CliMcpAgentId): void {
  const configFile = AGENT_CONFIG_PATHS[agentId];
  const config = readJsonFile<AgentMcpConfig>(configFile);
  if (!config?.mcpServers?.[CLI_SERVER_KEY]) return;
  delete config.mcpServers[CLI_SERVER_KEY];
  writeJsonAtomic(configFile, config);
}

function isCliMcpEnabled(agentId: CliMcpAgentId): boolean {
  const config = readJsonFile<AgentMcpConfig>(AGENT_CONFIG_PATHS[agentId]);
  return Boolean(config?.mcpServers?.[CLI_SERVER_KEY]);
}

export function refreshCliConfig(workspaceDirs: string[], log: (msg: string) => void): void {
  try {
    if (!fs.existsSync(CLI_CONFIG_PATH)) return;
    writeCliConfig(workspaceDirs);
    log(`CLI MCP server: workspace log path refreshed (${workspaceDirs.length} dir(s)).`);
  } catch (e) {
    log(`CLI MCP server: could not refresh config — ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function getCliMcpServerStatus(): {
  enabled: boolean;
  activeAgents: CliMcpAgentId[];
} {
  const all: CliMcpAgentId[] = ["claude", "cursor", "kiro"];
  const activeAgents = all.filter(isCliMcpEnabled);
  return { enabled: activeAgents.length > 0, activeAgents };
}

export function needsCliMcpSetup(): boolean {
  if (!fs.existsSync(CLI_SERVER_PATH)) return true;
  // Check all agents, not just Claude — on a Cursor-only machine ~/.claude.json never
  // exists and the old check would return true on every activation.
  const { activeAgents } = getCliMcpServerStatus();
  return activeAgents.length === 0;
}

export async function enableOfficialCliServer(
  extensionPath: string,
  workspaceDirs: string[],
  log: (msg: string) => void,
  onStatusChanged?: () => void
): Promise<CliEnableResult> {
  const result: CliEnableResult = {
    agentIds: enabledCliMcpAgentIds(),
    serverPath: "",
    configPath: CLI_CONFIG_PATH,
    enabled: [],
    skipped: [],
    errors: [],
  };

  try {
    const serverPath = copyCliServer(extensionPath);
    writeCliConfig(workspaceDirs);
    result.serverPath = serverPath;

    log(`CLI MCP server copied to ${serverPath}`);

    if (result.agentIds.length === 0) {
      const message = "No enabled AI agents configured for CLI MCP sync.";
      log(message);
      void vscode.window.showWarningMessage(`Claude Skills: ${message}`);
      onStatusChanged?.();
      return result;
    }

    for (const agentId of result.agentIds) {
      try {
        enableAgentCliMcp(agentId);
        result.enabled.push(agentId);
        log(`CLI MCP server configured for ${AGENT_DISPLAY_NAMES[agentId]}.`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push({ agentId, message });
        log(`CLI MCP server: failed to configure ${AGENT_DISPLAY_NAMES[agentId]} — ${message}`);
      }
    }

    if (result.errors.length === 0) {
      void vscode.window.showInformationMessage(
        `Claude Skills: CLI MCP server enabled for ${result.enabled
          .map((id) => AGENT_DISPLAY_NAMES[id])
          .join(", ")}. Reload affected agents for changes to take effect.`
      );
    } else {
      void vscode.window.showWarningMessage(
        `Claude Skills: CLI MCP server partially enabled (${result.enabled.length}/${result.agentIds.length} agents). See output for details.`
      );
    }

    onStatusChanged?.();
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.errors.push({ agentId: "claude", message: msg });
    log(`Failed to enable CLI MCP server: ${msg}`);
    void vscode.window.showErrorMessage(`Claude Skills: Could not enable CLI MCP server (${msg})`);
    onStatusChanged?.();
    return result;
  }
}

export async function disableOfficialCliServer(
  log: (msg: string) => void,
  onStatusChanged?: () => void
): Promise<void> {
  try {
    const all: CliMcpAgentId[] = ["claude", "cursor", "kiro"];
    for (const agentId of all) {
      disableAgentCliMcp(agentId);
      log(`CLI MCP server disabled for ${AGENT_DISPLAY_NAMES[agentId]}.`);
    }
    try {
      if (fs.existsSync(CLI_SERVER_DIR)) {
        fs.rmSync(CLI_SERVER_DIR, { recursive: true, force: true });
      }
    } catch { /* non-fatal */ }

    log("CLI MCP server disabled and removed.");
    void vscode.window.showInformationMessage(
      "Claude Skills: CLI MCP server disabled. Reload affected agents for changes to take effect."
    );
    onStatusChanged?.();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`Failed to disable CLI MCP server: ${msg}`);
    void vscode.window.showErrorMessage(`Claude Skills: Could not disable CLI MCP server (${msg})`);
  }
}
