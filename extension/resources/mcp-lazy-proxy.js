#!/usr/bin/env node
// MCP transparent proxy — bundled with Claude Skills extension.
// Aggregates multiple upstream MCP servers and compresses tool schemas to reduce token usage.
// Usage: node mcp-lazy-proxy.js --config /path/to/proxy-config.json
"use strict";

const { spawn } = require("child_process");
const readline = require("readline");
const fs = require("fs");

const DESC_MAX = 100;

function truncate(str, max) {
  if (!str || str.length <= max) return str;
  return str.slice(0, max - 1) + "…";
}

function compressInputSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const out = { ...schema };
  delete out.description;
  if (out.properties) {
    const props = {};
    for (const [k, v] of Object.entries(out.properties)) {
      props[k] = compressInputSchema(v);
    }
    out.properties = props;
  }
  if (out.items) out.items = compressInputSchema(out.items);
  if (out.additionalProperties && typeof out.additionalProperties === "object") {
    out.additionalProperties = compressInputSchema(out.additionalProperties);
  }
  return out;
}

function compressTool(tool) {
  return {
    name: tool.name,
    description: truncate(tool.description, DESC_MAX),
    ...(tool.inputSchema ? { inputSchema: compressInputSchema(tool.inputSchema) } : {}),
  };
}

class Upstream {
  constructor(name, cfg) {
    this.name = name;
    this.cfg = cfg;
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.tools = null;
    this._startPromise = null;
  }

  start() {
    if (this._startPromise) return this._startPromise;
    this._startPromise = this._doStart();
    return this._startPromise;
  }

  async _doStart() {
    const { command, args = [], env = {} } = this.cfg;
    this.proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...env },
      shell: false,
    });

    this.proc.on("exit", (code) => {
      process.stderr.write(`[mcp-proxy] upstream "${this.name}" exited (code=${code})\n`);
      for (const { reject } of this.pending.values()) {
        reject(new Error(`Upstream "${this.name}" exited`));
      }
      this.pending.clear();
      this.proc = null;
    });

    const rl = readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) {
          const err = new Error(msg.error.message);
          err.code = msg.error.code;
          reject(err);
        } else {
          resolve(msg.result);
        }
      }
    });

    const initResult = await this._request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "claude-skills-proxy", version: "1.0" },
    });
    this._write({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    return initResult;
  }

  _write(obj) {
    if (!this.proc) return;
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  _request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout waiting for "${method}" from upstream "${this.name}"`));
        }
      }, 15000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this._write({ jsonrpc: "2.0", id, method, params });
    });
  }

  async getTools() {
    if (this.tools) return this.tools;
    await this.start();
    const result = await this._request("tools/list", {});
    this.tools = (result.tools || []).map((t) => ({ ...t, _upstream: this.name }));
    return this.tools;
  }

  async callTool(name, args) {
    await this.start();
    return this._request("tools/call", { name, arguments: args });
  }
}

async function run() {
  const argv = process.argv.slice(2);
  const cfgIdx = argv.indexOf("--config");
  if (cfgIdx === -1 || !argv[cfgIdx + 1]) {
    process.stderr.write("Usage: mcp-lazy-proxy.js --config <path>\n");
    process.exit(1);
  }

  let proxyConfig;
  try {
    proxyConfig = JSON.parse(fs.readFileSync(argv[cfgIdx + 1], "utf-8"));
  } catch (e) {
    process.stderr.write(`[mcp-proxy] Cannot read config: ${e.message}\n`);
    process.exit(1);
  }

  const upstreams = Object.entries(proxyConfig.servers || {}).map(
    ([name, cfg]) => new Upstream(name, cfg)
  );

  // Start all upstreams in background so they're ready when tools/list arrives
  const startAll = Promise.all(
    upstreams.map((u) =>
      u.start().catch((e) => {
        process.stderr.write(`[mcp-proxy] Failed to start "${u.name}": ${e.message}\n`);
      })
    )
  );

  let toolRouting = null;
  let mergedTools = null;

  async function ensureToolRouting() {
    if (toolRouting) return;
    await startAll;
    toolRouting = new Map();
    mergedTools = [];
    for (const upstream of upstreams) {
      try {
        const tools = await upstream.getTools();
        for (const tool of tools) {
          toolRouting.set(tool.name, upstream);
          mergedTools.push(compressTool(tool));
        }
      } catch (e) {
        process.stderr.write(`[mcp-proxy] tools/list failed for "${upstream.name}": ${e.message}\n`);
      }
    }
  }

  function send(msg) {
    process.stdout.write(JSON.stringify(msg) + "\n");
  }
  function respond(id, result) {
    send({ jsonrpc: "2.0", id, result });
  }
  function respondError(id, code, message) {
    send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    const { id, method, params } = msg;
    if (!method) return;

    try {
      switch (method) {
        case "initialize":
          respond(id, {
            protocolVersion: params?.protocolVersion || "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "claude-skills-mcp-proxy", version: "1.0" },
          });
          break;

        case "notifications/initialized":
          break;

        case "tools/list":
          await ensureToolRouting();
          respond(id, { tools: mergedTools || [] });
          break;

        case "tools/call": {
          const toolName = params?.name;
          await ensureToolRouting();
          const upstream = toolRouting?.get(toolName);
          if (!upstream) {
            respondError(id, -32601, `Tool not found: ${toolName}`);
            break;
          }
          const result = await upstream.callTool(toolName, params?.arguments || {});
          respond(id, result);
          break;
        }

        case "ping":
          if (id != null) respond(id, {});
          break;

        default:
          if (id != null) respondError(id, -32601, `Method not supported by proxy: ${method}`);
      }
    } catch (e) {
      if (id != null) respondError(id, -32000, e.message);
    }
  });

  process.stdin.on("end", () => process.exit(0));
}

run().catch((e) => {
  process.stderr.write(`[mcp-proxy] Fatal: ${e.message}\n`);
  process.exit(1);
});
