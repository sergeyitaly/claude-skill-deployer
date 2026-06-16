import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

const CLAUDE_HOME = path.join(os.homedir(), ".claude");
const CLAUDE_CONFIG_PATH = path.join(os.homedir(), ".claude.json");
const MCP_SERVERS_HOME = path.join(CLAUDE_HOME, "mcp-servers");

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

/**
 * Enable official filesystem MCP server bundled with the extension
 */
export async function enableOfficialFilesystemServer(
  extensionPath: string,
  log: (msg: string) => void,
  onStatusChanged?: () => void
): Promise<void> {
  try {
    // 1. Copy bundled filesystem server to ~/.claude/mcp-servers/filesystem/
    const bundledPath = path.join(extensionPath, "resources", "mcp-servers", "filesystem");
    if (!fs.existsSync(bundledPath)) {
      throw new Error("Bundled filesystem MCP server not found in extension resources");
    }

    const targetDir = path.join(MCP_SERVERS_HOME, "filesystem");
    fs.mkdirSync(targetDir, { recursive: true });

    // Copy the index.js file
    const sourceFile = path.join(bundledPath, "index.js");
    const targetFile = path.join(targetDir, "index.js");
    fs.copyFileSync(sourceFile, targetFile);
    fs.chmodSync(targetFile, 0o755);

    log(`Filesystem MCP server copied to ${targetFile}`);

    // 2. Update ~/.claude.json to add filesystem server entry
    let config = readClaudeConfig() ?? {};
    if (!config.mcpServers) {
      config.mcpServers = {};
    }

    config.mcpServers.filesystem = {
      command: "node",
      args: [targetFile],
    };

    writeClaudeConfig(config);
    log("Added filesystem MCP server to ~/.claude.json");

    // 3. Show success message
    void vscode.window.showInformationMessage(
      "Claude Skills: Filesystem MCP server enabled. Restart Claude Desktop for changes to take effect."
    );

    log("Filesystem MCP server configured and will be auto-optimized by the MCP proxy.");
    onStatusChanged?.();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`Failed to enable filesystem MCP server: ${msg}`);
    void vscode.window.showErrorMessage(
      `Claude Skills: Could not enable filesystem MCP server (${msg})`
    );
  }
}

/**
 * Disable official filesystem MCP server
 */
export function disableOfficialFilesystemServer(
  log: (msg: string) => void,
  onStatusChanged?: () => void
): void {
  try {
    const config = readClaudeConfig();
    if (!config?.mcpServers?.filesystem) {
      log("Filesystem MCP server not configured.");
      void vscode.window.showInformationMessage(
        "Claude Skills: Filesystem MCP server is not configured."
      );
      return;
    }

    // Remove from config
    delete config.mcpServers.filesystem;
    writeClaudeConfig(config);

    // Optionally remove the files
    try {
      const targetDir = path.join(MCP_SERVERS_HOME, "filesystem");
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
    } catch {
      // Non-fatal if cleanup fails
    }

    log("Filesystem MCP server disabled and removed.");
    void vscode.window.showInformationMessage(
      "Claude Skills: Filesystem MCP server disabled. Restart Claude Desktop for changes to take effect."
    );
    onStatusChanged?.();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`Failed to disable filesystem MCP server: ${msg}`);
    void vscode.window.showErrorMessage(
      `Claude Skills: Could not disable filesystem MCP server (${msg})`
    );
  }
}
