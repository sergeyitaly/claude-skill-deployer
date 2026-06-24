---
name: "mcp-server-creation"
description: "Build, wire, and debug a stdio MCP server bundled inside a VS Code extension (claude-skills-deployer pattern). Covers server code, allow-list security, MCP content-response format, premature-exit fix, deployment to ~/.claude/mcp-servers/, registration in ~/.claude.json for Claude/Cursor/Kiro, auto-start on activation, and health dialog integration. Use when adding a new MCP server or debugging \"no output\" / early-exit failures."
applyTo:
  - **/mcp-servers/**/*.js
  - **/mcpCli.ts
  - **/mcpOfficial.ts
  - **/resources/mcp-servers/**
---

# mcp-server-creation

# MCP Server Creation — claude-skills-deployer pattern

This skill captures the end-to-end pattern for a **stdio MCP server bundled inside
a VS Code extension**, as implemented in `extension/resources/mcp-servers/cli/index.js`
and wired by `extension/src/mcpCli.ts` + `extension/src/extension.ts`.

---

## 1. File layout

```
extension/
  resources/
    mcp-servers/
      <server-name>/
        index.js          # bundled server — source of truth
  src/
    mcp<Name>.ts          # deploy + register helpers (TypeScript)
    extension.ts          # auto-start + status bar wiring

```

---

## 2. Server skeleton (Node.js stdio, no SDK dependency)

```js
#!/usr/bin/env node
"use strict";

const { spawn, execFileSync } = require("node:child_process");
const crypto  = require("node:crypto");
const fs      = require("node:fs");
const os      = require("node:os");
const path    = require("node:path");
const readline = require("node:readline");

// --- JSON-RPC helpers ---
function send(msg)              { process.stdout.write(JSON.stringify(msg) + "\n"); }
function respond(id, result)    { send({ jsonrpc: "2.0", id, result }); }
function respondError(id, c, m) { send({ jsonrpc: "2.0", id, error: { code: c, message: m } }); }

// --- CRITICAL: track pending async tool calls before exiting ---
let _pendingOps = 0;
let _stdinEnded = false;
function _tryExit() {
  if (_stdinEnded && _pendingOps === 0) process.exit(0);
}

// --- Dispatch ---
async function dispatchTool(id, toolName, args) {
  try {
    let result;
    switch (toolName) {
      case "my_tool": {
        const output = await doSomethingAsync(args);
        // CRITICAL: wrap in content array — raw objects produce "no output" in Claude
        result = { content: [{ type: "text", text: output }] };
        break;
      }
      default:
        respondError(id, -32601, `Tool not found: ${toolName}`);
        return;
    }
    respond(id, result);
  } catch (e) {
    // Errors must also use content format, with isError: true
    respond(id, { content: [{ type: "text", text: e.message }], isError: true });
  }
}

// --- Readline loop ---
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (!method) return;

  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "my-server", version: "1.0" },
      });
      break;
    case "notifications/initialized": break;
    case "tools/list":
      respond(id, { tools: [{ name: "my_tool", description: "...", inputSchema: { type: "object", properties: {}, required: [] } }] });
      break;
    case "tools/call":
      // CRITICAL: increment before await, decrement in finally
      _pendingOps++;
      try { await dispatchTool(id, params?.name, params?.arguments || {}); }
      finally { _pendingOps--; _tryExit(); }
      break;
    case "ping":
      if (id != null) respond(id, {});
      break;
    default:
      if (id != null) respondError(id, -32601, `Method not supported: ${method}`);
  }
});

// CRITICAL: don't call process.exit(0) directly here — check pending ops first
process.stdin.on("end", () => { _stdinEnded = true; _tryExit(); });
```

---

## 3. Two bugs that always appear — fix them first

### Bug 1 — Premature exit kills async tool calls

**Symptom:** Only synchronous tools (`list_available_clis` uses `execFileSync`) respond.
Async tools (`run_command` uses `spawn`) return nothing because `process.exit(0)` fires
the moment stdin closes (e.g. file-based test input), before child processes finish.

**Wrong:**
```js
process.stdin.on("end", () => process.exit(0));
```

**Correct (pending-ops gate):**
```js
let _pendingOps = 0;
let _stdinEnded = false;
function _tryExit() {
  if (_stdinEnded && _pendingOps === 0) process.exit(0);
}

// In tools/call handler:
_pendingOps++;
try { await dispatchTool(id, params?.name, params?.arguments || {}); }
finally { _pendingOps--; _tryExit(); }

// At end of file:
process.stdin.on("end", () => { _stdinEnded = true; _tryExit(); });
```

> Note: this bug does NOT manifest when the server runs as a real MCP server (Claude
> Code keeps stdin open). It only surfaces in file-based test scripts.

---

### Bug 2 — Raw result objects produce "no output" in Claude

**Symptom:** Tool calls complete with `(mcp__<server>__<tool> completed with no output)`.
The server is responding, but Claude's MCP layer discards responses that don't match
the MCP `tools/call` content format.

**Wrong:**
```js
respond(id, { stdout: "git version 2.47.0", exitCode: 0 });
respond(id, { clis: [...] });
```

**Correct:**
```js
respond(id, {
  content: [{ type: "text", text: "stdout:\ngit version 2.47.0\nexitCode: 0" }],
  isError: false,
});
// Errors:
respond(id, {
  content: [{ type: "text", text: e.message }],
  isError: true,
});
```

The `tools/call` MCP spec (2024-11-05) requires:
```json
{ "content": [{ "type": "text", "text": "..." }], "isError": false }
```

---

## 4. Allow-list security pattern (CLI server example)

```js
const DEFAULT_ALLOWED = ["az","aws","git","kubectl","helm","terraform","gcloud","docker","gh","dotnet","node","npm"];

function getAllowedClis() {
  // Optionally read from config file; normalise .cmd/.exe for Windows matching
  return DEFAULT_ALLOWED.map(c => c.toLowerCase().replace(/\.(cmd|exe)$/, ""));
}

// In run_command handler:
const cliNorm = rawCli.toLowerCase().replace(/\.(cmd|exe)$/, "");
if (!getAllowedClis().includes(cliNorm)) {
  throw new Error(`"${rawCli}" is not in the allow-list. Allowed: ${getAllowedClis().join(", ")}`);
}

// On Windows use shell:true so .cmd/.bat wrappers launch correctly
const useShell = process.platform === "win32";
const proc = spawn(cli, args, { env, cwd, shell: useShell, windowsHide: true });
```

---

## 5. Deploy helper (TypeScript — mcpCli.ts pattern)

```typescript
import * as fs   from "node:fs";
import * as os   from "node:os";
import * as path from "node:path";

const SERVER_DIR  = path.join(os.homedir(), ".claude", "mcp-servers", "my-server");
const SERVER_PATH = path.join(SERVER_DIR, "index.js");
const SERVER_KEY  = "my-server";                          // key in mcpServers JSON

const AGENT_CONFIGS: Record<string, string> = {
  claude: path.join(os.homedir(), ".claude.json"),
  cursor: path.join(os.homedir(), ".cursor", "mcp.json"),
  kiro:   path.join(os.homedir(), ".kiro", "settings", "mcp.json"),
};

export function needsSetup(): boolean {
  return !fs.existsSync(SERVER_PATH)
    || !JSON.parse(fs.readFileSync(AGENT_CONFIGS.claude, "utf-8") || "{}")
        ?.mcpServers?.[SERVER_KEY];
}

export function getServerStatus(): { enabled: boolean; activeAgents: string[] } {
  const activeAgents = Object.entries(AGENT_CONFIGS)
    .filter(([, p]) => {
      try { return Boolean(JSON.parse(fs.readFileSync(p,"utf-8"))?.mcpServers?.[SERVER_KEY]); }
      catch { return false; }
    })
    .map(([id]) => id);
  return { enabled: activeAgents.length > 0, activeAgents };
}

export async function enableServer(extensionPath: string, workspaceDirs: string[], log: (s:string)=>void): Promise<void> {
  // 1. Copy bundled server
  const src = path.join(extensionPath, "resources", "mcp-servers", "my-server", "index.js");
  fs.mkdirSync(SERVER_DIR, { recursive: true });
  fs.copyFileSync(src, SERVER_PATH);
  fs.chmodSync(SERVER_PATH, 0o755);

  // 2. Write config (allow-list, timeout, workspace log path)
  const config = { allowedClis: [...], timeout: 300000, workspaceLogPath: workspaceDirs[0] ? path.join(workspaceDirs[0], ".claude", "mcp-usage.jsonl") : undefined };
  fs.writeFileSync(path.join(SERVER_DIR, "config.json"), JSON.stringify(config, null, 2));

  // 3. Register in each agent config
  for (const [agentId, configPath] of Object.entries(AGENT_CONFIGS)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8") || "{}");
      cfg.mcpServers = cfg.mcpServers ?? {};
      cfg.mcpServers[SERVER_KEY] = { command: "node", args: [SERVER_PATH, "--config", path.join(SERVER_DIR, "config.json")] };
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
      log(`Registered ${SERVER_KEY} for ${agentId}.`);
    } catch (err) {
      log(`Could not configure ${agentId}: ${(err as Error).message}`);
    }
  }
}
```

---

## 6. Extension auto-start on activation (extension.ts pattern)

Wire inside the existing 5 s `setTimeout` block that also handles the filesystem server:

```typescript
// extension.ts — inside the setTimeout(() => { ... }, 5000) block
if (needsCliMcpSetup()) {
  void enableOfficialCliServer(context.extensionPath, workspaceDirs, log).then(() => {
    log("CLI MCP server: auto-started.");
    refreshCliMcpStatusBar();
  });
} else {
  log("CLI MCP server: already configured.");
  refreshCliMcpStatusBar();
}
```

---

## 7. Status bar item

```typescript
// Module-level variable
let mcpCliStatusBarItem: vscode.StatusBarItem;

// In activate():
mcpCliStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 91.5);
context.subscriptions.push(mcpCliStatusBarItem);

// Refresh function (module-level so it can be called from multiple places):
function refreshCliMcpStatusBar() {
  const status = getCliMcpServerStatus();
  if (status.enabled) {
    const agents = status.activeAgents.join(", ");
    mcpCliStatusBarItem.text = `$(terminal-cmd) CLI MCP · ${agents}`;
    mcpCliStatusBarItem.tooltip = `CLI MCP server active for: ${agents}.\nClick to disable.`;
    mcpCliStatusBarItem.command = "claudeSkills.disableCliMcpServer";
    mcpCliStatusBarItem.backgroundColor = undefined;
  } else {
    mcpCliStatusBarItem.text = `$(warning) CLI MCP: setup needed`;
    mcpCliStatusBarItem.tooltip = `CLI MCP server not configured. Click to enable.`;
    mcpCliStatusBarItem.command = "claudeSkills.enableCliMcpServer";
    mcpCliStatusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  }
  mcpCliStatusBarItem.show();
}
// Call after: enable command, disable command, auto-start, and in refreshAllImpl
```
---
## 8. Health dialog integration

In `claudeSkills.showMcpHealth` command handler, add a section after the filesystem block:

```typescript
const cliStatus = getCliMcpServerStatus();
lines.push(``, `── CLI MCP Server ──`);
if (cliStatus.enabled) {
  lines.push(
    `Status:  Connected  ✓`,
    `Agents:  ${cliStatus.activeAgents.join(", ")}`,
    `CLIs:    az, aws, git, kubectl, helm, terraform, gcloud, docker, gh, dotnet, node, npm`,
  );
} else {
  lines.push(
    `Status:  Setup needed  ✗`,
    `Action:  Run "Enable CLI MCP Server" from the command palette`,
  );
}
```

---

## 9. Testing without a running session (PowerShell)

The MCP server speaks JSON-RPC over stdio. Test it directly without Claude:

```powershell
$serverPath = "C:\Users\...\extension\resources\mcp-servers\cli\index.js"

$messages = @(
  '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}',
  '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}',
  '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_available_clis","arguments":{}}}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"run_command","arguments":{"cli":"git","args":["--version"]}}}'
) -join "`n"

$tmpIn  = [System.IO.Path]::GetTempFileName()
$tmpOut = [System.IO.Path]::GetTempFileName()
$tmpErr = [System.IO.Path]::GetTempFileName()
[System.IO.File]::WriteAllText($tmpIn, $messages + "`n", [System.Text.Encoding]::UTF8)

Start-Process "node" "`"$serverPath`"" `
  -RedirectStandardInput $tmpIn -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr `
  -NoNewWindow -PassThru -Wait | Out-Null

Get-Content $tmpOut -Raw
Remove-Item $tmpIn,$tmpOut,$tmpErr -ErrorAction SilentlyContinue
```

**Why temp files instead of pipe + ReadToEnd():** Redirecting stdout AND stderr
simultaneously with `ReadToEnd()` deadlocks on Windows when the server spawns child
processes (stdout buffer fills while you're blocked on stderr). Always use separate
temp files.

**Required message order:** `initialize` → `notifications/initialized` → tool calls.
The server ignores messages before `initialize` and errors on unknown methods.

---
