import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readMcpUsageLog, workspaceMcpLogPath } from "./mcpUsageLog";

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

function readJsonConfig<T = { mcpServers?: Record<string, { command: string; args?: string[] }> }>(
  filePath: string
): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function isFilesystemServerEntry(entry: { command: string; args?: string[] } | undefined): boolean {
  return entry?.command === "node" && (entry?.args?.length ?? 0) >= 1;
}

export function checkMcpHealth(target?: string): McpHealth {
  const errors: string[] = [];

  // Check 1: Server binary
  const serverExists = fs.existsSync(FILESYSTEM_SERVER_PATH);
  if (!serverExists) {
    errors.push(`MCP server script missing: ${FILESYSTEM_SERVER_PATH}`);
  }

  // Check 2: Per-agent config (claude, cursor, kiro; copilot is always registered via
  // package.json contributes.mcpServers and needs no config-file write).
  const configuredAgents: string[] = ["copilot"]; // always registered via contributes.mcpServers
  for (const [agentId, configPath] of Object.entries(AGENT_CONFIG_PATHS)) {
    const config = readJsonConfig(configPath);
    const entry = config?.mcpServers?.["filesystem"];
    if (isFilesystemServerEntry(entry)) {
      configuredAgents.push(agentId);
    }
  }

  // Copilot is always registered via contributes.mcpServers so it needs no config-file
  // write — exclude it from the "is the server actually wired up?" binary check, but
  // also require allowed-dirs.json to exist or Copilot's server process will crash.
  const allowedDirsPath = path.join(
    os.homedir(), ".claude", "mcp-servers", "filesystem", "allowed-dirs.json"
  );
  const copilotReady = fs.existsSync(allowedDirsPath);
  const realAgents = configuredAgents.filter((a) => a !== "copilot");
  const configValid = serverExists && (realAgents.length > 0 || copilotReady);
  if (!configValid && serverExists) {
    errors.push("Filesystem MCP server not configured for any agent (Claude, Cursor, or Kiro).");
  }

  // Check 3: Activity (last 24h across all agents). The global log (MCP_USAGE_LOG_PATH)
  // is never actually appended to by real tool-call recording — the only code that
  // touches it besides reading is clearMcpLogs(), which truncates it — so real usage
  // lives exclusively in each workspace's own <target>/.claude/mcp-usage.jsonl. Checking
  // only the global log meant this always reported "no-activity" regardless of how much
  // real, successful MCP usage had actually happened, permanently blocking
  // enableMcpForcePermissions()'s health gate. Check both when a target is available.
  const workspaceLogEntries = target ? readMcpUsageLog(workspaceMcpLogPath(target)) : [];
  const logEntries = [...readMcpUsageLog(), ...workspaceLogEntries];
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const recentEntries = logEntries.filter((e) => new Date(e.ts).getTime() >= dayAgo);
  const mcpCallsLast24h = recentEntries.length;
  let hasActivity = mcpCallsLast24h > 0;
  const lastActivityTime =
    recentEntries.length > 0
      ? recentEntries.slice().sort((a, b) => b.ts.localeCompare(a.ts))[0].ts
      : undefined;

  // A brand-new workspace has no history of its own yet — that's a chicken-and-egg
  // problem, not evidence the server is broken. allowed-dirs.json already lists every
  // workspace this machine's MCP server has ever been registered for; if any of them
  // shows real recent activity, that's sufficient proof the server itself works.
  // Deliberately doesn't affect mcpCallsLast24h/lastActivityTime above (which stay
  // scoped to *this* workspace) — otherwise the status bar would show a confusing count
  // blended in from unrelated projects.
  if (!hasActivity) {
    const allowedDirsConfig = readJsonConfig<{ allowedDirs?: string[] }>(allowedDirsPath);
    for (const dir of allowedDirsConfig?.allowedDirs ?? []) {
      if (dir === target) continue; // already checked above
      const entries = readMcpUsageLog(workspaceMcpLogPath(dir));
      if (entries.some((e) => new Date(e.ts).getTime() >= dayAgo)) {
        hasActivity = true;
        break;
      }
    }
  }

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

