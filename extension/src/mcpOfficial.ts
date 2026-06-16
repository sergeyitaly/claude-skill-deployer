import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { readJsonFile, writeJsonAtomic } from "./fileWriteCoordination";

export type FilesystemMcpAgentId = "claude" | "cursor" | "kiro" | "copilot";

const CLAUDE_HOME = path.join(os.homedir(), ".claude");
const CLAUDE_CONFIG_PATH = path.join(os.homedir(), ".claude.json");
const MCP_SERVERS_HOME = path.join(CLAUDE_HOME, "mcp-servers");
const FILESYSTEM_SERVER_DIR = path.join(MCP_SERVERS_HOME, "filesystem");
const ALLOWED_DIRS_CONFIG_PATH = path.join(FILESYSTEM_SERVER_DIR, "allowed-dirs.json");
const FILESYSTEM_SERVER_KEY = "filesystem";

const AGENT_DISPLAY_NAMES: Record<FilesystemMcpAgentId, string> = {
  claude: "Claude Code",
  cursor: "Cursor",
  kiro: "Kiro",
  copilot: "GitHub Copilot",
};

const AGENT_CONFIG_PATHS: Record<Exclude<FilesystemMcpAgentId, "copilot">, string> = {
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

interface ClaudeConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

interface CursorKiroConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

interface EnableResult {
  agentIds: FilesystemMcpAgentId[];
  serverPath: string;
  allowedDirsConfigPath: string;
  enabled: FilesystemMcpAgentId[];
  skipped: FilesystemMcpAgentId[];
  errors: { agentId: FilesystemMcpAgentId; message: string }[];
}

function isFilesystemMcpAgentId(value: string): value is FilesystemMcpAgentId {
  return value === "claude" || value === "cursor" || value === "kiro" || value === "copilot";
}

function readJsonConfig<T>(filePath: string): T | undefined {
  return readJsonFile<T>(filePath);
}

function writeJsonConfig(filePath: string, config: unknown): void {
  writeJsonAtomic(filePath, config);
}

function enabledMcpAgentIds(): FilesystemMcpAgentId[] {
  const configured = vscode.workspace
    .getConfiguration("claudeSkills.agents")
    .get<string[]>("enabled", ["claude", "cursor", "kiro", "copilot"]);
  return configured.filter(isFilesystemMcpAgentId);
}

function copyFilesystemServer(extensionPath: string): string {
  const bundledPath = path.join(extensionPath, "resources", "mcp-servers", "filesystem");
  if (!fs.existsSync(bundledPath)) {
    throw new Error("Bundled filesystem MCP server not found in extension resources");
  }

  const sourceFile = path.join(bundledPath, "index.js");
  const targetFile = path.join(FILESYSTEM_SERVER_DIR, "index.js");
  fs.mkdirSync(FILESYSTEM_SERVER_DIR, { recursive: true });
  fs.copyFileSync(sourceFile, targetFile);
  fs.chmodSync(targetFile, 0o755);
  return targetFile;
}

function writeAllowedDirsConfig(workspaceDirs: string[]): string[] {
  const allowedDirs = [CLAUDE_HOME, ...workspaceDirs].filter(Boolean).map((dir) => path.resolve(dir));
  const config: { allowedDirs: string[]; workspaceLogPath?: string } = { allowedDirs };
  if (workspaceDirs.length > 0) {
    config.workspaceLogPath = path.join(path.resolve(workspaceDirs[0]), ".claude", "mcp-usage.jsonl");
  }
  writeJsonConfig(ALLOWED_DIRS_CONFIG_PATH, config);
  return allowedDirs;
}

function filesystemServerArgs(serverPath: string): string[] {
  return [serverPath, "--config", ALLOWED_DIRS_CONFIG_PATH];
}

function claudeServerEntry(serverPath: string): McpServerEntry {
  return {
    command: "node",
    args: filesystemServerArgs(serverPath),
  };
}

function upsertClaudeServer(config: ClaudeConfig, entry: McpServerEntry): boolean {
  const previous = JSON.stringify(config.mcpServers?.[FILESYSTEM_SERVER_KEY]);
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers[FILESYSTEM_SERVER_KEY] = entry;
  return previous !== JSON.stringify(config.mcpServers[FILESYSTEM_SERVER_KEY]);
}

function upsertCursorKiroServer(config: CursorKiroConfig, entry: McpServerEntry): boolean {
  const previous = JSON.stringify(config.mcpServers?.[FILESYSTEM_SERVER_KEY]);
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers[FILESYSTEM_SERVER_KEY] = entry;
  return previous !== JSON.stringify(config.mcpServers[FILESYSTEM_SERVER_KEY]);
}

async function enableAgentMcp(agentId: FilesystemMcpAgentId, serverPath: string): Promise<void> {
  switch (agentId) {
    case "claude": {
      const config = readJsonConfig<ClaudeConfig>(CLAUDE_CONFIG_PATH) ?? {};
      if (upsertClaudeServer(config, claudeServerEntry(serverPath))) {
        writeJsonConfig(CLAUDE_CONFIG_PATH, config);
      }
      return;
    }
    case "cursor": {
      const configPath = AGENT_CONFIG_PATHS.cursor;
      const config = readJsonConfig<CursorKiroConfig>(configPath) ?? {};
      if (upsertCursorKiroServer(config, claudeServerEntry(serverPath))) {
        writeJsonConfig(configPath, config);
      }
      return;
    }
    case "kiro": {
      const configPath = AGENT_CONFIG_PATHS.kiro;
      const config = readJsonConfig<CursorKiroConfig>(configPath) ?? {};
      if (upsertCursorKiroServer(config, claudeServerEntry(serverPath))) {
        writeJsonConfig(configPath, config);
      }
      return;
    }
    case "copilot":
      // Registered via contributes.mcpServers in package.json — no settings write needed.
      return;
  }
}

function isClaudeFilesystemMcpServerEnabled(): boolean {
  const config = readJsonConfig<ClaudeConfig>(CLAUDE_CONFIG_PATH);
  return Boolean(config?.mcpServers?.[FILESYSTEM_SERVER_KEY]);
}

function isCursorFilesystemMcpServerEnabled(): boolean {
  const config = readJsonConfig<CursorKiroConfig>(AGENT_CONFIG_PATHS.cursor);
  return Boolean(config?.mcpServers?.[FILESYSTEM_SERVER_KEY]);
}

function isKiroFilesystemMcpServerEnabled(): boolean {
  const config = readJsonConfig<CursorKiroConfig>(AGENT_CONFIG_PATHS.kiro);
  return Boolean(config?.mcpServers?.[FILESYSTEM_SERVER_KEY]);
}

function isCopilotFilesystemMcpServerEnabled(): boolean {
  return true; // Always registered via contributes.mcpServers in package.json
}

function isAgentFilesystemMcpServerEnabled(agentId: FilesystemMcpAgentId): boolean {
  switch (agentId) {
    case "claude":
      return isClaudeFilesystemMcpServerEnabled();
    case "cursor":
      return isCursorFilesystemMcpServerEnabled();
    case "kiro":
      return isKiroFilesystemMcpServerEnabled();
    case "copilot":
      return isCopilotFilesystemMcpServerEnabled();
  }
}

async function disableAgentMcp(agentId: FilesystemMcpAgentId): Promise<void> {
  switch (agentId) {
    case "claude": {
      const config = readJsonConfig<ClaudeConfig>(CLAUDE_CONFIG_PATH);
      if (!config?.mcpServers?.[FILESYSTEM_SERVER_KEY]) return;
      delete config.mcpServers[FILESYSTEM_SERVER_KEY];
      writeJsonConfig(CLAUDE_CONFIG_PATH, config);
      return;
    }
    case "cursor": {
      const configPath = AGENT_CONFIG_PATHS.cursor;
      const config = readJsonConfig<CursorKiroConfig>(configPath);
      if (!config?.mcpServers?.[FILESYSTEM_SERVER_KEY]) return;
      delete config.mcpServers[FILESYSTEM_SERVER_KEY];
      writeJsonConfig(configPath, config);
      return;
    }
    case "kiro": {
      const configPath = AGENT_CONFIG_PATHS.kiro;
      const config = readJsonConfig<CursorKiroConfig>(configPath);
      if (!config?.mcpServers?.[FILESYSTEM_SERVER_KEY]) return;
      delete config.mcpServers[FILESYSTEM_SERVER_KEY];
      writeJsonConfig(configPath, config);
      return;
    }
    case "copilot":
      // Registered via contributes.mcpServers — cannot be unregistered at runtime.
      // Workspace access is effectively removed when allowed-dirs.json is deleted.
      return;
  }
}

export function getEnabledFilesystemMcpAgentIds(): FilesystemMcpAgentId[] {
  return enabledMcpAgentIds();
}

export function getFilesystemMcpServerStatus(agentIds = enabledMcpAgentIds()): {
  enabled: boolean;
  activeAgents: FilesystemMcpAgentId[];
  configuredAgents: FilesystemMcpAgentId[];
} {
  const activeAgents = agentIds.filter(isAgentFilesystemMcpServerEnabled);
  return {
    enabled: activeAgents.length > 0,
    activeAgents,
    configuredAgents: agentIds,
  };
}

export async function enableOfficialFilesystemServer(
  extensionPath: string,
  workspaceDirs: string[],
  log: (msg: string) => void,
  onStatusChanged?: () => void
): Promise<EnableResult> {
  const result: EnableResult = {
    agentIds: enabledMcpAgentIds(),
    serverPath: "",
    allowedDirsConfigPath: ALLOWED_DIRS_CONFIG_PATH,
    enabled: [],
    skipped: [],
    errors: [],
  };

  try {
    const serverPath = copyFilesystemServer(extensionPath);
    const allowedDirs = writeAllowedDirsConfig(workspaceDirs);
    result.serverPath = serverPath;

    log(`Filesystem MCP server copied to ${serverPath}`);
    log(`Filesystem MCP server: allowed dirs — ${allowedDirs.join(", ") || "(none)"}`);

    if (result.agentIds.length === 0) {
      const message = "No enabled AI agents configured for filesystem MCP sync.";
      log(message);
      result.skipped = [];
      void vscode.window.showWarningMessage(`Claude Skills: ${message}`);
      onStatusChanged?.();
      return result;
    }

    for (const agentId of result.agentIds) {
      try {
        await enableAgentMcp(agentId, serverPath);
        result.enabled.push(agentId);
        log(`Filesystem MCP server configured for ${AGENT_DISPLAY_NAMES[agentId]}.`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push({ agentId, message });
        log(`Filesystem MCP server: failed to configure ${AGENT_DISPLAY_NAMES[agentId]} — ${message}`);
      }
    }

    if (result.errors.length === 0) {
      void vscode.window.showInformationMessage(
        `Claude Skills: Filesystem MCP server enabled for ${result.enabled
          .map((agentId) => AGENT_DISPLAY_NAMES[agentId])
          .join(", ")}. Reload affected agents for changes to take effect.`
      );
    } else {
      void vscode.window.showWarningMessage(
        `Claude Skills: Filesystem MCP server partially enabled (${result.enabled.length}/${result.agentIds.length} agents). See output for details.`
      );
    }

    log(
      `Filesystem MCP server configured and will be auto-optimized by the MCP proxy for Claude Code when applicable.`
    );
    onStatusChanged?.();
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.errors.push({ agentId: "claude", message: msg });
    log(`Failed to enable filesystem MCP server: ${msg}`);
    void vscode.window.showErrorMessage(`Claude Skills: Could not enable filesystem MCP server (${msg})`);
    onStatusChanged?.();
    return result;
  }
}

export function refreshFilesystemAllowedDirs(
  workspaceDirs: string[],
  log: (msg: string) => void
): void {
  try {
    const allowedDirs = writeAllowedDirsConfig(workspaceDirs);
    log(`Filesystem MCP server: allowed dirs refreshed (${allowedDirs.length} dirs).`);
  } catch (e) {
    log(`Filesystem MCP server: could not refresh allowed dirs — ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function disableOfficialFilesystemServer(
  log: (msg: string) => void,
  onStatusChanged?: () => void
): Promise<void> {
  try {
    const allAgentIds: FilesystemMcpAgentId[] = ["claude", "cursor", "kiro", "copilot"];
    const disabled: FilesystemMcpAgentId[] = [];

    for (const agentId of allAgentIds) {
      await disableAgentMcp(agentId);
      disabled.push(agentId);
      log(`Filesystem MCP server disabled for ${AGENT_DISPLAY_NAMES[agentId]}.`);
    }

    try {
      if (fs.existsSync(FILESYSTEM_SERVER_DIR)) {
        fs.rmSync(FILESYSTEM_SERVER_DIR, { recursive: true, force: true });
      }
    } catch {
      // Non-fatal if cleanup fails
    }

    log("Filesystem MCP server disabled and removed from managed agent configs.");
    void vscode.window.showInformationMessage(
      `Claude Skills: Filesystem MCP server disabled for ${disabled
        .map((agentId) => AGENT_DISPLAY_NAMES[agentId])
        .join(", ")}. Reload affected agents for changes to take effect.`
    );
    onStatusChanged?.();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`Failed to disable filesystem MCP server: ${msg}`);
    void vscode.window.showErrorMessage(`Claude Skills: Could not disable filesystem MCP server (${msg})`);
  }
}
