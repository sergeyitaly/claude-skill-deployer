# Hook System & MCP Architecture

## 1. Overview — how hooks and MCP servers fit together

```mermaid
flowchart TB
  subgraph Agents["AI Agents"]
    Claude["Claude Code"]
    Cursor["Cursor"]
    Kiro["Kiro"]
    Copilot["GitHub Copilot"]
  end

  subgraph HookLayer["Hook layer (per-prompt / per-tool events)"]
    direction LR
    UPS["UserPromptSubmit\n(every prompt)"]
    PTU["PostToolUse\n(after each tool call)"]
    PRE["PreToolUse\n(before each tool call)"]
    SST["SessionStart\n(session open)"]
  end

  subgraph HookServer["Extension HTTP hook server\n(127.0.0.1:4895)"]
    HS["hookServer.ts\nhttp.createServer"]
    HH["hookHandlers.ts\nswitch(hookName)"]
    HS --> HH
  end

  subgraph MCPLayer["MCP servers (stdio JSON-RPC 2.0)"]
    FS["Filesystem MCP server\nresources/mcp-servers/filesystem/index.js\nread_file · write_file · edit_file\nlist_directory · search_files · delete_file"]
    CLI["CLI MCP server\nresources/mcp-servers/cli/index.js\nrun_command · list_available_clis"]
    Proxy["mcp-lazy-proxy.js\naggregates upstream servers\ncompresses tool schemas"]
  end

  subgraph Telemetry["Telemetry & learning"]
    MUL["mcp-usage.jsonl\n~/.claude/learning/"]
    RJL["runs.jsonl\n<workspace>/.claude/learning/"]
    Hints["mcp-agent-hints.md\n(auto-generated)"]
    SessionIdx["mcp-session-index.json\n(incremental cross-session cache)"]
  end

  subgraph ExtCore["Extension core"]
    MCPUsageLog["mcpUsageLog.ts\nparse · detect waste · score"]
    EffMetrics["efficiencyMetrics.ts\ncomputeEfficiencyMetrics"]
    Dashboard["costDashboard.ts\nWebView panel"]
    McpForce["mcpForce.ts\npermissions.deny + CLAUDE.md"]
    McpHealth["mcpHealth.ts\nconfigValid · hasActivity"]
  end

  Agents -->|"registered hooks fire on events"| HookLayer
  HookLayer -->|"node .../hook/<name>.js\nor\nPOST /hook/<name>"| HookServer
  Agents -->|"tool calls over stdio"| MCPLayer
  MCPLayer --> MUL
  HookServer --> RJL
  MUL --> MCPUsageLog
  MCPUsageLog --> Hints & SessionIdx
  MCPUsageLog --> EffMetrics
  EffMetrics --> Dashboard
  McpForce -.->|"blocks native tools"| Agents
  McpHealth -.->|"gates force-mode enable"| McpForce
```

---

## 2. MCP server deployment & registration per agent

```mermaid
flowchart LR
  subgraph Ext["Extension bundle\n(extensionPath)"]
    BundledFS["resources/mcp-servers/filesystem/index.js"]
    BundledCLI["resources/mcp-servers/cli/index.js"]
    Proxy["resources/mcp-lazy-proxy.js"]
  end

  subgraph Deployed["Deployed copies (~/.claude/mcp-servers/)"]
    DeployFS["filesystem/index.js\n(syncFilesystemServerBinary)"]
    DeployCLI["cli/index.js\n(syncCliServerBinary)"]
  end

  subgraph Configs["Config files (created at activation)"]
    AllowedDirs["filesystem/allowed-dirs.json\n{ allowedDirs, workspaceLogPath }"]
    CliConfig["cli/cli-config.json\n{ allowedClis, timeout, workspaceLogPath }"]
  end

  subgraph Registration["Agent registration"]
    ClaudeJSON["~/.claude.json\nmcpServers.filesystem\nmcpServers.claude-skills-cli"]
    CursorJSON["~/.cursor/mcp.json\nmcpServers.filesystem\nmcpServers.claude-skills-cli"]
    KiroJSON["~/.kiro/settings/mcp.json\nmcpServers.filesystem\nmcpServers.claude-skills-cli"]
    PkgJSON["package.json\ncontributes.mcpServers\n(claude-skills-filesystem + claude-skills-cli)"]
  end

  BundledFS -->|"copy on version change"| DeployFS
  BundledCLI -->|"copy on version change"| DeployCLI

  DeployFS -->|"args: --config"| AllowedDirs
  DeployCLI -->|"args: --config"| CliConfig

  DeployFS -->|"node path"| ClaudeJSON & CursorJSON & KiroJSON
  DeployCLI -->|"node path"| ClaudeJSON & CursorJSON & KiroJSON

  BundledFS -->|"${extensionPath} path"| PkgJSON
  BundledCLI -->|"${extensionPath} path"| PkgJSON

  PkgJSON -->|"always active"| Copilot["GitHub Copilot\n(contributes.mcpServers)"]
  ClaudeJSON --> ClaudeCode["Claude Code"]
  CursorJSON --> CursorAgent["Cursor"]
  KiroJSON --> KiroAgent["Kiro"]

  AllowedDirs -.->|"read by both server paths"| DeployFS & BundledFS
  CliConfig -.->|"read by both server paths"| DeployCLI & BundledCLI
```

---

## 3. MCP data flow: tool call → telemetry → dashboard

```mermaid
sequenceDiagram
  participant A as AI Agent
  participant S as MCP Server\n(filesystem / CLI)
  participant Log as mcp-usage.jsonl\n(global + workspace)
  participant Ext as Extension Process
  participant Idx as mcp-session-index.json
  participant Hints as mcp-agent-hints.md
  participant Dash as Cost Dashboard WebView

  A->>S: tools/call { name, arguments }
  Note over S: validates path vs allowed-dirs\nsession read/dir cache lookup
  S-->>A: result { content }
  S->>Log: appendMcpUsageLog({ ts, tool, path,\n  durationMs, bytes, sessionId, … })

  Note over Ext: dashboard open or pipeline tick
  Ext->>Log: readMcpUsageLog() [mtime-cached]
  Ext->>Ext: summarizeMcpUsage()\n detectWaste · detectAgentLoops\n detectReadAfterWrite\n computeScore → grade A–F
  Ext->>Idx: summarizeCrossSessionPatterns()\n index completed sessions,\n process only active-session live entries
  Ext->>Hints: writeMcpHints() [throttled 30s]\n + appendCliPatternHints()
  Ext->>Dash: formatEfficiencyPanelHtml()\n score banner · token KPI · warnings\n Auto-optimized · cross-session hot files
```

---

## 4. Hook registration per agent

```mermaid
flowchart TB
  subgraph HookScripts["Hook scripts\n(resources/hooks/)"]
    direction LR
    SIW["skill-invoke-watch.js\nPostToolUse + PreToolUse(Claude VS Code)"]
    SSW["session-size-watch.js\nUserPromptSubmit"]
    BW["budget-watch.js\nUserPromptSubmit"]
    CFW["context-focus-watch.js\nUserPromptSubmit"]
    PFW["practical-focus-watch.js\nUserPromptSubmit"]
    TDW["task-drift-watch.js\nUserPromptSubmit"]
    OSW["official-skills-watch.js\nSessionStart"]
    PIW["profile-init-watch.js\nSessionStart"]
    CLG["cli-loop-guard\nPostToolUse (run_command)"]
    DCG["dir-cache-guard\nPreToolUse (list_directory)"]
    FSA["file-split-advisor\nPostToolUse (read_file)\n+ file-split-read-guard PreToolUse companion"]
    MEG["mcp-error-guard\nPostToolUse (mcp__filesystem__)"]
    MF["mcp-force\nUserPromptSubmit"]
    MG["mcp-gate\nSessionStart"]
  end

  subgraph Standalone["Standalone scripts (no settings.json registration)"]
    BS["branch-sync.js\n.git/hooks/post-checkout\napply branch profile on checkout"]
    SA["session-apply.js\nSubprocess from profile-init-watch.js\napply skill set at session start"]
    TSF["task-skill-focus.js\nSubprocess from session-apply.js\nwrite task-active-skills.json"]
  end

  subgraph Claude["Claude Code\n(<workspace>/.claude/settings.json)"]
    C_UPS["hooks.UserPromptSubmit[]\n  session-size · budget · context-focus\n  practical-focus · task-drift\n  mcp-force"]
    C_POST["hooks.PostToolUse[]\nmatcher: Bash|Read|Edit|…\n  skill-invoke\nmatcher: run_command\n  cli-loop-guard\nmatcher: mcp__filesystem__read_file\n  file-split-advisor\nmatcher: mcp__filesystem__\n  mcp-error-guard"]
    C_PRE["hooks.PreToolUse[]\nmatcher: mcp__filesystem__list_directory\n  dir-cache-guard\nmatcher: mcp__filesystem__read_file\n  file-split-read-guard\nmatcher: Bash|Read|Edit|…\n  skill-invoke (VS Code workaround)"]
    C_SS["hooks.SessionStart[]\n  official-skills · profile-init\n  mcp-gate"]
  end

  subgraph Cursor["Cursor\n(<workspace>/.cursor/rules/)"]
    CU_UPS["*.mdc rule files\n  session-size · budget · context-focus\n  practical-focus · task-drift · skill-invoke"]
  end

  subgraph Kiro["Kiro\n(<workspace>/.kiro/)"]
    K_UPS[".kiro.hook (promptSubmit)\n  session-size · budget · context-focus\n  practical-focus · task-drift · skill-invoke"]
    K_SS[".kiro.hook (sessionStart)\n  official-skills · profile-init"]
  end

  subgraph Copilot["GitHub Copilot\n(<workspace>/.github/hooks/)"]
    CO_UPS[".json hooks (UserPromptSubmit)\n  session-size · budget · context-focus\n  practical-focus · task-drift · skill-invoke"]
  end

  HookScripts -.->|"Claude: node …/hook/<name>"| Claude
  HookScripts -.->|"Cursor: additional_context"| Cursor
  HookScripts -.->|"Kiro: USER_PROMPT env"| Kiro
  HookScripts -.->|"Copilot: hookSpecificOutput"| Copilot
  PIW -->|"spawns"| SA
  SA -->|"spawns"| TSF
```

---

## 5. Hook dispatch flow (HTTP server path)

```mermaid
sequenceDiagram
  participant A as Agent\n(Claude / Cursor / Kiro / Copilot)
  participant HK as Hook script\n(node …/hook/<name>.js)
  participant HS as hookServer.ts\nHTTP 127.0.0.1:4895
  participant HH as hookHandlers.ts\nswitch(hookName)
  participant HP as hookPlatform.js\n(shared stdin helpers)

  Note over A: Event fires (UserPromptSubmit / PostToolUse / PreToolUse / SessionStart)
  A->>HK: spawn process, pipe JSON payload via stdin\n(or USER_PROMPT env for Kiro)
  HK->>HP: readStdin() · parsePlatform() · resolveCwd() · resolveSessionId()
  HK->>HS: POST /hook/<name>?agent=<id>&cwd=<encoded>\n  body: normalized JSON payload
  HS->>HH: handleHookRequest({ hookName, agent, cwd, body })

  alt hookName = "skill-invoke"
    HH->>HH: extract skill from toolName / file path
    HH-->>HS: { run record }
    HS-->>HK: 200 { … }
    HK->>HK: append to runs.jsonl\nwrite skill-invoke-state.json (dedup)
  else hookName = "session-size" / "budget"
    HH->>HH: read runs.jsonl, compute spend
    HH-->>HS: { systemMessage / additionalContext }
    HS-->>HK: 200 { message }
    HK->>A: emit output (systemMessage / hookSpecificOutput)
  else hookName = "dir-cache-guard" (PreToolUse)
    HH->>HH: check session dir cache hit
    HH-->>HS: 200 { decision: "block" } when cached
    HS-->>HK: block response
    HK->>A: prevent redundant list_directory
  else hookName = "profile-init" / "official-skills" (SessionStart)
    HH->>HH: check learning/profile-init-request.json\n  or fetch official skills manifest
    HH-->>HS: { systemMessage with context }
    HS-->>HK: 200
    HK->>A: inject context into session start
  else hookName = "mcp-force" (UserPromptSubmit)
    HH->>HH: detect if agent used native tool (Bash/Read/Edit)\n  instead of MCP filesystem tool
    HH-->>HS: { systemMessage: "Use MCP tools instead" }
    HS-->>HK: 200
    HK->>A: inject corrective message
  else hookName = "mcp-gate" (SessionStart)
    HH->>HH: checkMcpHealth() — verify server is live\n  and inject mcp-agent-hints.md into context
    HH-->>HS: { systemMessage with MCP context }
    HS-->>HK: 200
    HK->>A: session opens with MCP health context
  else hookName = "mcp-error-guard" (PostToolUse, mcp__filesystem__)
    HH->>HH: detect MCP tool error, load learned patterns\n  from cliGuardLearner
    HH-->>HS: { systemMessage with corrective hint }
    HS-->>HK: 200
    HK->>A: inject fix hint after failed MCP call
  else hookName = "branch-sync" (HTTP path)
    HH->>HH: read branch-profiles.json\n  apply skill set for current branch
    HH-->>HS: 200 {}
  end

  Note over A,TSF: Standalone (no HTTP server)
  participant TSF as session-apply.js\n+ task-skill-focus.js
  A->>+PIW: SessionStart fires profile-init-watch.js
  PIW->>TSF: spawn session-apply.js <cwd>
  TSF->>TSF: read session-skill-apply-request.json\n  copy missing skills\n  clear skillOverrides "off"\n  spawn task-skill-focus.js
```

---

## 6. MCP Force enforcement

```mermaid
flowchart LR
  subgraph Check["Health gate\n(mcpHealth.ts)"]
    HC{"status\n= ready?"}
  end

  subgraph Enable["enableMcpForcePermissions()"]
    PD["Write permissions.deny\nto .claude/settings.json\n\nBlocked tools:\nRead · Write · Edit · Glob · Grep · Bash\nmcp__claude-skills-cli__run_command\nmcp__claude-skills-cli__list_available_clis"]
  end

  subgraph Inject["injectMcpForceClaude()"]
    CM["Prepend CLAUDE.md block\n(atomic temp+rename + lock file)\n\n## MCP REQUIRED\nUse ONLY mcp__filesystem__* tools\nDo NOT use Read / Write / Edit …"]
  end

  subgraph Revert["revert / remove"]
    RP["revertMcpForcePermissions()\nfilter deny list"]
    RC["removeMcpForceClaudeBlock()\nstrip <!-- claude-skills-mcp-force --> block"]
  end

  User["User enables\nMCP Force"] --> HC
  HC -->|"config-issue\nor no-activity"| Err["Abort — agent would deadlock\n(MCP not verified working)"]
  HC -->|"ready"| Enable & Inject
  Enable -.->|"agent reads permissions.deny\nbefore each tool call"| Agent["Claude Code\nagent process"]
  Inject -.->|"read at session start\ninstructs to use MCP only"| Agent
  User -->|"disable"| Revert
```

---

## 7. Hook × agent capability matrix

| Hook | Event | Matcher | Claude Code | Cursor | Kiro | Copilot |
|---|---|---|---|---|---|---|
| `skill-invoke` | PostToolUse | `Bash\|Read\|Edit\|…` | `settings.json` | `.mdc` rule | `.kiro.hook` promptSubmit | `.github/hooks/` |
| `skill-invoke` | PreToolUse *(VS Code workaround)* | `Bash\|Read\|Edit\|…` | `settings.json` | — | — | — |
| `session-size` | UserPromptSubmit | — | `settings.json` | `.mdc` rule | `.kiro.hook` | `.github/hooks/` |
| `budget` | UserPromptSubmit | — | `settings.json` | `.mdc` rule | `.kiro.hook` | `.github/hooks/` |
| `context-focus` | UserPromptSubmit | — | `settings.json` | `.mdc` rule | `.kiro.hook` | `.github/hooks/` |
| `practical-focus` | UserPromptSubmit | — | `settings.json` | `.mdc` rule | `.kiro.hook` | `.github/hooks/` |
| `task-drift` | UserPromptSubmit | — | `settings.json` | `.mdc` rule | `.kiro.hook` | `.github/hooks/` |
| `mcp-force` | UserPromptSubmit | — | `settings.json` | — | — | — |
| `official-skills` | SessionStart | — | `settings.json` | — | `.kiro.hook` sessionStart | — |
| `profile-init` | SessionStart | — | `settings.json` | — | `.kiro.hook` sessionStart | — |
| `mcp-gate` | SessionStart | — | `settings.json` | — | — | — |
| `cli-loop-guard` | PostToolUse | `mcp__claude-skills-cli__run_command` | `settings.json` | — | — | — |
| `mcp-error-guard` | PostToolUse | `mcp__filesystem__` | `settings.json` | — | — | — |
| `file-split-advisor` | PostToolUse | `mcp__filesystem__read_file` | `settings.json` | — | — | — |
| `file-split-read-guard` | PreToolUse | `mcp__filesystem__read_file` | `settings.json` *(paired with advisor)* | — | — | — |
| `dir-cache-guard` | PreToolUse | `mcp__filesystem__list_directory` | `settings.json` | — | — | — |
| `branch-sync` | git `post-checkout` / HTTP | — | `.git/hooks/post-checkout` + HTTP | — | — | — |
| `session-apply` | Subprocess *(from profile-init-watch)* | — | headless only | — | — | — |
| `task-skill-focus` | Subprocess *(from session-apply)* | — | headless only | — | — | — |

---

## Key file locations

| Artifact | Path |
|---|---|
| MCP filesystem server (bundled) | `${extensionPath}/resources/mcp-servers/filesystem/index.js` |
| MCP CLI server (bundled) | `${extensionPath}/resources/mcp-servers/cli/index.js` |
| MCP lazy proxy | `${extensionPath}/resources/mcp-lazy-proxy.js` |
| MCP filesystem server (deployed) | `~/.claude/mcp-servers/filesystem/index.js` |
| MCP CLI server (deployed) | `~/.claude/mcp-servers/cli/index.js` |
| Filesystem allowed dirs config | `~/.claude/mcp-servers/filesystem/allowed-dirs.json` |
| CLI allowed CLIs config | `~/.claude/mcp-servers/cli/cli-config.json` |
| Global MCP usage telemetry | `~/.claude/learning/mcp-usage.jsonl` |
| Workspace MCP telemetry | `<workspace>/.claude/mcp-usage.jsonl` |
| Session index (incremental cross-session) | `~/.claude/learning/mcp-session-index.json` |
| Auto-generated agent hints | `~/.claude/learning/mcp-agent-hints.md` |
| Hook scripts (HTTP-dispatched) | `${extensionPath}/resources/hooks/*.js` |
| Standalone hook scripts | `${extensionPath}/resources/hooks/branch-sync.js`, `session-apply.js`, `task-skill-focus.js` |
| Claude hook registration | `<workspace>/.claude/settings.json` |
| Cursor hook registration | `<workspace>/.cursor/rules/*.mdc` |
| Kiro hook registration | `<workspace>/.kiro/*.kiro.hook` |
| Copilot hook registration | `<workspace>/.github/hooks/*.json` |
| Skill attribution log | `<workspace>/.claude/learning/runs.jsonl` |
| MCP Force permissions | `<workspace>/.claude/settings.json` → `permissions.deny` |

← [IDE & agent skill profiles](06-ide-agent-skill-profiles.md) · [Diagram index](README.md)
