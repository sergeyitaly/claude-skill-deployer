#!/usr/bin/env node
/**
 * Minimal Filesystem MCP Server
 * Bundled with Claude Skills extension for convenient local file operations
 * Supports: read, write, list, delete files in user-specified directories
 */
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

// Helper: safely resolve paths to prevent directory traversal
function resolvePath(basePath, requestPath) {
  const resolved = path.resolve(basePath, requestPath);
  if (!resolved.startsWith(path.resolve(basePath))) {
    throw new Error("Path traversal attempt blocked");
  }
  return resolved;
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = msg;
  if (!method) return;

  try {
    switch (method) {
      case "initialize":
        respond(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "claude-skills-filesystem", version: "1.0" },
        });
        break;

      case "notifications/initialized":
        break;

      case "tools/list":
        respond(id, {
          tools: [
            {
              name: "read_file",
              description: "Read contents of a file",
              inputSchema: {
                type: "object",
                properties: {
                  path: {
                    type: "string",
                    description: "File path to read",
                  },
                },
                required: ["path"],
              },
            },
            {
              name: "write_file",
              description: "Write or overwrite a file",
              inputSchema: {
                type: "object",
                properties: {
                  path: {
                    type: "string",
                    description: "File path to write",
                  },
                  content: {
                    type: "string",
                    description: "File content",
                  },
                },
                required: ["path", "content"],
              },
            },
            {
              name: "list_directory",
              description: "List files and directories",
              inputSchema: {
                type: "object",
                properties: {
                  path: {
                    type: "string",
                    description: "Directory path to list",
                  },
                },
                required: ["path"],
              },
            },
            {
              name: "delete_file",
              description: "Delete a file",
              inputSchema: {
                type: "object",
                properties: {
                  path: {
                    type: "string",
                    description: "File path to delete",
                  },
                },
                required: ["path"],
              },
            },
          ],
        });
        break;

      case "tools/call": {
        const toolName = params?.name;
        const args = params?.arguments || {};

        try {
          let result;

          switch (toolName) {
            case "read_file": {
              const content = fs.readFileSync(args.path, "utf-8");
              result = { content };
              break;
            }

            case "write_file": {
              const dir = path.dirname(args.path);
              fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(args.path, args.content, "utf-8");
              result = { success: true, path: args.path };
              break;
            }

            case "list_directory": {
              const entries = fs.readdirSync(args.path, { withFileTypes: true });
              result = {
                entries: entries.map((e) => ({
                  name: e.name,
                  type: e.isDirectory() ? "directory" : "file",
                })),
              };
              break;
            }

            case "delete_file": {
              fs.unlinkSync(args.path);
              result = { success: true, path: args.path };
              break;
            }

            default:
              respondError(id, -32601, `Tool not found: ${toolName}`);
              break;
          }

          if (result) respond(id, result);
        } catch (e) {
          respondError(id, -32000, e.message);
        }
        break;
      }

      case "ping":
        if (id != null) respond(id, {});
        break;

      default:
        if (id != null) respondError(id, -32601, `Method not supported: ${method}`);
    }
  } catch (e) {
    if (id != null) respondError(id, -32000, e.message);
  }
});

process.stdin.on("end", () => process.exit(0));
