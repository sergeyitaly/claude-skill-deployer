import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enableMcpForcePermissions,
  injectMcpForceClaude,
  isMcpForceActive,
  isMcpForceClaudeMdInjected,
  isMcpForcePermissionsActive,
  removeMcpForceClaudeBlock,
  revertMcpForcePermissions,
} from "./mcpForce";

// Mock health check so force-enable tests are not coupled to real MCP server state.
vi.mock("./mcpHealth", () => ({
  checkMcpHealth: vi.fn(() => ({ status: "ready", errors: [] })),
}));

const tmpDirs: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-force-test-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
  vi.clearAllMocks();
});

function writeSettings(dir: string, data: object): void {
  fs.writeFileSync(path.join(dir, ".claude", "settings.json"), JSON.stringify(data), "utf-8");
}

function readSettings(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf-8")) as Record<string, unknown>;
}

// ── isMcpForcePermissionsActive ───────────────────────────────────────────────────────────────────────────────────────

describe("isMcpForcePermissionsActive", () => {
  it("returns false when settings.json does not exist", () => {
    const ws = makeWorkspace();
    expect(isMcpForcePermissionsActive(ws)).toBe(false);
  });

  it("returns false when deny list is absent", () => {
    const ws = makeWorkspace();
    writeSettings(ws, { permissions: {} });
    expect(isMcpForcePermissionsActive(ws)).toBe(false);
  });

  it("returns false when deny list is missing some force tools", () => {
    const ws = makeWorkspace();
    writeSettings(ws, { permissions: { deny: ["Read"] } });
    expect(isMcpForcePermissionsActive(ws)).toBe(false);
  });

  it("returns true when all eight force tools are in the deny list", () => {
    const ws = makeWorkspace();
    writeSettings(ws, {
      permissions: { deny: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "mcp__claude-skills-cli__run_command", "mcp__claude-skills-cli__list_available_clis"] },
    });
    expect(isMcpForcePermissionsActive(ws)).toBe(true);
  });

  it("returns true even when deny list has extra entries", () => {
    const ws = makeWorkspace();
    writeSettings(ws, {
      permissions: { deny: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "mcp__claude-skills-cli__run_command", "mcp__claude-skills-cli__list_available_clis", "SomethingElse"] },
    });
    expect(isMcpForcePermissionsActive(ws)).toBe(true);
  });
});

// ── isMcpForceClaudeMdInjected ────────────────────────────────────────────────────────────────────────────────────────

describe("isMcpForceClaudeMdInjected", () => {
  it("returns false when CLAUDE.md does not exist", () => {
    const ws = makeWorkspace();
    expect(isMcpForceClaudeMdInjected(ws)).toBe(false);
  });

  it("returns false when CLAUDE.md exists but has no force block", () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "CLAUDE.md"), "# Normal instructions\n", "utf-8");
    expect(isMcpForceClaudeMdInjected(ws)).toBe(false);
  });

  it("returns true when CLAUDE.md contains the force block marker", () => {
    const ws = makeWorkspace();
    fs.writeFileSync(
      path.join(ws, "CLAUDE.md"),
      "<!-- claude-skills-mcp-force -->\n## MCP REQUIRED\n<!-- /claude-skills-mcp-force -->\n",
      "utf-8"
    );
    expect(isMcpForceClaudeMdInjected(ws)).toBe(true);
  });
});

// ── isMcpForceActive ──────────────────────────────────────────────────────────────────────────────────────────────────

describe("isMcpForceActive", () => {
  it("is true iff permissions deny list is fully set (delegates to isMcpForcePermissionsActive)", () => {
    const ws = makeWorkspace();
    expect(isMcpForceActive(ws)).toBe(false);
    writeSettings(ws, {
      permissions: { deny: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "mcp__claude-skills-cli__run_command", "mcp__claude-skills-cli__list_available_clis"] },
    });
    expect(isMcpForceActive(ws)).toBe(true);
  });
});

// ── enableMcpForcePermissions ─────────────────────────────────────────────────────────────────────────────────────────

describe("enableMcpForcePermissions", () => {
  it("writes all six force tools to permissions.deny", () => {
    const ws = makeWorkspace();
    const result = enableMcpForcePermissions(ws);
    expect(result).toEqual({ ok: true, permissionsWritten: true });
    expect(isMcpForcePermissionsActive(ws)).toBe(true);
    const settings = readSettings(ws);
    const deny = (settings as { permissions?: { deny?: string[] } }).permissions?.deny ?? [];
    expect(deny).toContain("Read");
    expect(deny).toContain("Bash");
  });

  it("merges with existing deny entries without duplicates", () => {
    const ws = makeWorkspace();
    writeSettings(ws, { permissions: { deny: ["ExistingTool"] } });
    const result = enableMcpForcePermissions(ws);
    expect(result.ok).toBe(true);
    const settings = readSettings(ws);
    const deny = (settings as { permissions?: { deny?: string[] } }).permissions?.deny ?? [];
    expect(deny).toContain("ExistingTool");
    expect(deny).toContain("Read");
    const readCount = deny.filter((t) => t === "Read").length;
    expect(readCount).toBe(1);
  });

  it("returns ok:false when health check reports config-issue", async () => {
    const { checkMcpHealth } = await import("./mcpHealth");
    vi.mocked(checkMcpHealth).mockReturnValueOnce({
      status: "config-issue",
      errors: ["MCP server script missing"],
      configValid: false,
      serverExists: false,
      hasActivity: false,
      mcpCallsLast24h: 0,
      configuredAgents: [],
    });
    const ws = makeWorkspace();
    const result = enableMcpForcePermissions(ws);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("MCP server is not ready");
    }
  });
});

// ── revertMcpForcePermissions ─────────────────────────────────────────────────────────────────────────────────────────

describe("revertMcpForcePermissions", () => {
  it("removes force tools from deny list while preserving other entries", () => {
    const ws = makeWorkspace();
    writeSettings(ws, {
      permissions: { deny: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Keeper"] },
    });
    revertMcpForcePermissions(ws);
    const settings = readSettings(ws);
    const deny = (settings as { permissions?: { deny?: string[] } }).permissions?.deny ?? [];
    expect(deny).not.toContain("Read");
    expect(deny).not.toContain("Bash");
    expect(deny).toContain("Keeper");
  });

  it("removes permissions.deny key when only force tools were there", () => {
    const ws = makeWorkspace();
    writeSettings(ws, {
      permissions: { deny: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"] },
    });
    revertMcpForcePermissions(ws);
    const settings = readSettings(ws);
    const deny = (settings as { permissions?: { deny?: string[] } }).permissions?.deny;
    expect(deny).toBeUndefined();
  });

  it("is a no-op when settings.json has no deny list", () => {
    const ws = makeWorkspace();
    writeSettings(ws, {});
    expect(() => revertMcpForcePermissions(ws)).not.toThrow();
  });
});

// ── injectMcpForceClaude ──────────────────────────────────────────────────────────────────────────────────────────────

describe("injectMcpForceClaude", () => {
  it("creates CLAUDE.md with force block when file does not exist", () => {
    const ws = makeWorkspace();
    const result = injectMcpForceClaude(ws);
    expect(result).toEqual({ ok: true });
    expect(isMcpForceClaudeMdInjected(ws)).toBe(true);
    const content = fs.readFileSync(path.join(ws, "CLAUDE.md"), "utf-8");
    expect(content).toContain("## MCP REQUIRED");
    expect(content).toContain("mcp__filesystem__read_file");
  });

  it("prepends force block to existing CLAUDE.md content", () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "CLAUDE.md"), "# My Project\n", "utf-8");
    injectMcpForceClaude(ws);
    const content = fs.readFileSync(path.join(ws, "CLAUDE.md"), "utf-8");
    expect(content).toContain("## MCP REQUIRED");
    expect(content).toContain("# My Project");
  });

  it("replaces an existing force block without duplicating it", () => {
    const ws = makeWorkspace();
    injectMcpForceClaude(ws);
    injectMcpForceClaude(ws);
    const content = fs.readFileSync(path.join(ws, "CLAUDE.md"), "utf-8");
    const markerCount = (content.match(/<!-- claude-skills-mcp-force -->/g) ?? []).length;
    expect(markerCount).toBe(1);
  });

  it("returns ok:false when health check reports config-issue", async () => {
    const { checkMcpHealth } = await import("./mcpHealth");
    vi.mocked(checkMcpHealth).mockReturnValueOnce({
      status: "config-issue",
      errors: ["MCP server script missing"],
      configValid: false,
      serverExists: false,
      hasActivity: false,
      mcpCallsLast24h: 0,
      configuredAgents: [],
    });
    const ws = makeWorkspace();
    const result = injectMcpForceClaude(ws);
    expect(result.ok).toBe(false);
  });

  it("returns ok:true without modifying CLAUDE.md when the lock file is already held", () => {
    const ws = makeWorkspace();
    const claudeMd = path.join(ws, "CLAUDE.md");
    fs.writeFileSync(claudeMd, "# Existing content\n", "utf-8");

    // Simulate a concurrent writer holding the lock (freshly created = not stale).
    const lockFile = claudeMd + ".mcpforce.lock";
    const lockFd = fs.openSync(lockFile, "w");
    fs.closeSync(lockFd);

    const result = injectMcpForceClaude(ws);

    // Should succeed (ok:true) as a no-op — the lock holder will complete the write.
    expect(result).toEqual({ ok: true });
    expect(fs.readFileSync(claudeMd, "utf-8")).toBe("# Existing content\n");
    expect(isMcpForceClaudeMdInjected(ws)).toBe(false);

    fs.unlinkSync(lockFile);
  });

  it("two concurrent calls produce exactly one force block in the final file", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "CLAUDE.md"), "# My Project\n", "utf-8");

    // Both calls run synchronously; one acquires the lock, the other is a no-op.
    const [r1, r2] = await Promise.all([
      Promise.resolve(injectMcpForceClaude(ws)),
      Promise.resolve(injectMcpForceClaude(ws)),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    const content = fs.readFileSync(path.join(ws, "CLAUDE.md"), "utf-8");
    const markerCount = (content.match(/<!-- claude-skills-mcp-force -->/g) ?? []).length;
    expect(markerCount).toBe(1);
    expect(content).toContain("# My Project");
  });
});

// ── removeMcpForceClaudeBlock ─────────────────────────────────────────────────────────────────────────────────────────

describe("removeMcpForceClaudeBlock", () => {
  it("is a no-op when CLAUDE.md does not exist", () => {
    const ws = makeWorkspace();
    expect(() => removeMcpForceClaudeBlock(ws)).not.toThrow();
  });

  it("leaves CLAUDE.md unchanged when there is no force block", () => {
    const ws = makeWorkspace();
    const original = "# Normal\n";
    fs.writeFileSync(path.join(ws, "CLAUDE.md"), original, "utf-8");
    removeMcpForceClaudeBlock(ws);
    expect(fs.readFileSync(path.join(ws, "CLAUDE.md"), "utf-8")).toBe(original);
  });

  it("removes the force block and leaves the rest intact", () => {
    const ws = makeWorkspace();
    injectMcpForceClaude(ws);
    fs.appendFileSync(path.join(ws, "CLAUDE.md"), "\n# My Content\n", "utf-8");
    removeMcpForceClaudeBlock(ws);
    const content = fs.readFileSync(path.join(ws, "CLAUDE.md"), "utf-8");
    expect(content).not.toContain("<!-- claude-skills-mcp-force -->");
    expect(content).not.toContain("## MCP REQUIRED");
    expect(content).toContain("# My Content");
  });

  it("removes the block and leaves an empty file when there was only the block", () => {
    const ws = makeWorkspace();
    injectMcpForceClaude(ws);
    removeMcpForceClaudeBlock(ws);
    const content = fs.readFileSync(path.join(ws, "CLAUDE.md"), "utf-8");
    expect(content.trim()).toBe("");
  });
});
