import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readMcpUsageLog } from "./mcpUsageLog";

const CLAUDE_HOME = path.join(os.homedir(), ".claude");
const FILESYSTEM_SERVER_DIR = path.join(CLAUDE_HOME, "mcp-servers", "filesystem");
const FILESYSTEM_SERVER_PATH = path.join(FILESYSTEM_SERVER_DIR, "index.js");

const AGENT_CONFIG_PATHS: Record<string, string> = {
  claude: path.join(os.homedir(), ".claude.json"),
  cursor: path.join(os.homedir(), ".cursor", "mcp.json"),
  kiro: path.join(os.homedir(), ".kiro", "settings", "mcp.json"),
};

export interface McpHealth {
  configValid: boolean;
  serverExists: boolean;
  hasActivity: boolean;
  lastActivityTime?: string;
  mcpCallsLast24h: number;
  status: "ready" | "config-issue" | "no-activity";
  errors: string[];
  /** Which agents have the filesystem server registered in their config. */
  configuredAgents: string[];
}

function readJsonConfig(filePath: string): { mcpServers?: Record<string, { command: string; args?: string[] }> } | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function isFilesystemServerEntry(entry: { command: string; args?: string[] } | undefined): boolean {
  return entry?.command === "node" && (entry?.args?.length ?? 0) >= 1;
}

export function checkMcpHealth(): McpHealth {
  const errors: string[] = [];

  // Check 1: Server binary
  const serverExists = fs.existsSync(FILESYSTEM_SERVER_PATH);
  if (!serverExists) {
    errors.push(`MCP server script missing: ${FILESYSTEM_SERVER_PATH}`);
  }

  // Check 2: Per-agent config (claude, cursor, kiro; copilot is always registered via package.json)
  const configuredAgents: string[] = ["copilot"]; // always registered via contributes.mcpServers
  for (const [agentId, configPath] of Object.entries(AGENT_CONFIG_PATHS)) {
    const config = readJsonConfig(configPath);
    const entry = config?.mcpServers?.["filesystem"];
    if (isFilesystemServerEntry(entry)) {
      configuredAgents.push(agentId);
    }
  }

  // Copilot is always registered via contributes.mcpServers — it needs no config-file write,
  // so it must not count toward the "is the server actually wired up?" binary check.
  const realAgents = configuredAgents.filter((a) => a !== "copilot");
  const configValid = serverExists && realAgents.length > 0;
  if (!configValid && serverExists) {
    errors.push("Filesystem MCP server not configured for any agent (Claude, Cursor, or Kiro).");
  }

  // Check 3: Activity (last 24h across all agents — shared log)
  const logEntries = readMcpUsageLog();
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const recentEntries = logEntries.filter((e) => new Date(e.ts).getTime() >= dayAgo);
  const mcpCallsLast24h = recentEntries.length;
  const hasActivity = mcpCallsLast24h > 0;
  const lastActivityTime =
    recentEntries.length > 0
      ? recentEntries.slice().sort((a, b) => b.ts.localeCompare(a.ts))[0].ts
      : undefined;

  let status: McpHealth["status"] = "ready";
  if (!configValid || !serverExists) {
    status = "config-issue";
  } else if (!hasActivity) {
    status = "no-activity";
  }

  return {
    configValid,
    serverExists,
    hasActivity,
    lastActivityTime,
    mcpCallsLast24h,
    status,
    errors,
    configuredAgents,
  };
}

