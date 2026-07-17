import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { readJsonFile, writeJsonAtomic } from "./fileWriteCoordination";

/**
 * Registers arbitrary, user-specified MCP servers across every enabled agent's own config
 * file, reusing the same config paths mcpOfficial.ts already writes the built-in
 * filesystem server to. Deliberately kept separate from mcpOfficial.ts rather than
 * generalizing its hardcoded filesystem-server upsert helper in place — this is new,
 * lower-trust surface (arbitrary user-supplied command/args), and mcpOfficial.ts's
 * existing path is load-bearing for every workspace's filesystem access.
 *
 * Copilot is excluded: it only reads MCP servers from package.json's
 * contributes.mcpServers at install time, so a server registered at runtime can never
 * reach it through a settings-file write the way Claude/Cursor/Kiro's config files can.
 */
export type CustomMcpAgentId = "claude" | "cursor" | "kiro";

const CLAUDE_CONFIG_PATH = path.join(os.homedir(), ".claude.json");
const AGENT_CONFIG_PATHS: Record<CustomMcpAgentId, string> = {
  claude: CLAUDE_CONFIG_PATH,
  cursor: path.join(os.homedir(), ".cursor", "mcp.json"),
  kiro: path.join(os.homedir(), ".kiro", "settings", "mcp.json"),
};
export const CUSTOM_MCP_AGENT_DISPLAY_NAMES: Record<CustomMcpAgentId, string> = {
  claude: "Claude Code",
  cursor: "Cursor",
  kiro: "Kiro",
};

// A registry of servers this extension has added, distinct from each agent's own config
// file — without it, "remove a custom server" would have no way to tell a server this
// extension added from one the user configured by hand outside the extension entirely.
const REGISTRY_PATH = path.join(os.homedir(), ".claude", "mcp-servers", "custom-servers.json");

export interface CustomMcpServerSpec {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface AgentMcpConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

function readRegistry(): CustomMcpServerSpec[] {
  return readJsonFile<CustomMcpServerSpec[]>(REGISTRY_PATH) ?? [];
}

function writeRegistry(specs: CustomMcpServerSpec[]): void {
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  writeJsonAtomic(REGISTRY_PATH, specs);
}

export function listCustomMcpServers(): CustomMcpServerSpec[] {
  return readRegistry();
}

function toEntry(spec: CustomMcpServerSpec): McpServerEntry {
  const entry: McpServerEntry = { command: spec.command, args: spec.args };
  if (spec.env && Object.keys(spec.env).length > 0) {
    entry.env = spec.env;
  }
  return entry;
}

function upsertEntry(configPath: string, name: string, entry: McpServerEntry): void {
  const config = readJsonFile<AgentMcpConfig>(configPath) ?? {};
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers[name] = entry;
  writeJsonAtomic(configPath, config);
}

function removeEntry(configPath: string, name: string): boolean {
  const config = readJsonFile<AgentMcpConfig>(configPath);
  if (!config?.mcpServers?.[name]) {
    return false;
  }
  delete config.mcpServers[name];
  writeJsonAtomic(configPath, config);
  return true;
}

function enabledAgentIds(): CustomMcpAgentId[] {
  const configured = vscode.workspace
    .getConfiguration("claudeSkills.agents")
    .get<string[]>("enabled", ["claude", "cursor", "kiro", "copilot"]);
  return (["claude", "cursor", "kiro"] as const).filter((agentId) => configured.includes(agentId));
}

export interface AddCustomMcpServerResult {
  name: string;
  configured: CustomMcpAgentId[];
  errors: { agentId: CustomMcpAgentId; message: string }[];
}

export function addCustomMcpServer(spec: CustomMcpServerSpec): AddCustomMcpServerResult {
  const result: AddCustomMcpServerResult = { name: spec.name, configured: [], errors: [] };
  const entry = toEntry(spec);
  const agentIds = enabledAgentIds();

  for (const agentId of agentIds) {
    try {
      upsertEntry(AGENT_CONFIG_PATHS[agentId], spec.name, entry);
      result.configured.push(agentId);
    } catch (err) {
      result.errors.push({ agentId, message: err instanceof Error ? err.message : String(err) });
    }
  }

  const registry = readRegistry().filter((s) => s.name !== spec.name);
  registry.push(spec);
  writeRegistry(registry);

  return result;
}

export interface RemoveCustomMcpServerResult {
  name: string;
  removedFrom: CustomMcpAgentId[];
}

export function removeCustomMcpServer(name: string): RemoveCustomMcpServerResult {
  const removedFrom: CustomMcpAgentId[] = [];
  for (const agentId of ["claude", "cursor", "kiro"] as const) {
    if (removeEntry(AGENT_CONFIG_PATHS[agentId], name)) {
      removedFrom.push(agentId);
    }
  }
  const registry = readRegistry().filter((s) => s.name !== name);
  writeRegistry(registry);
  return { name, removedFrom };
}
