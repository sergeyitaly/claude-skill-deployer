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
});
