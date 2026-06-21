# Claude Skills Manager

A VS Code extension that bundles a personal AI agent skill library and helps
you install the skills relevant to whatever project you have open. It targets
[Claude Code](https://docs.claude.com/claude-code), **Cursor**, **Kiro**, and
**GitHub Copilot** â€” you do **not** need Claude Code installed to use it.

| Editor | Primary listing | Also on |
|--------|-----------------|---------|
| **VS Code** | [**Claude Skills Manager** â€” Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=SerhiiVoinolovych.claude-skill-deployer&ssr=false#version-history) | [Open VSX â†—](https://open-vsx.org/extension/serhiivoinolovych/claude-skill-deployer) |
| **Cursor / Kiro** | [**Claude Skills Manager** â€” Open VSX](https://open-vsx.org/extension/serhiivoinolovych/claude-skill-deployer) | [VS Marketplace â†—](https://marketplace.visualstudio.com/items?itemName=SerhiiVoinolovych.claude-skill-deployer&ssr=false#version-history) |

Distribution map: [diagram/00-extension-registries.md](../diagram/00-extension-registries.md) Â· Publish: [PUBLISHING.md](PUBLISHING.md)

## What's new in 1.0.82

### Simplification — dead features removed, modules consolidated

**Removed entirely:**
- **Weekly report** — `weeklyReport.ts`, `weeklyReportBenefits.ts`, `vcsReportDelivery.ts`, `tierBenefitBenchmark.ts` deleted. Commands `Configure Weekly Report Email` and `Send Weekly AI Usage Report` removed. All 12 `weeklyReport.*` settings and 4 `benchmarks.*` settings removed. Export CSV from the cost dashboard instead.
- **Cycle commands** — `Cycle Budget Mode`, `Cycle Context Focus Level`, `Cycle Practical Focus Level` removed. Change these via VS Code Settings (`claudeSkills.budget.mode`, `claudeSkills.contextFocus.level`, `claudeSkills.practicalFocus.level`).
- **4 status bars** — trust badge, budget mode, context focus, and practical focus bars removed. Remaining: usage stats, skills count, project tier, workspace folder, MCP health.
- **9 legacy JS hooks** — `budget-watch.js`, `prompt-context-watch.js`, `task-drift-watch.js`, `skill-invoke-watch.js`, `profile-init-watch.js`, `official-skills-watch.js`, `branch-sync.js`, `usageParse.js`, `hookPlatform.js` deleted. Only `terminal-watch.js` is kept for native terminal telemetry. All hook logic runs via HTTP endpoints in `hookHandlers.ts`.
- **Config settings** — `practicalFocus.enabled` removed (inferred), `skillFeedback.taskDrift*` (4 settings) consolidated, `optimizer.*` fine-tuning (6 settings) removed — only `optimizer.autoApply` remains.

**Modules merged (files deleted):**
- `haceMetrics.ts` → inline in `efficiencyMetrics.ts`
- `projectProfileDisplay.ts` → inline in `projectProfile.ts`
- `dashboardCache.ts` → inline in `dashboardPrecompute.ts`
- `generalApiSpend.ts` → inline in `costAttribution.ts`

---

## What's new in 1.0.71

### Large-file self-correction â€” now actually enforcing, not just advising

The file-split-advisor hook previously emitted a suggestion after a large file (>50 KB / 500 lines) was read, but the agent could silently ignore it. Three issues have been fixed:

**1. PostToolUse escalation** â€” the hook now has two modes:
- **Read 1:** advisory hint as before â€” agent is informed and can continue.
- **Read 2+:** returns `stopTask: true` for Claude Code (halts the tool chain) and a hard `ðŸ›‘ MANDATORY SPLIT REQUIRED` message for all agents. The agent must complete the split before it can proceed.

**2. New PreToolUse read-guard** (`file-split-read-guard`) â€” fires *before* the read, so it can block the call entirely with `decision: "block"` and redirect the agent to `search_in_file` or a line-range read instead. The token burn is prevented, not just warned about after the fact. The guard only activates when the file has already been read at least once this session and is recorded in the large-file store â€” first reads always pass through.

**3. Both hooks installed together** â€” `installFileSplitAdvisorHook` now registers the PostToolUse advisor and the PreToolUse guard as a pair, on the same `mcp__filesystem__read_file` matcher. `removeFileSplitAdvisorHook` removes both. Existing workspaces pick up the guard automatically on next extension activation.

### MCP telemetry â€” performance and correctness fixes

- **`resolvePath` memoized per summarize call** â€” `fs.realpathSync` was called once per log entry per unique path on every `summarizeMcpUsage` invocation. A per-call `Map` cache now ensures each unique path is resolved at most once. For a session log with thousands of entries this cuts syscall count from O(n) to O(unique paths).
- **LRU log cache raised from 20 â†’ 50 paths** â€” multi-root workspaces with many active log files no longer thrash the cache.
- **`detectReadAfterWrite` reports all writeâ†’read cycles** â€” previously only the first read-after-write per path was reported (a `seen` Set suppressed subsequent occurrences). The fix clears the write timestamp after the first warning, so each independent writeâ†’read cycle on the same path is reported separately, while a second read after the same write (without an intervening write) correctly produces no additional warning.

### Hook file writes are now atomic

`hookOps.ts` was writing hook JSON files (`.cursor/hooks.json`, `.kiro/hooks/*.kiro.hook`, `.github/hooks/*.json`) with a direct `fs.writeFileSync`. These are now written via `writeJsonAtomic` (temp-file â†’ rename with retry), matching the approach already used everywhere else in the codebase. A VS Code crash mid-write no longer corrupts hook files.

### CLAUDE.md concurrent write protection

`mcpForce.ts` `injectMcpForceClaude` and `removeMcpForceClaudeBlock` now acquire an exclusive lock file (`CLAUDE.md.mcpforce.lock`) before reading and writing CLAUDE.md, and use a temp-file rename for the write itself. Two VS Code windows targeting the same workspace simultaneously no longer risk corrupting CLAUDE.md.

---

This is the VS Code front-end for the `claude-skills-deployer` repo. The
skill content lives in `../skills_library/`; this extension bundles a synced
copy (`skills_library/`, generated by `npm run sync-skills`, gitignored).

## How it works

The extension detects your project context, lets an AI agent choose the best
development skills, synchronizes them across tools like Cursor and Copilot,
tracks how those skills are actually used, calculates cost and value, and
continuously optimizes your setup based on real usage.

On first open it **probes your git repo** (local history + optional `origin`
check) and suggests a **project tier**. You confirm or override with
**Choose Project Profile Tier** â€” that choice controls multi-agent sync,
attribution overhead, budget hooks, and how aggressively skills are trimmed.

## Examples: different teams, tools, and budgets

These are practical walkthroughs â€” not theory. Each row is a common situation;
pick the closest match when the tier prompt appears (or run **Choose Project
Profile Tier** later).

| You areâ€¦ | Pick this plan / tier | Multi-agent sync | Cost tracking | Typical daily budget |
|---|---|:---:|:---:|---|
| One person, Cursor only, new repo | **Solo developer** â†’ `solo-dev` | Host IDE only (`.cursor/skills/`) | Basic dashboard | `$5` Normal (adjust in Settings) |
| One person on a **shared team repo** | **Solo developer** (override detection) | Host IDE only; `.claude/skills/` still git-shared | Basic + branch profiles | `$5` Normal or **Economy** |
| Shipping with Claude + Cursor + Copilot | **Multi-agent workflow** â†’ `team-multi-agent` | All enabled paths | Full attribution + ROI | `$5â€“15` Normal |
| Product team, many branches/authors | **Team product** (or accept detected) | Full fan-out | Full + team cost sharing | `$10+` Normal |
| Every token counts | **Tight budget / economy** â†’ `budget-sensitive` | Host IDE only (even on shared repos) | Full alerts + optimizer hints | **`$2â€“3` + Economy mode** |
| Large org, compliance, unlimited spend | **Enterprise team** | Full fan-out | Minimal ROI overhead | Unlimited or high cap |
| Scratch script, no git | **Quick spike** â†’ `throwaway` | Off | Off | N/A |

Status bar shows your tier (`SOLO DEV`, `TEAM MULTI-AGENT`, â€¦). **Show Project Tier** prints repo signals and rationale.

### Example 1 â€” Solo developer in Cursor (new repo)

**Situation:** You cloned an empty repo, use **Cursor only**, never open Claude Code.

**What you pick:** **Plan: solo developer** (or accept detected `solo-dev`).

**What the extension does:**

1. Creates `.claude/skills/` as the **git-tracked source of truth** (even without Claude Code).
2. Installs relevant skills from the bundled library (**Install Relevant Skills for Workspace**).
3. Mirrors skills **only to** `.cursor/skills/` â€” not `.kiro/` or `.github/instructions/`.
4. Turns **off** heavy attribution collector overhead; keeps session skill adaptation and task focus (cap ~12 active skills).
5. Writes `.claude/learning/project-profile.json` with `multiAgent: false`.

**Folders you should see:**

```
your-repo/
  .claude/skills/          â† commit these (team source of truth)
  .claude/learning/        â† local metrics (usually gitignored)
  .cursor/skills/          â† Cursor mirror (auto-synced from .claude/)
```

**If you were wrongly detected as multi-agent first:** choosing **solo developer** again **removes** auto-created `.kiro/skills/`, `.github/instructions/`, and extra learning mirrors â€” only your running IDE keeps a clone.

**Budget tip:** leave **Normal** mode (`$5`/day default). Click the status bar budget chip to switch to **Economy** â€” high-tier skills are disabled locally via `skillOverrides` without deleting shared files.

---

### Example 2 â€” Solo on a shared product repo

**Situation:** Company monorepo with 20 contributors; you work alone in Cursor but `.claude/skills/` is committed for the team.

**What you pick:** **Plan: solo developer** â€” overrides â€œteamâ€ detection without forcing full multi-agent sync on your machine.

**What the extension does:**

- **Does not** fan out to Kiro/Copilot paths on your laptop.
- **Respects** branch-committed skills in `.claude/skills/` â€” unchecking a skill in the tree sets `"skill": "off"` in **your** `.claude/settings.local.json` only (eye icon / local disable).
- Saves **your** effective set per branch in `~/.claude/learning/branch-profiles.json` (personal, not committed).
- Optional: team layout in `.claude/skills-profile.json` still applies on branch switch before your personal overrides.

**Typical workflow:**

1. `git checkout feature/payments` â†’ extension restores your saved branch profile.
2. **Choose Task Skill Set** when prompted â†’ pick **Focused** (3â€“5 skills) or **Workspace** (~12 cap).
3. Work in Cursor; hooks log usage to `.claude/learning/runs.jsonl` for your usage report.

---

### Example 3 â€” Tight budget / economy mode

**Situation:** Personal side project; you want cost alerts, skill pruning, and no wasted tokens on unused skills.

**What you pick:** **Plan: tight budget / economy mode** â†’ `budget-sensitive` with **`multiAgent` forced off** (host IDE only).

**What the extension does:**

- Enables **full cost intelligence**: dashboard, predictive alerts, optimization suggestions, task drift reproposal.
- **Cost discipline** after focus: disables skills outside the cap via `skillOverrides`, prunes irrelevant personal installs.
- **Economy** budget mode (status bar): locally disables expensive catalog tiers; **Normal** enforces daily USD cap; hooks warn on large sessions.

**Suggested settings:**

| Setting | Suggested value |
|---|---|
| `claudeSkills.budget.mode` | `economy` |
| `claudeSkills.budget.dailyBudgetUsd` | `2`â€“`3` |
| `claudeSkills.taskFocus.maxActiveSkills` | `8`â€“`10` |
| `claudeSkills.features.skillSetResolver` | on (weekly prune idle skills) |

**Weekly check:** **Show Cost Intelligence Dashboard** â†’ **Optimization** panel â†’ apply safe disables (keep `claudeSkills.optimizer.autoApply` off until attribution looks healthy).

---

### Example 4 â€” Multi-agent team (Claude Code + Cursor + Copilot)

**Situation:** Platform team; developers use different AI tools on the same repo.

**What you pick:** **Plan: multiple AI tools** or **AIDLC greenfield** â†’ `team-multi-agent`.

**What the extension does:**

1. One skill change in `.claude/skills/` propagates to:
   - `.cursor/skills/` (SKILL.md)
   - `.kiro/skills/` (SKILL.md)
   - `.github/instructions/*.instructions.md` (Copilot)
2. **Attribution v2 hooks** on all enabled agents â†’ per-skill cost in `runs.jsonl`.
3. **Team cost sharing** attributes skill maintenance to git authors of each `SKILL.md`.
4. **Export Team Branch Profile to Git** â†’ commit `.claude/skills-profile.json` for shared branch layouts.

**Typical workflow:**

1. Add `terraform-module-ops` via checkbox â†’ all agent paths update on save.
2. **Enable Cost Control Hooks** once per repo (budget + session size + focus).
3. New branch â†’ **Init Profile for Current Branch** â†’ agent picks skills â†’ auto-install + multi-agent mirror.

---

### Example 5 â€” Enterprise team (high volume, minimal attribution overhead)

**Situation:** Large engineering org; unlimited budget; want multi-tool sync without per-invoke attribution CPU cost.

**What you pick:** **Plan: enterprise team** â†’ `enterprise`.

**Multi-agent sync stays on**; **attribution collector defaults off** (transcript/dashboard still available). Good when hook volume across hundreds of devs would be noisy.

---

### Example 6 â€” Quick spike (minimal extension footprint)

**Situation:** Temporary folder, experiment, or non-git scratch work.

**What you pick:** **Plan: quick spike** â†’ `throwaway`.

Almost all features off â€” no branch profiles, no multi-agent sync, no cost pipeline. Install skills manually if needed, then delete the folder.

---

### How tiers change what runs (cheat sheet)

```text
                    solo-dev / budget-focused     team-multi-agent / enterprise
                    â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€     â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
Skills source       .claude/skills/ (git)       same
IDE mirrors         running IDE only            cursor + kiro + copilot paths
Task skill sets     approve 2â€“3 options         same (recommended on teams too)
Branch profiles     personal + optional team    personal + team export
Attribution hooks   lighter (solo) / full (budget)   full (team) / off (enterprise)
Downgrade cleanup   removes other agent folders  N/A (full sync expected)
```

**Commands worth bookmarking:**

| Goal | Command |
|---|---|
| Confirm or change tier | **Choose Project Profile Tier** |
| See why a tier was picked | **Show Project Tier** |
| Pick skill set before apply | **Choose Task Skill Set** |
| Force mirror refresh (team tier) | **Sync Workspace Skills to All Agents** |
| Cut spend today | **Cycle Budget Mode** â†’ Economy |
| See ROI / waste | **Show Cost Intelligence Dashboard** |

Full tier table and feature flags: [Project profile tiers](#project-profile-tiers-auto-configure-cpu--tokens) below.

## Do you need Claude Code?

**No.** Install this extension in VS Code or Cursor and open a workspace folder.
The extension creates `.claude/` paths itself â€” they are a **layout convention**
for skills and learning data, not a requirement that Claude Code is installed.

| Feature | Without Claude Code | With Claude Code |
|---|---|---|
| Skill library tree, detection, install | Yes | Yes |
| Multi-agent sync (`.cursor/skills/`, Copilot, Kiro) | Yes | Yes |
| Branch profiles, skill overrides | Yes | Yes |
| Attribution v2 hooks | Per enabled agent (e.g. Cursor â†’ `.cursor/hooks.json`) | + Claude hooks |
| Cost dashboard / ROI | Yes; Cursor transcript spend when Cursor is used | + Claude transcript spend |
| Budget / session / focus hooks | Yes â€” Cursor `beforeSubmitPrompt`, Kiro `promptSubmit`, Copilot `UserPromptSubmit`, plus Claude Code | Yes |
| Profile-init SessionStart hook | Cursor `sessionStart` + Kiro `sessionStart` + Copilot `SessionStart` | + Claude SessionStart |
| Session skill adaptation hook | Same on all enabled host agents | Same |

Missing Claude data shows empty sections or informational messages â€” the extension does not error on startup.

**Cursor-only / host-first:** Settings â†’ `claudeSkills.agents.enabled` â†’ e.g. `["cursor"]` to skip Claude path installs. The extension detects the **running IDE** (`detectHostAgentId`) and creates `.claude/` as the canonical store even if you never open Claude Code â€” skills and learning import from `.cursor/skills/` (or Copilot/Kiro mirrors) on first activate. With `multiAgent` off (solo-dev tier), workspace sync mirrors **only to that host IDE**; enable `multiAgent` for full Cursor + Kiro + Copilot fan-out.

## Claude CLI (terminal) without VS Code

Set up once with the IDE extension, then work only in **`claude` CLI**:

**Command Palette â†’ Claude Skills: Prepare for Claude CLI (headless)**

That runs: global library install, relevant workspace skills, cost + profile-init hooks, `cli-config.json`, and a git `post-checkout` hook for branch profiles.

After that you can close the IDE. SessionStart hooks run `session-apply.js` automatically.

Manual CLI equivalent (from repo root):

```bash
py generate_skills.py hooks install --target .
py generate_skills.py sync --target .
```

See root [README.md](../README.md#headless-applysync-claude-cli--no-vs-code-required) for all subcommands and `cli-config.json`.


- **Activity bar view ("Claude Skills")** â€” lists every skill in the bundled
  library with its status for the current workspace:
  - ðŸ’¡ relevant to this workspace but not yet installed
  - âœ… installed in `<workspace>/.claude/skills/`
  - â—¦ available in `~/.claude/skills/` but not relevant/installed here
  - âŠ˜ not yet installed in `~/.claude/skills/` at all
- **Project-local skills** â€” if `<workspace>/.claude/skills/` already
  contains skills that aren't part of the bundled library (e.g. this
  extension was installed into a project that already has its own custom
  skills, or skills installed from elsewhere), they're listed too, marked
  *project-only*. Their description is read from the skill's own `SKILL.md`
  frontmatter when available. This means installing the extension into an
  existing project never hides skills that are already there.
- **On/off checkboxes** â€” each skill in the tree has a checkbox: check it to
  install ("enable") the skill into `<workspace>/.claude/skills/`, uncheck
  it to remove ("disable") it from there. This is the simplest way to turn
  individual skills on or off per project.

  **Note:** `<workspace>/.claude/skills/` is normally git-tracked and shared
  with your team â€” unchecking a skill here deletes its files, and if you
  commit that, it removes the skill for everyone after merge. To turn a
  skill off **only for yourself**, without touching the shared files, use
  the eye icon described below instead.
- **Multi-agent clones (auto-sync by default)** â€” one `skills_library/` fans
  out to Claude, Cursor, Kiro (`SKILL.md`), and Copilot
  (`.github/instructions/*.instructions.md`). When
  `claudeSkills.agents.syncWorkspaceToAll` is `true` (default), your
  **effective** skill set (enabled for you, respecting `skillOverrides`)
  is mirrored to agent paths: **all enabled agents** when
  `claudeSkills.features.multiAgent` is on, or **only the running IDE**
  (Cursor/Kiro/Copilot) on solo-dev tier. Sync runs on checkbox/eye toggle,
  branch profile apply, extension startup, and `.claude/skills` /
  `settings.local.json` changes. Manual: **Sync Workspace Skills to All Agents**.
  `.claude/skills/` stays the git-tracked file source of truth.
- **Cost-aware skills tree** (`claudeSkills.features.costAwareSearch`, default on) â€” description shows **`$X/session (API)`** from measured hook cost, **`(logged)`** from token totals, or **`~$X/session (catalog)`** from manifest tier before any invoke. Status bar uses **`API` / `Mixed` / `Est.`** for today's session spend.
- **Per-branch skill profiles** â€” each git branch can have its own skill
  layout stored in `~/.claude/learning/branch-profiles.json` (global,
  personal, not committed). A **Branch profiles** section at the top of the
  Skills tree shows the current branch and saved profiles; toolbar icons
  provide show / save / apply. The extension auto-saves when you install/remove
  skills or change local overrides; on branch switch it restores the saved
  profile for the new branch (adds missing skills by default, mirrored to other
  agents when sync is on). Committed `.claude/skills/` on the branch remains
  the team-shared source of truth after you `git commit`.
- **Team branch profiles in git** â€” commit a shared layout per branch in
  `.claude/skills-profile.json` via **Export Team Branch Profile to Git**.
  Shown in a **Team profiles** tree section. On branch switch: team profile first,
  then personal profile from `~/.claude/learning/branch-profiles.json`.
- **Multi-root workspaces** â€” uses the active editor's workspace folder; **Pick Active
  Workspace Folder** (or status bar) when multiple roots are open.
- **SKILL.md lint** â€” source + Cursor/Kiro/Copilot mirror checks on sync (`claudeSkills.lint.*`); blocks multi-agent sync only when `blockSyncOnError` is on.
- **Attribution v2 hooks** â€” installed automatically when you open a workspace
  (`claudeSkills.agents.autoInstallAttributionHooks`, default on) for **Claude Code**
  (`.claude/settings.json` â€” **PostToolUse** plus **PreToolUse** workaround for the VS Code extension when PostToolUse does not fire), **Cursor** (`.cursor/hooks.json`), **Kiro**
  (`.kiro/hooks/*.kiro.hook`, stdin or `USER_PROMPT`), and **GitHub Copilot**
  (`.github/hooks/*.json`, matches Skill tool and `.github/instructions/*.instructions.md` reads).
  The cost dashboard **Workspace hooks** panel warns when Claude VS Code sessions show tool use but zero PostToolUse fires.
  All agents log hook invocations to `.claude/learning/runs.jsonl` with the correct `agent` field.
- **Copilot bootstrap** â€” multi-agent sync writes `.github/copilot-instructions.md`
  (always-on index) plus per-skill `.github/instructions/*.instructions.md`.
- **Local skill set vs. git branch** â€” the checkbox means **enabled for you**,
  not "change what the branch commits":
  - **Uncheck a branch-committed skill** â†’ writes `"off"` to personal
    `.claude/settings.local.json` (`skillOverrides`). Files stay in
    `.claude/skills/` for teammates; your git status stays clean.
  - **Check a skill not on the branch** â†’ copies into `.claude/skills/` and
    adds it to `.git/info/exclude` so it stays **personal-only** on your machine.
  - **Uncheck a personal-only skill** â†’ removes the directory from your workspace.
  Branch profiles in `~/.claude/learning/branch-profiles.json` store this
  per-branch *effective* set (including overrides), restored on branch switch.
- **IDE / agent skill sets** â€” when you use the same repo in **VS Code**, **Cursor**,
  and **Kiro**, each IDE can keep its own saved skill layout per git branch
  (`~/.claude/learning/agent-skill-profiles.json`). The extension detects Cursor/Kiro
  from the editor name; plain VS Code maps to Copilot or Claude Code via
  `claudeSkills.agentProfiles.vscodeAgent`. On workspace open, the saved set for
  the current IDE is applied automatically. Commands: **Save Skill Set for Current IDE**,
  **Switch IDE / Agent Skill Set**, **Show IDE / Agent Skill Sets**. Diagram:
  [diagram/06-ide-agent-skill-profiles.md](../diagram/06-ide-agent-skill-profiles.md)
  ([draw.io](../docs/diagrams/skill-profiles-ide-branch-flow.drawio)).
- **Profile init (role + branch)** â€” on a new git branch with no saved profile,
  pick your **position** once; extension writes catalog + request files; **SessionStart hook**
  and the **`profile-init` skill** auto-run on the next AI agent session (Claude Code hook;
  Cursor/Kiro/Copilot via synced skill + request file). Agent picks skills from the live catalog;
  extension auto-installs from `.claude/profile.local.json`. See [Profile init](#profile-init-role--branch-agent-driven).
- **Eye icon** â€” same as uncheck/check for branch-committed skills (local
  `skillOverrides` only). Disabled skills show "disabled locally" and a
  closed-eye icon; the checkbox is unchecked while files remain on the branch.
- **Status bar items**:
  - How many relevant skills are pending install; click it to install them.
  - A skill *usage* summary (active / needs review / inefficient / unused), based on
    hook + self-learning rows in `.claude/learning/runs.jsonl` and user feedback in
    `skill-feedback.jsonl`; click it to open the full usage/KPI report.
  - **Today's estimated Claude spend** (tokens + USD, with % of daily budget
    when configured); click for the full usage report.
  - **Budget mode** (Economy / Normal / Unlimited); click to cycle modes.
  - **`$(plug) MCP Connected`** / **`$(plug) MCP Â· N agents`** / **`$(warning) MCP: setup needed`** â€” filesystem MCP server health; click for the combined MCP health dialog.
  - **`$(pulse) KPI: A Â· N calls`** / **`$(pulse) Agent KPI: ready`** â€” MCP filesystem efficiency grade and 24 h call count; click for the health dialog.
  - **`$(terminal-cmd) CLI MCP Â· claude, cursor, kiro`** / **`$(warning) CLI MCP: setup needed`** â€” CLI MCP server status; click to enable or disable. Auto-starts on activation alongside the filesystem server.
- **Claude Credits Usage report** â€” the usage report also includes a
  **Credits Â· 14d** section: workspace-scoped tokens and estimated cost by day
  and model from session transcripts (Claude + Cursor when enabled). Additional panels:
  **Inefficient skills (user feedback)** â€” heat-colored inefficiency % and update
  suggestions from `skill-feedback.jsonl`; **Proposed for current task** â€” ranked
  skills from `task-skill-proposals.json`. The **Skills detail** table counts hook
  invocations and self-learning runs (runs, success rate, tokens, feedback %, last
  used, rating) â€” not transcript cost estimates. Enable Attribution v2 hooks for
  accurate per-skill run counts.
- Click any skill to open its `SKILL.md` (workspace copy if installed, else
  global copy, else the bundled copy).

## How to use this extension

1. Install the `.vsix` (Extensions view -> `...` menu -> "Install from
   VSIX...") or get it from the Marketplace, then open a workspace folder.
2. Open the **Claude Skills** view in the activity bar. It lists the full
   bundled skill library plus any skills already in
   `<workspace>/.claude/skills/`, each annotated with its status for this
   workspace (relevant / installed / available / project-only).
3. First time only: run **"Install Skill Library to ~/.claude/skills"** to
   seed your personal global library (subsequent steps copy from there).
4. Run **"Install Relevant Skills for Workspace"** to auto-install the
   skills that match files in your project (or **"Preview Skill Detection
   (Dry Run)"** first to see what would happen without writing anything).
5. Fine-tune per skill: tick/untick a skill's checkbox in the tree to
   enable/disable it for this workspace, or right-click -> "Install to
   Workspace .claude/skills" for a single skill.
6. Click **"Show Skill Usage Report"** (graph icon, also in the status bar)
   to see which installed skills were **hook-invoked** or logged by
   self-learning (active / unused / removal candidates), plus workspace
   transcript spend for the last 14 days in **Credits Â· 14d**.
7. Optionally run **"Enable Cost Control Hooks"** to install session-size, daily-budget, **context focus**, **practical/deployment focus**, and **task-drift** hooks for all enabled agents (Claude `UserPromptSubmit`; Cursor `beforeSubmitPrompt`; Kiro `promptSubmit`; Copilot `UserPromptSubmit`).
8. Set budget caps under **Settings â†’ Extensions â†’ Claude Skills Manager â†’ Budget**, or click the **Economy / Normal / Unlimited** status bar item to cycle modes.
9. Click **Context focus** (`$(target)`) and **Practical focus** (`$(rocket)`) in the status bar when deploying or in long sessions â€” reduces hallucination and hand-wavy infra advice.
10. **New branch?** When prompted, set your position â€” **start a new AI agent session**; `profile-init` runs automatically (SessionStart hook + synced skill).

## Profile init (role + branch, agent-driven)

Personal skill setup when you start work on a **new git branch**. Your **position** is stable; the **skill list** is chosen by the AI agent from the live catalog (no hardcoded role map).

**Required platform skills** (always installed on every profile init): `self-learning`, `file-style-conventions`, `skill-creator`, `skill-usage-insights`, `skill-feedback-adaptation`, `skill-official-updater`. Override via `claudeSkills.profileInit.requiredSkills`. If any are accidentally deleted or locally disabled, they are **auto-recovered** when you create/switch to a new git branch without a saved profile (default on; `claudeSkills.profileInit.recoverRequiredSkillsOnNewBranch`).

### Steps

1. **Set position** (once) â€” **Set Your Position** or the init prompt â†’ `.claude/position.local.json`.
2. **Start init** â€” automatic prompt on branch switch, or **Init Profile for Current Branch**.
3. **New AI session** â€” SessionStart hook injects instructions; **`profile-init`** runs automatically (no copy-paste prompt).
4. **Agent output** â€” `.claude/profile.local.json` with `skills[]`.
5. **Extension apply** â€” auto-install, sync agents, save branch profile.

### Multi-agent (Cursor, Kiro, Copilot)

| Layer | Agent-specific? |
|---|---|
| VS Code prompts, catalog, auto-apply, SessionStart hook | Extension (Claude Code SessionStart; others use synced skill + request file) |
| Writing `profile.local.json` | No |
| Installing chosen skills | No â€” extension only |

`profile-init` syncs to `.cursor/skills/`, `.kiro/skills/`, `.github/instructions/`. Catalog and profile paths stay under **`.claude/`**.

Settings: `claudeSkills.profileInit.autoStartOnSession` (default on).

## Project profile tiers (auto-configure CPU / tokens)

On workspace open the extension **analyzes the git repository** locally; when you **choose a tier**, it also **probes `origin` via git** (`ls-remote`, remote-tracking refs, upstream ahead/behind) â€” extension-only, no AI agent. Signals include tracked files, branches (local + remote), commit history, authors, repo size, and age.

| Tier | Best for | Multi-agent | Attribution | Cost intel | Session adapt |
|---|---|:---:|:---:|:---:|:---:|
| `solo-dev` | Single agent, solo / new repo | off* | off | basic | on (focused) |
| `team-multi-agent` | Collaborative product, multi-branch | on | on | full | on |
| `budget-sensitive` | Economy mode / cost alerts | optional | on | full | on |
| `enterprise` | Large team, unlimited budget | on | off | minimal | on |
| `throwaway` | Scripts, no git | off | off | off | off |

Settings: `claudeSkills.projectProfile.autoDetect` (default on), `applyTierFeatures` (default on), `promptOnFirstDetect` (default on â€” **asks on first open**), `lockedTier` (manual override).

**First open on a new project:** shows **git analysis summary** + detected tier, then asks about **your plans** (AIDLC greenfield, multi-agent workflow, team product, budget focus, quick spike, or accept detected). Solo + new repo defaults to solo-dev, but **AIDLC and multi-tool greenfield projects should pick AIDLC greenfield or multi-agent** â€” detection also upgrades automatically when `aidlc-state.md`, AIDLC docs, or multiple AI tool folders are present.

**Visible in UI:** status bar badge (`TEAM MULTI-AGENT`, `SOLO DEV`, â€¦), cost dashboard **Project tier** panel (repo stats + rationale), and command **Show Project Tier**.

Commands: **Show Project Tier**, **Detect Project Profile**, **Choose Project Profile Tier** (plan confirmation).

\* `solo-dev` keeps `multiAgent` off â€” workspace skills mirror **only to the running IDE** (Cursor/Kiro/Copilot), not all enabled agents. Choosing **solo developer** or **tight budget** in the tier picker also **removes** auto-created mirror folders for other agents (`.kiro/skills/`, `.github/instructions/`, etc.). Turn on `claudeSkills.features.multiAgent` (or pick a team tier) for full multi-agent fan-out.

## Cost discipline (task focus & branch economy)

Keeps skill overhead low without manual curation:

| Setting | Default | Purpose |
|---|---|---|
| `claudeSkills.taskFocus.maxActiveSkills` | 12 | Cap active + proposed skills (required platform skills count toward cap) |
| `claudeSkills.taskFocus.minProposalConfidence` | 50 | Only propose skills at or above this confidence; required platform skills exempt |
| `claudeSkills.branchBootstrap.enabled` | on | New git branches get infra/app heuristics + relevant-only install (not main's full library) |
| `claudeSkills.costDiscipline.enabled` | on | Budget tier gating + irrelevant-skill prune after task focus |
| `claudeSkills.costDiscipline.propagateToAllAgents` | on | Fan out focus/budget disables to other agents when multi-agent sync is on |
| `claudeSkills.skillFeedback.taskSkillUnderusePromote` | on | After a busy session with zero active-skill invokes, promote high-confidence ignored skills from `task-skill-proposals.json` back into task focus |
| `claudeSkills.skillSetResolver.enabled` | tier default | Weekly install relevant / remove idle skills (`solo-dev` and `budget-sensitive` tiers enable the feature when unset) |

**Flow:** extension refreshes `task-skill-proposals.json` with **2â€“3 option sets** â†’ user picks one (**Choose Task Skill Set** command or startup quick pick) â†’ applies `skillOverrides` for skills outside the cap â†’ runs budget tier gating â†’ mirrors learning artifacts â†’ syncs effective skill set to agent mirror paths (all enabled agents, or host IDE only on solo-dev).

**Headless parity:** `task-skill-focus.js` reads `taskFocus.maxActiveSkills` from `.claude/learning/cli-config.json` (synced by the extension).

### Cost-control hooks (all agents)

Five prompt-time hooks share `hookPlatform.js` for cwd resolution and per-agent output:

| Hook | Purpose |
|---|---|
| `budget-watch.js` | Daily budget / economy mode warnings + skill disables |
| `session-size-watch.js` | Large transcript nudge (`/compact`) â€” needs `transcript_path` (Claude + Cursor) |
| `context-focus-watch.js` | Grounding level (balanced â†’ strict-local) |
| `practical-focus-watch.js` | Architecture-first / deploy-ready delivery mode |
| `task-drift-watch.js` | One-shot inject when task skill set is refreshed |

Registered on Claude `UserPromptSubmit`, Cursor `beforeSubmitPrompt`, Kiro `promptSubmit`, Copilot `UserPromptSubmit`. CLI: `py generate_skills.py hooks install --target . --full`.

## Skill feedback & task proposals

Personal learning loop when agent answers miss the mark or a new task needs the right skills.

| File | Purpose |
|---|---|
| `.claude/learning/skill-feedback.jsonl` | User negative/correction feedback per skill |
| `.claude/learning/task-skill-proposals.json` | Ranked skills for the current task |
| `.claude/learning/skill-proposal-alert-state.json` | Notification dedup (month / branch / task) |

**Agent skill:** install `skill-feedback-adaptation` â€” records disagreement (`no`, `wrong`, â€¦), writes task proposals on new work, deprioritizes inefficient skills.

**Extension:** Usage Report **Inefficient skills** panel; high branch/task spend popup (default when usage exceeds **50%** of monthly credits â€” `claudeSkills.skillFeedback.*`). **Session skill adaptation** (`claudeSkills.features.sessionSkillAdaptation`, default on) installs and locally enables the proposed set on each new agent session/window â€” toggle via **Manage Feature Toggles**.

### Skill lifecycle (versioning)

Each skill in `skills_library/manifest.json` may declare:

```json
{
  "version": "1.2.0",
  "changelog": "Improved Terraform parsing",
  "deprecation": false
}
```

Installed copies store `.skill-version.json` beside `SKILL.md`. The extension detects **outdated** skills, shows them in the Usage Report, prompts periodically, and offers **Claude Skills: Upgrade Outdated Skills**.

### Attribution trust messaging

Status bar **Trust** badge and dashboard headers show graded reliability:

| Badge | Meaning |
|---|---|
| **Reliable (hooks active)** | v2 hooks logged skill invokes â€” measured per-skill cost where hooks fired |
| **Estimated (transcripts)** | Mix of hooks/transcripts â€” probabilistic split, not an API invoice |
| **Low confidence** | Enable Attribution v2 hooks or collect runs for usable per-skill data |

Per-skill rows show **ROI band** and **Confidence: N% (Hook-based / Transcript-based / â€¦)**.

**CLI:** `py record_feedback.py <skill> --signal "no" --context "..."`

### Local files (gitignored)

| File | Purpose |
|---|---|
| `.claude/position.local.json` | Team role |
| `.claude/learning/skills-catalog.json` | Live skill inventory |
| `.claude/learning/profile-init-request.json` | Init context (`status`: `pending` â†’ `completed`) |
| `.claude/profile.local.json` | Agentâ€™s selection (`status`: `pending` â†’ `applied`) |
| `.claude/learning/write-locks.json` | Coordinated write versions (extension vs agent) |

## Cost intelligence & FinOps (v1.0.17+)

The extension tracks **cost** and **estimated value** so optimizations favor high-ROI skills, not blind cutbacks.

**v1.0.18** â€” compact shared dashboard layout (stat pills, tighter panels), **Models by agent** panel, improved Cursor skill attribution paths, pipeline trace + circuit breaker in the System panel, workspace-scoped predictive alerts, Usage Report skills detail from hooks/self-learning only.

### Usage Report vs Cost Dashboard

| Section | Data source | What it means |
|---|---|---|
| **Credits Â· 14d** | Session transcripts (this workspace) | Spend at published API rates when usage metadata exists; **Est.** only when transcripts lack usage lines |
| **Skills detail** | `runs.jsonl` hooks + self-learning | Invocations with **Cost/run** (`API` or `logged`) â€” not equal-split transcript guesses |
| **Inefficient skills** | `skill-feedback.jsonl` | User negative reactions; inefficiency % and SKILL.md update hints |
| **Proposed for current task** | `task-skill-proposals.json` | Agent/heuristic skill set for the active task |
| **Cost Dashboard per-skill** | Hook rows in `runs.jsonl` (API-priced when usage present); falls back to `cost-attribution.json` only when no hook runs | Dollar attribution with **API-priced** / **hook-measured** labels |

If Skills detail shows many skills with identical run counts and millions of tokens, run **Reset Mis-attributed Cost Data** once after upgrading to v1.0.18+, then reopen the report.

### Dashboard panels

| Panel | What it shows |
|---|---|
| **Trust banner** | Disclaimer + workspace confidence % + attribution fallback (hooks â†’ transcripts â†’ heuristics) |
| **System state** | Mode, profile, attribution, hooks, pipeline freshness, trace timings, circuit breaker status |
| **Usage by agent** | Claude/Cursor transcript spend for this workspace (14d); Kiro/Copilot deploy-only unless transcripts exist |
| **Models by agent** | Per-model tokens and spend per agent â€” Claude ids from transcripts; **Skill invokes (API)** from attribution hooks in `runs.jsonl`; Cursor **cursor-agent (size est.)** only when transcript lines lack usage metadata |
| **Top skills Â· measured** | Hook + self-learning rows from `runs.jsonl` at published API rates (excludes attribution-collector splits) |
| **Skill spend** | Overview stat â€” hook-grounded 14d total separate from transcript **Est. spend** |
| **General API** | 14d base-model / non-skill session work â€” transcript totals minus hook skill invokes |
| **Cost by repo** | Rollup from `runs.jsonl` `project` field |
| **Cost by skill owner** | Git author of each `SKILL.md` (proxy â€” not who invoked the agent) |
| **Top expensive skills** | Cost + ROI band + confidence per skill |
| **Optimization** | Apply suggestions with **monthly $** outcomes |

### ROI & confidence

- **Skills tree** â€” `Cycle Skill Sort (ROI / Cost)`; labels like `ROI: HIGH`, `~20 min saved`
- **Confidence** â€” `high` (v2 hooks / strong runs), `estimated` (transcripts or partial data), `low` (tier heuristics only)
- **Optimizer gate** â€” suggestions when workspace confidence â‰¥ 45%; apply-actions still safest when attribution is `healthy`

### Cost pipeline

Each sync cycle: **collect** (transcripts â†’ `cost-attribution.json`) â†’ **index** (`skill-stats.json`, `daily-stats.json`) â†’ **analyze** (ROI, suggestions, system state, alerts). Timings and errors show in the dashboard **System state** panel.

| Roadmap item | Status (v1.0.20) |
|---|---|
| **Confidence everywhere** | Usage Report rows + trust banner; weekly report; predictive alerts; pipeline trace |
| **In-memory index** | Runs cache + derived v2 stats; transcript credit cache (mtime fingerprint) |
| **Real-time optimizer** | `autoDetectOnPipeline` â€” debounced auto-apply after pipeline when `autoApply` is on |

### Optional pricing overrides

Create `.claude/learning/pricing-overrides.json` to align estimates with your contract or invoice:

```json
{
  "version": 1,
  "defaultHourlyRateUsd": 75,
  "models": {
    "opus": { "input": 5, "output": 25, "cacheWrite": 6.25, "cacheRead": 0.5 }
  }
}
```

Rates are USD **per 1M tokens**. Keys match model id substrings (same logic as built-in tiers).

### Learning & index files

| File | Purpose |
|---|---|
| `.claude/learning/runs.jsonl` | Attribution v2 hook invocations + self-learning run log (not transcript estimates) |
| `.claude/learning/skill-feedback.jsonl` | User negative/correction feedback per skill |
| `.claude/learning/task-skill-proposals.json` | Latest task-scoped skill proposals (confidence + install status) |
| `.claude/learning/skill-proposal-alert-state.json` | Dedup keys for high-usage proposal notifications (per month/branch/task) |
| `.claude/learning/skill-stats.json` | Pre-aggregated per-skill stats from hook/self-learning runs |
| `.claude/learning/daily-stats.json` | Cost/tokens/runs by calendar day |
| `.claude/learning/project-profile.json` | Auto-detected tier (solo/team/budget/throwaway) and feature preset |
| `.claude/learning/system-state.json` | Unified snapshot for debugging and UI |
| `.claude/learning/cost-attribution.json` | Background collector transcript estimates (`transcriptSkills`, unattributed) |
| `.claude/learning/pricing-overrides.json` | Optional manual pricing |

Profile-init local files â€” see [Profile init](#profile-init-role--branch-agent-driven).

## Commands (Command Palette / view toolbar)

| Command | What it does |
|---|---|
| `Claude Skills: Install Skill Library to ~/.claude/skills` | Copies every bundled skill into your personal global library (skips ones that already exist). |
| `Claude Skills: Install Relevant Skills for Workspace` | Detects which skills apply to the open workspace (by file patterns) and installs them. With `syncWorkspaceToAll` (default), deploys to all enabled agent workspace paths; otherwise Claude only. |
| `Claude Skills: Install All Skills for Workspace` | Same, ignoring detection â€” installs the whole library (all agents when sync is on). |
| `Claude Skills: Preview Skill Detection (Dry Run)` | Shows what *would* be installed, without writing anything. |
| `Claude Skills: Install to Workspace .claude/skills` (per-skill, right-click in the tree) | Installs a single skill into the current workspace, prompting before overwrite. |
| `Claude Skills: Disable Skill Locally (this workspace only)` (per-skill, eye icon) | Adds `"<skill>": "off"` to `<workspace>/.claude/settings.local.json` (`skillOverrides`) â€” turns the skill off for you only, without changing `<workspace>/.claude/skills/`. |
| `Claude Skills: Enable Skill Locally` (per-skill, eye icon) | Removes the local override, reverting the skill to the project default ("on"). |
| `Claude Skills: Show Skill Usage Report` | WebView KPI report: **Skills detail** from hook + self-learning rows in `runs.jsonl`; **Inefficient skills** from feedback; **Proposed for current task**; **Credits Â· 14d** from session transcripts for this workspace (by day and model). |
| `Claude Skills: Apply Suggested Skills for Current Task` | Installs uninstalled skills from `task-skill-proposals.json` to all enabled agent paths. Also offered automatically when branch/task token use exceeds the monthly credit threshold. |
| `Claude Skills: Enable Session Size Notifications` | Alias for **Enable Cost Control Hooks** (session size + budget). |
| `Claude Skills: Enable Cost Control Hooks (Budget + Session + Focus)` | Installs session-size, budget, context-focus, practical-focus, and task-drift hooks; syncs `~/.claude/learning/budget.json`, `context-focus.json`, and `practical-focus.json` from VS Code settings. |
| `Claude Skills: Cycle Budget Mode (Economy / Normal / Unlimited)` | Cycles global budget mode. Economy disables high-tier skills locally; Normal enforces the daily cap; Unlimited only notifies at a high spend threshold. |
| `Claude Skills: Cycle Context Focus Level` | Cycles Knowledge-forward â†’ Balanced â†’ Local-first â†’ Strict local â†’ off (reduces hallucination in long sessions). |
| `Claude Skills: Cycle Practical Focus Level` | Cycles Exploratory â†’ Balanced â†’ Architecture-first â†’ Deploy-ready â†’ off (concrete deploy steps over theory). |
| `Claude Skills: Preview Skill Set Resolver` | Dry-run weekly skill install/remove plan from workspace relevance and usage rules. |
| `Claude Skills: Run Skill Set Resolver Now` | Execute the skill set resolver plan (install relevant, remove/archive unused). |
| `Claude Skills: Open Extension Settings` | Opens all extension settings (`@ext:serhiivoinolovych.claude-skill-deployer`); also available from the gear icon on the Skills Library toolbar. |
| `Claude Skills: Open Budget Settings` | Opens VS Code settings filtered to `claudeSkills.budget.*`. |
| `Claude Skills: Save Branch Skill Profile` | Snapshots installed skills + `skillOverrides` for the current git branch to `~/.claude/learning/branch-profiles.json`. |
| `Claude Skills: Apply Branch Skill Profile` | Restores the saved profile for the current branch (install missing skills; optional remove extras via setting). |
| `Claude Skills: Show Branch Skill Profiles` | Lists all saved branch profiles for this repo (output channel + summary toast). Also visible in the Skills tree under **Branch profiles**. |
| `Claude Skills: Set Your Position (local profile)` | Saves your team role to `.claude/position.local.json` (gitignored, not committed). |
| `Claude Skills: Init Profile for Current Branch` | Sets position, writes request + catalog, installs SessionStart hook, syncs `profile-init` to all agents. |
| `Claude Skills: Refresh Skill Catalog for Agent` | Regenerates `.claude/learning/skills-catalog.json` from the extension library. |
| `Claude Skills: Apply Local Profile (.claude/profile.local.json)` | Installs skills the agent selected in `profile.local.json` and saves the branch profile. |
| `Claude Skills: Reset Mis-attributed Cost Data` | Removes legacy collector transcript rows from `runs.jsonl`, clears `transcriptSkills` in `cost-attribution.json`, resets collector state, refreshes indexes. Reopen Usage Report after reset. |
| `Claude Skills: Install Skill Library to All Enabled AI Agents` | Copies the bundled library to global dirs for Claude, Cursor, Kiro, and Copilot (per `claudeSkills.agents.enabled`). |
| `Claude Skills: Show Enabled AI Agent Targets` | Lists which agents are enabled and their deploy paths (`skills_library/agents.json`). |
| `Claude Skills: Show Cost Intelligence Dashboard` | WebView: agent spend (14d), trust/confidence banner, **System state**, Value & ROI, per-skill costs with ROI band + confidence, cost by repo/owner, cross-agent savings, financial optimization hints (`â†’ save ~$X/month`). **Efficiency metrics panel**: cost per task/skill/agent/file, efficiency score (Aâ€“F), waste warnings (repeated reads, agent loops, read-after-write, large files, no-op writes). Hides per-skill detail when attribution is broken. |
| `Claude Skills: Sync Workspace Skills to All Agents` | Force mirror effective workspace skills to Cursor, Kiro, Copilot. |
| `Claude Skills: Show Cost Optimization Suggestions` | Actionable disable / agent-switch / archival hints with estimated monthly savings. |
| `Claude Skills: Apply Cost Optimizations` | Interactive apply (or auto when `claudeSkills.optimizer.autoApply` is on). |
| `Claude Skills: Manage Feature Toggles` | Flip major features on/off (`claudeSkills.features.*`). |
| `Claude Skills: Cycle Skill Sort (ROI / Cost)` | Sort skills tree by relevance, lowest cost, highest ROI, or best value. |
| `Claude Skills: Reset Emergency Cost Cutoff` | Re-enable skills after hard daily limit triggered. |
| `Claude Skills: Restore Archived Skill` | Move skill back from `.claude/skills-archived/`. |
| `Claude Skills: Estimate PR Review Cost` | PR cost estimate via `gh` (feature `prCostEstimate`). |
| `Claude Skills: Configure Weekly Report Email` | One-time setup: GitHub/GitLab token finds your inbox, SMTP sends the report. |
| `Claude Skills: Send Weekly AI Usage Report` | Sends benefits + cost summary now (test) or waits for Monday 9:00 schedule. |

### Weekly benefits report (informative email)

When `claudeSkills.weeklyReport.enabled` is on (default), the extension checks every 15 minutes while VS Code/Cursor is open. On the configured day (default **Monday 9:00** local), it sends a plain **informative email** with **extension benefits from your logs** (`runs.jsonl`, `project-profile.json`, attribution) plus AI spend â€” no GitHub/GitLab issues.

The email leads with:

- **Project tier** â€” capability %, overhead saved vs full stack, net benefit index
- **Skill outcomes** â€” success rate, hook-tracked invocations, reliable vs failing skills
- **Cross-agent value** â€” measured Cursor savings and multi-agent skill usage
- **AI usage & spend** â€” weekly tokens/cost, agent breakdown, top skills (as before)

**One-time setup**

1. Open a workspace with a GitHub or GitLab `origin` remote.
2. Run **Configure Weekly Report Email** (sidebar key icon or Command Palette).
3. Paste a **personal access token** (stored in VS Code Secret Storage â€” not in `settings.json`), or reuse `gh auth login` / `GITLAB_TOKEN`.
4. Complete **SMTP** (Gmail app password, Microsoft 365, or custom). Also stored in secrets.

Full token types, scopes, and settings table: see [Weekly AI usage report in the repo README](../README.md#weekly-ai-usage-report-extension).

**GitHub PAT (minimum scopes):** `read:user`, `user:email` (classic) or fine-grained with **Email addresses: Read** + **Profile: Read**. `repo` is not required.

**GitLab PAT (minimum scope):** `read_user`.

**SMTP is required** â€” the git token finds your address; SMTP sends the mail.

**Prerequisites**

1. One-time **Configure Weekly Report Email** (PAT + SMTP).
2. VS Code/Cursor open at the scheduled time, or run **Send Weekly AI Usage Report** manually.

Advanced: `claudeSkills.weeklyReport.emailTo` or `CLAUDE_SKILLS_SMTP_*` env vars instead of the wizard.

### Settings highlights

Find all options under **Settings â†’ Extensions â†’ Claude Skills Manager** (or search `@ext:serhiivoinolovych.claude-skill-deployer`). Sections: Budget, Skill feedback & proposals, Agents, Features, Lint, Optimizer, Weekly Report, and more.

| Setting | Default | Purpose |
|---|---|---|
| `claudeSkills.skillFeedback.promptOnHighUsage` | `true` | Popup when branch/task exceeds monthly credit threshold, offering to install suggested skills |
| `claudeSkills.skillFeedback.monthlyCreditThresholdPercent` | `50` | Branch/task must reach this % of monthly credits before prompting |
| `claudeSkills.skillFeedback.monthlyCreditsUsd` | `0` | Monthly credit budget (USD); `0` = daily budget Ã— 30, or 30-day workspace spend |
| `claudeSkills.budget.mode` | `normal` | Economy / Normal / Unlimited token budget mode |
| `claudeSkills.budget.dailyBudgetUsd` | `5` | Daily estimated spend cap (USD) |
| `claudeSkills.branchProfiles.enabled` | `true` | Per-git-branch skill profiles in `~/.claude/learning/branch-profiles.json` |
| `claudeSkills.profileInit.enabled` | `true` | Agent-driven profile init for new branches |
| `claudeSkills.profileInit.promptOnNewBranch` | `true` | Prompt when switching to a branch with no saved profile |
| `claudeSkills.profileInit.autoApplyProfileFile` | `true` | Auto-install when agent writes `.claude/profile.local.json` |
| `claudeSkills.profileInit.autoStartOnSession` | `true` | SessionStart hook + agent sync when profile init is pending |
| `claudeSkills.profileInit.requiredSkills` | see below | Platform skills always merged into every profile-init set |
| `claudeSkills.profileInit.recoverRequiredSkillsOnNewBranch` | `true` | Reinstall missing/disabled required platform skills on new branch (no saved profile) |
| `claudeSkills.lifecycle.alertOnOutdated` | `true` | Detect catalog version newer than installed copy |
| `claudeSkills.lifecycle.autoSuggestUpgrades` | `true` | Periodic popup to upgrade outdated skills |
| `claudeSkills.agents.enabled` | `claude`, `cursor`, `kiro`, `copilot` | Agents that receive skill clones |
| `claudeSkills.agents.syncWorkspaceToAll` | `true` | Mirror workspace installs to agent paths (all enabled when `multiAgent` on; host IDE only on solo-dev) |
| `claudeSkills.agents.syncGlobalToAll` | `true` | Fan out global library install to all enabled agent paths |
| `claudeSkills.agents.autoInstallAttributionHooks` | `true` | Auto-install Attribution v2 hooks on extension activate / workspace setup |
| `claudeSkills.agents.syncHooksOnSkillChange` | `true` | Refresh cost-control scripts on all agent paths when any Claude cost hook is active; attribution-only workspaces refresh attribution scripts only |
| `claudeSkills.preferLocalSkillOverrides` | `true` | Uncheck branch skill â†’ `skillOverrides` off (no git diff) |
| `claudeSkills.features.costIntelligence` | `true` | Dashboard, suggestions, export |
| `claudeSkills.features.predictiveAlerts` | `true` | Workspace spend vs weekly budget warning (sanitized WoW trend) |
| `claudeSkills.features.emergencyCutoff` | `true` | Hard daily limit (`claudeSkills.emergency.hardLimitUsd`, default $10) |
| `claudeSkills.features.communityBenchmarks` | `false` | Opt-in community benchmarks |
| `claudeSkills.features.sessionSkillAdaptation` | `true` | Auto install/enable proposed skills on new agent session or window |
| `claudeSkills.optimizer.autoApply` | `false` | Auto-disable expensive idle skills |
| `claudeSkills.weeklyReport.enabled` | `true` | Monday-morning AI usage report (local time) |
| `claudeSkills.weeklyReport.dayOfWeek` | `1` | 0=Sun, 1=Mon, â€¦ |
| `claudeSkills.weeklyReport.hour` | `9` | Local hour |
| `claudeSkills.search.sortBy` | `relevance` | `lowest_cost`, `highest_roi`, `best_value` |

**Pricing overrides** â€” not a VS Code setting; optional file `.claude/learning/pricing-overrides.json` (see [Cost intelligence](#cost-intelligence--finops-v1017)).

Checkbox toggles your **effective** skill set: enable installs or clears `skillOverrides`; disable on a branch-committed skill sets `skillOverrides: off` locally (files stay on the branch). Personal-only skills are removed from disk and added to `.git/info/exclude`. Changes propagate to other enabled agents automatically.

All results are logged to the **"Claude Skills"** output channel.

## Onboarding & recovery (v1.0.x)

| Command | Purpose |
|---|---|
| `Claude Skills: Open Setup Wizard` | WebView checklist: verify global + workspace install, then optional cost features |
| `Claude Skills: Start Onboarding Tour (step prompts)` | Legacy step-by-step toast tour |
| `Claude Skills: Repair Claude Skills Data` | Fix corrupted JSON/JSONL, create missing dirs |
| `Claude Skills: Reset Mis-attributed Cost Data` | Removes legacy equal-split transcript rows from `runs.jsonl` and clears stale `transcriptSkills`; run once after upgrade if Skills detail shows inflated token counts |

First activation prompts **Get Started** if `~/.claude/skills/` is empty.

### Cost attribution notes (v1.0.17+)

Two stores â€” do not confuse them:

| Store | Used for |
|---|---|
| `runs.jsonl` | Hook invocations + self-learning â†’ Usage Report **Skills detail**, skills tree usage summary |
| `cost-attribution.json` | Transcript collector estimates â†’ Cost Dashboard when hooks are sparse; per-skill rows in Cross-agent panel merge hook `cost` from `runs.jsonl` when present (v1.0.52+) |

Cross-agent **Per-skill** costs use measured API `cost` from hook rows when available â€” not a flat blended re-estimate from token count alone.

The background collector writes transcript-based estimates to **`cost-attribution.json` only** (v1.0.18+). It does not append equal-split rows to `runs.jsonl`.

**Confidence labels** on dashboard rows (`high` / `estimated` / `low`) indicate how much to trust per-skill **dollar** costs â€” not an API invoice. Strongest signal: Attribution v2 hooks across Claude, Cursor, Kiro, and Copilot.

**Predictive alerts** (`claudeSkills.features.predictiveAlerts`) compare **this workspaceâ€™s** last-7-day transcript spend to your weekly budget â€” not all projects under `~/.claude/projects/`.

**CLI (repo root):**

```bash
py scripts/skill_cost_from_runs.py --target .   # per-skill cost from runs.jsonl
py scripts/agent_billing_report.py              # Anthropic/Cursor/Copilot admin billing (optional keys)
```

Record runs with `metadata.invoked: true` via the `self-learning` skill for supplementary KPI data. Keep `claudeSkills.optimizer.autoApply` off until attribution looks correct. Optional: `.claude/learning/pricing-overrides.json` for model rates and ROI hourly wage.

Inspect `.claude/learning/system-state.json` when debugging profile init, hooks, or attribution health.

## MCP Servers

The extension bundles two MCP servers, both **auto-started on activation** (5 s after extension activate). No manual setup required on a fresh install.

### Filesystem MCP server

Gives Claude agents direct read/write access to `~/.claude/` and your open workspace folders â€” without copy-pasting file contents into chat.

**Enable / Disable manually:**

- **Command Palette â†’ Claude Skills: Enable Filesystem MCP Server**
- **Command Palette â†’ Claude Skills: Disable Filesystem MCP Server**

After toggling, reload the VS Code window (**Developer: Reload Window**) for the change to take effect.

### CLI MCP server

Lets agents run allow-listed infrastructure CLIs without leaving the conversation. Supported CLIs: `az`, `aws`, `git`, `kubectl`, `helm`, `terraform`, `gcloud`, `docker`, `gh`, `dotnet`, `node`, `npm`.

Every call captures `stdout`, `stderr`, `exitCode`, and `timedOut` and returns them as readable text. Calls are also logged to `~/.claude/learning/mcp-usage.jsonl` for unified session telemetry.

**Enable / Disable:**

- **Command Palette â†’ Claude Skills: Enable CLI MCP Server**
- **Command Palette â†’ Claude Skills: Disable CLI MCP Server**

Reload the VS Code window after toggling so the new registration takes effect in the agent.

**Security:** only CLIs on the allow-list can be invoked. The list is stored in `~/.claude/mcp-servers/cli/cli-config.json` and defaults to the 12 CLIs above. On Windows, `.cmd`/`.exe` wrappers are stripped for allow-list matching so `git.exe` matches `git`.

### MCP Health dialog

Click any MCP status bar item (`$(plug) MCP â€¦` or `$(pulse) KPI â€¦` or `$(terminal-cmd) CLI MCP â€¦`) to open the combined health modal:

```
â”€â”€ Filesystem MCP Server â”€â”€
Status:       Connected  âœ“
Config:       âœ“ valid
Server script:âœ“ found
Calls (24h):  38
Agents:       copilot, claude, cursor

â”€â”€ CLI MCP Server â”€â”€
Status:       Connected  âœ“
Agents:       claude, cursor, kiro
CLIs:         az, aws, git, kubectl, helm, terraform, gcloud, docker, gh, dotnet, node, npm

â”€â”€ Agent KPI (last 24h) â”€â”€
Efficiency:   84% (grade B)
Total ops:    38  Wasteful: 6
```

### Self-correcting hook guards

Both MCP servers feed a two-layer guard system that prevents agents from blindly retrying failed operations:

**`cli-loop-guard`** (PostToolUse on `run_command`) â€” fires after any non-zero CLI exit and injects a corrective hint. Eight static patterns cover the most common failures (terraform init missing, Azure 403, git conflicts, gh auth, timeouts). A learner (`analyzeCliFailures`) runs at each session start, groups repeated failures from `mcp-usage.jsonl`, and promotes them to `~/.claude/learning/cli-guard-patterns.json` after â‰¥ 2 occurrences.

**`mcp-error-guard`** (PostToolUse on `mcp__filesystem__`) â€” fires after any failed filesystem tool call and injects a corrective hint. Eight static patterns cover ENOENT, EACCES, EISDIR, access-denied, ENOSPC, EROFS, Invalid regex, and allowed-directory violations. A parallel learner (`analyzeMcpErrors`) promotes repeated project-specific errors to `~/.claude/learning/mcp-guard-patterns.json`.

**`dir-cache-guard`** (PreToolUse on `list_directory`) â€” blocks redundant directory scans within a session using an in-memory cache (4 h TTL). Cache hit returns `{ decision: "block" }` â€” the scan never executes.

Enable / disable all guards via the Command Palette: **Claude Skills: Enable/Disable CLI Loop Guard**, **Enable/Disable MCP Error Guard**, **Enable/Disable Dir Cache Guard**.

### What it unlocks in practice

| Before | After |
|--------|-------|
| "Update this skill's trigger" â†’ paste file, get edit, save manually | Claude reads and writes `~/.claude/skills/<name>/skill.md` directly |
| "My hooks aren't firing" â†’ paste `.claude/settings.json` | Claude inspects and repairs the hook config in place |
| Agent retries a failing CLI command 3Ã— before giving up | `cli-loop-guard` injects the fix after the first failure |
| `read_file` fails with ENOENT â†’ agent re-tries the same path | `mcp-error-guard` redirects to `search_files` immediately |
| `self-learning` / `skill-usage-insights` depend on proxy being active | Those skills read `.claude/learning/*.jsonl` reliably via a dedicated server |
| `~/.claude.json` MCP config issues need manual inspection | Claude can read and fix the config from chat |

### Security scope

The server enforces an **allowed-directories allowlist** â€” it cannot read or write outside:

- `~/.claude/` (always included)
- Every workspace folder open at enable time

When you open an additional workspace folder, the extension updates the allowlist automatically; the running server picks up the change on the next tool call without restart.

**Path traversal and sibling-directory access are blocked at the server level.** The error message names the blocked path and the current allowlist, so Claude can explain what happened.

### Server details

#### Filesystem server

| Property | Value |
|----------|-------|
| Transport | JSON-RPC 2.0 over stdio |
| Tools | `read_file`, `write_file`, `list_directory`, `search_files`, `delete_file` |
| Location | `~/.claude/mcp-servers/filesystem/index.js` (copied on enable) |
| Config | `~/.claude/mcp-servers/filesystem/allowed-dirs.json` |
| Latency | < 2 ms per call (local stdio, no network) |

#### CLI server

| Property | Value |
|----------|-------|
| Transport | JSON-RPC 2.0 over stdio |
| Tools | `list_available_clis`, `run_command` |
| Location | `~/.claude/mcp-servers/cli/index.js` (copied on enable) |
| Config | `~/.claude/mcp-servers/cli/cli-config.json` (allow-list, timeout, workspace log path) |
| Default timeout | 5 min per call (configurable up to 30 min) |
| Output cap | 512 KB per stream (stdout / stderr independently) |

Both servers are bundled in the extension under `extension/resources/mcp-servers/` and copied to `~/.claude/mcp-servers/` on enable â€” no npm install or external dependency required.

**Building or debugging a bundled MCP server?** See the `mcp-server-creation` skill in `skills_library/` for the full pattern, including the two bugs that always appear (premature exit on stdin EOF, missing content envelope) and a PowerShell test harness.

### MCP usage log and waste detection

Every tool call is appended to `~/.claude/learning/mcp-usage.jsonl`. Each entry carries a `sessionId` generated when the agent connects â€” a 12-character UUID that rotates on each new conversation:

```json
{"ts":"2026-06-16T12:00:00Z","tool":"read_file","path":"/src/main.tf","durationMs":23,"bytes":4200,"sessionId":"a1b2c3d4e5f6"}
{"ts":"2026-06-16T12:00:05Z","tool":"write_file","path":"/src/out.tf","durationMs":41,"bytes":1800,"contentHash":"a3f1b2c4","skipped":false,"sessionId":"a1b2c3d4e5f6"}
```

The extension's **Cost Intelligence Dashboard** reads this log to surface:

| Detection | Trigger | Output |
|-----------|---------|--------|
| **Repeated reads** | Same file read â‰¥ 3Ã— | Wasted token estimate (file size Ã— redundant reads Ã· 4) |
| **Agent loops** | Same file read â‰¥ 4Ã— in 5 min | Loop warning + wasted tokens |
| **Read-after-write** | `write_file` then `read_file` same path within 60 s | Reminder to reuse written content |
| **Large files** | Any `read_file` > 100 KB | Suggestion to use partial reads |
| **No-op writes** | New content = existing content | Write silently skipped; logged as `skipped: true` |

An **efficiency score** (0â€“100, Aâ€“F) is calculated as `(total ops âˆ’ wasteful ops) / total ops` and shown as the headline metric, with a tooltip showing the formula.

### Token quality KPI bar

The efficiency panel includes a stacked bar that makes waste visible at a glance:

```
Useful â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–‘â–‘â–‘â–‘ Wasted
       14.2k tokens       3.8k tokens (21%)  ~$0.011 avoidable
```

A *Potential saving* pill appears when suggestions carry estimated token counts.
When recent session data is available, waste is also shown as a percentage of total API tokens across those sessions.

### Cross-session hot-file analysis

The dashboard groups 30 days of log entries by `sessionId` and reports files that appear in >50% of sessions:

```
Persistently over-read files Â· 30d Â· 12 sessions
  .claude/settings.json    83% of sessions Â· avg 6.2Ã— per session
  src/main.tf              67% of sessions Â· avg 4.1Ã— per session
```

These are global hot spots â€” adding them to `mcp-agent-hints.md` prevents redundant reads across all future sessions, not just the current one.

### Real-time efficiency alerts

The extension evaluates MCP efficiency on each workspace-state refresh and shows a notification when thresholds are crossed:

| Condition | Severity | Notification type |
|-----------|----------|-------------------|
| Efficiency < 40% **or** agent loop + > 5 k wasted tokens | Critical | `showWarningMessage` |
| Efficiency 40â€“60% | Warning | `showInformationMessage` |
| < 1 000 MCP tokens total | â€” | Silent (too small to be meaningful) |

Each distinct issue type (`loop`, `high-waste`, `low-efficiency`) fires **at most once per agent session** (keyed by `sessionId`) so different problems each surface without spam, and the same problem does not repeat mid-session.

Alert action buttons:

- **View Details** â€” opens the Cost Intelligence dashboard.
- **Auto-optimize** â€” writes `mcp-agent-hints.md` immediately with current patterns documented; shows a confirmation with the issue count.
- **Dismiss** â€” suppresses for this session.

### Auto-remediation hints file

After each analysis the extension writes `~/.claude/learning/mcp-agent-hints.md` â€” a plain-text file containing agent-readable rules derived from observed patterns:

```markdown
## Files to cache in memory (read repeatedly â€” do not re-read)
- `/src/main.tf` â€” read 8Ã—, ~2400 tokens wasted

## Detected reasoning loops
- `/src/config.yaml` â€” read 6Ã— in 5min
â†’ Rule: analyze once, store the result. Do not re-read to verify.

## General rules (always apply)
- Do not call list_directory on the same path more than once per session
- After write_file, reuse the content you already have
```

Add a reference to this file in your `CLAUDE.md` or as a skill instruction to give all agents cross-session optimization guidance automatically.

---

## What this tool does NOT do

- SKILL.md lint is advisory by default (`claudeSkills.lint.blockSyncOnError` to hard-block) â€” covers the `.claude/skills` source of truth plus Cursor/Kiro SKILL.md mirrors and Copilot `.instructions.md` mirror presence.
- **Cost and ROI are estimates** â€” confidence scores express uncertainty; not billing-grade without pricing overrides + invoice reconciliation.
- Community benchmark upload requires you to configure endpoints (no default public server).
- PR comments require GitHub CLI and explicit feature enable.
- Copilot clones are instruction files, not native Copilot skills.
- **Cost by skill owner** attributes to who committed `SKILL.md`, not who ran the agent.

## Performance & compatibility

See root [README.md](../README.md#performance-impact) and [CHANGELOG.md](../CHANGELOG.md).

## Development

```powershell
npm install
npm run sync-skills   # copy ../skills_library -> ./skills_library
npm run compile       # or: npm run watch
npm test              # unit tests (vitest)
npm run test:integration   # VS Code host smoke test (@vscode/test-electron)
npm run bench:complete     # extension stack + CI/ADX complex harness (see scripts/COMPLETE-BENCHMARK-GUIDE.md)
npm run bench:hotpaths     # hot-path timings only (dashboard, sync, pipeline)
npm run bench:skill-impact # live Claude CLI token/cost A/B (with vs without skills)
npm run bench:smoke-installed  # hot-path smoke against installed VSIX
npm run test:all      # unit + integration
```

Press `F5` in VS Code (with this folder open) to launch an Extension
Development Host.

## Packaging

```powershell
npm run package   # runs sync-skills, then `vsce package` (requires @vscode/vsce)
```

Produces a `.vsix` named `{name}-{version}.vsix` (e.g. `claude-skill-deployer-1.0.20.vsix`).

Remove stale `.vsix` files in `extension/` before publishing â€” old packages with different names can confuse manual publish scripts.

## Publishing

Publish to **Visual Studio Marketplace** (VS Code) and **Open VSX** (Cursor + Kiro IDE). See **[PUBLISHING.md](PUBLISHING.md)** for tokens, GitHub Actions, and release steps.

```powershell
npm run package
$env:VSCE_PAT = "<azure-devops-pat>"
$env:OVSX_PAT = "<open-vsx-pat>"
npm run publish:all    # marketplace + Open VSX
```

| Script | Registry | IDEs | Listing |
|--------|----------|------|---------|
| `npm run publish:marketplace` | [Claude Skills Manager â€” VS Marketplace](https://marketplace.visualstudio.com/items?itemName=SerhiiVoinolovych.claude-skill-deployer&ssr=false#version-history) | VS Code | â†” [Open VSX](https://open-vsx.org/extension/serhiivoinolovych/claude-skill-deployer) |
| `npm run publish:openvsx` | [Claude Skills Manager â€” Open VSX](https://open-vsx.org/extension/serhiivoinolovych/claude-skill-deployer) | Cursor, Kiro, VSCodium | â†” [VS Marketplace](https://marketplace.visualstudio.com/items?itemName=SerhiiVoinolovych.claude-skill-deployer&ssr=false#version-history) |
