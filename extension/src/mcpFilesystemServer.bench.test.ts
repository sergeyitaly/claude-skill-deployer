/**
 * Benchmark: Filesystem MCP server (extension/resources/mcp-servers/filesystem/index.js)
 *
 * Spawns the server scoped to a temp directory via --config, drives it via
 * JSON-RPC 2.0 over stdio, and reports min/avg/max latency for each tool.
 * Also verifies the allowlist actually blocks paths outside the scoped dir.
 *
 * Run: npx vitest run src/mcpFilesystemServer.bench.test.ts
 */

import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SERVER_PATH = path.join(__dirname, "..", "resources", "mcp-servers", "filesystem", "index.js");
const ITERATIONS = 20;

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

class McpClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, (res: JsonRpcResponse) => void>();
  private buffer = "";

  constructor(configPath: string) {
    this.proc = spawn("node", [SERVER_PATH, "--config", configPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, MCP_DISABLE_USAGE_LOG: "1" },
    });

    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          const resolve = this.pending.get(msg.id);
          if (resolve) {
            this.pending.delete(msg.id);
            resolve(msg);
          }
        } catch {
          // ignore malformed lines
        }
      }
    });

    this.proc.stderr.on("data", () => {});
  }

  async call(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
      }, 5000);
      this.proc.stdin.write(msg, () => clearTimeout(timeout));
    });
  }

  notify(method: string, params?: unknown) {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.proc.stdin.write(msg);
  }

  close() {
    this.proc.stdin.end();
  }
}

// ---------------------------------------------------------------------------
// Stats helper
// ---------------------------------------------------------------------------

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: sorted[0],
    avg: Math.round(sum / sorted.length),
    p95: sorted[Math.floor(sorted.length * 0.95)],
    max: sorted.at(-1) ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Filesystem MCP server benchmark", () => {
  let client: McpClient;
  let tmpDir: string;
  let configFile: string;
  let sampleFile: string;
  // A sibling directory outside the allowlist — used to verify blocking
  let blockedDir: string;

  beforeAll(async () => {
    // Create two separate temp dirs: one allowed, one blocked
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-bench-"));
    blockedDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-blocked-"));

    sampleFile = path.join(tmpDir, "sample.txt");
    fs.writeFileSync(sampleFile, "hello benchmark\n".repeat(100));

    // Write allowed-dirs config scoped to tmpDir only
    configFile = path.join(tmpDir, "allowed-dirs.json");
    fs.writeFileSync(configFile, JSON.stringify({ allowedDirs: [tmpDir] }), "utf-8");

    client = new McpClient(configFile);

    // Handshake
    const init = await client.call("initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "bench", version: "0.0.1" },
    });
    expect(init.result).toBeDefined();
    // Verify server advertises our allowed dir
    const info = (init.result as { serverInfo?: { allowedDirs?: string[] } }).serverInfo;
    expect(info?.allowedDirs).toContain(path.resolve(tmpDir));

    client.notify("notifications/initialized");
  });

  afterAll(() => {
    client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(blockedDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Security
  // -------------------------------------------------------------------------

  it("blocks read outside allowed dirs", async () => {
    const res = await client.call("tools/call", {
      name: "read_file",
      arguments: { path: path.join(blockedDir, "secret.txt") },
    });
    expect(res.error).toBeDefined();
    expect(res.error?.message).toMatch(/Access denied/);
  });

  it("blocks write outside allowed dirs", async () => {
    const res = await client.call("tools/call", {
      name: "write_file",
      arguments: { path: path.join(blockedDir, "evil.txt"), content: "x" },
    });
    expect(res.error).toBeDefined();
    expect(res.error?.message).toMatch(/Access denied/);
    expect(fs.existsSync(path.join(blockedDir, "evil.txt"))).toBe(false);
  });

  it("blocks list_directory outside allowed dirs", async () => {
    const res = await client.call("tools/call", {
      name: "list_directory",
      arguments: { path: blockedDir },
    });
    expect(res.error).toBeDefined();
    expect(res.error?.message).toMatch(/Access denied/);
  });

  it("blocks delete outside allowed dirs", async () => {
    const decoy = path.join(blockedDir, "decoy.txt");
    fs.writeFileSync(decoy, "should not be deleted");
    const res = await client.call("tools/call", {
      name: "delete_file",
      arguments: { path: decoy },
    });
    expect(res.error).toBeDefined();
    expect(fs.existsSync(decoy)).toBe(true);
  });

  it("live config reload: newly allowed dir is accessible without restart", async () => {
    const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-extra-"));
    try {
      const extraFile = path.join(extraDir, "live.txt");
      fs.writeFileSync(extraFile, "live reload content");

      // Before update — access denied
      const before = await client.call("tools/call", {
        name: "read_file",
        arguments: { path: extraFile },
      });
      expect(before.error).toBeDefined();

      // Update config file in place (simulates refreshFilesystemAllowedDirs)
      fs.writeFileSync(
        configFile,
        JSON.stringify({ allowedDirs: [tmpDir, extraDir] }),
        "utf-8"
      );

      // After update — same process, next call picks up new dirs
      const after = await client.call("tools/call", {
        name: "read_file",
        arguments: { path: extraFile },
      });
      expect(after.error).toBeUndefined();
      expect((after.result as { content: string }).content).toBe("live reload content");
    } finally {
      // Restore config to tmpDir-only for remaining tests
      fs.writeFileSync(configFile, JSON.stringify({ allowedDirs: [tmpDir] }), "utf-8");
      fs.rmSync(extraDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Performance
  // -------------------------------------------------------------------------

  it("tools/list latency", async () => {
    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      const res = await client.call("tools/list");
      samples.push(performance.now() - t0);
      expect(res.error).toBeUndefined();
    }
    const s = stats(samples);
    console.log(`tools/list  — min:${s.min.toFixed(1)}ms  avg:${s.avg}ms  p95:${s.p95.toFixed(1)}ms  max:${s.max.toFixed(1)}ms`);
    // 200ms allows for system load when running alongside the full test suite;
    // tools/list has no disk I/O so genuine regressions still register clearly.
    expect(s.avg).toBeLessThan(200);
  });

  it("read_file latency", async () => {
    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      const res = await client.call("tools/call", { name: "read_file", arguments: { path: sampleFile } });
      samples.push(performance.now() - t0);
      expect(res.error).toBeUndefined();
    }
    const s = stats(samples);
    console.log(`read_file   — min:${s.min.toFixed(1)}ms  avg:${s.avg}ms  p95:${s.p95.toFixed(1)}ms  max:${s.max.toFixed(1)}ms`);
    expect(s.avg).toBeLessThan(50);
  });

  it("write_file latency", async () => {
    const writeFile = path.join(tmpDir, "write-bench.txt");
    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      const res = await client.call("tools/call", {
        name: "write_file",
        arguments: { path: writeFile, content: `iteration ${i}\n` },
      });
      samples.push(performance.now() - t0);
      expect(res.error).toBeUndefined();
    }
    const s = stats(samples);
    console.log(`write_file  — min:${s.min.toFixed(1)}ms  avg:${s.avg}ms  p95:${s.p95.toFixed(1)}ms  max:${s.max.toFixed(1)}ms`);
    expect(s.avg).toBeLessThan(50);
  });

  it("list_directory latency", async () => {
    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      const res = await client.call("tools/call", { name: "list_directory", arguments: { path: tmpDir } });
      samples.push(performance.now() - t0);
      expect(res.error).toBeUndefined();
    }
    const s = stats(samples);
    console.log(`list_dir    — min:${s.min.toFixed(1)}ms  avg:${s.avg}ms  p95:${s.p95.toFixed(1)}ms  max:${s.max.toFixed(1)}ms`);
    expect(s.avg).toBeLessThan(50);
  });

  it("delete_file latency", async () => {
    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const delFile = path.join(tmpDir, `del-${i}.txt`);
      fs.writeFileSync(delFile, "x");
      const t0 = performance.now();
      const res = await client.call("tools/call", { name: "delete_file", arguments: { path: delFile } });
      samples.push(performance.now() - t0);
      expect(res.error).toBeUndefined();
    }
    const s = stats(samples);
    console.log(`delete_file — min:${s.min.toFixed(1)}ms  avg:${s.avg}ms  p95:${s.p95.toFixed(1)}ms  max:${s.max.toFixed(1)}ms`);
    expect(s.avg).toBeLessThan(50);
  });

  it("concurrent throughput (10 parallel read_file calls)", async () => {
    const t0 = performance.now();
    const calls = Array.from({ length: 10 }, () =>
      client.call("tools/call", { name: "read_file", arguments: { path: sampleFile } })
    );
    const results = await Promise.all(calls);
    const elapsed = performance.now() - t0;
    const errors = results.filter((r) => r.error);
    console.log(`concurrent  — 10 reads in ${elapsed.toFixed(1)}ms (${(elapsed / 10).toFixed(1)}ms/req)`);
    expect(errors).toHaveLength(0);
    expect(elapsed).toBeLessThan(500);
  });
});
