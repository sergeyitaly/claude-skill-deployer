# claude-skills-deployer

Personal tool to detect which AI agent skills are relevant to a project
(based on which files are present) and install matching instructions from a
shared library — starting with [Claude Code](https://docs.claude.com/claude-code)
and extending to **Cursor**, **Kiro**, and **GitHub Copilot**.

Skills live in `skills_library/` (source of truth). Deploy globally to your
machine, per workspace, per git branch, and across multiple AI agents from
one manifest.

## How it works

The extension detects your project context, lets an AI agent choose the best
development skills, synchronizes them across tools like Cursor and Copilot,
tracks how those skills are actually used, calculates cost and value, and
continuously optimizes your setup based on real usage.

## Do you need Claude Code?

**No.** The VS Code extension works in **VS Code or Cursor** without the [Claude Code](https://docs.claude.com/claude-code) app or CLI installed.

Paths like `.claude/skills/` and `.claude/learning/` are a **shared layout convention** — the extension **creates them** on install. They are not proof that Claude Code is on your machine. With `multiAgent` on (default), skills deploy to all enabled agent paths (`.cursor/skills/`, `.kiro/skills/`, `.github/instructions/`). On **solo-dev** tier (`multiAgent` off), skills mirror only to the **running IDE** (Cursor, Kiro, or Copilot).

| You primarily use… | Works without Claude Code? | What you get |
|---|---|---|
| **Cursor** | Yes | Skill tree, detection, branch profiles, `.cursor/skills/` sync, Cursor attribution hooks, Cursor transcript cost estimates |
| **GitHub Copilot / Kiro** | Yes | Per-skill instruction files; attribution hooks when enabled |
| **Claude Code** | Full set | Everything above plus Claude session transcripts, budget/session/focus hooks, SessionStart profile-init |

**Needs Claude Code specifically** (otherwise skipped or empty — no crash):

- **Cost control hooks** (budget, session size, context/practical focus) — installed into `.claude/settings.json` for Claude Code to run
- **Claude transcript spend** in the status bar and usage report — shows *“No recorded Claude Code token usage”* when `~/.claude/projects/` is absent
- **SessionStart hooks** for profile-init and official Anthropic skill checks — Claude Code uses `.claude/settings.json`; Cursor/Kiro/Copilot use their agent hook formats (see [Profile init](#profile-init-role--branch-agent-driven))

**Cursor-only tip:** set `claudeSkills.agents.enabled` to `["cursor"]` (Settings) if you do not want global/workspace installs under Claude paths. Workspace skills still use `.claude/skills/` as the git-tracked source of truth; the extension mirrors from there to your enabled agents.

See [`extension/README.md`](extension/README.md) for the full extension guide.

## Install — pick your editor’s registry

Same extension, two galleries. Each link goes to the **extension listing** (install page):

| Editor | Primary listing | Also on |
|--------|-----------------|---------|
| **VS Code** | [**Claude Skills Manager** — Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=SerhiiVoinolovych.claude-skill-deployer&ssr=false#version-history) | [Open VSX ↗](https://open-vsx.org/extension/serhiivoinolovych/claude-skill-deployer) |
| **Cursor** | [**Claude Skills Manager** — Open VSX](https://open-vsx.org/extension/serhiivoinolovych/claude-skill-deployer) | [VS Marketplace ↗](https://marketplace.visualstudio.com/items?itemName=SerhiiVoinolovych.claude-skill-deployer&ssr=false#version-history) |
| **Kiro IDE** | [**Claude Skills Manager** — Open VSX](https://open-vsx.org/extension/serhiivoinolovych/claude-skill-deployer) | [VS Marketplace ↗](https://marketplace.visualstudio.com/items?itemName=SerhiiVoinolovych.claude-skill-deployer&ssr=false#version-history) ([Kiro uses Open VSX by default](https://kiro.dev/docs/editor/extension-registry/)) |

Distribution diagram: [diagram/00-extension-registries.md](diagram/00-extension-registries.md) · Publishing: [extension/PUBLISHING.md](extension/PUBLISHING.md)

## Two ways to use this

| Surface | Best for |
|---|---|
| **CLI** (`generate_skills.py`) | Scripts, CI, **Claude CLI**, headless apply/sync — no VS Code |
| **VS Code extension** ([`extension/`](extension/)) | Activity-bar UI, budget controls, cost intelligence, branch profiles, multi-agent sync |

## Quick start (extension)

1. Install **Claude Skills Manager** from the [install table above](#install--pick-your-editors-registry) (or a `.vsix` from `extension/`).
2. Open a workspace folder.
3. **Claude Skills** activity bar → **Install Skill Library to ~/.claude/skills** (one-time).
   With `multiAgent` on (default), this also seeds `~/.cursor/skills/`, `~/.kiro/skills/`, and Copilot global instructions when those agents are enabled.
4. **Install Relevant Skills for Workspace** (or **Preview** first).
   By default, detected skills are copied to **all enabled agent paths** in the workspace (`.claude/skills/`, `.cursor/skills/`, `.kiro/skills/`, `.github/instructions/`).
5. Optional: **Enable Cost Control Hooks**, open **Cost Intelligence Dashboard**, configure **Budget** and **Feature Toggles**.

### MCP Servers

The extension bundles two MCP (Model Context Protocol) servers, both auto-started on activation — no manual setup for a fresh install.

#### Filesystem MCP server

Gives AI agents structured read/write/edit access to `~/.claude/` and open workspace folders; records every operation as telemetry for KPI scoring.

- **Auto-started on activation** — deployed and registered for Claude/Cursor/Kiro automatically. The server binary is auto-synced on every activation so extension updates propagate without a manual "Enable" step.
- **`edit_file` tool (v1.2)** — targeted string-replace edits. `old_string` must match exactly once; errors on ambiguous or missing matches. Prefer over `write_file` for surgical changes.
- **Session read/dir cache** — `read_file` skips re-reads of unchanged files (mtime guard); `list_directory` returns cached listings within the same session. Both caches invalidate on writes, edits, and deletes. A **60-minute TTL** evicts stale entries so long-running sessions never serve outdated dir listings.
- **Binary file guard** — `read_file` rejects files larger than 50 MB or detected as binary (PNG, JPEG, PDF, ZIP, ELF, PE/EXE) with a clear error message. Use `search_in_file` to locate specific content in large or binary files instead.
- **MCP Health** status bar (`$(plug) MCP Connected` / `$(plug) MCP · N agents` / `$(warning) MCP: setup needed`) — click for the combined health report (filesystem + CLI sections).
- **Agent KPI** status bar (`$(pulse) KPI: A · 42 calls`) — live efficiency grade from the last 24 h of file-access telemetry.
- **MCP Force Mode** — blocks Claude's native `Read`/`Write`/`Edit`/`Glob`/`Grep`/`Bash` **and** the CLI MCP tools (`run_command`, `list_available_clis`), routing all file I/O through the filesystem MCP server. Enable at startup via `claudeSkills.mcpForce.enableOnStartup`. Revert with **Disable MCP Force Mode**.
- **Apply auto-fixes to hints** — button in the Efficiency panel (and Command Palette → **Claude Skills: Apply MCP Auto-Fixes**) that converts detected hot files, excessive scans, and large-file patterns into permanent cache rules in `mcp-agent-hints.md`. Rules survive session-hint refreshes.
- **Clear MCP Logs** — Command Palette → **Claude Skills: Clear MCP Server Logs**.
- **Dir Cache Guard** — PreToolUse hook that blocks redundant `list_directory` calls within a session using an in-memory cache. Auto-installed with the server.
- **Log auto-pruning** — `mcp-usage.jsonl` is trimmed automatically when it exceeds 2 MB (keeps the last 30 days), using an atomic temp-file rename to avoid interrupting concurrent appends.
- Security: `allowed-dirs.json` restricts access to `~/.claude/` and open workspace folders only.

#### CLI MCP server

Lets agents run allow-listed infrastructure CLIs (`az`, `aws`, `git`, `kubectl`, `helm`, `terraform`, `gcloud`, `docker`, `gh`, `dotnet`, `node`, `npm`) directly — no shell scripting needed in the conversation.

- **Auto-started on activation** — deployed to `~/.claude/mcp-servers/cli/index.js` and registered in `~/.claude.json`, `~/.cursor/mcp.json`, and `~/.kiro/settings/mcp.json` automatically.
- **CLI MCP** status bar (`$(terminal-cmd) CLI MCP · claude, cursor, kiro` / `$(warning) CLI MCP: setup needed`) — click to enable or disable.
- **MCP Health dialog** — clicking any MCP status bar item shows a combined modal with both servers: filesystem status + KPI, and a `── CLI MCP Server ──` block with agent list and supported CLIs.
- Security: only CLIs on the configurable allow-list can be invoked; Windows `.cmd`/`.exe` wrappers handled transparently.
- **CLI Loop Guard** — PostToolUse hook that injects corrective hints on CLI failures (ed25519 key rejection, missing init, auth errors, timeouts). Auto-installed with the server.
- Commands: **Enable CLI MCP Server** / **Disable CLI MCP Server** (Command Palette).

See [MCP Servers — Scenarios & Benefits](#mcp-servers--scenarios--benefits) for the full data-flow and KPI guide.

### Adaptive agent hooks

Three hooks close the agent feedback loop so errors self-correct and tokens aren't wasted on re-scanning work already in context. All three auto-install when the relevant MCP server activates; each has an enable/disable command in the Command Palette.

#### CLI Loop Guard (`PostToolUse`)

Fires after every `mcp__claude-skills-cli__run_command` call that exits non-zero. Injects a corrective `systemMessage` on the agent's next turn — before the agent decides whether to retry — so the root cause is addressed rather than blindly repeated.

| Pattern | Corrective hint |
|---|---|
| `terraform` exitCode=1 + ed25519 stderr | Azure only accepts RSA keys — regenerate with `ssh-keygen -t rsa -b 4096` |
| `terraform` exitCode=255 | State dir not initialized — run `terraform init` first |
| Any CLI + `AuthorizationFailed`/403 | Routes to `azure-rbac-diagnostics` skill |
| `kubectl`/`helm` + connection refused | Check kubeconfig / cluster reachability |
| `git` + CONFLICT/index.lock | Conflict or stale lock file — resolve before retrying |
| `gh` + not logged in | `gh auth login` required |
| Any CLI + timed out | Increase `timeout` parameter (max 30 min) |

Commands: **Enable CLI Loop Guard** / **Disable CLI Loop Guard**

#### Dir Cache Guard (`PreToolUse`)

Maintains an in-memory session cache (`Map<sessionId, Set<path>>`, 4-hour TTL). Before each `mcp__filesystem__list_directory` call:
- **Cache miss** — allow the call, record the path.
- **Cache hit** — return `{ decision: "block" }` with a `CACHE HIT` reason. The scan **never executes** — zero tokens spent.

Works alongside the `mcp-agent-hints.md` section that lists directories scanned 3+ times (written automatically by the efficiency scoring pipeline).

Commands: **Enable Dir Cache Guard** / **Disable Dir Cache Guard**

#### Session context injection (`SessionStart`)

At the start of every session, the `profile-init` and `mcp-gate` hooks inject a `## Last session` block (if the last MCP session was within 24 hours):

```
Last session: 14min ago
  Project dir: c:\Users\...\azure-extention-test\.claude\azure-nginx-demo
  Files written: main.tf, terraform.tfvars, run-log.md
  CLI calls: terraform×22, az×7
```

Agents resume with full context — no need to re-derive what was done or which project is active.

#### Skill gap detector (`SessionStart`)

At the start of every session the extension scans the workspace for technology markers and cross-references them against the skills installed in `.claude/skills/`. If required skills are missing, a concise warning is injected into the agent's context before any tool call runs:

```
[skill-gap-detector] Skills missing for this workspace:
  • azure-infra-preflight — Azure provider (azurerm) found in Terraform files
  • terraform-plan-review — Terraform (.tf) files detected in workspace
Run the skill-creator skill or: python generate_skills.py install <skill-name>
```

Detection rules:

| Stack marker | Skills flagged if absent |
|---|---|
| Any `.tf` file | `terraform-module-ops`, `terraform-plan-review` |
| `.tf` file containing `azurerm` | `azure-infra-preflight` |
| `.ps1` or `.sh` files | `cross-platform-scripting` |
| Security keywords in `CLAUDE.md` | `security-review` |

The hook outputs nothing when all relevant skills are installed — zero noise in normal sessions. It self-heals its own path on extension updates (same mechanism as `terminal-watch`).

The extension never hides skills already in `<workspace>/.claude/skills/` —
project-local skills show as *project-only* in the tree. `.claude/skills/` remains the git-tracked source of truth; other agent paths are mirrored automatically.

## MCP Servers — Scenarios & Benefits

Both MCP servers auto-start on extension activation — no manual setup required. The **filesystem server** gives agents structured, observable file I/O. The **CLI server** lets agents run infrastructure and developer CLIs directly without shell scripting.

### Filesystem MCP server tools

| Tool | What it does |
|---|---|
| `mcp__filesystem__read_file` | Read a file's full content |
| `mcp__filesystem__write_file` | Write a file (auto-skips if content is unchanged) |
| `mcp__filesystem__list_directory` | List directory entries (name + type) |
| `mcp__filesystem__search_files` | Find files by name pattern, up to depth 10 |
| `mcp__filesystem__delete_file` | Delete a file |

Every call is recorded as a JSONL line in `~/.claude/learning/mcp-usage.jsonl` (global) and `<workspace>/.claude/mcp-usage.jsonl` (workspace-scoped). The extension reads these logs to compute efficiency KPIs and optimization hints.

> **v1.0.80 — HACE score (Human-AI Collaboration Efficiency)** — New metric computed from Claude session transcripts (`~/.claude/projects/`) combined with CLI telemetry. Four components: Prompt Clarity (thinking-block rate), Task Velocity (turns/min), Accuracy Rate (correction-turn rate), CLI Efficiency (exit-code success rate). Composite weighted score 0–100 with letter grade, visible in the Efficiency Metrics dashboard panel and plain-text report. Session JSONL is parsed per-workspace; the panel is silent when no transcript data exists.

> **v1.0.79 — terminal-watch auto-install on new workspaces** — `terminal-watch` (the PostToolUse hook that writes CLI exit codes to `mcp-usage.jsonl`) was previously only installed when a user explicitly ran "Enable Cost Control Hooks". On a brand-new workspace with no prior setup, no hook fired and `mcp-usage.jsonl` was never created. Fixed by wiring `installTerminalWatchHook` into the automatic activation path alongside the skill-gap-detector, so telemetry starts on first workspace open without any manual step. A standalone `installTerminalWatchHook` export was also added so the hook can be installed independently of the full cost-control suite.

> **v1.0.78 — Skill gap detector + terminal-watch self-heal** — New `SessionStart` hook (`skill-gap-detector.js`) scans the workspace at startup, detects missing skills for the active tech stack (Terraform, Azure, shell scripts, security), and injects a plain-text warning into the agent session before any tool call. Zero output when all skills are present. Additionally, `terminal-watch` now self-heals its extension path on version upgrades — previously the hook silently broke whenever the extension updated because the versioned path in `settings.json` was not updated automatically.

> **v1.0.73 — Native tool operations now logged** — PostToolUse hooks now capture all IDE tool invocations, including native tools like `run_task` and `run_in_terminal`. These appear in `mcp-usage.jsonl` with the `tool` field prefixed as `native:<toolName>` to distinguish them from MCP server operations. This provides complete observability across all agent tooling, filling a previous gap where native tools were untracked.

> **v1.0.70 fix — all tools now return MCP-compliant responses.** Previous builds returned non-standard shapes (`{ content: string }` for `read_file`; `{ entries: [...] }` for `list_directory`; `{ results: [...] }` for `search_files`) that caused Zod validation errors or silent empty output. All six tools now wrap results in the required `content: [{ type: "text", text: "..." }]` array. The fix is deployed automatically on the next extension activation (`syncFilesystemServerBinary` copies the updated binary). Because the MCP server is a **persistent stdio process**, open agent sessions must reconnect (reload the IDE window or start a new chat) to pick up the updated binary.

### CLI MCP server tools

| Tool | What it does |
|---|---|
| `mcp__claude-skills-cli__list_available_clis` | Probe which allow-listed CLIs are on PATH — returns a found/missing table |
| `mcp__claude-skills-cli__run_command` | Execute any allow-listed CLI and return `stdout`, `stderr`, `exitCode`, and timeout status |

Supported CLIs (configurable via `cli-config.json`): `az`, `aws`, `git`, `kubectl`, `helm`, `terraform`, `gcloud`, `docker`, `gh`, `dotnet`, `node`, `npm`.

---

### Scenario 1 — Infrastructure automation without shell scripting

An agent can drive your entire cloud workflow (`az`, `aws`, `terraform`, `kubectl`, `helm`, `gcloud`) by calling `mcp__claude-skills-cli__run_command` directly — no Bash step needed in the conversation.

**Example flow:**

```
Agent calls mcp__claude-skills-cli__run_command(cli="terraform", args=["plan", "-out=tfplan"])
  → stdout: plan output, exitCode: 0
Agent calls mcp__claude-skills-cli__run_command(cli="terraform", args=["apply", "tfplan"])
  → stdout: apply summary, exitCode: 0
Agent calls mcp__claude-skills-cli__run_command(cli="kubectl", args=["rollout", "status", "deployment/api"])
  → stdout: "deployment successfully rolled out", exitCode: 0
```

**What you get:**

- The agent reads plan output, catches errors, and decides whether to apply — all in one conversation turn.
- No copy-paste between terminal and chat; no shell injection risk (args are passed as a safe array, not a shell string).
- Long-running operations (AKS creation, Azure Backup) can use extended timeouts up to 30 minutes.

**When to use this scenario:** IaC apply workflows, cluster deployments, multi-step cloud operations the agent needs to observe and react to.

---

### Scenario 2 — Git and GitHub DevOps from conversation

The `git` and `gh` CLIs let an agent handle the full git/PR lifecycle without leaving the chat — check repo state, inspect history, manage pull requests, and verify CI.

**Example flow:**

```
Agent calls mcp__claude-skills-cli__list_available_clis
  → confirms git ✓, gh ✓
Agent calls mcp__claude-skills-cli__run_command(cli="git", args=["log", "--oneline", "-5"])
  → last 5 commits for context
Agent calls mcp__claude-skills-cli__run_command(cli="gh", args=["pr", "list", "--state", "open"])
  → open PRs the agent can reference or close
Agent calls mcp__claude-skills-cli__run_command(cli="gh", args=["auth", "status"])
  → confirms auth and token scopes before attempting write operations
```

**What you get:**

- Agents can read real repo and PR state before suggesting code changes — no stale context.
- `gh` scopes are validated upfront; the agent knows what write operations are safe.
- Works across Claude, Cursor, and Kiro without any per-IDE shell configuration.

**When to use this scenario:** code review assistance, automated PR descriptions, branch health checks, pre-deploy verification.

---

### Scenario 3 — Node / npm / dotnet project management

Agents can drive builds, tests, and dependency checks through the CLI MCP server — useful for confirming the environment before generating code.

**Example flow:**

```
Agent calls mcp__claude-skills-cli__run_command(cli="node", args=["--version"])
  → v24.14.1 — agent confirms runtime before generating Node-specific code
Agent calls mcp__claude-skills-cli__run_command(cli="npm", args=["--version"])
  → 11.11.0
Agent calls mcp__claude-skills-cli__run_command(cli="npm", args=["run", "build"])
  → build output and exit code — agent detects errors and proposes fixes inline
```

**What you get:**

- Agents verify the runtime environment before recommending version-specific APIs.
- Build/test output is captured as structured text — the agent can parse errors and iterate without you copying output manually.
- Combine with the filesystem MCP server to read failing files and rewrite them in the same session.

**When to use this scenario:** build-fix loops, dependency audits, scaffolding new projects with correct runtime assumptions.

---

### Scenario 4 — Full file I/O observability (no enforcement)

An AI agent can choose between its built-in native tools (`Read`, `Edit`, `Glob`, etc.) and the MCP filesystem tools. Both work; **all calls are now logged and scored** via PostToolUse hooks.

**What you get:**

- The **Agent KPI** status bar shows an efficiency grade (A–F) based on how the agent used file and IDE tools in the last 24 h (including native `run_task`, `run_in_terminal`, etc.).
- The **Cost Dashboard → Efficiency metrics** panel breaks down token waste by tool, file, and session.
- A hints file (`~/.claude/learning/mcp-agent-hints.md`) is auto-written after each analysis pass with rules the agent can read at session start to avoid repeating past wasteful patterns.
- Native tool operations appear in the logs with the prefix `native:<toolName>` for clear distinction from MCP server operations.

**When to use this scenario:** auditing an existing agent setup without changing its behavior, or tracking both MCP and native tool efficiency.

---

### Scenario 5 — MCP Force Mode (strict enforcement)

Command Palette → **Enable MCP Force Mode** applies two changes:

1. Writes `["Read", "Write", "Edit", "Glob", "Grep", "Bash", "mcp__claude-skills-cli__run_command", "mcp__claude-skills-cli__list_available_clis"]` to `.claude/settings.json → permissions.deny` — Claude refuses to call those native tools and CLI MCP tools.
2. Injects an `## MCP REQUIRED` block into `CLAUDE.md` with explicit instructions to use only MCP filesystem tools.

**Auto-enable on startup:** set `claudeSkills.mcpForce.enableOnStartup: true` in VS Code settings to activate Force Mode automatically every time the extension starts (e.g. for a project that always requires strict file-I/O observability). The safety interlock still applies — if MCP is not healthy the setting is silently skipped.

**Safety interlock:** Force Mode only activates when `checkMcpHealth()` confirms the server is configured and reachable. If the MCP server is broken, the deny list is **not** written — the agent cannot be left with no working file tools.

**What you get:**

- 100% of file I/O flows through the MCP server, so every read, write, list, and search appears in the telemetry log.
- All native tool operations (run_task, run_in_terminal, etc.) are also captured and logged as `native:<toolName>` entries in `mcp-usage.jsonl`.
- KPI grades are meaningful and comprehensive (all tool calls are tracked—no gaps).
- The **Efficiency metrics** panel shows exact token counts per file, per session, per tool type, and across native tools.

**When to use this scenario:** strict agent observability across all IDE operations, cost audits, or testing agents in isolation.

---

### Scenario 6 — Validation test (confirm MCP wiring end-to-end)

Use the CLI MCP server to verify both servers are alive before starting a sensitive operation:

```
1. mcp__claude-skills-cli__list_available_clis          → all required CLIs present
2. mcp__claude-skills-cli__run_command(git --version)   → git responds, exitCode 0
3. mcp__filesystem__list_directory("~/.claude/skills")  → skill library visible to filesystem server
4. Check status bar: $(plug) MCP Connected + $(terminal-cmd) CLI MCP · claude, cursor, kiro
```

The MCP Health dialog (click any MCP status bar item) shows a combined modal: filesystem server status + KPI grade, and a `── CLI MCP Server ──` block with agent list and supported CLIs. The test prompt in `tests/mcp_cli_test_propmt.md` walks through all steps above automatically.

---

### Data flow: filesystem MCP call → status bar KPI

```
Agent calls mcp__filesystem__read_file("src/extension.ts")
  │
  ▼
index.js dispatchTool()
  Records: { ts, tool, path, durationMs, bytes, sessionId }
  Auto-skips write_file if SHA-1 content matches on-disk
  │
  ▼
appendMcpUsageLog()
  Writes JSONL line to:
    ~/.claude/learning/mcp-usage.jsonl        (global — cross-session intelligence)
    <workspace>/.claude/mcp-usage.jsonl       (workspace — per-project KPI)
  │
  ▼
Extension refresh cycle (every ~2 s)
  summarizeMcpUsage()
    readMcpUsageLog()            — mtime-cached, no re-parse if file unchanged
    detectWaste()                — files read 3+ times
    detectAgentLoops()           — same file read 4+ times in 5-min window
    detectExcessiveScans()       — same directory listed 3+ times
    detectReadAfterWrite()       — read within 60 s of write to same path
    detectLargeFiles()           — files > 100 KB
    detectNoOpWrites()           — write_file skipped because content unchanged
    computeScore()               → score (0–100), grade (A–F)
  │
  ▼
Status bar: "$(pulse) KPI: B · 38 calls"
Cost Dashboard → Efficiency metrics panel
~/.claude/learning/mcp-agent-hints.md   ← written for the agent to read next session
```

---

### How efficiency is scored

```
wasteful_ops =
    (read_file calls - 1) per hot file    ← redundant repeated reads
  + read_after_write count                ← re-reading content just written
  + (loop reads - 1) per looping path     ← agent reasoning loops
  + no-op write count                     ← identical content written again
  + ceil(excess_scan_entries / 50)        ← repeated directory scans

score = round(((total_ops - wasteful_ops) / total_ops) * 100)
```

| Grade | Score | Meaning |
|---|---|---|
| **A** | ≥ 90% | Efficient — minimal redundancy |
| **B** | 75–89% | Good — minor repeated reads |
| **C** | 60–74% | Moderate waste — check repeated reads and scans |
| **D** | 45–59% | High waste — agent likely looping or re-reading large files |
| **F** | < 45% | Severe waste — enforce MCP Force and review hints file |

Grades appear after **5 or more** MCP calls (below that threshold the score shows `notEnoughData`).

---

### What the efficiency panel shows

The **Cost Dashboard → Efficiency metrics** section (Command Palette → **Show Cost Intelligence Dashboard**) contains:

- **Token quality bar** — stacked useful / wasted / untracked token totals for the last 14 d
- **Cost per file** — which files consumed the most context tokens (MCP reads)
- **Waste detected** — per-pattern breakdowns: repeated reads, agent loops, read-after-write, large files, excessive directory scans, no-op writes
- **Suggestions** — actionable hints with estimated token savings
- **Persistently over-read files (30 d)** — files read in > 50% of sessions across multiple agent conversations; these are candidates for permanent entries in `mcp-agent-hints.md`

---

### Cross-session intelligence

`summarizeCrossSessionPatterns()` groups every `read_file` event by `sessionId` across the last 30 days and surfaces files that appear in more than 50% of sessions. These are genuine global hot spots — files the agent consistently re-reads from scratch.

The hints file (`mcp-agent-hints.md`) includes these as permanent cache rules:

```markdown
## Files to cache in memory (read repeatedly — do not re-read)
- `src/extension.ts` — read 6×, ~12,400 tokens wasted
→ Rule: if a file is already in your context, do NOT call read_file again.
```

Agents that read this file at session start avoid repeating the patterns from prior sessions.

---

### Log files

| File | Written by | Purpose |
|---|---|---|
| `~/.claude/learning/mcp-usage.jsonl` | Filesystem MCP server (`index.js`) | Global log — all agents, all sessions |
| `<workspace>/.claude/mcp-usage.jsonl` | Filesystem MCP server (`index.js`) | Workspace-scoped log for per-project KPIs |
| `~/.claude/learning/mcp-agent-hints.md` | Extension (`mcpUsageLog.ts`) | Auto-generated optimization rules for agents |

Clear all three with **Claude Skills: Clear MCP Server Logs** (Command Palette) or the **Clear MCP Logs** button inside the Cost Dashboard.

---

### Quick benefit checklist

| Goal | What to do |
|---|---|
| Check which CLIs the agent can call | `mcp__claude-skills-cli__list_available_clis` → found/missing table |
| Run a CLI from conversation | `mcp__claude-skills-cli__run_command(cli, args)` → stdout, stderr, exitCode |
| Drive IaC from chat | Use `terraform` / `az` / `aws` via CLI MCP — agent reads output and iterates |
| Inspect git/PR state before coding | Use `git log`, `gh pr list` via CLI MCP — no terminal copy-paste |
| See if both MCP servers are working | Check `$(plug) MCP Connected` + `$(terminal-cmd) CLI MCP` in the status bar; click for health dialog |
| Get a file-I/O KPI grade | Run any agent task that reads files; grade appears in `$(pulse) KPI` bar after 5+ calls |
| Force all file I/O through MCP | Command Palette → **Enable MCP Force Mode** |
| Auto-enable Force Mode on every startup | `claudeSkills.mcpForce.enableOnStartup: true` in VS Code settings |
| Understand what the agent re-read | Cost Dashboard → **Efficiency metrics → Waste detected** |
| Give the agent memory of past waste | Check `~/.claude/learning/mcp-agent-hints.md` — add it to agent context at session start |
| Reset and start clean | Command Palette → **Claude Skills: Clear MCP Server Logs** |

---

## Docs & diagrams

| Topic | Doc |
|-------|-----|
| **Install listings** | [VS Marketplace](https://marketplace.visualstudio.com/items?itemName=SerhiiVoinolovych.claude-skill-deployer&ssr=false#version-history) · [Open VSX](https://open-vsx.org/extension/serhiivoinolovych/claude-skill-deployer) · [diagram/00-extension-registries.md](diagram/00-extension-registries.md) |
| Extension user guide | [extension/README.md](extension/README.md) |
| Publish releases | [extension/PUBLISHING.md](extension/PUBLISHING.md) |
| Runtime architecture (Mermaid) | [diagram/README.md](diagram/README.md) |
| IDE / agent skill profiles (Mermaid + draw.io) | [diagram/06-ide-agent-skill-profiles.md](diagram/06-ide-agent-skill-profiles.md) |

## Quick start (CLI)

```bash
py generate_skills.py sync-library   # primary name; "install" is an alias
py generate_skills.py list --target .
py generate_skills.py generate --target .
py generate_skills.py generate --target . --dry-run
py generate_skills.py cost-report --target .
py generate_skills.py cost-report --weekly
py record_feedback.py <skill-name> --signal "no" --context "what went wrong"
```

### Headless apply/sync (Claude CLI — no VS Code required)

Use the IDE extension **once** to bootstrap, then work only in **`claude` CLI**:

**In Cursor / Kiro / VS Code:** Command Palette → **Claude Skills: Prepare for Claude CLI (headless)**

Or from the repo CLI:

```bash
# One-time per repo: copy hooks + register SessionStart / PostToolUse in .claude/settings.json
py generate_skills.py hooks install --target .

# Optional: all five cost-control hooks on Claude + Cursor + Kiro + Copilot
py generate_skills.py hooks install --target . --full

# After profile-init or SessionStart hook writes request files:
py generate_skills.py apply-session --target .   # session-skill-apply-request.json
py generate_skills.py apply-profile --target .   # profile.local.json (agent pending → applied)
py generate_skills.py sync-branch --target .     # saved branch profile on git switch
py generate_skills.py sync-agents --target .     # mirror to .cursor/, .kiro/, .github/instructions/

# All of the above in one shot:
py generate_skills.py sync --target .
```

**Automatic session apply:** the SessionStart hook runs `session-apply.js` inline (no VS Code). Install hooks once with `hooks install`.

**Git branch switch** (optional `.git/hooks/post-checkout`):

```bash
py generate_skills.py sync-branch --target "$(git rev-parse --show-toplevel)"
```

**CLI feature toggles** — optional `.claude/learning/cli-config.json` (mirrors extension defaults when absent):

```json
{
  "features": {
    "sessionSkillAdaptation": true,
    "branchProfiles": true,
    "multiAgent": true,
    "taskSkillFocus": true,
    "skillSetResolver": true
  },
  "agents": {
    "enabled": ["claude", "cursor", "kiro", "copilot"]
  },
  "taskFocus": {
    "enabled": true,
    "maxActiveSkills": 12
  },
  "costDiscipline": {
    "enabled": true,
    "propagateToAllAgents": true
  }
}
```

Text-only cost reports: `py generate_skills.py cost-report` (no webview dashboard).

## Feature toggles (extension)

Toggle major capabilities without uninstalling the extension:

**Command Palette → Claude Skills: Manage Feature Toggles**

Or Settings → `claudeSkills.features.*`:

| Feature | Default | Purpose |
|---|---|---|
| `budgetControls` | on | Daily budget, economy mode, hooks |
| `branchProfiles` | on | Per-branch skill layouts |
| `profileInit` | on | Role + branch agent-driven profile init (`claudeSkills.profileInit.*`) |
| `multiAgent` | on | Cursor / Kiro / Copilot deploy |
| `attributionCollector` | on | Background transcript attribution |
| `costIntelligence` | on | Dashboard, suggestions, export |
| `autoOptimizer` | on | Scheduled safe auto-optimizations |
| `predictiveAlerts` | on | Workspace spend vs weekly budget; sane WoW trend (not global all-projects) |
| `communityBenchmarks` | off | Opt-in community cost benchmarks |
| `teamCostSharing` | on | Git author attribution on shared skills |
| `skillArchival` | on | Archive idle / LOW-ROI skills (fully reversible; restoreArchivedSkill re-installs) |
| `emergencyCutoff` | on | Hard daily spend limit ($10 default) |
| `prCostEstimate` | off | PR cost comment via `gh` CLI |
| `costAwareSearch` | on | ROI/cost labels and sort in skills tree |
| `sessionSkillAdaptation` | on | Auto install/enable proposed skills on new agent session or window |
| `autoApplyTaskProposals` | on | Auto-install all **Proposed for current task** skills (+ required platform skills) locally |
| `taskSkillFocus` | on | Cap active skills via `skillOverrides`; syncs to all enabled agents |
| `skillSetResolver` | tier default | Weekly relevant install + idle prune (`solo-dev` / `budget-sensitive` when unset) |

**Cost discipline settings** (Settings → `claudeSkills.taskFocus.*`, `branchBootstrap.*`, `costDiscipline.*`): cap at 12 active skills, branch bootstrap on new git branches, budget tier gating, and optional `propagateToAllAgents` when multi-agent sync is enabled.

## Cost intelligence

Estimates where no usage data exists — hook/API-priced where hooks logged usage. Per-skill data is **best-effort**; confidence labels say how much to trust each row.

### Dashboard & ROI

- **Cost Intelligence Dashboard** — agent-level spend for **this workspace** (last 14 days); **General API** panel for base-model / non-skill session work (transcript residual minus hook invokes); **Models by agent** shows API-priced **Skill invokes** from hooks plus transcript estimates where ids are missing; **Top skills · measured** from hook invocations at published API rates; **Skill spend** overview stat separate from transcript estimates; per-skill costs with **ROI band** and **confidence**; **Value & ROI** summary; **System state** panel; cost by repo and skill owner; cross-agent savings; CSP-hardened webview
- **ROI in skills tree** — each skill shows **`$X/session (API)`** when hooks logged usage, **`(logged)`** from token totals, or **`~$X/session (catalog)`** before first invoke; sort via `Cycle Skill Sort (ROI / Cost)`
- **Status bar (today)** — **`API` / `Mixed` / `Est.`** prefix from transcript usage metadata (not a flat estimate label)
- **Graded trust** — workspace confidence score (0–100%) and per-skill `high` / `estimated` / `low`; optimizer runs when confidence ≥ 45% (not only when fully `reliable`)

### Attribution & data

- **Attribution collector** — parses session transcripts into `cost-attribution.json` (`transcriptSkills`, unattributed). Does **not** duplicate estimates into `runs.jsonl`.
- **Attribution v2 hooks** — PostToolUse hooks for **Claude, Cursor, Kiro, Copilot** → `.claude/learning/runs.jsonl` (auto-installed on workspace open). **Claude VS Code:** also registers **PreToolUse** workaround when PostToolUse does not fire; dashboard warns when a gap is detected
- **Cost-control hooks** — all five prompt hooks (`session-size`, `budget`, `context-focus`, `practical-focus`, `task-drift`) on Claude, Cursor, Kiro, and Copilot via `hookPlatform.js`; `task-skill-focus.js` caps via `cli-config.json`. Session-size needs `transcript_path` (Claude + Cursor only).
- **Usage Report split** — **Skills detail** (runs, **Cost/run**, tokens, ratings) from `runs.jsonl` hooks + self-learning; **Credits · 14d** from session transcripts (`API` / `Mixed` / `Est.` basis); **Inefficient skills** from user feedback; **Proposed for current task** from `task-skill-proposals.json`
- **Fallback chain** — hooks → session transcripts → install-tier heuristics (documented in dashboard)
- **Stale data guard** — auto-purges equal-split `transcriptSkills`; **Top skills** uses hook-measured costs when v2 runs exist (even if transcript attribution is stale)
- **Indexed stats** — `skill-stats.json` + `dashboard-snapshot.json` updated on refresh (reduces full `runs.jsonl` scans); in-memory cache on mtime/size

### Controls & optimization

- **Optimization suggestions** — disable expensive low-use skills, agent-switch hints with **estimated $/month** savings
- **Apply optimizations** — interactive or `claudeSkills.optimizer.autoApply` (max **3 applies per 30 minutes** when auto)
- **Pricing overrides** — optional `.claude/learning/pricing-overrides.json` for model $/M tokens and ROI hourly rate (audit-friendly vs built-in tiers)
- **Predictive alerts** — workspace last-7-day spend vs weekly budget (`claudeSkills.features.predictiveAlerts`); sane WoW % when prior week has enough data
- **Emergency cutoff**, **skill archival**, **PR cost estimate**, **commit cost hook** — unchanged from 1.0.x
- **Community benchmarks** — opt-in via `~/.claude/learning/community-benchmarks.json`

### Skill feedback & adaptation

When users disagree with agent output (`no`, `wrong`, `stop`, etc.), the **`skill-feedback-adaptation`** skill records reactions in `.claude/learning/skill-feedback.jsonl`. The Usage Report shows **inefficiency %** per skill (deeper red = more negative feedback) with update suggestions.

On a **new task**, the same skill analyzes the prompt and repo and writes `.claude/learning/task-skill-proposals.json` — a ranked set of skills from the library that should help. This file is **local-only** (auto-added to `.git/info/exclude`) — proposals never get committed or pushed to teammates.

When a **branch or task** exceeds a configurable share of monthly credits (default **50%**), the extension prompts to **Apply suggested skills** (`claudeSkills.skillFeedback.*` settings).

CLI helpers (from repo root):

```bash
py record_feedback.py <skill> --signal "no" --context "what went wrong"
py record_runs.py <skill> --tokens 12000 --fail   # existing run log
py scripts/skill_cost_from_runs.py --target .      # per-skill cost from runs.jsonl (hook-grounded)
py scripts/agent_billing_report.py                 # org billing via admin APIs (optional keys)
```

Install **`skill-feedback-adaptation`**, **`self-learning`**, and **`skill-usage-insights`** together for the full feedback loop.

### Learning files (workspace)

| File | Purpose |
|---|---|
| `.claude/learning/runs.jsonl` | Hook invocations + self-learning run log (not transcript cost estimates) |
| `.claude/learning/skill-feedback.jsonl` | User negative/correction feedback per skill (machine-local) |
| `.claude/learning/task-skill-proposals.json` | Latest task-scoped skill proposal set (machine-local, auto-excluded via `.git/info/exclude`) |
| `.claude/learning/skill-proposal-alert-state.json` | Dedup state for high-usage skill proposal notifications |
| `.claude/learning/cost-attribution.json` | Transcript-based per-skill estimates (`transcriptSkills`) and unattributed totals |
| `.claude/learning/skill-stats.json` | Aggregated per-skill stats index (hook/self-learning runs) |
| `.claude/learning/dashboard-snapshot.json` | Pre-computed dashboard data (cost/tokens/runs by session; replaces `daily-stats.json`) |
| `.claude/learning/system-state.json` | Unified `profileInit` / attribution / hooks / capabilities snapshot |
| `.claude/learning/write-locks.json` | Coordinated write versions for profile-init files |
| `.claude/learning/pricing-overrides.json` | Optional manual model pricing + hourly rate |

- **Reset Mis-attributed Cost Data** — removes legacy collector transcript rows from `runs.jsonl`, clears `transcriptSkills`, resets collector state; reopen Usage Report after reset

### Cost pipeline

Background sync runs **collect → index → analyze** on a schedule and after hooks append to `runs.jsonl`:

| Stage | What it does |
|---|---|
| **Collect** | Parse session transcripts into `cost-attribution.json`; refresh attribution health |
| **Index** | Aggregate hook/self-learning runs into `skill-stats.json`; pre-compute `dashboard-snapshot.json` |
| **Analyze** | ROI bands, optimization suggestions, system-state snapshot, predictive alerts |

Stage timings and errors appear in the Cost Dashboard **System** panel. A circuit breaker trips after more than 10 pipeline runs per minute and forces safe mode (auto-optimize off) until the window clears.

**Pipeline roadmap** (v1.0.20):

| Direction | Status |
|---|---|
| **Confidence on every layer** | Usage Report trust banner + per-skill confidence column; weekly report + predictive alerts + pipeline trace show workspace confidence |
| **In-memory index** | Unified `runs.jsonl` cache with derived v2 stats; transcript mtime fingerprint cache for credit usage (`transcriptUsageIndex.ts`) |
| **Real-time optimizer** | `autoDetectOnPipeline` (default on): debounced auto-apply after each pipeline sync when `autoApply` is enabled |

### Official Anthropic skills (repos with `skills_library/`)

- **SessionStart hook** — on new Claude Code sessions, checks [anthropics/skills](https://github.com/anthropics/skills) and injects context for the `skill-official-updater` skill
- **Check Official Anthropic Skill Updates** — manual check from Command Palette
- Setting: `claudeSkills.officialSkillsCheckOnSession` (default on)

### Weekly AI usage report (extension)

Default: **every Monday at 9:00** (local time) while Cursor/VS Code is open, the extension emails an AI usage summary to your inbox.

- One-time setup: **Configure Weekly Report Email** (recommended)
- Manual test: **Claude Skills: Send Weekly AI Usage Report**
- Schedule settings: `claudeSkills.weeklyReport.enabled`, `dayOfWeek`, `hour`, `emailSubject`

#### What credentials you need (two parts)

The extension does **not** send mail through GitHub/GitLab. A git token only **looks up the inbox** linked to your account. Something else must **deliver** the email.

| Credential | Purpose | Where to store |
|---|---|---|
| **GitHub or GitLab personal access token (PAT)** | Read your git account profile and primary email | VS Code Secret Storage via **Configure Weekly Report Email** (not `settings.json`) |
| **SMTP username + password** | Send the weekly usage email to that inbox | Same wizard (secrets), or `claudeSkills.weeklyReport.smtp*` / `CLAUDE_SKILLS_SMTP_*` env vars |

Do **not** put PATs or SMTP passwords in committed settings files. The wizard stores them in VS Code Secret Storage. For SMTP, env vars are safer than plain `settings.json` values.

#### GitHub token (if `origin` is GitHub)

**Token type:** [GitHub personal access token](https://github.com/settings/tokens) — **fine-grained** or **classic (legacy)**.

**Minimum scopes (classic PAT):**

| Scope | Why |
|---|---|
| `read:user` | Read your GitHub username and public profile |
| `user:email` | Read your real inbox address (skips `*@users.noreply.github.com`) |

`repo` is **not** required for weekly email reports (only identity/email lookup).

**Fine-grained PAT (alternative):** create a token with **Account** permissions only:

- **Email addresses** → Read
- **Profile** → Read (or Metadata read, depending on GitHub UI)

**How to insert it in the extension:**

1. Open a workspace whose `git remote get-url origin` points to GitHub.
2. Command Palette → **Claude Skills: Configure Weekly Report Email**.
3. Choose **Paste GitHub personal access token** (or **Use existing GitHub CLI session** if you already ran `gh auth login` with `user:email`).
4. Complete the SMTP step (Gmail app password, Microsoft 365, or company SMTP).
5. Choose **Send test email now** to verify.

**CLI alternative (no pasted PAT):** `gh auth login`, then refresh email scope if needed:

```bash
gh auth refresh -h github.com -s user,read:user
```

#### GitLab token (if `origin` is GitLab)

**Token type:** [GitLab personal access token](https://gitlab.com/-/user_settings/personal_access_tokens) (or your self-hosted GitLab **User Settings → Access Tokens**).

**Minimum scopes:**

| Scope | Why |
|---|---|
| `read_user` | Read your username and email on file |

`api` is broader than needed; `read_user` is enough for email discovery.

**How to insert it in the extension:**

1. Open a workspace whose `origin` is GitLab.
2. Command Palette → **Claude Skills: Configure Weekly Report Email**.
3. Choose **Paste GitLab personal access token** (or set `GITLAB_TOKEN` / `GLAB_TOKEN` in the environment and pick **Use existing GitLab CLI session**).
4. Complete SMTP and send a test email.

#### SMTP (required to actually receive the email)

The git PAT **cannot** replace SMTP. Pick one:

| Provider | SMTP host | Port | Password |
|---|---|---|---|
| Gmail | `smtp.gmail.com` | `587` | [Google App Password](https://myaccount.google.com/apppasswords) (not your login password) |
| Microsoft 365 / Outlook | `smtp.office365.com` | `587` | Your work Microsoft account password (or app password if MFA requires it) |
| Company / other | Your IT host | Usually `587` or `465` | From your mail admin |

The wizard stores SMTP in Secret Storage. Advanced override via settings or env:

```json
"claudeSkills.weeklyReport.emailTo": "you@company.com"
```

```powershell
$env:CLAUDE_SKILLS_SMTP_HOST = "smtp.gmail.com"
$env:CLAUDE_SKILLS_SMTP_PORT = "587"
$env:CLAUDE_SKILLS_SMTP_USER = "you@gmail.com"
$env:CLAUDE_SKILLS_SMTP_PASSWORD = "your-app-password"
$env:CLAUDE_SKILLS_REPORT_TO = "you@gmail.com"
```

#### Extension settings reference (`claudeSkills.weeklyReport.*`)

| Setting | Used for token? | Notes |
|---|---|---|
| `emailTo` | No (recipient override) | Leave empty to use email discovered from the PAT |
| `smtpHost`, `smtpPort`, `smtpUser`, `smtpPassword` | No (mail delivery) | Optional if configured via wizard or env vars |
| `enabled`, `dayOfWeek`, `hour`, `minute`, `emailSubject` | No | Schedule and subject only |

There is **no** `weeklyReport.githubToken` setting — the PAT is entered once in the **Configure Weekly Report Email** command and saved to VS Code secrets.

CLI helpers (automation outside the IDE):

```bash
py scripts/send_weekly_report.py --target .
py scripts/send_weekly_report.py --email          # needs CLAUDE_SKILLS_SMTP_* env vars
py scripts/test_skill_cost.py terraform-plan-review --write-manifest
```

## Multi-agent support

See `skills_library/agents.json`.

| Setting | Default | Effect |
|---|---|---|
| `claudeSkills.agents.enabled` | `claude`, `cursor`, `kiro`, `copilot` | Which agents receive clones |
| `claudeSkills.agents.syncWorkspaceToAll` | `true` | Mirror workspace installs to agent paths (all enabled when `multiAgent` on; host IDE only on solo-dev) |
| `claudeSkills.agents.syncGlobalToAll` | `true` | Global library install fans out to all enabled agents |
| `claudeSkills.agents.syncHooksOnSkillChange` | `true` | After any workspace skill change, refresh cost-control hook scripts (all agent paths) when any cost hook is already enabled on Claude; attribution-only workspaces refresh attribution scripts only |

Adding, removing, or editing skills under `.claude/skills/` automatically propagates to Cursor, Kiro, and Copilot paths when `syncWorkspaceToAll` is on. The same path runs on checkbox toggles, branch profile apply, generate/install commands, and file watchers (create, change, delete). With `syncHooksOnSkillChange` (default on), cost-control scripts refresh in `.claude/hooks/`, `.cursor/hooks/`, `.kiro/hooks/`, and `.github/hooks/` when cost control is active.

**Local-only skills:** unchecking a branch-committed skill disables it for you via `.claude/settings.local.json` (`skillOverrides`) without deleting shared files. Checking a skill not on the branch installs it as personal-only (`.git/info/exclude`). Other agents mirror your **effective** enabled set, not the raw folder listing.

## Per-branch skill profiles & local-only skills

`~/.claude/learning/branch-profiles.json` — personal layouts per git branch.
Committed `.claude/skills/` remains team source of truth. Optional team layout in
`.claude/skills-profile.json` applies **before** your personal profile on branch switch.

**Your personal skill set (not the same as the branch):**

| Action | What happens | Git impact |
|---|---|---|
| Uncheck skill **on the branch** | `skillOverrides: { "skill": "off" }` in `.claude/settings.local.json` | None |
| Check skill **not on the branch** | Installed under `.claude/skills/` + listed in `.git/info/exclude` | None (personal-only) |
| Uncheck **personal-only** skill | Directory removed from your workspace | None |
| Branch switch | Saved profile restores your effective set (overrides + personal adds) | None |

Setting: `claudeSkills.preferLocalSkillOverrides` (default `true`).

- **Branch profiles** section at the top of the Skills tree (current branch + saved profiles)
- Toolbar icons: show / save / apply branch profile (git repos only)
- Auto-save on skill install/remove; optional auto-apply on branch switch

## Profile init (role + branch, agent-driven)

When you land on a **new git branch** with no saved personal profile:

1. Extension saves your **position** → `.claude/position.local.json` (gitignored).
2. On init, writes `.claude/learning/skills-catalog.json` and `.claude/learning/profile-init-request.json` (includes `agentInstructions`).
3. **SessionStart hook** + synced **`profile-init` skill** auto-run on the **next AI agent session** — no manual prompt copy.
4. Agent writes `.claude/profile.local.json` → extension auto-installs (always includes **required platform skills**: `self-learning`, `skill-creator`, `skill-usage-insights`, `skill-feedback-adaptation`, etc.) and saves branch profile.

**Local-only files:** `position.local.json`, `skills-catalog.json`, `profile-init-request.json`, `profile.local.json`.

**Settings:** `claudeSkills.profileInit.*` — see [`extension/README.md`](extension/README.md).

### Multi-agent

Profile init is **agent-agnostic** for apply/catalog. **`profile-init`** syncs to Cursor, Kiro, and Copilot. Claude Code uses a **SessionStart hook**; other agents rely on the synced skill + pending request file at session start.

| Agent | Skill copy |
|---|---|
| Claude | `.claude/skills/profile-init/SKILL.md` + SessionStart hook |
| Cursor | `.cursor/skills/profile-init/SKILL.md` |
| Kiro | `.kiro/skills/profile-init/SKILL.md` + `sessionStart` hook (`.kiro/hooks/*.kiro.hook`) |
| Copilot | `.github/instructions/profile-init.instructions.md` + `SessionStart` hook (`.github/hooks/*.json`) |

## Library layout

```
skills_library/
  manifest.json       # detect_globs, cost_estimate, optional empirical_cost
  agents.json
  <skill-name>/SKILL.md
```

## Packaging & publishing

```powershell
cd extension
npm install
npm run package
npx vsce publish
```

Current extension version: **1.0.70** (`serhiivoinolovych`). See [CHANGELOG.md](CHANGELOG.md) for release notes.

## Performance impact

- **CPU**: under 1% idle; 2–5% during attribution collection (5-minute intervals)
- **Memory**: ~50 MB baseline; +20 MB when the dashboard WebView is open
- **Disk**: ~500 KB–2 MB per project under `<workspace>/.claude/learning/` (`runs.jsonl`, indexes, attribution store); `skill-stats.json` / `dashboard-snapshot.json` limit full-log rescans
- **Startup**: under 200 ms added to VS Code activation

Tuned for workspaces with fewer than 100 skills and fewer than 10K transcript lines. `runs.jsonl` is pruned to 90 days on attribution reset.

## Compatibility

| Component | Required? | Version / notes |
|---|---|---|
| VS Code or Cursor | Yes | 1.85+ |
| Claude Code | No | 0.2+ for Claude-only hooks and Claude transcript spend |
| Node.js | For hooks | 18+ |
| OS | | Windows 10+, macOS 11+, Linux (glibc 2.28+) |

Git integration is optional (branch profiles, team attribution). GitHub CLI is optional (PR cost estimates).

## Pre-publish validation

```bash
node scripts/validate-release.mjs
```

## v1.0.x onboarding & recovery

First launch shows **Get Started** → onboarding tour. Migration backs up v0.7 learning data to `.claude/backup-v0.7/`.

| Command | Purpose |
|---|---|
| `Claude Skills: Start Onboarding Tour` | Guided setup |
| `Claude Skills: Repair Claude Skills Data` | Fix corrupted JSON/JSONL |
| `Claude Skills: Reset Mis-attributed Cost Data` | Clear bad cost attribution after v1.0.0 collector bug |

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## What this tool does NOT do

- **SKILL.md lint is advisory** — sync-time checks on `.claude/skills` plus Cursor/Kiro SKILL.md mirrors and Copilot `.instructions.md` existence checks; set `claudeSkills.lint.blockSyncOnError` to hard-block multi-agent sync only (hooks and branch profiles still run).
- **Cost figures are estimates** — not Anthropic/Cursor invoices; per-skill attribution is best-effort with **confidence labels**. Strongest with Attribution v2 hooks across Claude, Cursor, Kiro, and Copilot. Override model rates via `.claude/learning/pricing-overrides.json` for audit alignment.
- Community benchmark upload requires you to configure endpoints (no default public server).
- PR comments require GitHub CLI and explicit feature enable.
- Copilot clones are instruction files, not native Copilot skills.
