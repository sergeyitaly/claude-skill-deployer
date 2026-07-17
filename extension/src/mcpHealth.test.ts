import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted before imports — must be declared at module top level before
// any variable that references the mocked module.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

// Stub readMcpUsageLog to avoid reading the real global log.
vi.mock("./mcpUsageLog", () => ({
  readMcpUsageLog: vi.fn(() => []),
  workspaceMcpLogPath: (root: string) => `${root}/.claude/mcp-usage.jsonl`,
}));

// Import after mocks are declared.
import * as fs from "node:fs";
import { checkMcpHealth } from "./mcpHealth";

const FILESYSTEM_SERVER_PATH = path.join(
  os.homedir(),
  ".claude",
  "mcp-servers",
  "filesystem",
  "index.js"
);
const CLAUDE_CONFIG_PATH = path.join(os.homedir(), ".claude.json");
const CURSOR_CONFIG_PATH = path.join(os.homedir(), ".cursor", "mcp.json");
const KIRO_CONFIG_PATH = path.join(os.homedir(), ".kiro", "settings", "mcp.json");
const ALLOWED_DIRS_PATH = path.join(
  os.homedir(),
  ".claude",
  "mcp-servers",
  "filesystem",
  "allowed-dirs.json"
);

afterEach(() => {
  vi.clearAllMocks();
});

function fakeExistsSync(presentPaths: string[]): void {
  vi.mocked(fs.existsSync).mockImplementation((p) => presentPaths.includes(String(p)));
}

function fakeReadFileSync(fileMap: Record<string, string>): void {
  vi.mocked(fs.readFileSync).mockImplementation((p, ..._args) => {
    const key = String(p);
    if (key in fileMap) return fileMap[key];
    throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
  });
}

describe("checkMcpHealth", () => {
  it("reports config-issue when server binary is missing", () => {
    fakeExistsSync([]);
    fakeReadFileSync({});
    const health = checkMcpHealth();
    expect(health.serverExists).toBe(false);
    expect(health.status).toBe("config-issue");
    expect(health.errors.some((e) => e.includes("missing"))).toBe(true);
  });

  it("reports config-issue when server exists but no real agent is configured", () => {
    fakeExistsSync([FILESYSTEM_SERVER_PATH]);
    fakeReadFileSync({
      [CLAUDE_CONFIG_PATH]: JSON.stringify({ mcpServers: {} }),
    });
    const health = checkMcpHealth();
    expect(health.serverExists).toBe(true);
    expect(health.configValid).toBe(false);
    expect(health.status).toBe("config-issue");
  });

  it("reports no-activity when server exists and claude is configured but no recent calls", () => {
    fakeExistsSync([FILESYSTEM_SERVER_PATH]);
    fakeReadFileSync({
      [CLAUDE_CONFIG_PATH]: JSON.stringify({
        mcpServers: {
          filesystem: { command: "node", args: [FILESYSTEM_SERVER_PATH] },
        },
      }),
    });
    const health = checkMcpHealth();
    expect(health.serverExists).toBe(true);
    expect(health.configValid).toBe(true);
    expect(health.status).toBe("no-activity");
    expect(health.configuredAgents).toContain("claude");
  });

  it("reports ready when server is configured and has recent activity", async () => {
    const { readMcpUsageLog } = await import("./mcpUsageLog");
    vi.mocked(readMcpUsageLog).mockReturnValueOnce([
      { ts: new Date().toISOString(), tool: "read_file", path: "/a.ts", durationMs: 5 },
    ]);
    fakeExistsSync([FILESYSTEM_SERVER_PATH]);
    fakeReadFileSync({
      [CLAUDE_CONFIG_PATH]: JSON.stringify({
        mcpServers: {
          filesystem: { command: "node", args: [FILESYSTEM_SERVER_PATH] },
        },
      }),
    });
    const health = checkMcpHealth();
    expect(health.status).toBe("ready");
    expect(health.hasActivity).toBe(true);
    expect(health.mcpCallsLast24h).toBe(1);
  });

  it("always includes copilot in configuredAgents (registered via package.json)", () => {
    fakeExistsSync([]);
    fakeReadFileSync({});
    const health = checkMcpHealth();
    expect(health.configuredAgents).toContain("copilot");
  });

  it("counts cursor and kiro as configured when their config files list the server", () => {
    const filesystemEntry = { command: "node", args: ["/some/path/index.js"] };
    fakeExistsSync([FILESYSTEM_SERVER_PATH]);
    fakeReadFileSync({
      [CLAUDE_CONFIG_PATH]: JSON.stringify({ mcpServers: {} }),
      [CURSOR_CONFIG_PATH]: JSON.stringify({ mcpServers: { filesystem: filesystemEntry } }),
      [KIRO_CONFIG_PATH]: JSON.stringify({ mcpServers: { filesystem: filesystemEntry } }),
    });
    const health = checkMcpHealth();
    expect(health.configuredAgents).toContain("cursor");
    expect(health.configuredAgents).toContain("kiro");
  });

  it("configValid is true only when serverExists AND at least one real agent is configured", () => {
    fakeExistsSync([FILESYSTEM_SERVER_PATH]);
    fakeReadFileSync({
      [CLAUDE_CONFIG_PATH]: JSON.stringify({
        mcpServers: {
          filesystem: { command: "node", args: [FILESYSTEM_SERVER_PATH] },
        },
      }),
    });
    const health = checkMcpHealth();
    expect(health.configValid).toBe(true);
  });

  it("regression: reports ready from workspace-log activity even when the global log has none", async () => {
    // Real-world bug: the global log (MCP_USAGE_LOG_PATH) is only ever truncated by
    // clearMcpLogs(), never appended to by real tool-call recording — actual usage lives
    // in <target>/.claude/mcp-usage.jsonl. Passing no target meant checkMcpHealth() always
    // read the (perpetually empty) global log and reported "no-activity" regardless of how
    // much real MCP usage had happened, permanently blocking enableMcpForcePermissions().
    const { readMcpUsageLog } = await import("./mcpUsageLog");
    vi.mocked(readMcpUsageLog).mockImplementation((logPath?: string) => {
      if (logPath === "/my/workspace/.claude/mcp-usage.jsonl") {
        return [{ ts: new Date().toISOString(), tool: "read_file", path: "/a.ts", durationMs: 5 }];
      }
      return []; // global log: empty, as it always is in practice
    });
    fakeExistsSync([FILESYSTEM_SERVER_PATH]);
    fakeReadFileSync({
      [CLAUDE_CONFIG_PATH]: JSON.stringify({
        mcpServers: {
          filesystem: { command: "node", args: [FILESYSTEM_SERVER_PATH] },
        },
      }),
    });

    const withoutTarget = checkMcpHealth();
    expect(withoutTarget.status).toBe("no-activity");

    const withTarget = checkMcpHealth("/my/workspace");
    expect(withTarget.status).toBe("ready");
    expect(withTarget.hasActivity).toBe(true);
  });

  it("regression: falls back to any other allowed-dirs workspace's activity for a brand-new workspace with no history of its own", async () => {
    // Real-world case: a workspace that has never had an agent chat session use MCP
    // tools inside it (only extension commands run via Command Palette, which don't
    // generate MCP usage log entries) has no own workspace log at all yet — that's a
    // chicken-and-egg problem, not proof the server is broken. allowed-dirs.json already
    // lists every workspace this machine's MCP server has ever served; if any of them has
    // real recent activity, that's sufficient evidence the server itself works.
    const { readMcpUsageLog } = await import("./mcpUsageLog");
    vi.mocked(readMcpUsageLog).mockImplementation((logPath?: string) => {
      if (logPath === "/other/real-project/.claude/mcp-usage.jsonl") {
        return [{ ts: new Date().toISOString(), tool: "read_file", path: "/a.ts", durationMs: 5 }];
      }
      return []; // global log and the brand-new workspace's own log: both empty
    });
    fakeExistsSync([FILESYSTEM_SERVER_PATH]);
    fakeReadFileSync({
      [CLAUDE_CONFIG_PATH]: JSON.stringify({
        mcpServers: {
          filesystem: { command: "node", args: [FILESYSTEM_SERVER_PATH] },
        },
      }),
      [ALLOWED_DIRS_PATH]: JSON.stringify({
        allowedDirs: ["/brand/new/workspace", "/other/real-project"],
      }),
    });

    const health = checkMcpHealth("/brand/new/workspace");

    expect(health.status).toBe("ready");
    expect(health.hasActivity).toBe(true);
    // The displayed count/timestamp stay scoped to this workspace — not blended in from
    // the unrelated project that actually proved the server works.
    expect(health.mcpCallsLast24h).toBe(0);
    expect(health.lastActivityTime).toBeUndefined();
  });
});
