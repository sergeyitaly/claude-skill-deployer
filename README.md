# Claude Skills Manager

**v1.0.101** — AI agent skill deployment, cost intelligence, HACE coaching, adaptive learning, Skill Enrichment Intelligence, and Context Efficiency Intelligence for Claude, Cursor, Kiro, and GitHub Copilot.

Install from:
- [VS Code / Cursor / Kiro — Open VSX](https://open-vsx.org/extension/serhiivoinolovych/claude-skill-deployer)
- [VS Code — Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=SerhiiVoinolovych.claude-skill-deployer)

---

## What it does

Claude Skills Manager is a VS Code extension that:

1. **Detects your project stack** (Terraform, Azure, Node, Python, CI/CD, etc.) and proposes the right AI agent skills automatically.
2. **Deploys skills** to all your AI agents in one action — Claude Code, Cursor, Kiro, and GitHub Copilot share a single `.claude/skills/` source of truth.
3. **Measures AI spend** per session, per agent, and (when hooks are active) per skill invocation.
4. **Scores agent intelligence** with the Agent Performance Index (API Score) — a 0–100 composite covering prediction accuracy, attribution quality, learning rate, and task completion.
5. **Adapts over time** — proposal confidence improves as the system observes which skills are actually used; the Adaptation Log tracks every configuration change with before/after snapshots.
6. **Coaches you to improve** — the HACE Coaching Engine converts every weak metric into prioritised advice with estimated improvement points; the Session Coach injects targeted hints directly into your Claude context (max 3 per session).

---

## Do you need Claude Code?

**No.** The extension works in VS Code or Cursor without the Claude Code CLI installed.

The `.claude/skills/` and `.claude/learning/` paths are a shared convention the extension creates. With `multiAgent` on (default), skills deploy to all enabled agents (`.cursor/skills/`, `.kiro/skills/`, `.github/instructions/`).

| You primarily use… | Works without Claude Code? | What you get |
|---|---|---|
| **Cursor** | Yes | Skill tree, detection, branch profiles, Cursor attribution hooks, cost estimates |
| **Kiro / Copilot** | Yes | Per-skill instruction files; attribution hooks when enabled |
| **Claude Code** | Full feature set | Everything above + session transcripts, budget/session/focus hooks, SessionStart profile-init |

---

## When is this actually useful?

### Scenario A — You spend real money on AI and want to know where it goes

You're running Claude or Cursor on a production codebase. Sessions cost $5–50 each. After two weeks you have no idea which skills are used, which are dead weight, or whether the AI is improving.

**What the extension does:** parses session transcripts, combines them with hook-measured invocations, and shows you a cost breakdown by agent, by model, and (when attribution hooks are active) by skill. The Agent Performance Index tells you in one number (0–100) whether your setup is getting better or worse. The Attribution Alert status bar fires when confidence drops below 80% so you know before the data becomes misleading.

**Real evidence from this project:** 14-day Claude spend $936, Cursor spend $16, 1443M total tokens across 77+34 sessions. The dashboard shows this immediately on open.

---

### Scenario B — Your AI agent keeps proposing irrelevant skills

Every session the agent loads 12 skills when only 2 are relevant. That's wasted context, slower responses, and higher cost.

**What the extension does:** the Prediction Intelligence panel shows Precision/Recall/F1 for skill proposals. The v1.0.86 fix eliminated catch-all glob matching (`**/*`) that was causing 10+ noise proposals per session. Skills are now proposed only when they match specific file patterns, keyword hints, or recent-use history. The stop-word filter (55 words) prevents "warn", "task", "file", "work" from boosting unrelated skills.

**Measurable:** proposals drop from 12 generic entries to 2–4 specific-match entries per session. Precision improves as the system learns which proposals convert to actual invocations.

---

### Scenario C — You work across Claude, Cursor, and Kiro and want consistent behavior

You have custom skills for your infrastructure stack. Keeping them in sync across three agents manually is tedious and error-prone.

**What the extension does:** one `.claude/skills/` directory is the source of truth. Every skill change (install, remove, edit) propagates automatically to `.cursor/skills/`, `.kiro/skills/`, and `.github/instructions/` via the sync engine. Hook scripts refresh across all agent paths too. Branch profiles remember per-branch skill layouts and restore them on checkout.

---

### Scenario D — HACE is low and you don't know why

Your HACE Score is 33/100. Prompt Clarity is 9%. Task Velocity is 2%. You can see the numbers but don't know what to do.

**What the extension does:** the HACE Coaching Engine reads your scores and generates a prioritised coaching report — for each weak metric it tells you *why* it's low (e.g. "91% of turns trigger extended thinking blocks"), *what to do* (e.g. "one goal per prompt, include the exact error message"), and *how much it's worth* ("est. +7 HACE pts if fixed"). The Productivity Impact Simulation projects what your score would reach if you followed the top 3 recommendations. The Session Coach then injects the most relevant hint directly into your next Claude prompt (at most 3 per session, never on your first prompt).

**Learning loop:** advice that leads to score improvements is shown more frequently; advice ignored 3 times enters a cooldown to avoid fatigue.

---

### Scenario E — Your prompts are vague and the AI keeps guessing

You type "Fix ESO" and get a 6-turn back-and-forth before anything works.

**What the extension does:** the Prompt Intelligence Engine scores every prompt you submit across 9 dimensions — goal clarity, error evidence, environment, constraints, success criteria, logs, expected output, context, and scope. It detects anti-patterns (multi-goal, missing error evidence, mixed architecture+debugging) and generates 3 improved rewrites: concise, troubleshooting, and expert. The Prompt Intelligence Panel shows your quality trend over time and your most common failure patterns. The Prompt Template Library provides 10 domain templates (Kubernetes Troubleshooting, GitHub Actions Failure, Terraform Deployment, Root Cause Analysis, etc.) that hit ≥80/100 quality when filled in.

---

### Scenario F — You need to audit AI usage for a team or client

A client asks: what did the AI do, how much did it cost, which skills ran, was attribution reliable?

**What the extension does:** the Governance panel (Feature Mode: power) shows a compliance checklist — telemetry is local-only, no prompt content in logs, attribution confidence, provenance status, and audit export readiness. The Adaptation Log records every configuration change with timestamps and before/after API Score snapshots. Export Telemetry CSV produces a structured record of all invocations.

---

### Scenario G — You want to run infrastructure CLIs from conversation

You're doing Terraform + Azure + Kubernetes work and copying between terminal and chat is breaking your flow.

**What the extension does:** the bundled CLI MCP server lets agents call `az`, `terraform`, `kubectl`, `helm`, `docker`, `git`, `gh`, `npm`, and others directly via `mcp__claude-skills-cli__run_command`. The agent reads stdout, catches errors, and iterates — all in one turn. Long-running operations (AKS creation, Azure Backup) support up to 30-minute timeouts. The CLI Loop Guard hook injects corrective hints on failures (wrong key type, missing init, auth errors) before the agent retries blindly.

---

### Scenario H — You want all file I/O observable and scored

You suspect the agent is re-reading the same files repeatedly, wasting tokens. You want to see and fix it.

**What the extension does:** the Filesystem MCP server logs every file operation to `mcp-usage.jsonl`. The Efficiency panel computes a score (A–F) based on redundant reads, read-after-write, directory scan loops, and no-op writes. The Dir Cache Guard PreToolUse hook blocks duplicate `list_directory` calls in the same session. MCP Force Mode blocks native tools entirely, routing 100% of file I/O through the observable MCP server.

---

## Quick Start

1. Install **Claude Skills Manager** from [VS Marketplace](https://marketplace.visualstudio.com/items?itemName=SerhiiVoinolovych.claude-skill-deployer) or [Open VSX](https://open-vsx.org/extension/serhiivoinolovych/claude-skill-deployer).
2. Open a workspace folder.
3. **Claude Skills** activity bar → **Install Skill Library to ~/.claude/skills** (one-time, fans out to all enabled agents).
4. **Install Relevant Skills for Workspace** — detected skills copy to all enabled agent paths.
5. Open **Cost Intelligence Dashboard** (Command Palette → `Claude Skills: Show Cost Intelligence Dashboard`).

---

## Install — pick your editor's registry

| Editor | Primary listing | Also on |
|--------|-----------------|---------|
| **VS Code** | [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=SerhiiVoinolovych.claude-skill-deployer) | [Open VSX](https://open-vsx.org/extension/serhiivoinolovych/claude-skill-deployer) |
| **Cursor** | [Open VSX](https://open-vsx.org/extension/serhiivoinolovych/claude-skill-deployer) | [VS Marketplace](https://marketplace.visualstudio.com/items?itemName=SerhiiVoinolovych.claude-skill-deployer) |
| **Kiro IDE** | [Open VSX](https://open-vsx.org/extension/serhiivoinolovych/claude-skill-deployer) | [VS Marketplace](https://marketplace.visualstudio.com/items?itemName=SerhiiVoinolovych.claude-skill-deployer) |

---

## Intelligence Dashboard

Open with: Command Palette → **Claude Skills: Show Cost Intelligence Dashboard**

The dashboard answers five questions on first open (no scroll required):

| Question | Where to find it |
|---|---|
| Is the system healthy? | Executive Summary → System panel (mode, hooks, pipeline) |
| Is attribution working? | Executive Summary → Attribution pill + Trust banner |
| Is prediction working? | Executive Summary → Prediction pill (0% = catch-all noise; >65% = learning) |
| What is ROI? | Executive Summary → ROI pill |
| What should I improve? | Executive Summary → Top Action pill |

### Status Bar (3 bars)

| Bar | Shows | Hides when |
|---|---|---|
| `⚠/$(graph) API D (32)` | Agent Performance Index score + grade | Never |
| `$(credit-card) ~$256` | Today's AI spend | — |
| `⚠ ATTR 35%` | Attribution confidence alert | Attribution ≥ 80% |

### Agent Performance Index (API Score)

Composite 0–100 score. Target: ≥ 65 (B).

| Component | Weight | What it measures |
|---|---|---|
| Precision | 25% | Fraction of proposed skills that are actually invoked |
| Attribution | 20% | Confidence of per-skill cost data (from attribution-trust.json) |
| Skill Efficiency | 15% | ROI of installed skills (0x when no invocations measured) |
| Learning Rate | 15% | v2 hook runs accumulating across sessions |
| Task Completion | 15% | Fraction of skill runs that succeeded |
| Human Correction | 10% | Absence of negative feedback in skill-feedback.jsonl |

### Feature Modes

Set via `claudeSkills.featureMode` setting:

| Mode | Unlocked features |
|---|---|
| `starter` | Skills library, basic dashboard, today's cost, cost control, profile init |
| `professional` (default) | + Attribution, API Score, optimization, prediction, learning timeline, ROI matrix |
| `power` | + Governance, adaptation log, prediction detail, audit export, community benchmarks |
| `team` | + Team telemetry, team reporting, team governance |

---

## MCP Servers

Both MCP servers auto-start on extension activation — no manual setup.

### Filesystem MCP server

Gives agents structured, observable file I/O. Every operation is logged to `mcp-usage.jsonl` for efficiency scoring.

**Tools:** `read_file`, `write_file`, `edit_file`, `list_directory`, `search_files`, `search_in_file`, `delete_file`

Key behaviors:
- **Session read/dir cache** — skips re-reads of unchanged files (mtime guard); caches `list_directory` within session
- **Binary file guard** — rejects files > 50 MB or detected binary (PNG, JPEG, PDF, ZIP, ELF)
- **`edit_file` (v1.2)** — targeted string-replace; `old_string` must match exactly once
- **Log auto-pruning** — `mcp-usage.jsonl` trimmed when it exceeds 2 MB (keeps last 30 days)

### CLI MCP server

Lets agents run allow-listed CLIs directly: `az`, `aws`, `git`, `kubectl`, `helm`, `terraform`, `gcloud`, `docker`, `gh`, `dotnet`, `node`, `npm`.

**Tools:** `mcp__claude-skills-cli__list_available_clis`, `mcp__claude-skills-cli__run_command`

Key behaviors:
- **CLI Loop Guard** (PostToolUse) — on non-zero exit, injects corrective hint before agent retries
- **Extended timeouts** — up to 30 minutes for long-running operations (AKS, backups, migrations)
- **Safe arg passing** — args array, not shell string — no injection risk

---

## Adaptive Agent Hooks

### Attribution v2 (per-skill logging)

PostToolUse hooks for Claude, Cursor, Kiro, and Copilot. When the agent reads a skill file, the hook logs an invocation to `runs.jsonl` with timestamp, skill name, agent, tokens, cost, and session ID.

Claude Code CLI: full PostToolUse support.
Claude VS Code extension: PreToolUse workaround registered automatically when PostToolUse does not fire.

### Cost Control (Claude Code)

Five prompt hooks that inject context at the right moment:
- **Session size warnings** — fires when session tokens exceed threshold
- **Daily budget warnings** — fires when daily spend approaches limit
- **Context focus grounding** — keeps the agent on task
- **Practical/deployment focus** — reduces speculative planning turns
- **Task drift re-proposal** — refreshes skill proposals when the session diverges from its original goal

### Efficiency Guards

- **Dir Cache Guard** (PreToolUse) — blocks duplicate `list_directory` calls in the same session
- **CLI Loop Guard** (PostToolUse) — corrects common CLI failures before the agent retries

---

## Cost Intelligence

### How spend is measured

| Source | What it covers | Accuracy |
|---|---|---|
| Session transcripts | Total tokens + cost per agent session | API-measured for Claude; size-estimated for Cursor |
| Attribution v2 hooks (`runs.jsonl`) | Per-skill invocation cost at published API rates | Highest accuracy |
| Transcript attribution | Per-skill cost heuristic (pre-hook fallback) | Low confidence until hooks populate |

The dashboard labels each figure: **API** (transcript usage lines), **Mixed** (API + estimates), or **Est.** (size-based).

### Confidence levels

| Level | Meaning |
|---|---|
| High (green) | Hook-measured at API rates |
| Estimated (yellow) | Heuristic from transcripts or install-tier |
| Low (red) | < 50% attribution confidence — figures are approximate |

Safe mode activates when attribution confidence < 35%. Optimization suggestions hide; figures still display with warnings.

---

## HACE Coaching System

The HACE Coaching System transforms the Human-AI Collaboration Efficiency (HACE) score from a passive measurement into an active improvement loop.

### How it works

On every pipeline cycle the coaching engine reads the current HACE component scores and generates a **Coaching Report** — shown directly below the HACE Efficiency panel in the dashboard:

- For each metric below its threshold (Prompt Clarity <65%, Task Velocity <60%, etc.) it generates:
  - **Why it's low** — specific, evidence-backed reasons (e.g. "91% of turns trigger extended thinking blocks")
  - **What to do** — concrete, ordered action steps
  - **Estimated gain** — approximate HACE points if the advice is followed
- **Productivity Impact Simulation**: "Following the top 3 recommendations could improve HACE by +N points (X → Y/100)"

### Session Coach

During active Claude Code sessions, the Session Coach injects coaching hints directly into your prompt context:

- Fires on `UserPromptSubmit` (skip prompt 1, skip scores ≥65)
- Max **3 hints per session** across all hint types (coach + skill opportunity)
- Anti-spam: hints only surface when their metric's cooldown has not fired
- Format: `[HACE Coach] ...` for metric hints; `[Prompt Coach] ...` for prompt quality hints

### Prompt Intelligence Engine

Every prompt you submit is analyzed across 9 quality dimensions and scored 0–100:

| Dimension | What it checks |
|-----------|---------------|
| Goal defined | Single clear action verb; goal count |
| Context provided | Current-state references |
| Error evidence | Error messages, stack traces, exit codes |
| Constraints | Must/should-not/avoid clauses |
| Success criteria | Expected result, done-when statements |
| Environment | Platform, cloud, tool version |
| Logs / output | Pasted log lines, command output |
| Expected output | Return/generate/provide directives |
| Task scope | Single-goal focus |

**Anti-patterns detected:** multi-goal (>1 goal), missing error evidence, no environment, vague request, mixed architecture+debugging, missing logs, excessive length.

**Prompt Rewriter:** generates 3 structured versions of any prompt (concise / troubleshooting / expert) without any API call.

### Prompt Template Library

10 domain templates in the dashboard, each enforcing all quality dimensions:

| Template | Category | Target score |
|----------|----------|-------------|
| Kubernetes Troubleshooting | Infrastructure | ≥85 |
| DevOps Investigation | DevOps | ≥82 |
| AWS Incident Response | Cloud | ≥83 |
| Azure Troubleshooting | Cloud | ≥83 |
| GitHub Actions Failure | CI/CD | ≥84 |
| Terraform Deployment | IaC | ≥85 |
| VS Code Extension Dev | Extension | ≥82 |
| Architecture Review | Design | ≥78 |
| Feature Implementation | Development | ≥80 |
| Root Cause Analysis | Investigation | ≥86 |

### Adaptive Learning Loop

The coaching system learns which advice is effective:

- Advice shown → user improves score >3pts → `adaptedMultiplier × 1.2` (shown more often, up to 2×)
- Advice shown 3× → no improvement → cooldown 24–72h → `adaptedMultiplier × 0.7` (suppressed, down to 0.25×)
- State persisted in `.claude/learning/coaching-state.json`

---

## Prediction Intelligence

The proposal engine ranks skills for each task using:
1. **Keyword hints** — task text matched against a hint table (terraform → terraform-plan-review, etc.)
2. **Skill name/description match** — tokens from prompt scored against skill metadata (stop-word filtered)
3. **Specific file globs** — skills with matching non-catch-all globs score +20
4. **Recent use history** — skills used in last 7 days score +25; last 30 days +15
5. **Minimum confidence threshold** — proposals below 20 points are dropped

Metrics (Prediction Intelligence panel):
- **Precision** — fraction of proposals that were invoked
- **Recall** — fraction of invoked skills that were proposed
- **F1** — harmonic mean; goal: ≥ 65%

Over-predicted skills (proposed but never used) are listed by name with their confidence and reason.

---

## Adaptation Log

Every significant configuration change is recorded to `.claude/learning/adaptation-log.jsonl`:

| Event type | When recorded |
|---|---|
| `hooks_installed` | Attribution v2 hooks installed or updated |
| `cost_control_enabled` | Cost control hooks first enabled |
| `attribution_reset` | Reset Mis-attributed Cost Data command run |
| `manual` | Manual events via `appendAdaptationEvent()` |

Each entry includes: timestamp, description, before/after API Score snapshots (when available).

The Adaptation Timeline in the dashboard (Feature Mode: power) shows these entries chronologically with delta API Score.

---

## Learning Files (workspace)

| File | Purpose |
|---|---|
| `.claude/learning/runs.jsonl` | Hook invocations + self-learning run log |
| `.claude/learning/skill-feedback.jsonl` | Negative/correction feedback per skill |
| `.claude/learning/task-skill-proposals.json` | Latest task-scoped proposal set (local-only, git-excluded) |
| `.claude/learning/cost-attribution.json` | Transcript-based per-skill cost estimates |
| `.claude/learning/skill-stats.json` | Aggregated per-skill stats index |
| `.claude/learning/dashboard-snapshot.json` | Pre-computed dashboard body (cached) |
| `.claude/learning/system-state.json` | Attribution / hooks / capabilities snapshot |
| `.claude/learning/attribution-trust.json` | Attribution confidence score (0–100) and trust tier |
| `.claude/learning/adaptation-log.jsonl` | Configuration change history with API Score snapshots |
| `.claude/learning/proposalOutcome.jsonl` | Session-level proposal→invocation→success outcome records |
| `.claude/learning/recommendation-feedback.jsonl` | Per-skill rejection feedback (written on session Stop) |
| `.claude/learning/hace-sessions.jsonl` | HACE metric snapshots per pipeline cycle |
| `.claude/learning/prompt-intelligence.jsonl` | Per-prompt quality scores (max 500 records) |
| `.claude/learning/coaching-events.jsonl` | Coaching interaction log for learning loop |
| `.claude/learning/coaching-state.json` | Per-metric adaptive frequency and cooldown state |
| `.claude/learning/confidence-history.jsonl` | Daily confidence snapshots per skill for trend engine |
| `.claude/mcp-usage.jsonl` | MCP file-access telemetry (workspace-scoped) |

---

## Multi-Agent Support

| Setting | Default | Effect |
|---|---|---|
| `claudeSkills.agents.enabled` | `claude`, `cursor`, `kiro`, `copilot` | Which agents receive skill copies |
| `claudeSkills.agents.syncWorkspaceToAll` | `true` | Mirror workspace installs to all enabled agent paths |
| `claudeSkills.agents.syncGlobalToAll` | `true` | Global library install fans out to all enabled agents |
| `claudeSkills.agents.syncHooksOnSkillChange` | `true` | Refresh hook scripts across all agent paths on skill change |

---

## Per-Branch Skill Profiles

`~/.claude/learning/branch-profiles.json` stores personal layouts per git branch. `.claude/skills/` remains the team source of truth.

| Action | What happens | Git impact |
|---|---|---|
| Uncheck skill on the branch | `skillOverrides: { "skill": "off" }` in `.claude/settings.local.json` | None |
| Check skill not on the branch | Installed under `.claude/skills/` + listed in `.git/info/exclude` | None (personal-only) |
| Branch switch | Saved profile restores your effective set | None |

---

## Feature Toggles

Command Palette → **Claude Skills: Manage Feature Toggles** (or Settings → `claudeSkills.features.*`)

| Feature | Default | Purpose |
|---|---|---|
| `budgetControls` | on | Daily budget, economy mode, hooks |
| `branchProfiles` | on | Per-branch skill layouts |
| `profileInit` | on | Role + branch agent-driven profile init |
| `multiAgent` | on | Cursor / Kiro / Copilot deploy |
| `attributionCollector` | on | Background transcript attribution |
| `costIntelligence` | on | Dashboard, suggestions, export |
| `autoOptimizer` | on | Scheduled safe auto-optimizations |
| `predictiveAlerts` | on | Workspace spend vs weekly budget |
| `emergencyCutoff` | on | Hard daily spend limit ($10 default) |
| `skillArchival` | on | Archive idle / LOW-ROI skills |
| `sessionSkillAdaptation` | on | Auto-install proposed skills on new agent session |
| `taskSkillFocus` | on | Cap active skills per `skillOverrides` |

---

## CLI Usage (headless / no VS Code)

```bash
py generate_skills.py sync-library        # install library globally
py generate_skills.py list --target .     # list detected skills
py generate_skills.py generate --target . # install relevant skills for workspace
py generate_skills.py cost-report --target .
py record_feedback.py <skill> --signal "no" --context "what went wrong"
```

Hooks without VS Code:
```bash
py generate_skills.py hooks install --target .
py generate_skills.py hooks install --target . --full  # all 5 cost-control hooks
py generate_skills.py sync --target .                  # full sync in one shot
```

---

## MCP Force Mode

Command Palette → **Toggle MCP Force** — blocks Claude's native `Read`/`Write`/`Edit`/`Glob`/`Grep`/`Bash` and CLI MCP tools, routing all file I/O through the observable MCP server.

Safety interlock: Force Mode only activates when `checkMcpHealth()` confirms the server is reachable. If MCP is broken, the deny list is not written — the agent cannot be left with no working file tools.

Auto-enable on startup: `claudeSkills.mcpForce.enableOnStartup: true`

---

## Key Commands

| Command | What it does |
|---|---|
| `Claude Skills: Show Cost Intelligence Dashboard` | Open the full intelligence dashboard |
| `Claude Skills: Show Skill Usage Report` | Agent spend, skill usage, proposals |
| `Claude Skills: Toggle MCP Force` | Enable/disable MCP Force Mode |
| `Claude Skills: Manage MCP Servers` | Enable/disable Filesystem MCP server |
| `Claude Skills: Manage Efficiency Guards` | Toggle CLI Loop Guard and Dir Cache Guard |
| `Claude Skills: Reset Mis-attributed Cost Data` | Clear bad attribution, re-collect |
| `Claude Skills: Export Skill Telemetry (CSV)` | Export runs.jsonl as CSV for audit |
| `Claude Skills: Repair Claude Skills Data` | Fix corrupted JSON/JSONL files |
| `Claude Skills: Start Onboarding Tour` | Guided setup for new installs |

---

## Docs

| Topic | Doc |
|-------|-----|
| Extension user guide | [extension/README.md](extension/README.md) |
| Publish releases | [extension/PUBLISHING.md](extension/PUBLISHING.md) |
| Runtime architecture | [diagram/README.md](diagram/README.md) |
| Release history | [extension/CHANGELOG.md](extension/CHANGELOG.md) |

---

## Compatibility

| Component | Required? | Version |
|---|---|---|
| VS Code or Cursor | Yes | 1.85+ |
| Claude Code | No | 0.2+ for Claude-only hooks and transcript spend |
| Node.js | For hooks | 18+ |
| OS | | Windows 10+, macOS 11+, Linux (glibc 2.28+) |

---

## Performance

- **CPU**: < 1% idle; 2–5% during attribution collection (5-minute intervals)
- **Memory**: ~50 MB baseline; +20 MB when dashboard WebView is open
- **Disk**: ~500 KB–2 MB per project under `<workspace>/.claude/learning/`
- **Startup**: < 200 ms added to VS Code activation
- **Pipeline**: collect/index/analyze typically 4–6 seconds total

---

## What this tool does NOT do

- **Cost figures are estimates** — not Anthropic/Cursor invoices. Strongest with Attribution v2 hooks across all agents. Override rates via `.claude/learning/pricing-overrides.json`.
- **SKILL.md lint is advisory** — sync-time checks only; set `claudeSkills.lint.blockSyncOnError` to hard-block sync on lint failure.
- **Community benchmarks** require you to configure endpoints — no default public server.
- **PR comments** require GitHub CLI and explicit feature enable.
- **Copilot skill copies** are instruction files, not native Copilot skill objects.

---

**Current version:** 1.0.101 (`serhiivoinolovych.claude-skill-deployer`)
