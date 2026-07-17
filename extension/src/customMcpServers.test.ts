import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let mockedHome = os.tmpdir();
// Same pattern as mcpOfficial.test.ts: os.homedir() is a native Node built-in, so the
// whole module is mocked rather than spied on, with a mutable variable each test points
// at its own scratch "home" directory.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockedHome };
});

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T,>(_key: string, defaultValue?: T): T | undefined => defaultValue,
    }),
  },
}));

const homeDirs: string[] = [];

function makeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csd-custommcp-home-"));
  homeDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of homeDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  homeDirs.length = 0;
  vi.resetModules();
});

async function loadWithHome(home: string) {
  mockedHome = home;
  vi.resetModules();
  return import("./customMcpServers");
}

function readClaudeConfig(home: string): { mcpServers?: Record<string, unknown> } {
  return JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf-8"));
}

function readCursorConfig(home: string): { mcpServers?: Record<string, unknown> } {
  return JSON.parse(fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf-8"));
}

describe("addCustomMcpServer", () => {
  it("writes the server into every default-enabled agent's config (claude, cursor, kiro — not copilot)", async () => {
    const home = makeHome();
    const mod = await loadWithHome(home);

    const result = mod.addCustomMcpServer({
      name: "github",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    });

    expect(result.configured.sort()).toEqual(["claude", "cursor", "kiro"]);
    expect(result.errors).toEqual([]);

    const claudeConfig = readClaudeConfig(home);
    expect(claudeConfig.mcpServers?.github).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    });

    const cursorConfig = readCursorConfig(home);
    expect(cursorConfig.mcpServers?.github).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    });
  });

  it("preserves pre-existing, unrelated mcpServers entries in the same config file", async () => {
    const home = makeHome();
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { filesystem: { command: "node", args: ["/some/path"] } } }),
      "utf-8"
    );
    const mod = await loadWithHome(home);

    mod.addCustomMcpServer({ name: "github", command: "npx", args: ["-y", "server-github"] });

    const config = readClaudeConfig(home);
    expect(config.mcpServers?.filesystem).toEqual({ command: "node", args: ["/some/path"] });
    expect(config.mcpServers?.github).toBeDefined();
  });

  it("records the server in the registry so it can be listed and removed later", async () => {
    const home = makeHome();
    const mod = await loadWithHome(home);

    mod.addCustomMcpServer({ name: "github", command: "npx", args: ["-y", "server-github"] });

    expect(mod.listCustomMcpServers()).toEqual([
      { name: "github", command: "npx", args: ["-y", "server-github"] },
    ]);
  });

  it("re-adding the same name updates the entry instead of duplicating it in the registry", async () => {
    const home = makeHome();
    const mod = await loadWithHome(home);

    mod.addCustomMcpServer({ name: "github", command: "npx", args: ["-y", "old-version"] });
    mod.addCustomMcpServer({ name: "github", command: "npx", args: ["-y", "new-version"] });

    const servers = mod.listCustomMcpServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].args).toEqual(["-y", "new-version"]);
  });
});

describe("removeCustomMcpServer", () => {
  it("removes the server from every agent config and the registry", async () => {
    const home = makeHome();
    const mod = await loadWithHome(home);
    mod.addCustomMcpServer({ name: "github", command: "npx", args: ["-y", "server-github"] });

    const result = mod.removeCustomMcpServer("github");

    expect(result.removedFrom.sort()).toEqual(["claude", "cursor", "kiro"]);
    expect(mod.listCustomMcpServers()).toEqual([]);
    const config = readClaudeConfig(home);
    expect(config.mcpServers?.github).toBeUndefined();
  });

  it("leaves unrelated entries in the same config file untouched", async () => {
    const home = makeHome();
    const mod = await loadWithHome(home);
    mod.addCustomMcpServer({ name: "github", command: "npx", args: ["-y", "server-github"] });
    mod.addCustomMcpServer({ name: "slack", command: "npx", args: ["-y", "server-slack"] });

    mod.removeCustomMcpServer("github");

    const config = readClaudeConfig(home);
    expect(config.mcpServers?.github).toBeUndefined();
    expect(config.mcpServers?.slack).toBeDefined();
  });

  it("is a no-op (empty removedFrom) when the server was never added", async () => {
    const home = makeHome();
    const mod = await loadWithHome(home);

    const result = mod.removeCustomMcpServer("nonexistent");

    expect(result.removedFrom).toEqual([]);
  });
});
