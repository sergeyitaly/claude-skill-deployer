# Changelog

All notable changes to **Claude Skills Manager** (VS Code extension) are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Consolidated release line starts at **1.0.1** (2026-06-12). **1.0.77** is the current Marketplace publish target.

## How to read this log

Each release includes:

- **Summary** â€” what changed for *you* in one line
- **Theme** â€” the strategic wave that release belongs to
- **Highlights** â€” demo-friendly bullets (when the release is substantial)
- **Behavior changes** â€” things that may change what you see day-to-day

### Product evolution (release waves)

| Versions | Theme |
|----------|--------|
| **1.0.139** | Session summary — the telemetry pipeline (`runs.jsonl`) genuinely works but had zero proactive visibility outside a dashboard nobody opens mid-session; adds a once-per-session usage summary toast, independent of `kpiAlert.ts`'s problem-only alerts |
| **1.0.138** | Custom MCP servers, and a silent feature made honest — "Manage MCP Servers" only ever handled two hardcoded built-ins; adds a generic add/remove flow for any server, across Claude/Cursor/Kiro. Also found and fixed: model-tier routing has fired on every prompt since it was built (44 real decisions in this repo alone) asking the agent to "silently" switch models — a mechanism that doesn't exist — and defaulted to placeholder model names like `"planning"` instead of real ones |
| **1.0.137** | Agent debuggability — an agent driving this extension can't click VS Code's UI, which made every live test this project's own reliability work needed require a human round-trip; adds an output-log file mirror, a full-state-dump debug command, and a cache/throttle-bypassing force-refresh debug command, closing that gap for future sessions |
| **1.0.136** | Budget/task-focus coupling visibility — a static audit (not live-verified like 1.0.129-135, but grounded in real code paths) found budget's threshold auto-disable was a silent, undocumented no-op whenever task focus was off; now surfaced in the output log and both settings' descriptions |
| **1.0.135** | MCP-Force health check, part 2 — live-testing 1.0.134 against a brand-new workspace with no MCP activity of its own found it still refused; a workspace that's only ever had extension commands run in it (not an agent chat session) generates no usage log at all, so the check now also accepts proof from any other workspace the server has ever served |
| **1.0.134** | MCP-Force health check — "Enable MCP-Force Mode" refused to enable with "MCP server has not been used yet" on every workspace, regardless of real usage, because its activity check read a global log file that nothing has ever actually written real entries to; now also checks the workspace's own (real) usage log |
| **1.0.133** | Reliability — live-verifying 1.0.132's CLAUDE.md parity feature in a real "settled" workspace found it never actually ran: the sync call was nested inside task-focus's own re-apply gate, so once a workspace stopped needing re-assignment, CLAUDE.md silently stopped syncing too; moved to run unconditionally |
| **1.0.132** | CLAUDE.md parity — Claude Code was the only one of the four supported agents with no auto-maintained project-instructions file; it now gets an installed-skills summary in CLAUDE.md unconditionally, independent of MCP-Force Mode, matching what Copilot's `copilot-instructions.md` already provided |
| **1.0.131** | Benchmark fixes — a live practical benchmark against a synthetic Terraform/Azure/AKS/GitHub-Actions repo found "Install Relevant Skills for Workspace" installing 8 skills that match literally every project (`detect_globs: ["**/*"]`), and task focus never pruning them because its re-sync guard only reacted to proposal regeneration, not installed-set drift |
| **1.0.130** | Release process — the published 1.0.129 package was built before its own CLAUDE.md-repair fix landed in source, so that fix shipped as a version-number claim with no code behind it; this release actually contains it, and documents the packaging gap |
| **1.0.129** | Dogfooding fixes — MCP-Force Mode was leaky on Windows (PowerShell missing from the deny list) and could permanently skip repairing a missing CLAUDE.md; task focus could silently disable an in-use skill mid-session with no visible notice |
| **1.0.128** | Test coverage — the 1.0.127 fixes shipped with no automated tests; added real regression tests for both, and hardened the test harness after it was found writing into the developer's actual global skills directory |
| **1.0.127** | Learning & routing intelligence, part 2 — live-runtime verification of 1.0.126 found enrichment auto-apply silently rewrote SKILL.md by default with no confirmation, and the new ignored/rejected funnel split never actually recorded an ignored event; both fixed |
| **1.0.126** | Learning & routing intelligence — automatic enrichment, durable learning artifacts, clearer adoption outcomes, and prompt-aware model tiers |
| **1.0.125** | Recommendation trust & attribution reliability — generic repository files score weakly, and Claude VS Code hook gaps no longer retire valid skills |
| **1.0.124** | Recommendation precision, part 2 — the 1.0.123 generic-filename fix covered two extension-publishing skills but missed `deployment-practical`, whose `detect_globs` still included `**/README.md` and `**/.github/workflows/*.yml`; live telemetry showed it proposed 6 times in a row with 0% acceptance in a repo with zero Docker/Terraform/Azure evidence |
| **1.0.123** | Recommendation precision — a live workspace's real proposal history caught `globSpecificityScore()` scoring near-universal filenames (`package.json`, `CHANGELOG.md`, `README.md`) as strongly as a targeted path glob, pushing two unrelated extension-publishing skills to 83-87% confidence in a pure Kubernetes/Terraform repo |
| **1.0.122** | Simplification — four more dead/legacy features removed (Onboarding Tour, two no-op feature flags, orphaned weekly-report/tier-benefit scripts) plus README documentation drift left behind by v1.0.82's earlier, incomplete removal of the weekly-report email subsystem |
| **1.0.121** | Simplification — the Compliance Audit Framework (shipped 1.0.109) is removed entirely: its dashboard panel was the last of ~15 collapsed sections at the bottom of the Cost Dashboard, and 2 of its 5 compliance checks were permanently red for typical solo use regardless of actual project health |
| **1.0.120** | Workspace isolation — five places skill-affecting state (MCP filesystem allowed-dirs, emergency cost cutoff, budget spend tracking, branch-profile saves, CLI usage attribution) was stored or computed machine-wide instead of per-project, so one project's activity could silently affect another's; all five are now correctly scoped |
| **1.0.119** | Task-focus reliability, part 4 — live-runtime verification of 1.0.117's reclaim migration found it could report success while a completely different, ungated code path (`applyBranchProfile()`'s saved-profile-override reapply) silently undid it moments later, permanently losing the retry window; closes both the missing gate and the missing persistence check |
| **1.0.118** | Emergency cutoff visibility — a real cutoff on the dev machine was found still silently disabling 17 skills 32 days after triggering, with zero ongoing visibility since the one-time trigger dialog; adds a recurring SessionStart reminder (no auto-expiry, by design) |
| **1.0.117** | Task-focus reliability, part 3 — live-runtime verification of 1.0.116 found that stale "off" overrides from before the fix (or from a second untracked writer) could survive forever, since the only bookkeeping (`ignoredSkills`) can go stale independent of the overrides it describes; adds a durable ledger and an audited one-time migration |
| **1.0.116** | Task-focus reliability, part 2 — live-runtime verification of 1.0.115 found a second, deeper force-disable path (`applyBranchProfile()`'s branch-committed-skill sweep) that never checked `taskFocus.enabled` at all, plus wired up the dead `clearTaskSkillFocus()` cleanup function |
| **1.0.115** | Task-focus reliability — the one `applyTaskSkillFocus()` call site that bypassed `taskFocus.enabled` is fixed, budget-tier gating no longer disables skills using a frozen active-set snapshot, and SessionStart now actually applies + explains skill focus instead of a dead hook route doing nothing |
| **1.0.114** | Recommendation & enrichment visibility — skill recommendations now reach SessionStart and prompt-time hints instead of only ever landing in task-skill-proposals.json; approved-but-unapplied enrichments get a reminder + notification; fixed a dedup bug that let applied enrichments get re-proposed |
| **1.0.113** | Dashboard trust audit — fixed 3 hardcoded fake KPIs, a %/x ROI unit mislabel, an uncapped funnel percentage (live 1150% bug), and collapsed 4 conflicting Precision/Recall/F1 implementations into 1 canonical source |
| **1.0.112** | Reliability — fixed a false-positive in the attribution equal-split detector that pinned `attribution.status` to "broken" on accurate per-skill cost data |
| **1.0.111** | Reliability — task focus / task drift feature flags now honor their settings, task-drift re-proposal reacts to new tool calls, hook-server stale-port self-healing extended to all hook categories |
| **1.0.110** | Simplification — legacy Context Efficiency feature (analysis engine, advisor, commands, dashboard panel) removed; superseded by the Compliance Audit Framework and Workspace Intelligence systems |
| **1.0.109** | Compliance Audit Framework — automated and manual audit execution, background scheduler with cron trigger, HTML reporting with compliance checklist, 5 new audit modules (execution, scheduling, status bar UI, command registry, HTML generation), full integration with cost-attribution system |
| **1.0.108** | Workspace Intelligence v1 — workspace affinity engine, session bootstrap & update advisor, recommendation boost breakdown, skill lifecycle prioritization, safe auto-upgrade with rollback, 2 new dashboard panels, 5 new audit checks |
| **1.0.107** | Telemetry Integrity Audit Framework — 6-check validation pipeline, cost attribution verification, HACE formula validation, coaching decay loop analysis, recommendation engine testing, and comprehensive audit reporting |
| **1.0.106** | Skill Adoption Intelligence v1 — Delivery Summary — Phase 10 tests, full funnel e2e, architecture wired end-to-end |
| **1.0.105** | Skill Adoption Intelligence v1 + Skill Enrichment Intelligence v1 — adoption event funnel, precision/recall/F1, telemetry-mined SKILL.md proposals, staleness detection, recommendation boosting |
| **1.0.104** | Learning Dashboard — live server toggle, dynamic review.html, skill-profile mapping fixes |
| **1.0.103** | Telemetry quality — coaching decay fix, rejection staleness guard, normPath Windows fix, advisor log ordering, enrichment patterns, HACE 2.0 docs |
| **1.0.99** | Adoption Intelligence hardening — dormancy-aware proposals TTL, 30 unit tests |
| **1.0.98** | Adoption Intelligence v1 — prompt signal gating, keyword inflation fix, penalty engine |
| **1.0.95** | Bug fixes — SonarQube S3776 x5, OPPORTUNITY_SIGNALS dedup, dormant comment fix |
| **1.0.94** | Skill Adoption System v2 — dormancy suppression, trust repair, Adoption Coach |
| **1.0.87** | Learning loop unblocked — runs.jsonl populates from MCP reads; General API cost corrected to per-type rates |
| **1.0.86** | Quality audit — 6 critical bugs fixed, attribution score accurate, prediction noise eliminated, adaptation log wired |
| **1.0.85** | v1.1 UX Modernization — 3-bar status, Executive Summary, Learning Timeline, Prediction Intelligence, Feature Modes |
| **1.0.84** | Production readiness — attribution fix, proposal history boost, API Score, cost hooks auto-on, audit export |
| **1.0.83** | Quality — Windows CRLF fix, stop-word proposal filter, skill library cleanup, 2 new skills |
| **1.0.82** | Simplification wave 2 — 16 TS files deleted, 9 JS hooks removed, 22 settings removed |
| **1.0.81** | Simplification wave 1 — ~50% code surface reduction |
| **1.0.77** | Bug fixes â€” archiveSkill Windows EPERM, terminal-watch CLI name extraction for chained commands |
| **1.0.76** | Native bash telemetry â€” terminal-watch hook, auto-registration, Azure E2E benchmark, telemetry dashboard |
| **1.0.75** | CLI KPI Phase 1 â€” success rate, retry count, P50/P95 duration, recovery rate across all CLI MCP calls |
| **1.0.74** | QA audit hardening â€” binary file guard, skill lifecycle pipeline, security test suite, 24 new tests |
| **1.0.73** | PostToolUse native tool logging â€” run_task, run_in_terminal, and all IDE tools now tracked in mcp-usage.jsonl |
| **1.0.72** | MCP server v1.2 â€” edit_file, session caches, auto-fix hints, and scoring accuracy |
| **1.0.71** | Self-correcting large-file guard â€” enforced hook escalation, atomic writes, CLAUDE.md lock |
| **1.0.70** | MCP filesystem error guard â€” self-correcting hooks extend to all MCP tool failures |
| **1.0.69** | Adaptive agent loop â€” self-correcting hooks, session memory, dir-cache guard |
| **1.0.68** | CLI MCP server auto-start, status bar, and health dialog |
| **1.0.65** | MCP health monitoring, Force Mode & proxy auto-migration |
| **1.0.64** | Hybrid per-project MCP telemetry storage |
| **1.0.61 â€“ 1.0.63** | MCP filesystem server, efficiency metrics & KPI alerts |
| **1.0.38 â€“ 1.0.60** | Project tiering, cost optimization & tier cleanup |
| **1.0.34 â€“ 1.0.35** | Dashboard & cache performance |
| **1.0.30 â€“ 1.0.33** | Sync engine stability & concurrency |
| **1.0.36** | Security hardening |
| **1.0.37** | Benchmarks & release quality |
| **1.0.17 â€“ 1.0.29** | Cost intelligence, multi-agent, CLI headless |
| **1.0.0 â€“ 1.0.16** | Foundation â€” skills, agents, profile init |

---

## [1.0.139] - 2026-08-10

**Summary:** Real dogfooding in a different project (not this repo) found that the extension's hook-based telemetry pipeline — the thing that actually records skill invocations, cost, and success/failure into `runs.jsonl` — genuinely works and had real numbers in it the whole time, but never once surfaced any of that during the session that generated them, because the only place to see it was a dashboard nobody opened mid-session. Added a quiet, once-per-session summary toast so a routine, healthy session gets *some* proactive visibility, not just `kpiAlert.ts`'s existing "something went wrong" alerts.

**Theme:** Closing the last "technically works, zero visible effect" gap found this cycle — same root pattern as 1.0.115/1.0.129/1.0.134/1.0.136 (feature runs, nothing observable happens), this time in the telemetry layer itself rather than in gating logic.

### Added

- **One-time, end-of-session usage summary toast.** New `maybeNotifySessionSummary()` in `hookHandlers.ts`, fired from the `session-stop` handler after the existing adoption-outcome bookkeeping. When a session recorded at least 3 skill invocations, shows a toast with invocation count, success rate, total cost, and the top 3 skills used, with a "Show Usage Report" button that opens the existing dashboard command. Capped at once per session (in-memory `Set` keyed by session ID) and gated by new setting `claudeSkills.sessionSummary.enabled` (default `true`). Deliberately bypasses the usual `notifyBackground()`/`claudeSkills.notificationLevel` quiet-by-default gate — that gate defaults to `"minimal"` and would otherwise suppress this the same way it silently suppressed task-focus disables, budget gating, and model-routing suggestions earlier this cycle; the once-per-session cap is what keeps this from reintroducing that noise. 3 new tests in `hookHandlers.test.ts`.

---

## [1.0.138] - 2026-07-17

**Summary:** Researching "could the extension help configure new MCP servers, or silently switch models per task stage" for its own future usefulness found: the first genuinely didn't exist (only two hardcoded servers were manageable); the second already existed, has been running on every single prompt since it was built, and — as far as could be determined — has never once actually worked. Both fixed.

**Theme:** Two research findings acted on immediately, not deferred to a backlog — one net-new capability, one honesty fix for a feature that looked complete but wasn't.

### Added

- **Generic custom MCP server registration.** New `customMcpServers.ts`, kept deliberately separate from `mcpOfficial.ts`'s hardened, load-bearing filesystem-server path rather than generalizing it in place. `claudeSkills.addCustomMcpServer` prompts for name/command/args and writes the entry into Claude/Cursor/Kiro's own config files (Copilot excluded — it only reads `contributes.mcpServers` from `package.json` at install time, so a runtime write can never reach it). `claudeSkills.manageMcpServers`'s QuickPick now lists every custom server alongside the filesystem toggle, click one to remove it. A small registry (`~/.claude/mcp-servers/custom-servers.json`) tracks what this extension added, distinct from anything the user configured by hand. 7 new tests in `customMcpServers.test.ts`.

### Fixed

- **Model-tier routing asked the agent to do something no hook mechanism can do, on every single prompt, with the wrong model names.** `modelRoutingContext()` (`modelRouting.ts`) injected a hidden `UserPromptSubmit` context block on every prompt telling the agent to "use this tier silently when model selection is available" — there is no hook-level API for changing which model runs a session, so this instruction was unactionable by design. Confirmed live: this repo's own `.claude/learning/model-routing.jsonl` had 44 real recorded decisions, all presumably inert. Separately, `claudeSkills.modelRouting.{fast,balanced,reasoning,planning}` defaulted to the literal tier name (e.g. `"planning"`) instead of a real model identifier — even a perfectly-actionable suggestion would have named a nonexistent model. Both fixed: the four settings now default to real model IDs (`claude-haiku-4-5-20251001` / `claude-sonnet-5` / `claude-opus-4-8` / `claude-opus-4-8`), and `modelRoutingContext()` now only surfaces text for the tiers where model choice plausibly matters (reasoning/planning) at high confidence (≥85%), phrased as a one-time, human-actionable suggestion to mention to the user — not an instruction to self-switch. Every decision is still recorded to the log regardless of whether anything is surfaced. 4 new regression tests in `modelRouting.test.ts`.

---

## [1.0.137] - 2026-07-17

**Summary:** Every live test this whole reliability effort has run (1.0.129 through 1.0.136) needed a human to click through VS Code's UI and report back, because the agent driving the work has no way to invoke commands or read output itself. Added three things to close that: an output-log file mirror, a full-state-dump debug command, and a debug command that clears the refresh-loop's caches/throttles for a deterministic re-run. Also found, while auditing for missing notification-log wiring, that `claudeSkills.features.autoOptimizer` — a real, documented, tier-defaulted-on feature — has no code path that ever calls its own entry point; see "Known gaps" below.

**Theme:** Agent debuggability — infrastructure for the extension-devops-growth playbook, not a bug fix.

### Added

- **The "Claude Skills" output channel now mirrors to `.claude/learning/extension-output.log`.** `log()` (`extension.ts`) previously only called `outputChannel.appendLine()`, with no durable form — every debugging exchange this session that needed real output content required a manual copy-paste. Same content, also written to disk now, size-capped at 2MB (oldest half dropped) matching `mcpUsageLog.ts`'s existing convention.
- **New command: "Debug: Dump Full State to File"** (`claudeSkills.debugDumpState`, new `commandsDebug.ts`). Writes MCP health, Force Mode status, task-focus active/ignored skills, budget config and usage, and installed-skill count to `.claude/learning/debug-state-dump.json` in one shot — previously this required cross-referencing `task-active-skills.json`, `settings.local.json`, `mcp-usage.jsonl`, and `allowed-dirs.json` by hand, which this whole session's benchmarking did repeatedly.
- **New command: "Debug: Force Full Refresh (Clear Caches)"** (`claudeSkills.debugForceFullRefresh`). Clears `skillOps.ts`'s stack-detection cache and the refresh-loop's in-memory throttle/dedup timers (`lastWorkspaceStateAt`, `lastCostDisciplineLogged`), then immediately re-runs a full workspace-state refresh. Previously, testing a fix meant waiting on a cache TTL or reloading the whole window as a workaround — both happened this session.
- **`maybePromptHighUsageSkillProposals()`'s (`skillProposalAlert.ts`) install-confirmation toast now logs.** Found during the same audit that motivated the two items above — it called `notifyBackground()` with no `log` argument, so accepting the high-usage-alert prompt never left a trace anywhere.

### Known gaps (not fixed this release — flagged for a deliberate decision, not a silent patch)

- **`claudeSkills.features.autoOptimizer` has no code path that ever invokes it.** `runAutoOptimizePass()` (`autoOptimizer.ts`) is fully implemented — feature-flag check, safety caps, notifications — but is never called from anywhere in the codebase (confirmed by exhaustive reference search). `projectProfile.ts` defaults this feature to **on** for the `team-multi-agent` and `budget-sensitive` tiers, meaning those users see "Auto-optimizer: on" in their feature status with a feature that can never actually do anything. Not fixed here because wiring up a real periodic timer that auto-disables/archives/upgrades skills without per-action confirmation is a real behavioral decision, not a mechanical fix.
- Two more `notifySuggestion()` call sites without a `log` option remain: `notifyApprovedEnrichmentsToast()` and `notifyEmergencyCutoffToast()` (`hookHandlers.ts`) — both real, reachable, hook-triggered notifications. Not threaded through this release given `hookHandlers.ts`'s size and its role as a hot path for every tool-use hook; worth a dedicated pass.

---

## [1.0.136] - 2026-07-17

**Summary:** A static-code audit of subsystems not yet live-tested (budget gating, branch profiles, cost dashboard, adoption funnel — using the same "look for the shape of the six bugs already found today" method, applied without live VS Code driving) found `claudeSkills.budget.autoDisableHighTier`'s threshold auto-disable silently does nothing whenever `claudeSkills.taskFocus.enabled` is off, with zero signal anywhere that this happened — same shape as the 1.0.129 and 1.0.131 silent-gap bugs. The underlying no-op itself is a deliberate, correct safety choice (without task focus's active-skill tracking there's no reliable way to know which high-tier skills are actually in use, so indiscriminately disabling all of them would be worse) — the bug was that it was completely invisible, not that it happened.

**Theme:** Reliability — extends today's "silent gap" pattern-matching to a subsystem this session hadn't live-tested yet, per the extension-devops-growth playbook's backlog item #3.

### Fixed

- **Budget tier gating's task-focus dependency was undocumented and gave zero signal when it silently no-op'd.** `applyBudgetTierGating()` (`budgetTierGating.ts`) returns `{ disabled: [] }` with no `reason` when `taskSkillFocusEnabled()` is false — correct behavior, but neither `claudeSkills.budget.autoDisableHighTier`'s nor `claudeSkills.taskFocus.enabled`'s description mentioned the coupling, and the caller (`costDiscipline.ts` → `extension.ts`) only ever logs when `budgetDisabled.length > 0`, so this specific skip reached neither the output channel nor any setting description. Now: the function reports `reason: "task-focus-disabled"` — but only when spend is actually at/above the warn threshold (i.e. only when the gate would have mattered, not on every routine refresh for the common, valid case of task focus off + low spend); `extension.ts` logs a specific message for that reason; both settings' descriptions in `package.json` now cross-reference each other. `budgetTierGating.test.ts` gained two regression tests: one confirming the reason fires above the warn threshold, one confirming it stays silent below it.

---

## [1.0.135] - 2026-07-17

**Summary:** Live-testing 1.0.134's fix against `benchmark-devops-project` — a real workspace that had only ever had extension commands run in it via the Command Palette, never an actual agent chat session using MCP tools — found "Enable MCP-Force Mode" still refused. That workspace's own `<target>/.claude/mcp-usage.jsonl` genuinely doesn't exist yet, because MCP tool-call activity is only ever recorded when an agent uses the tools, not when the extension's own commands run. Fixed by also accepting proof from any other workspace the machine's MCP server has ever served.

**Theme:** MCP-Force health check, part 2 — closes the gap 1.0.134 didn't: a genuinely brand-new workspace has no history of its own to check yet, which isn't the same as the server being broken.

### Fixed

- **A brand-new workspace with no MCP activity of its own still failed the health check, even with 1.0.134's per-workspace fix.** `checkMcpHealth(target)` correctly checks `<target>/.claude/mcp-usage.jsonl` now, but a workspace that's only ever had extension commands run against it (install skills, refresh, etc. — none of which are MCP tool calls) has no such file at all; only an actual agent chat session using `mcp__filesystem__*` tools generates entries. Requiring *this exact folder* to have proven the server works first is a chicken-and-egg problem for every new project. `allowed-dirs.json` (`~/.claude/mcp-servers/filesystem/`) already lists every workspace this machine's MCP server has ever been registered for — `checkMcpHealth()` now falls back to checking each of those for recent activity when the target's own log has none, treating proof from *any* of them as sufficient evidence the server itself works. Deliberately doesn't change what `mcpCallsLast24h`/`lastActivityTime` report (still scoped to the current workspace only) — only `hasActivity`/`status`, so the status bar's displayed numbers don't get a confusing count blended in from an unrelated project. `mcpHealth.test.ts` gained a regression test for exactly this: a brand-new workspace with zero activity reports `"ready"` because a different allowed directory has real recent entries, while `mcpCallsLast24h` for the new workspace correctly stays `0`.

---

## [1.0.134] - 2026-07-17

**Summary:** Trying to run "Claude Skills: Enable MCP-Force Mode" against a real workspace, after both extensive real MCP filesystem usage that session and a brand-new benchmark workspace, refused every time with "MCP server has not been used yet and cannot be verified as working." Traced to the health check's activity gate reading a log file that nothing in the codebase actually writes real entries to. Fixed.

**Theme:** MCP-Force health check — this gate has likely been silently broken for every user on every machine since it was written; nothing about it is workspace-specific.

### Fixed

- **`checkMcpHealth()`'s activity check read a global log that is never populated with real usage.** `MCP_USAGE_LOG_PATH` (`~/.claude/learning/mcp-usage.jsonl`) is the *only* thing `readMcpUsageLog()` defaulted to when called with no argument, and the only code in the entire codebase that ever writes to that exact path is `clearMcpLogs()` — which truncates it to empty. Real tool-call activity has only ever been recorded per-workspace, in `<target>/.claude/mcp-usage.jsonl` (confirmed live: this repo's own workspace log had 8,427 real entries at the time the global log was sitting at 0 bytes). Since `enableMcpForcePermissions()`/`injectMcpForceClaude()`/the auto-enable-on-startup path/the watchdog/the status bar all called `checkMcpHealth()` with no target, `hasActivity` was structurally guaranteed to be `false` forever, regardless of real usage — meaning "Enable MCP-Force Mode" could never actually succeed anywhere, for anyone, unless someone bypassed it by hand-editing `permissions.deny` directly (which is exactly how force mode got enabled in this session's own `verify-mcpforce-ws` test workspace, sidestepping the bug without realizing it). `checkMcpHealth()` now takes an optional `target` and also checks that workspace's own usage log; all 5 call sites (`mcpForce.ts` ×2, `mcpForceWatchdog.ts`, `commandsMcp.ts`, `mcpStatusBars.ts`) now pass the workspace target they already had in scope. `mcpHealth.test.ts` gained a regression test proving `checkMcpHealth()` reports `"no-activity"` without a target and `"ready"` with one, from the exact same (real) workspace-log data.

---

## [1.0.133] - 2026-07-17

**Summary:** Live-verifying 1.0.132's CLAUDE.md parity feature against a real workspace that had already settled (no pending task-focus re-assignment) found `CLAUDE.md` still wasn't being created. Traced to a placement bug: the sync call never actually ran for a settled workspace. Fixed by moving it out of task-focus's own re-apply gate.

**Theme:** Reliability — same pattern as 1.0.129→1.0.130 (a version number claiming a fix the code path didn't actually reach); caught by re-testing against the exact real workspace the feature was built for, not a fresh one.

### Fixed

- **`syncClaudeBootstrap()` was nested inside `applyTaskSkillFocusFromProposals()`'s own early-return guard, so it only ran when task focus itself decided something needed re-applying.** Once a workspace's `task-active-skills.json` state matched the current proposals and nothing was installed-drifted (exactly the state the benchmark workspace was left in after the 1.0.131 fixes), `applyTaskSkillFocusFromProposals()` returned `{ applied: false }` at its very first opportunity — before ever reaching the `syncClaudeBootstrap()` call added in 1.0.132. `CLAUDE.md` syncing has nothing to do with whether task-focus's active/ignored assignment changed; it only depends on `listEffectiveEnabledSkills()`, which is always computable regardless. Moved the call out of `taskSkillFocus.ts` entirely and into `extension.ts`'s workspace-state refresh loop, called unconditionally right after `applyTaskSkillFocusFromProposals()` regardless of its `applied` result — matching how `syncCopilotBootstrap()`'s sibling call already behaves in the same refresh cycle.

---

## [1.0.132] - 2026-07-17

**Summary:** Asked directly why `CLAUDE.md` wasn't appearing in a workspace that never enabled MCP-Force Mode, investigation found the honest answer ("that's intentional — Force Mode is the only thing that ever writes it") pointed at a real asymmetry: Copilot gets an auto-maintained project-instructions file (`copilot-instructions.md`) unconditionally, because it has no native skill system and can't use skills without one, while Claude Code — which discovers `.claude/skills/*` natively and needs no such file to function — got nothing at all unless Force Mode happened to be on. Claude now gets a CLAUDE.md installed-skills summary too, purely for documentation/discoverability parity, independent of Force Mode.

**Theme:** CLAUDE.md parity — closes a real gap the CLAUDE.md-repair work in 1.0.129/1.0.130 didn't touch, since that was about the Force Mode block specifically, not this.

### Added

- **CLAUDE.md now gets an installed-skills summary for every Claude Code workspace, independent of MCP-Force Mode.** New `claudeBootstrap.ts`: `buildClaudeSkillsBootstrapBlock()` renders a markdown table (skill name, `detect_globs`, description) under its own marker pair (`<!-- claude-skills-manager:installed-skills -->`), explicitly noting in its own text that this is documentation only — Claude discovers skills on its own regardless. `syncClaudeSkillsBootstrap()` writes/refreshes the block and is a no-op (doesn't even create `CLAUDE.md`) when there are zero installed skills yet. New `agentOps.ts` function `syncClaudeBootstrap()` mirrors the existing `syncCopilotBootstrap()`'s manifest/`listEffectiveEnabledSkills()` pattern, and is wired into `taskSkillFocus.ts`'s `applyTaskSkillFocusFromProposals()` — deliberately alongside `bootstrapWorkspaceForHostAgent()`, not inside the multi-agent-mirror-gated `propagateCostDisciplineToAgents()`, so a solo Claude-only workspace with Cursor/Kiro/Copilot mirroring entirely disabled still gets its own summary.
- **`mcpForce.ts`'s CLAUDE.md read/write logic is now shared, reusable infrastructure.** The marker-splice-and-atomic-write logic `injectMcpForceClaude()`/`removeMcpForceClaudeBlock()` used inline is now two exported functions, `upsertClaudeMdBlock()`/`removeClaudeMdBlock()`, using the same lock file (`CLAUDE.md.mcpforce.lock`) as before — a pure refactor with zero behavior change (all 26 pre-existing `mcpForce.test.ts` tests pass unchanged). This is what lets the new skills-bootstrap writer safely coexist with a Force Mode block in the same file without either one racing or clobbering the other's write.

### Fixed

- **`syncClaudeBootstrap()` could crash the entire task-focus apply chain on a missing `agents.json`.** `enabledAgents()` throws hard when `libraryDir` has no `agents.json` — `syncCopilotBootstrap()`'s only caller already guards against this, but `syncClaudeBootstrap()`'s new call site didn't, and a real test run (`taskDriftReproposal.test.ts`) caught it immediately. Fixed by adding the same `fs.existsSync` guard directly inside `syncClaudeBootstrap()`, so it's robust regardless of caller.

`claudeBootstrap.test.ts` (new, 6 tests) covers table rendering, pipe-character escaping in descriptions, the zero-entries no-op, block replacement on re-sync without touching surrounding user content, and — the important one — coexistence with an already-present MCP-Force block in the same file.

---

## [1.0.131] - 2026-07-17

**Summary:** A live practical benchmark — a synthetic Terraform+Azure+AKS+GitHub-Actions repo, built solely to test stack detection, task-focus pruning, multi-agent sync, and cost dashboard accuracy — found that "Install Relevant Skills for Workspace" installed 24 skills when only ~6 were genuinely stack-relevant. Traced to two compounding bugs, both fixed. (Multi-agent sync and cost dashboard accuracy passed cleanly in the same benchmark — no changes needed there.)

**Theme:** Benchmark fixes — real usage against a realistic project, not synthetic unit-test fixtures, found both of these.

### Fixed

- **`detectRelevantSkills()` (`skillOps.ts`) had no discount for match-everything globs.** 8 skills' entire `detect_globs` is the literal `["**/*"]` (`brand-guidelines`, `canvas-design`, `claude-api`, `frontend-design`, `mcp-builder`, `theme-factory`, `web-artifacts-builder`, `webapp-testing`), and 2 more (`doc-coauthoring`, `internal-comms`) match on the near-universal `**/*.md` — so all 10 "detected" as relevant for literally any project, including a pure Terraform/Azure/GitHub-Actions repo with nothing design-, doc-, or MCP-related in it. The sibling `task-skill-proposals.json` confidence engine already solved this with a `CATCH_ALL_GLOBS` discount inside `globSpecificityScore()` (added in 1.0.123), but `detectRelevantSkills()` — used by `generateForWorkspace()` ("Install Relevant Skills for Workspace") and every other caller (`agentOps.ts`, `branchSkillBootstrap.ts`, `skillSetResolver.ts`, `usageStats.ts`'s `computeSuggestedSkills`) — never shared it. `CATCH_ALL_GLOBS` is now exported from `skillOps.ts` as the single source of truth (`taskSkillProposals.ts` imports it instead of keeping its own copy), and `detectRelevantSkills()` now requires at least one non-catch-all glob match before treating a skill as relevant. These 10 skills are task/prompt-driven (design requests, MCP-server-building, testing), not stack-detected — they're still installable manually or proposed via prompt content, just no longer force-installed by file-glob stack detection alone. `skillOps.test.ts` gained regression tests against the real bundled manifest confirming `brand-guidelines` is no longer detected for a pure Terraform+GitHub-Actions repo while `terraform-plan-review`/`github-actions-ci` still correctly are.
- **Task focus never pruned skills installed after the last sweep, if proposals hadn't regenerated.** `applyTaskSkillFocusFromProposals()` (`taskSkillFocus.ts`) gated its entire re-sync on `state?.proposalsGeneratedAt === proposals.generatedAt` — if that timestamp was unchanged, it returned `{ applied: false }` unconditionally, even though the *installed skill set* could have grown in the meantime (e.g. from the bug above, or any other out-of-band install). In the benchmark this meant `settings.local.json` had **zero** `skillOverrides` despite 13 of 24 installed skills (54%) being objectively irrelevant — they were neither active nor ignored, just permanent noise. Fixed by also checking whether any installed skill is missing from both the last sweep's `activeSkills` and `ignoredSkills` — re-applying in that case even when the proposals themselves haven't changed. `taskSkillFocus.test.ts` gained two regression tests: one confirming a skill installed after the last sweep gets correctly pruned on the next call with unchanged proposals, one confirming the function still stays a no-op when nothing has actually drifted.

### Notes

- Confirmed during the same benchmark: `CLAUDE.md` is only ever created by MCP-Force Mode (`mcpForce.ts` and its two callers `extension.ts`/`commandsMcp.ts` are the only places in the codebase that reference it) — a workspace that never enables Force Mode correctly has no `CLAUDE.md`. That's intended behavior, not a bug.

---

## [1.0.130] - 2026-07-17

**Summary:** Live-verifying the 1.0.129 CLAUDE.md-repair fix in a scratch workspace found it didn't fire — the installed and published `1.0.129` package was built and shipped ~15 minutes *before* that fix was written to source, so the version number claimed a fix the actual code didn't contain. No code changed in this release; it exists to make the published artifact match what `1.0.129`'s CHANGELOG entry already claimed.

**Theme:** Release process — closes a build/publish-timing gap the 1.0.129 dogfooding pass itself introduced.

### Fixed

- **`1.0.129`'s CLAUDE.md auto-repair fix was documented but not shipped.** The fix to `maybeAutoEnableMcpForce()` (independently checking `isMcpForcePermissionsActive()`/`isMcpForceClaudeMdInjected()` instead of gating both on `isMcpForceActive()`) was made after the `1.0.129` VSIX had already been built, locally installed, and published to Open VSX — confirmed directly by comparing the installed `out/extension.js` (built 18:02) against the source-file edit (18:17). A live test — pre-seeding `permissions.deny` without a `CLAUDE.md`, then opening the workspace fresh — reproduced the old bug exactly (no `CLAUDE.md` created) against that build, proving the gap. This release is a rebuild/republish so the shipped code actually matches the version number and its changelog claim.

---

## [1.0.129] - 2026-07-17

**Summary:** Dogfooding the extension in a real workspace (a k3s-observability/Kong-charts session) surfaced two bugs: MCP-Force Mode didn't actually block all native file access on Windows, and task focus's skill auto-disable had no user-visible signal at all. Verifying the first fix live turned up a third: the auto-enable-on-startup path could skip recreating a missing CLAUDE.md doc block entirely. All three are fixed.

**Theme:** Dogfooding fixes — real usage in another project, not synthetic test cases, found both of these.

### Fixed

- **MCP-Force Mode left PowerShell unblocked on Windows.** `MCP_FORCE_DENY` (`mcpForce.ts`) denied `Bash` but not `PowerShell` — on Windows these are two separate tool names, so enabling Force Mode (`claudeSkills.enableMcpForce`) blocked one shell tool while leaving the other, the primary shell on Windows, completely open. An agent could (and in the reported session, did) fall back to raw `[System.IO.File]::ReadAllText`/`WriteAllText` PowerShell calls for every file edit instead of the mandated `mcp__filesystem__*` tools. That fallback path is exactly what caused two further symptoms in the same session: Windows PowerShell 5.1's `Get-Content`/write-back round-trip silently mangles non-ASCII characters (mojibake), and a delete-then-edit sequence on the same file sometimes failed to persist with no error. `PowerShell` is now included in the deny list (9 tools total) and in the injected `CLAUDE.md` doc block; `mcpForce.test.ts` gained a regression test asserting Force Mode is *not* considered active when `PowerShell` is missing from an otherwise-complete deny list.
- **Task focus could silently switch off a skill you were actively using.** `applyTaskSkillFocusFromProposals()` (`taskSkillFocus.ts`), called on every workspace-state refresh via `extension.ts`, only ever wrote its result to the output-channel log — never a VS Code notification, unlike the sibling task-drift-reproposal path which already calls `notifyBackground()`. A skill in active use could be set to `skillOverrides: "off"` mid-session with zero visible signal; the only way to notice was opening the output channel or catching the Skills tree view change by eye. `extension.ts` now diffs the previously-active skill set against the newly-ignored list on every re-apply and calls `notifyBackground()` naming the specific skill(s) whenever task focus newly disables one that was active, gated by the new `claudeSkills.taskFocus.notifyOnDisable` setting (default `true`).
- **`claudeSkills.mcpForce.enableOnStartup` could permanently skip recreating a missing CLAUDE.md.** `maybeAutoEnableMcpForce()` (`extension.ts`) gated both halves of Force Mode (writing `permissions.deny` and injecting the CLAUDE.md doc block) behind a single check, `isMcpForceActive()` — which only reflects the `permissions.deny` half. If `permissions.deny` was already fully set but `CLAUDE.md` was missing (deleted by hand, or a fresh machine that never pulled the file down from git while workspace-scoped settings synced some other way), the function returned immediately and never called `injectMcpForceClaude()` — the doc mandate silently went stale forever with no self-repair. Found while live-verifying the `PowerShell` deny-list fix above, by reproducing exactly that state in a scratch workspace. Fixed by checking `isMcpForcePermissionsActive()` and `isMcpForceClaudeMdInjected()` independently, so each half is (re)applied only if it's actually missing.

---

## [1.0.128] - 2026-07-17

**Summary:** 1.0.127's two fixes (enrichment auto-apply gating, ignored-funnel wiring) shipped with no automated test coverage — the only verification was a manual live run. This adds real regression tests for both, exercising the actual, unmocked functions against real files on disk rather than re-implementing their logic.

**Theme:** Test coverage — closes the gap left by 1.0.127's fixes, and fixes a hazard the test-writing process itself uncovered.

### Added

- **Real regression tests for the 1.0.127 enrichment auto-apply split.** `autoApplyEnrichmentProposals()` (`commandsEnrichment.ts`) is now exported and covered by `commandsEnrichment.test.ts`, which drives it against a real proposal file and a real SKILL.md on disk: confirms defaults (`autoApprove=true` / `autoApply=false`) approve the proposal without writing to SKILL.md, confirms explicitly enabling `autoApply` does write, and confirms the two gates are independent (`autoApprove=false` leaves nothing for `autoApply=true` to act on).
- **Real regression tests for the ignored-adoption-funnel wiring.** `recordSessionRejectionFeedback()`'s call into `recordIgnoredSkills()` had never actually run in a test — `hookHandlers.test.ts` mocks `recordSessionRejectionFeedback()` out entirely. `proposalOutcomeAdoptionWiring.test.ts` calls the real function and confirms a passively-ignored skill produces a real `"ignored"` event in `skill-adoption.jsonl`, is reflected in `computeAdoptionFunnel().ignored`, never produces a `"rejected"` event, and is idempotent per `(session, skill)` across repeated Stop-hook firings.

### Fixed

- **Test harness could write into the developer's real global skills directory.** `applyEnrichmentProposal()`'s SKILL.md search path includes the real `globalSkillsDir()` (`~/.claude/skills`), which was unmocked in the first draft of `commandsEnrichment.test.ts`. Because the test seeded a proposal for a skill name ("pdf") that happens to exist in the developer's actual global skills directory, running the auto-apply test appended fake enrichment text into the real local `~/.claude/skills/pdf/SKILL.md` twice before this was caught. The file was restored to its original content, and the test now mocks `os.homedir()` to an isolated temp directory so no test in that file can resolve a real path outside its own sandbox.

---

## [1.0.127] - 2026-07-17

**Summary:** Live-runtime verification of 1.0.126 — actually exercising the new code paths through the real hook server and command surface instead of just reading them — surfaced two gaps between what it claimed and what it did: enrichment auto-apply silently rewrote SKILL.md by default with no confirmation, and the new ignored/rejected adoption split never wrote an event to the funnel it was meant to fix. Both are corrected here.

**Theme:** Learning & routing intelligence, part 2 — continues 1.0.126's work with fixes found by running the new code paths rather than reading them.

### Fixed

- **Enrichment auto-apply no longer bypasses manual review by default.** `autoApplyEnrichmentProposals()` (`commandsEnrichment.ts`) auto-approved *and* wrote pending proposals straight into SKILL.md whenever `claudeSkills.enrichment.autoApply` was left at its default (`true`), contradicting `skillEnrichmentProposal.ts`'s own documented safety contract ("this module never modifies SKILL.md automatically... applied ONLY when the user clicks Apply... after an explicit confirmation dialog"). The single setting is now split: `claudeSkills.enrichment.autoApprove` (default `true`) only marks proposals approved — no file write — and `claudeSkills.enrichment.autoApply` (default now `false`) gates the actual SKILL.md write, which stays opt-in. Verified live: seeded a pending proposal and fired the exact command SessionStart triggers — SKILL.md now stays untouched by default, with the proposal landing on `approved` instead of `applied`.
- **Adoption funnel's "ignored" stage is wired up.** 1.0.126 removed `proposalOutcome.ts`'s only call to `skillAdoption.ts`'s `recordRejectedSkills()` (correctly — passive non-use isn't a rejection) but never replaced it with anything, so `computeAdoptionFunnel().ignored` was permanently 0 against real session data even though `recommendation-feedback.jsonl` and `proposalOutcome.jsonl` correctly tracked the same skill as ignored. Added `recordIgnoredSkills()` (mirrors `recordRejectedSkills()`, writes `event: "ignored"`) and called it from `recordSessionRejectionFeedback()`. Verified live: a session with one invoked and one passively-ignored skill now produces a real `ignored` adoption event in `skill-adoption.jsonl`, with no `rejected` event.

---

## [1.0.126] - 2026-07-17

**Summary:** The extension now turns more of its learning signals into useful workspace behavior. Enrichment can apply approved updates automatically, session boundaries refresh durable learning artifacts, passive non-use is separated from explicit rejection, and prompt context can carry a silent model-tier recommendation.

**Theme:** Learning & routing intelligence — connects the self-learning pipeline, adoption metrics, and agent prompt handling into a more reliable workspace loop.

### Added

- **Automatic enrichment on session start.** `commandsEnrichment.ts` can run the enrichment pipeline asynchronously from the official SessionStart hook, auto-approve and apply pending proposals by default, and send one summary notification; `claudeSkills.enrichment.autoApply` and `claudeSkills.enrichment.runOnSessionStart` control the behavior.
- **Durable learning artifacts.** `learningArtifacts.ts` materializes `patterns.md`, `knowledge-cache.md`, and `skill-feedback.jsonl` at session stop, while `dashboardPrecompute.ts` includes learning-file changes in snapshot invalidation so the dashboard does not serve stale intelligence.
- **Prompt-aware model routing.** `modelRouting.ts` classifies prompt scenarios into fast, balanced, reasoning, or planning tiers and records decisions silently; routing settings expose model identifiers without changing the user-facing prompt.

### Changed

- **Adoption outcomes distinguish ignored from rejected.** `proposalOutcome.ts` no longer treats passive non-use as an explicit rejection, and `skillAdoption.ts` exposes an `ignored` funnel stage so penalties and adoption rates reflect actual user feedback more accurately.
- **Skill instruction mirrors stay aligned.** Generated `.github/instructions` content is refreshed with the current skill library, including removal of the retired deployment-practical mirror.

---

## [1.0.125] - 2026-07-17

**Summary:** Recommendation and adoption signals are now more trustworthy in two common edge cases. Near-universal repository files no longer make unrelated skills look highly relevant, and a known Claude VS Code `PostToolUse` attribution gap no longer causes valid skills to be suppressed or marked dormant based on incomplete invocation data.

**Theme:** Recommendation trust & attribution reliability — extends the precision fixes from 1.0.123-1.0.124 while making adoption feedback safer when the host agent cannot reliably emit hook events.

### Fixed

- **Generic repository files no longer look like stack evidence.** `globSpecificityScore()` (`taskSkillProposals.ts`) now assigns low specificity to `package.json`, `README.md`, `CHANGELOG.md`, license files, `.gitignore`, `Makefile`, and `CONTRIBUTING.md`, so those files cannot boost an unrelated skill like a targeted project marker does.
- **Claude VS Code hook gaps no longer retire valid skills.** `confidenceCalibration()` and `getDormantSkills()` (`proposalOutcome.ts`) now detect recent VS Code transcripts with tool use but zero configured `PostToolUse` fires and skip acceptance-based suppression while attribution is unreliable, preventing missing telemetry from being treated as repeated rejection.
- **Added regression coverage for both safeguards.** `taskSkillProposals.test.ts` covers generic-glob scoring, while `proposalOutcome.test.ts` reproduces the Claude VS Code attribution gap and verifies normal suppression still applies when no gap is present.

---

## [1.0.124] - 2026-07-17

**Summary:** A follow-up audit of the recommendation engine — extending 1.0.123's generic-filename fix —
found `deployment-practical` still matching on `**/README.md` and `**/.github/workflows/*.yml`, both
present in nearly every repository regardless of whether it deploys anything. Live telemetry
(`recommendation-feedback.jsonl`, session `d5383429`) showed the skill proposed 6 consecutive times with
a 0% acceptance rate in a repo containing no Dockerfile, Terraform, or Azure configuration whatsoever.

**Theme:** Recommendation precision, part 2 — same root-cause class as 1.0.123 (near-universal filenames
scored as targeted signals), found in a skill 1.0.123's pass didn't cover.

### Fixed

- **`deployment-practical` no longer matches on README/workflow presence alone.** Its `detect_globs` in
  `skills_library/manifest.json` (kept in sync in `extension/skills_library/manifest.json`) dropped
  `**/README.md`, `**/.github/workflows/*.yml`, and `**/.github/workflows/*.yaml`, leaving only genuine
  deployment/IaC signals: `**/*.tf`, `**/*.bicep`, `**/azure.yaml`/`.yml`, `**/Dockerfile`(`.*`),
  `**/docker-compose*.yml`, `**/.gitlab-ci.yml`, `**/azure-pipelines.yml`, `**/.env*`, `**/deployment/**`.
- **Added regression coverage for `detectRelevantSkills()`/`patternMatchesAny()`**
  (`extension/src/skillOps.test.ts`), the first direct unit tests for the glob-matching functions every
  proposal path (`agentOps.ts`, `taskSkillProposals.ts`, `branchSkillBootstrap.ts`, `skillSetResolver.ts`)
  calls through. Tests load the real bundled manifest and assert `deployment-practical` doesn't fire on a
  README+CI-only workspace, and still fires on one with real IaC evidence (`main.tf`, `Dockerfile`).

---

## [1.0.123] - 2026-07-17

**Summary:** A practical usefulness test against a real, 3.5-week-old workspace (33 skills installed, 82 invocations, 775 HACE sessions) found the dashboard's own "Skill Utilization: LOW" and "ROI: LOW" flags had a concrete, reproducible cause: `vscode-extension-publishing` and `cursor-kiro-extension-publishing` were repeatedly proposed at 83-87% confidence — the top of that workspace's entire proposal queue — in a pure Kubernetes/Terraform/Kong infra repo containing no VS Code extension whatsoever, while the skills actually being invoked (`k3s-observability`, `dataviz`, `artifact-design`) went unproposed in the same batch. This release fixes the root cause.

**Theme:** Recommendation precision — a live-workspace-verified fix, in the same spirit as the task-focus reliability passes (1.0.115-1.0.119): a real reproduction, not a hypothetical.

### Fixed

- **`globSpecificityScore()` (`taskSkillProposals.ts`) treated near-universal filenames as strong signals.** The function gave any glob that wasn't a bare `**/*.ext` wildcard the full 20-point "specific" bonus — including `**/package.json` and `**/CHANGELOG.md`, which appear in nearly every software repo regardless of stack. Combined with the +40 base for already-installed skills, that alone reached ~60 points before any affinity/history boosts, which is exactly how two unrelated extension-publishing skills reached 83-87% confidence against a repo with zero VS Code extension code. Added a `GENERIC_REPO_FILES` set (`package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`/`LICENSE.md`/`.txt`, `.gitignore`, `Makefile`, `CONTRIBUTING.md`) that now scores 10 points — the same low tier as a bare extension wildcard — since matching one of these says almost nothing about what a project actually is. This is a general fix: it protects every skill's manifest from the same mistake, not just the two that were caught live.
- **`vscode-extension-publishing` and `cursor-kiro-extension-publishing` manifests (`skills_library/manifest.json`, `extension/skills_library/manifest.json`) still listed `**/package.json`/`**/CHANGELOG.md` as detect globs.** Removed both from each skill — their genuinely distinctive markers (`.vscodeignore`, `vsc-extension-quickstart.md`, `*.vsix`, `src/extension.ts`, `PUBLISHING.md`, `publish-openvsx.js`, `.github/workflows/publish*.yml`, `00-extension-registries.md`) are untouched and still correctly detect real extension projects (including this repo's own `extension/` folder) without false-positiving on unrelated repos that merely have a package.json and a changelog.

Verified against the exact reproduction: a real workspace's `skill-adoption.jsonl` (841 proposed / 70 invoked / 11 accepted — an 8.3% propose→invoke rate) showing these two skills as the two highest-confidence entries in the most recent proposal batch, with zero invocations ever recorded for either. Added `taskSkillProposals.test.ts`: "generic near-universal filename globs score no higher than bare extension globs" — asserts a skill matched only by `package.json`/`CHANGELOG.md` scores identically to one matched only by a bare extension wildcard, and strictly lower than one matched by a genuinely specific path glob. Full suite: 877/877 passing, clean `tsc --noEmit`.

---

## [1.0.122] - 2026-07-16

**Summary:** A README/CHANGELOG audit against the extension's stated core goal (deploy, silently update, and enrich skills via an MCP-log-driven coaching pipeline to save tokens and keep agents task-focused) found four features that no longer earn their keep — one explicitly labeled "Legacy" in the README's own Onboarding table, two feature flags that had never been wired to any real behavior, and a cluster of CLI scripts left behind when the feature they depended on was deleted 40 releases ago. This release removes all four and scrubs the README documentation drift that had accumulated around them.

**Theme:** Simplification — the same kind of full-removal call as 1.0.110/1.0.121, plus closing a documentation gap those earlier removals didn't catch.

### Removed

- **Onboarding Tour (`onboarding.ts`).** The README's own Onboarding & recovery table already labeled `claudeSkills.startOnboardingTour` "Legacy step-by-step toast tour" — a 7-step toast-message walkthrough that duplicated the still-live Setup Wizard (`claudeSkills.startOnboarding` / `onboardingWizard.ts`), including writing the same `claudeSkills.onboardingTourCompleted` globalState key the wizard also sets on its own completion. Deleted `onboarding.ts`, its command registration and import in `commandsMisc.ts`, the dead import in `extension.ts`, and the `claudeSkills.startOnboardingTour` command contribution in `package.json`.
- **`communityBenchmarks` and `prCostEstimate` feature flags.** Both were declared in `featureFlags.ts`, offered in the "Manage Feature Toggles" quick-pick, carried through `projectProfile.ts`'s tier presets (`TIER_FEATURE_KEYS`/`TIER_FEATURE_LABELS`), and documented as real settings/commands in the README — but neither flag was ever read anywhere to gate actual behavior, so toggling either did nothing. The README-documented `Claude Skills: Estimate PR Review Cost` command was never registered in `package.json` at all. Removed both keys end-to-end (`featureFlags.ts`, `featureFlags.test.ts`, `commandsMisc.ts`, `projectProfile.ts`, `package.json`'s settings contributions).
- **Orphaned weekly-report/tier-benefit CLI scripts.** The Weekly Report email subsystem itself (`weeklyReport.ts`, `weeklyReportBenefits.ts`, `vcsReportDelivery.ts`, `tierBenefitBenchmark.ts`) was already deleted from `extension/src` in v1.0.82's simplification wave, but two standalone scripts that `import()` their compiled output at runtime — `scripts/send-weekly-report-cli.mjs` (loads `out/weeklyReport.js`) and `scripts/tier-benefit-benchmark.mjs` (loads `out/tierBenefitBenchmark.js`) — were left behind and would fail immediately if run today. Deleted both scripts, their `npm run send-weekly-report` / `npm run bench:tier-benefits` `package.json` entries, and the stale `scripts/tier-benefit-results/` sample output.
- **README documentation drift from the same v1.0.82 removal, never cleaned up.** `extension/README.md` still carried a full "Weekly benefits report (informative email)" section (SMTP + GitHub/GitLab PAT setup wizard instructions), two Commands-table rows (`Configure Weekly Report Email`, `Send Weekly AI Usage Report`), and three `claudeSkills.weeklyReport.*` settings rows — all describing a feature deleted ~40 releases earlier. The root `README.md` still listed `Claude Skills: Start Onboarding Tour` as a command; swapped for the surviving `Open Setup Wizard`.

Also audited the Cost/FinOps dashboard's ~25 panels (ROI, cost-by-repo/owner, cross-agent savings, efficiency/HACE, adoption/enrichment) against the same bar. None qualify as legacy: every panel checked (e.g. `formatSkillHealthCard` → `skillHealthCard.test.ts`, `formatTeamEconomicsPanelsHtml`'s owner/repo panels) has a live call site and dedicated tests, unlike the dead code removed above — these directly serve the "save tokens" half of the extension's core goal. Left untouched pending a specific consolidation request.

This session's own instructions restrict it to MCP filesystem tools only, so `tsc`/`vitest` could not be run here to confirm — same constraint noted in 1.0.115; run both before shipping.

---

## [1.0.121] - 2026-07-15

**Summary:** The Compliance Audit Framework (shipped in 1.0.109) had drifted into pure overhead: its dashboard panel was the last of roughly 15 collapsed sections at the bottom of the Cost Dashboard, its compliance checklist showed 2 of its 5 checks permanently failing for typical solo use (skill provenance signing and audit-export scheduling — enterprise-governance features nobody casually configures) regardless of actual project health, and a background job re-ran these checks every day for a panel effectively nobody could find. This release removes the framework entirely.

**Theme:** Simplification — the same kind of full-removal call as 1.0.110's Context Efficiency removal, once a feature stops earning the maintenance cost of keeping it running.

### Removed

- **Compliance Audit Framework deleted end-to-end.** `auditExecution.ts` (`AuditExecutor`, its 6-check validation pipeline), `backgroundAuditScheduler.ts` (the daily cron-style re-run), and `auditExportScheduler.ts` (already fully orphaned — nothing in the codebase imported from it) are gone. `extension.ts` no longer initializes the executor or the daily scheduler, and the `claude-skills.runAuditNow` / `claude-skills.viewAuditReport` / `claude-skills.clearAuditHistory` commands (and their `package.json` contributions) are removed. The Cost Dashboard's "Telemetry & Export" panel — `buildGovernancePanelHtml()` and its "Run Compliance Audit" button in `costDashboard.ts` — is gone; the section is now "Export & Maintenance", keeping the genuinely useful CSV export, MCP-hint autofix, and clear-logs actions. The now-unused `"governance"` feature-mode gate is removed from `featureMode.ts`.

Verified: clean `tsc --noEmit`, full suite 876/876 passing (`auditExecution.test.ts`'s 6 tests were removed along with the module they tested; nothing else referenced the removed code).

---

## [1.0.120] - 2026-07-15

**Summary:** A follow-up investigation into "shouldn't automatically-applied skill state be per-project, not machine-wide" — prompted directly by 1.0.119's MCP allowed-dirs fix — found four more instances of the same root problem: state that gates or scopes skill behavior was stored in a single machine-wide file, or computed from spend totaled across every project on the machine, instead of being scoped to the actual workspace it affects. This release fixes all five (including the original MCP allowed-dirs case) together.

**Theme:** Workspace isolation — generalizes the fix pattern first applied to the filesystem MCP server's allowed-dirs to every other place the same mistake was made.

### Fixed

- **Filesystem MCP server's `allowed-dirs.json` was overwritten, not merged, by every project's activation.** `mcpOfficial.ts`'s `writeAllowedDirsConfig()` rewrote the single, machine-wide `~/.claude/mcp-servers/filesystem/allowed-dirs.json` (shared by one filesystem MCP server registered once in `~/.claude.json`/`~/.cursor/mcp.json`/`~/.kiro/settings/mcp.json`) with only the current window's workspace dirs on every activation — opening a second project silently revoked the first project's previously-granted access, even mid-session. Now unions the current workspace's dirs into whatever's already there instead of replacing (the same fix extends to `workspaceLogPath`, previously dropped entirely when a window with no folder open activated after a real project had set it).
- **Emergency Cutoff triggered off spend totaled across every project on the machine, not the project it disabled skills in.** `emergencyCutoff.ts`'s `checkEmergencyCutoff()` used `computeTodayCreditUsage()` — documented as "cost for today... across all projects" — so heavy use in one project could trigger a cutoff that disabled skills in an unrelated one the next time its SessionStart hook ran, with `active`/`disabledSkills`/`priorOverrides` all stored in one global `~/.claude/learning/emergency-state.json`. Confirmed against real data: this project's own emergency-state.json listed 17 disabled skills including generic, cross-project ones (`self-learning`, `file-style-conventions`, `cross-platform-scripting`) unrelated to this project's own usage. Now computes spend via the already-workspace-scoped `computeEnabledAgentsCreditUsage(libraryDir, 1, target)`, and state moves to `<target>/.claude/learning/emergency-state.json`. A one-time legacy-file fallback keeps any cutoff that was already active visible and resettable instead of stranding it.
- **Budget Tier Gating had the same cross-project spend problem, compounded by a stale-write hazard.** `budgetTierGating.ts` read `readTodayCostUsd()` from one global `~/.claude/learning/today-cost.json`, populated by `statusBarManager.ts`'s `refreshCreditStatusBar(target)` — which already computes a properly workspace-scoped cost via `computeEnabledAgentsCreditUsage(..., workspaceTarget)`, then discarded that scoping by writing the result into the shared global snapshot. Whichever project's status bar refreshed last silently overwrote the number every other open project's budget-gating check read next. `readTodayCostUsd` / `writeTodayCostSnapshot` / `remainingDailyBudgetUsd` now all take a `target` and read/write `<target>/.claude/learning/today-cost.json`.
- **`branchProfiles.ts`'s shared store had a real concurrent-write race.** `saveBranchProfile()` — the only writer of the shared `~/.claude/learning/branch-profiles.json` — did a plain read-mutate-write of the entire store (every repo, every branch); if two different projects' extension-host processes saved a branch profile around the same time, the second write's stale read could silently clobber the first project's just-saved entry (the existing atomic-rename write prevents corruption, not this kind of lost update). Added `withBranchProfilesLock()`, a real cross-process mutex via exclusive file creation (`wx`, atomic at the OS level on both Windows and POSIX), with stale-lock recovery (5s) if an owning process crashed or was killed.
- **`mcpCli.ts`'s CLI usage log attributed every call to whichever project last activated the shared MCP server config.** The bundled CLI MCP server is one process registered machine-wide; its `workspaceLogPath` config field was a single value set by whichever project's activation ran most recently, so a `run_command` call made from one project could get logged into a different project's `.claude/mcp-usage.jsonl`. Each call's own `args.cwd` was already captured correctly in the log entry itself — `appendUsageLog()` (`resources/mcp-servers/cli/index.js`) now derives the per-project log path from the call's own `entry.cwd` first, falling back to the configured path only for calls with no cwd of their own.

Verified live and with new regression tests: `mcpOfficial.test.ts` (3 cases — the exact cross-project revocation bug reproduced and fixed, no-duplicate-dirs, `workspaceLogPath` preservation), `emergencyCutoff.test.ts` (2 new cases — a cutoff in one project invisible in another, and the legacy-file fallback), `budgetTierGating.test.ts` (updated for the new signature), and a new `branchProfilesLock.test.ts` (4 cases, including a genuine cross-process release test via a spawned child process, and a stale-lock-steal test). Full suite: 882/882 passing, clean `tsc --noEmit`.

---

## [1.0.119] - 2026-07-15

**Summary:** A live-runtime verification pass of 1.0.117's reclaim migration found it could log "reclaimed" and permanently lock its one-time retry flag, while a completely unrelated, unguarded code path — `applyBranchProfile()`'s saved-profile-override reapply — silently put the same skills straight back to `"off"` moments later, with no persistence check to catch it. This release closes both the missing gate and the missing verification.

**Theme:** Task-focus reliability, part 4 — a live-runtime verification pass of 1.0.117 (itself the same kind of pass that found 1.0.116's gap) found the reclaim migration's actual persistence could be undone by a path none of 1.0.115/116/117 ever touched.

### Fixed

- **`applyBranchProfile()`'s saved-profile-override reapply had no gate at all, unlike the sweep next to it.** `branchProfiles.ts`'s `profileOverrides` reapplication loop — the step that restores a branch's saved `skillOverrides` snapshot from `~/.claude/learning/branch-profiles.json` — never checked `claudeSkills.taskFocus.enabled`, unlike the `disableUndesired` sweep 1.0.116 fixed right next to it. Confirmed live on a real workspace: `reclaimOrphanedTaskFocusOverrides()` correctly cleared 16 stale `"off"` overrides (`mcp-builder`, `github-actions-ci`, `webapp-testing`, `frontend-design`, `mcp-server-creation`, and 11 others), logged success, and permanently locked its one-time retry flag — then this loop, triggered automatically by the next branch-switch check / git post-checkout sync / team-profile sync, silently put all 16 straight back to `"off"` from the saved snapshot, which still had them baked in from before the fix. `applyBranchProfile()`'s `disableUndesired` default now falls back to `claudeSkills.taskFocus.enabled` (was unconditionally `true`) instead of requiring every caller to opt in individually, and the loop now skips reapplying a saved `"off"` value when `disableUndesired` is false (reapplying "on" is never gated, since re-enabling a skill is never the hazard). The one explicit user command that restores a saved profile ("Apply Branch Skill Profile", `commandsProfile.ts`) now passes `disableUndesired: true` explicitly, so an explicit restore request still restores in full.
- **`reclaimOrphanedTaskFocusOverrides()` locked its permanent retry flag before confirming the clear actually stuck.** `taskSkillFocus.ts`'s reclaim wrote `legacyMigrationDone: true` immediately after its clearing loop, with no read-back check — so the race above (or any other second writer) could silently undo the clear while the flag closed the one-time window forever, with the migration log itself still (accurately, at the time) recording "reclaimed". It now re-reads `settings.local.json` after clearing and only locks `legacyMigrationDone` if every reclaimed name is confirmed gone; otherwise it logs `persisted: false` plus which names are `stillOff`, and leaves the retry window open for a future session.

Verified live: reset this project's own stuck `legacyMigrationDone` and re-ran the fixed reclaim against the real, still-broken workspace — all 16 previously-stuck skills cleared, and replaying the exact stale `branch-profiles.json` snapshot that originally undid the fix (the same automatic call shape `handleBranchChange`/`handleBranchSync`/`applyTeamBranchProfile` use) applied zero overrides afterward. Added 2 new `taskFocusOverrideCleanup.test.ts` cases (happy-path lock, and a simulated second-writer race that reproduces the exact reported bug and confirms a later retry succeeds) and a new `branchProfiles.test.ts` (5 cases covering the gate in both directions plus the explicit-command override). Full suite: 872/873 passing (1 pre-existing, unrelated Windows `EPERM` rename flake in `mcpForce.test.ts`).

---

## [1.0.118] - 2026-07-14

**Summary:** Following up on 1.0.117's stale-override investigation, its own live verification surfaced a real emergency cost cutoff on the dev machine — triggered 32 days earlier at $126.80 spend — still silently forcing 17 skills off, with the one-time trigger error dialog long dismissed and forgotten. `isEmergencyCutoffActive()` had zero callers anywhere in the extension besides the reclaim-exclusion check added in 1.0.117, so there was no ongoing visibility at all. This release adds a recurring SessionStart reminder, deliberately without any auto-expiry.

**Theme:** Emergency cutoff visibility — a direct follow-up to 1.0.117, whose own live-verification pass against a real workspace is what surfaced this gap in the first place.

### Added

- **SessionStart now reminds you an emergency cutoff is still active, every session, until you reset it.** `emergencyCutoff.ts` gains `getActiveEmergencyCutoffReminder()` (days since trigger, cost at trigger, count of disabled skills) and `formatEmergencyCutoffReminderText()`, wired into `handleOfficialSkills()` (`hookHandlers.ts`) the same way the existing approved-enrichment reminder is — plus a `notifySuggestion` toast with a "Reset Emergency Cutoff" button bound to the existing `claudeSkills.resetEmergencyCutoff` command (which still shows its own confirmation dialog before restoring anything). Deliberately **no auto-expiration**: a cutoff exists because spending got out of control, so silently letting it lapse after N days risks the exact runaway cost it was meant to prevent — this only ever reminds a human to decide.

Verified live: a fresh process loading current source, pointed at this project's real (still-active, 32-day-old) cutoff state, returned the reminder text verbatim in the actual SessionStart response. Added `emergencyCutoff.test.ts` (3 tests: null when inactive, singular/plural day formatting, multi-skill count) and 2 new `hookHandlers.test.ts` cases (reminder surfaced + notified when active, silent when not). Full suite: 866/866 passing.

---

## [1.0.117] - 2026-07-14

**Summary:** A live-runtime verification pass of 1.0.116's task-focus fixes confirmed future writes are now correctly gated, but found overrides set *before* those fixes (or by a second untracked writer) had no way to ever get cleaned up: the only bookkeeping (`task-active-skills.json`'s `ignoredSkills`) can go stale independent of the `settings.local.json` overrides it's supposed to describe. This release adds a durable ledger and an audited one-time migration that reclaims those orphaned overrides automatically, without touching overrides another subsystem owns.

**Theme:** Task-focus reliability, part 3 — closes the gap live-verification found in 1.0.116: `clearTaskSkillFocus()` only ever looked at `ignoredSkills`, and that file can be reset or edited on its own, leaving `skillOverrides` entries stranded forever with nothing left to tell them apart from a real manual disable.

### Fixed

- **Stale `"off"` overrides could survive forever once `ignoredSkills` read back empty.** `taskSkillFocus.ts`'s `clearTaskSkillFocus()` only cleared overrides listed in `task-active-skills.json`'s `ignoredSkills` — confirmed live on a real workspace where `ignoredSkills` was `[]` while 5+ `skillOverrides` entries (`mcp-builder`, `mcp-server-creation`, `github-actions-ci`, `vscode-extension-publishing`, `frontend-design`) were still `"off"`. Added a durable ledger (`claudeSkillsTaskFocus.disabledByTaskFocus`), co-located in `settings.local.json` itself so it can't drift out of sync the way a separate file can — mirrors the existing `claudeSkillsBudget` pattern in `budgetOps.ts`. `applyTaskSkillFocus()` writes it every run; `applyBranchProfile()`'s `disableUndesired` sweep (`branchProfiles.ts`) now reports what it disabled via a new `ApplyProfileResult.disabledUndesired` field, which `sessionSkillApply.ts` feeds into the ledger via a new `recordTaskFocusDisabled()`. `clearTaskSkillFocus()` now consults both the ledger and `ignoredSkills`.
- **Overrides that predated the ledger (or the fix to it) had no record anywhere, so nothing could ever reclaim them.** Added `reclaimOrphanedTaskFocusOverrides()` — a one-time, audited sweep (logged to `.claude/learning/task-focus-migration.jsonl`) that reclaims any `"off"` override with no ledger entry, while excluding anything already explained by an active emergency cutoff (new `emergencyDisabledSkillNames()` in `emergencyCutoff.ts`) or budget/economy tracking (new `budgetDisabledSkillNames()` in `budgetOps.ts`). Runs once per workspace, gated by a `legacyMigrationDone` flag — anything left `"off"` unattributed after that first run is presumed a real, intentional user choice and is never swept again.

Verified live against a real stale workspace: 16 of 26 legacy `"off"` overrides were correctly reclaimed; the other 10 (including `vscode-extension-publishing`) were correctly left alone because an unrelated, still-active emergency cost cutoff (triggered weeks earlier, $126.80 spend) independently owned them — proof the exclusion logic works, not just that the sweep runs. Added `taskFocusOverrideCleanup.test.ts` (9 tests): reproduces the exact reported bug, confirms the ledger survives a `task-active-skills.json` reset, confirms emergency/budget-protected overrides are never touched, and confirms the migration never re-examines overrides created after it has already run once. Full suite: 860/861 passing (1 pre-existing, unrelated CRLF bench failure).

---

## [1.0.116] - 2026-07-14

**Summary:** A live-runtime verification pass of 1.0.115's task-focus fixes — actually invoking the running hook server and re-reading state files, not just reading source — found that the fix was incomplete: a second, independent force-disable path never checked `taskFocus.enabled` at all, and a cleanup function meant to undo stale overrides was never called from anywhere. This release closes both gaps.

**Theme:** Task-focus reliability, part 2 — a direct continuation of 1.0.115, fixing what static review couldn't catch: manually clearing the exact `skillOverrides` entries 1.0.115 was supposed to stop got silently reverted within seconds, live, by a path 1.0.115 never touched.

### Fixed

- **`applyBranchProfile()`'s branch-committed-skill sweep force-disabled installed skills regardless of `claudeSkills.taskFocus.enabled`.** `sessionSkillApply.ts`'s `applyProposedSkillsLocally()` — which runs on every SessionStart via `applyPendingSkillProposalsForSession()` — reuses `applyBranchProfile()`'s branch-switch reconciliation machinery (`branchProfiles.ts`) to install proposed skills. That machinery unconditionally sets `skillOverrides: "off"` for any installed, branch-committed skill outside the current "desired" set, with no `taskSkillFocusEnabled()` check anywhere in the function — a gap 1.0.115's fix of the other three call sites (`branchSkillBootstrap.ts`, `budgetTierGating.ts`, `hookHandlers.ts`) didn't cover, since this one is a level deeper, inside shared reconciliation code originally written for genuine branch-switch behavior. Confirmed live: with `taskFocus.enabled: false`, manually clearing `mcp-builder`/`github-actions-ci`/`mcp-server-creation`/`vscode-extension-publishing`/`frontend-design` from `.claude/settings.local.json` got silently reintroduced within seconds on the next hook call. `applyBranchProfile()` now takes a `disableUndesired` option (default `true`, so real branch-switch reconciliation elsewhere is unchanged); `applyProposedSkillsLocally()` is the one call site that now passes `taskSkillFocusEnabled()` for it.
- **`clearTaskSkillFocus()` existed to release stale forced-off overrides but had zero call sites anywhere in the extension.** Wired it into `applyTaskSkillFocusFromProposals()`'s already-existing disabled branch (`taskSkillFocus.ts`), so turning task-focus off mid-task now actively releases overrides the feature previously applied, instead of merely no-op'ing and leaving them in place.

Verified live this time: ran the actual running hook server's `/hook/official-skills` route over HTTP (not a mock), diffed `.claude/settings.local.json` and `~/.claude/learning/branch-profiles.json` before/after, and added a regression test (`taskFocusDisable.test.ts`) confirmed to fail without the fix and pass with it, via `npx vitest run`.

---

## [1.0.115] - 2026-07-14

**Summary:** A user-reported investigation ("relevant MCP-related skills aren't loading, but unrelated ones are") traced to two bugs that force-disable installed skills even when they shouldn't, plus a third that left the correct fix for both unreachable at session start — this release fixes all three.

**Theme:** Task-focus reliability — a direct follow-up to 1.0.111's task-focus fixes: one call site still bypassed the master switch, budget gating still trusted a snapshot that switch no longer keeps fresh, and the apply/explain step for a new session was wired to a hook route nothing calls.

### Fixed

- **`bootstrapBranchSkillSet()` force-disabled installed skills even with `claudeSkills.taskFocus.enabled: false`.** Unlike every other `applyTaskSkillFocus()` call site (`sessionSkillApply.ts`, `taskSkillUnderuse.ts`), the branch-bootstrap path in `branchSkillBootstrap.ts` called it unconditionally. On a "general"-flavored branch (one matching neither the infra nor app branch-name regex, e.g. `main`) this narrows the candidate set to whatever `detectRelevantSkills`'s glob matching happens to catch within a small `maxActiveSkills` cap, then sets `skillOverrides: "off"` for every other installed skill — including ones with genuinely matching `detect_globs` (confirmed: `mcp-server-creation`'s manifest entry matches this repo's own `mcpCli.ts`/`mcpOfficial.ts`) that simply didn't survive the cap. `applyTaskSkillFocus()` is now gated behind `taskSkillFocusEnabled()` there too.
- **`applyBudgetTierGating()`'s "protect the active task set" exemption relied on a list that stops updating the moment task-focus is disabled.** Its warn/critical thresholds exempt skills from disabling by checking `task-active-skills.json`'s `activeSkills` — a file only the task-focus pipeline refreshes. With task-focus off, that file freezes (observed: a 4-day-old, 7-skill snapshot), so the exemption silently degrades and every high/medium-tier skill outside it becomes disable-eligible the next time the budget threshold trips. `budgetTierGating.ts` now short-circuits on the same `taskSkillFocusEnabled()` check; the unconditional "economy mode" path is unaffected since it has no active-set dependency.
- **The apply step and the agent-facing "what's active" explanation for `task-skill-proposals.json` were both correct and unreachable at session start.** Same root shape as 1.0.114's recommendation-visibility fix: `handleProfileInit()` calls `applyTaskSkillFocusFromProposals()` and builds the `formatFreshSessionContext()`/`formatNewSessionTaskContext()` instruction block, but its `profile-init` hook route is never registered in `.claude/settings.json`'s `SessionStart` array — only `official-skills` is. A task spanning multiple chat sessions never had its skill focus re-applied or re-explained at the start of a new session; the underlying data (proposal ranking already folds in MCP usage log signal via `enrichmentRankingAdjustment`) sat correct on disk but idle until something mid-session happened to touch it. New `applyPendingSkillProposalsForSession()` + `buildTaskSkillFocusContext()` in `hookHandlers.ts` are now called from `handleOfficialSkills` (the hook that actually runs).

Verified by static review and cross-checking against `hookHandlers.test.ts`'s existing `official-skills` assertions (all substring-based and wrapped in non-fatal try/catch on the new code paths) — this workspace's own instructions restrict this session to MCP filesystem tools only, so `tsc`/`vitest` could not be run here to confirm; run both before shipping.

---

## [1.0.114] - 2026-07-13

**Summary:** A pipeline-trace investigation found that the skill-recommendation engine and the skill-enrichment approval workflow both compute correct data that never reaches the user — this release wires that data into the hook paths and dashboard that actually run, instead of into ones that don't.

**Theme:** Recommendation & enrichment visibility — a direct follow-up to this session's pipeline trace, fixing its two root causes: recommendations "generated but not surfaced," and enrichments "generated but not applied."

### Fixed

- **`task-skill-proposals.json` was generated correctly but never displayed at SessionStart.** The only function that formatted it into readable text (`formatFreshSessionContext`) was reachable only through `handleProfileInit`, whose hook route (`profile-init`) this workspace's `.claude/settings.json` never registers — only `official-skills` is registered for SessionStart, and it never read the proposals file. New `taskSkillProposals.ts:formatSessionStartSkillRecommendations` is now called from `handleOfficialSkills` (the hook that actually runs), rendering a numbered top-3 list (skill, confidence, reason, `/skill-name` invoke line) filtered by the existing `minProposalConfidence` threshold (default 70).
- **Mid-session, `_detectOpportunity` used a separate keyword engine that explicitly excluded real proposals.** Its `OPPORTUNITY_SIGNALS` regex table only fired for already-installed skills and skipped anything already in `task-skill-proposals.json`'s proposed set — the real, confidence-scored recommendation was never the thing shown. New `taskSkillProposals.ts:formatPromptTimeSkillRecommendation` is now tried first inside `_detectOpportunity`, sharing the existing per-session cooldown (`_sessionProposalSurfaceCount`/`_sessionOpportunityProposals`) so the two engines draw from one interruption budget instead of each getting an independent 3-per-session allowance.
- **Approved skill-enrichment proposals could sit unapplied indefinitely.** Approving a proposal never applies it (`skillEnrichmentProposal.ts`'s SAFETY CONTRACT is intentional — SKILL.md is only ever written by an explicit "Apply" click), but nothing reminded anyone that step was still pending; real proposals sat "approved" for 7–17 days. New `getApprovedUnappliedSummary`/`formatApprovedEnrichmentReminderText` surface a count + per-skill breakdown at SessionStart, plus a real VS Code notification (`notifySuggestion`, "Open Enrichment Panel" button) via the new `notifyApprovedEnrichmentsToast` helper in `hookHandlers.ts`.
- **`generateEnrichmentProposals` could re-propose content that was already applied.** Its dedup check (`activeKeys` in `skillEnrichmentProposal.ts`) excluded `pending`/`approved`/active-`postponed` proposals but not `applied` ones, so re-running the mining pipeline after a proposal shipped to SKILL.md created a duplicate proposal for identical content — confirmed twice in real data. `applied` is now a terminal dedup state.

### Added

- The Cost Dashboard's enrichment stat pill now reads "N approved — Apply now" (with an oldest-pending-age tooltip) instead of a passive "N approved" count, and is clickable — it opens the enrichment panel via the same `data-*`-attribute + delegated-listener + `postMessage` convention the dashboard's other action buttons already use (`costDashboard.ts`, `commandsDashboard.ts`).
- 21 new tests covering all five fixes: SessionStart recommendation rendering, prompt-time recommendation + cooldown, the approved-enrichment reminder and its notification, the applied-proposal dedup regression, the underlying formatter unit tests in `taskSkillProposals.test.ts`, and direct unit tests for `getApprovedUnappliedSummary`/`formatApprovedEnrichmentReminderText`/`formatEnrichmentSummaryHtml` in `skillEnrichment.test.ts` (previously only exercised indirectly through mocks).

Verified with a clean `tsc` compile and the full extension test suite (851/851 tests, 101 files) passing, including `featureIntegration.test.ts`'s live end-to-end Cost Dashboard render test.

---

## [1.0.113] - 2026-07-13

**Summary:** A full trust audit of the Learning Dashboard and VS Code Cost Dashboard found several dashboard metrics that were fabricated, mislabeled, unbounded, or duplicated across up to four independent implementations — this release fixes every finding from that audit.

**Theme:** Dashboard trust audit — the metrics you see are now either computed from real data or explicitly removed; nothing renders a hardcoded placeholder or a number that can exceed its own logical bounds.

### Fixed

- **Three dashboard KPIs were hardcoded literal strings, not computed values.** `learning-dashboard.html`'s Executive Summary "Skill Runs" caption, the Skill Adoption "Success Rate" KPI, and the Hook Health "Write Rate"/"Failure Rate" KPIs all rendered `"100%"`/`"0%"` regardless of the real data sitting next to them. All four now compute from `skill-stats.json` (`successCount`/`runs`) and `hook-health.jsonl` (`wrote_runs`), matching the existing server-side `hookHealth.ts:computeHookHealthSummary` formula.
- **The same ROI number was labeled `%` in one dashboard and `x` in the other.** `teamEconomics.ts`'s `netRoi` is a multiple (e.g. `84` means "84x"); the VS Code Cost Dashboard already rendered it correctly, but the Learning Dashboard showed the identical value as `"ROI 84%"`. Fixed to render `x` consistently, with color/grade bands now driven by the real `netRoiBand` string instead of percent-tuned numeric thresholds that silently mis-graded any realistic multiple.
- **`skillAdoption.ts`'s funnel percentages (acceptance/invocation/success/reuse/global) were uncapped and could exceed 100%.** Reproduced live in this repo's own `skill-adoption.jsonl`: 23 `invoked` events against 2 `accepted` events produced a 1150% invocation rate, because "accepted" is recorded once per skill while "invoked" fires on every run. `computeAdoptionFunnel` and `computePerSkillAdoption` now use the existing `cappedPct()` helper for every rate field; a new, honestly-labeled `avgInvocationsPerAcceptedSkill` field preserves the real reinvocation signal without it reading as an impossible percentage.
- **Four independent, conflicting Precision/Recall/F1 implementations existed, three rendering on one Cost Dashboard page load.** `skillAdoption.ts`, `agentPerformanceIndex.ts`, `adoptionIntelligence.ts`, and `costDashboard.ts` each computed their own version from different event sources. Consolidated onto `skillAdoption.ts:computeRecommendationQuality` as the single canonical source — removed the duplicate stat-pills from `adoptionIntelligence.ts`'s dashboard panel and its targets table, repointed `costDashboard.ts`'s Prediction Intelligence panel at the canonical function, and removed the now-redundant `formatProposalFunnelHtml` render block.
- **Three "minutes saved per skill" tables disagreed on values for the same skills** (e.g. `ci-pipeline-debug`: 15 min in `skillRoi.ts` vs 25 min in `adoptionIntelligence.ts`). `skillRoi.ts`'s table is now canonical; `adoptionIntelligence.ts:estimateBenefitMinutes` and `learningTimeline.ts` (which also had a third, substring-matching-based table) now defer to it.
- Deleted `extension/src/haceMetrics.ts` — fully dead code, superseded by `efficiencyMetrics.ts`'s live HACE 2.0 formula but still imported (unused) in `costDashboard.ts`.
- Removed a byte-for-byte duplicate `roiBandFromRoi` in `teamEconomics.ts`; it now imports `skillRoi.ts`'s `roiBandFromMultiple`.

### Added

- A shared `.claude/learning/adoption-funnel-summary.json` precompute (`dashboardPrecompute.ts:writeAdoptionFunnelSummary`, run every pipeline cycle from `costPipeline.ts`) so the static Learning Dashboard reads the exact same canonical funnel numbers as the VS Code Cost Dashboard, instead of needing its own reimplementation.
- A regression test in `skillAdoption.test.ts` reproducing the live 23-invoked/2-accepted case and asserting the capped `100%` plus the new `23x` `avgInvocationsPerAcceptedSkill` value.

Verified with a clean `tsc` compile and the full extension test suite (830/830 tests, 101 files) passing, including `featureIntegration.test.ts`'s live end-to-end Cost Dashboard render test.

---

## [1.0.112] - 2026-07-10

**Summary:** Fixed a false-positive in the attribution equal-split detector that pinned `attribution.status` to "broken" (20% confidence) even when per-skill cost data was accurate — a live smoke-test of the 1.0.111 fixes traced the report to the detector's rounding granularity, not to actual stale or mis-attributed data.

**Theme:** Reliability — a follow-up to 1.0.111's hook/task-drift fixes, found while verifying them end-to-end against real telemetry.

### Fixed

- `detectEqualSplitCluster()` (`costAttribution.ts`) bucketed each skill's accumulated cost by rounding to the nearest **cent** to flag naive even-split cost data (a real bug pattern where a whole session's cost gets divided equally across every skill it touched). With only a handful of skills and typical per-skill costs in the $0.10–$0.30 range, three *unrelated* real costs (e.g. $0.1280, $0.1349, $0.1266) routinely collide in the same cent bucket by coincidence, tripping `staleEqualSplit` and forcing `attribution.status` to "broken" regardless of actual data quality — even immediately after running "Reset Mis-attributed Cost Data". Bucket precision tightened from cents (`×100`) to micro-cents (`×1,000,000`): a genuine equal-split bug still produces bit-identical floats and is still caught, but coincidental cent-level rounding collisions no longer are.

---

## [1.0.111] - 2026-07-09

**Summary:** Fixed the hook-driven "quiet" skill-set self-update pipeline — task focus narrowing had no working off switch, task-drift re-proposal was never triggered by new tool calls, and hook-server URLs could get stuck on a dead port for three of four hook categories.

**Theme:** Reliability — several feature-enabled getters silently ignored their documented settings (hardcoded `true`), and the hook-server's port-fallback mechanism only self-healed one of four hook categories, causing hooks to point at ports nothing was listening on.

### Fixed

- `taskSkillFocusEnabled()` (`taskSkillFocus.ts`) was hardcoded `true` and ignored `claudeSkills.taskFocus.enabled` — the setting had no effect regardless of value. It now reads the real configuration.
- `readTaskDriftSettings().enabled` (`taskDriftReproposal.ts`) was hardcoded `true`. Added a real `claudeSkills.skillFeedback.taskDriftEnabled` setting and declared it plus the four existing `taskDrift*` settings in `package.json` — previously none of them were visible in the Settings UI.
- The `runs.jsonl` file watcher (`extension.ts`) — the file the PostToolUse `skill-invoke` hook appends to on every tool/skill call — only scheduled a cost-pipeline sync and never called `refreshAll()`. `processTaskDriftReproposal` therefore only re-evaluated task-scope drift incidentally, when an unrelated watched file happened to change, instead of reacting to new (including off-profile) calls as they occurred.
- Stale hook-server-port self-healing (`hookOps.ts`) existed only in `ensurePostToolHookRegistered`. `ensurePreToolHookRegistered`, `ensureSessionStartHookRegistered`, and `ensureHookRegistered` (UserPromptSubmit) now apply the same in-place command rewrite when the hook server's bound port changes across restarts, so previously-registered hooks stop silently failing against a dead port.

---

## [1.0.110] - 2026-07-07

**Summary:** Removed the legacy Context Efficiency feature — its analysis engine, advisor, commands, and dashboard panel are gone, superseded by the Compliance Audit Framework and Workspace Intelligence systems.

**Theme:** Simplification — trimming dead code surface now that audit execution and workspace affinity cover the same signal the context-efficiency advisor used to provide.

### Removed

- `contextEfficiency.ts`, `contextAdvisor.ts`, `commandsContextEfficiency.ts` and their test/benchmark suites (`contextEfficiency.test.ts`, `context-efficiency-e2e.bench.test.ts`)
- All references to context-efficiency analysis, compact-advice tracking, and the Context Efficiency Intelligence dashboard panel from `commandsDashboard.ts`, `costDashboard.ts`, `mcpForce.ts`, and `extension.ts`

### Changed

- `auditExecution.ts` and `backgroundAuditScheduler.ts` updated to drop dependencies on the removed context-efficiency modules
- `mcpFilesystemServer.bench.test.ts` updated accordingly

---

## [1.0.109] - 2026-07-06

**Summary:** Compliance Audit Framework — automated audit execution engine with background scheduler, manual trigger, HTML reporting, and full telemetry validation pipeline.

**Theme:** Making compliance checks executable and observable — audit results are now computed in real-time on demand or on schedule, cached with checksums, and visualized in interactive HTML reports with pass/fail indicators and compliance checklists.

### Added — Audit Execution Engine (`auditExecution.ts`)

- `AuditExecutor` class with validators for: manifest schema, telemetry data, privacy compliance, provenance tracking, scheduling configuration
- `executeAudit()` async method computes full compliance status and returns `AuditResult` with timestamp, checksums, and per-check results
- `getLatestAudit()` retrieves cached results without re-running validators
- Integration with existing SkillSorter component for ROI/quality assessment

### Added — Background Audit Scheduler (`backgroundAuditScheduler.ts`)

- Automatic daily audit at midnight UTC with configurable interval
- Manual audit trigger via `triggerManualAudit()` command
- 5-minute minimum deduplication interval between runs
- `.claude/learning/auditHistory.jsonl` records all audit executions with timestamp, duration, status, and failed check count
- `dispose()` cleanup on extension deactivation

### Added — Status Bar UI (`auditStatusBar.ts`)

- Real-time audit status display in VS Code status bar
- Color coding: green (pass), yellow (warn), red (fail)
- Pass/fail counts and last-run timestamp
- Click to open audit report

### Added — Command Registry (`auditCommands.ts`)

- `claude-skills.runAuditNow` — manual audit trigger
- `claude-skills.viewAuditReport` — open HTML report
- `claude-skills.clearAuditHistory` — clear cached results
- All commands properly integrated with extension command palette

### Added — HTML Reporting (`auditReporting.ts`)

- `generateAuditReport()` produces formatted HTML with compliance results table
- Pass/fail indicator for each check
- Visual compliance checklist
- Timestamp and overall status summary
- Report file saved to `.claude/learning/auditReport.html`

### Integration with `extension.ts`

- Added `getAuditExecutor()` singleton getter for parameterless audit execution
- Registered all three audit commands on activation
- Initialized `BackgroundAuditScheduler` with automatic startup audit
- Proper resource cleanup via `context.subscriptions.push()`
- Full null-safety for async results with user notifications

### Tests

- Fixed `featureIntegration.test.ts` assertion to handle zero Cursor sessions gracefully
- All 876 tests pass across 99 test files
- Zero TypeScript compilation errors

---

## [1.0.108] - 2026-07-06

**Summary:** Workspace Intelligence v1 — telemetry, enrichment, adoption, affinity, and lifecycle data now drive automatic session intelligence instead of passive reporting.

**Theme:** Turning existing intelligence into action — workspace-proven skills are surfaced and prioritized in recommendations automatically, and high-impact outdated skills are proactively flagged, instead of relying on users to manually invoke skills or manually check for updates.

### Added — Workspace Affinity Engine (`workspaceAffinity.ts`)

- `.claude/learning/workspace-affinity.json` — a normalized 0-100 affinity score per skill from 30% manual invocations, 30% observations, 20% successful outcomes, 10% reuse, 10% recency, derived from the existing adoption event log.
- `.claude/learning/workspace-affinity.jsonl` — observability log for `affinity-created`, `affinity-updated`, `bootstrap-generated`, `recommendation-boosted`, `upgrade-available`, and `upgrade-installed` events.

### Added — Session Bootstrap & Update Advisor (`sessionIntelligence.ts`)

- New `workspace-intelligence` SessionStart hook surfaces a "Workspace Intelligence" report at the start of every session: ⭐ Top Workspace Skills (ranked by real usage) and ⚠ Updates Available (ranked by upgrade impact). Advisory only — never auto-invokes or auto-installs anything.

### Added — Recommendation Boost Breakdown (`taskSkillProposals.ts`)

- Tiered workspace-affinity boost in proposal ranking: affinity > 90 → +25, > 75 → +15, > 60 → +10.
- `confidenceBreakdown` on every proposal (semantic match, workspace affinity, repository affinity, adoption success, enrichment, penalty) so confidence is explainable point-by-point, not just a prose reason.
- Manual invocation (`/skill-name`) now records as a distinct `"recommended"` vs `"manual"` `AdoptionSource`, since direct invocation is the strongest signal of user intent.

### Added — Skill Lifecycle Intelligence (`skillLifecycleIntelligence.ts`)

- `.claude/learning/skill-lifecycle.json` — installed/latest version, status (current/outdated/deprecated/missing), affinity, 30-day usage, days outdated, and an upgrade priority (HIGH/MEDIUM/LOW) ranked by affinity → usage → recommendation impact → version delta.

### Added — Safe Auto-Upgrade (`safeAutoUpgrade.ts`)

- New setting `claudeSkills.autoUpgradeTrustedSkills` (default `false`). When enabled, automatically upgrades only trusted releases — patch-only version bumps and documentation/metadata-only changelogs. Never applies major/minor bumps, breaking-flagged changes, or deprecated skills.
- Every automatic upgrade snapshots the skill directory first (`.claude/learning/skill-backups/`) with a rollback function to restore it.

### Added — Dashboard & Audit

- Two new dashboard panels: **Workspace Intelligence** (top skills, affinity, manual invocations, successes, reuse, last used) and **Skill Lifecycle Intelligence** (current/outdated/deprecated/missing, upgrade priority).
- Five new audit checks in `scripts/audit_check_integrity.py`: workspace affinity integrity, recommendation boost validation, manual invocation learning, skill lifecycle integrity, and outdated skill prioritization.

### Tests

- 44 new vitest tests across 5 new test files (`workspaceAffinity.test.ts`, `skillLifecycleIntelligence.test.ts`, `sessionIntelligence.test.ts`, `safeAutoUpgrade.test.ts`, plus extensions to `taskSkillProposals.test.ts`), and 17 new Python unittest cases in `tests/test_audit_check_integrity.py` — including corrupted-file recovery for every new JSON store.

---

## [1.0.106] - 2026-07-04

**Summary:** Skill Adoption Intelligence v1 delivery complete — all 10 phases verified, Phase 10 test suite created, end-to-end architecture confirmed wired.

**Theme:** Release verification and quality assurance — new Phase 10 test coverage confirms all adoption-funnel systems (event recording, funnel progression, P/R/F1 calculation, confidence feedback, audit queries, dashboard rendering) work together as specified.

### Added — Phase 10 Test Suite (`skillAdoptionIntegration.test.ts`)

- **44 new tests** across 9 describe blocks (797 → 841 total, +44 adoption tests, all passing)
- **Test coverage by phase:**
  - Phase 1 (event schema) — 4 tests: all fields written, reuse fields, validation drop, all 6 types accepted
  - Phase 2 (full funnel e2e) — 3 tests: all 5 stages lifecycle, daysBack window, per-skill sort
  - Phase 3 (acceptance via Apply) — 4 tests: recordAcceptedSkills, auto-acceptance on invocation, non-proposed, rejection idempotency
  - Phase 4 (success detection) — 5 tests: clean success, correction suppression, failed invocation, formula bounds, idempotency
  - Phase 5 (reuse detection) — 3 tests: 7d window, first-ever use, beyond 90d cutoff
  - Phase 6+7 (P/R/F1) — 4 tests: standard ratios, perfect precision, zero precision, no-data guard
  - Phase 8 (confidence feedback) — 7 tests: boost, penalty, ±25 cap, recency weighting, unsuccessful-use penalty, no history, ranking effect
  - Phase 9 (audit queries) — 8 tests: Q1–Q6 from spec, report text, dashboard HTML sections
  - Concurrent write safety — 2 tests: interleaved appends, atomic batch write
  - detectBranch — 4 tests: branch read, null fallback, detached HEAD, branch written to events

### Verified — Architecture End-to-End Wiring

- `handleSkillInvoke` → `recordInvokedSkill` → `skill-adoption.jsonl` ✓
- `handleSessionStop` → `recordSessionAdoptionOutcomes` → writes successful + reused ✓
- `applyProposedSkillsLocally` → `recordAcceptedSkills` → `skill-adoption.jsonl` ✓
- `writeTaskSkillProposals` → `recordProposedSkills` → deduplicated by generatedAt ✓
- `adoptionConfidenceAdjustment` → fed into `rankAllTaskSkillProposals` confidence ✓
- `formatAdoptionFunnelPanelHtml` → rendered in `buildDashboardMainBodyHtml` (line 1040) ✓

---

## [1.0.105] - 2026-07-03

**Summary:** Two new intelligence systems — a unified skill-adoption event funnel (proposed → accepted → invoked → successful → reused) with precision/recall/F1, and a telemetry-mining enrichment engine that turns real usage into reviewable SKILL.md update proposals.

**Theme:** Closing the learning loop — the extension now measures which recommendations actually deliver value and feeds that back into both ranking and skill content.

### Added — Skill Adoption Intelligence v1 (`skillAdoption.ts`)

- **Adoption event log** `.claude/learning/skill-adoption.jsonl` — append-only, corruption-tolerant, single-syscall batch writes. Events: `proposed | accepted | rejected | invoked | successful | reused` with workspace, branch, taskId, source (`auto | manual | profile-init`), confidence, and agent.
- **Funnel wiring across existing flows:**
  - `proposed` — recorded on proposal batch writes (deduped by `generatedAt`), plus a session-stop catch-up for agent-written proposal files.
  - `accepted` — proposed skill becomes installed (`applyProposedSkillsLocally`); user-consented installs record `manual`, profile applies record `profile-init`; invoking an already-installed proposed skill records an implicit acceptance.
  - `rejected` — fresh proposals that expire un-invoked at session stop (idempotent per session+skill — the Stop hook fires per response turn).
  - `invoked` — skill-invoke hook, carrying proposal confidence and agent.
  - `successful` — at session stop when the skill had a successful run and no correction feedback; carries a 0–100 success-confidence score.
  - `reused` — successful use with a prior-session use within 7d/30d/90d windows, with day-gap tracking.
- **Funnel metrics** — acceptance (accepted/proposed), invocation (invoked/accepted), success (successful/invoked), reuse (reused/successful), global adoption (invoked/proposed), composite Adoption Score, per-skill stats and top lists.
- **Recommendation quality** — precision = successful/accepted, recall = successful/proposed, F1; new `recommendationQuality` AQI sub-score (10% weight; precision reweighted 25% → 15%), "Recommendation F1" pill in the dashboard AQI row.
- **Feedback loop** — exponentially decayed adjustment (14-day half-life; accepted +5, invoked +3, successful +9, reused +12, rejected −7, unsuccessful-use penalty), clamped ±25, applied in proposal ranking.
- **Dashboard panel** "Skill Adoption Funnel" — 5-stage funnel with rates, Adoption Score, precision/recall/F1, Top Accepted / Ignored / Successful / Reused / Least Effective.
- **Usage Report section** "Skill Adoption Intelligence" — stage counts, rates, quality metrics, top performing skill.

### Added — Skill Enrichment Intelligence v1 (`enrichmentIntelligence.ts`)

- **Per-skill enrichment model** `.claude/learning/skill-enrichment.json` — usage/success counts, frequently used files and commands, common errors and fixes, related technologies, suggested updates, staleness inputs, confidence.
- **Success pattern extraction** — mines successful sessions only, joining `runs.jsonl` attribution against `mcp-usage.jsonl` (filesystem paths, CLI/bash commands with exit codes) and `skill-feedback.jsonl`.
- **Technology affinity engine** — 22 signatures (Kubernetes, Helm, ArgoCD, Terraform, AWS/IAM, Azure, GCP, K3s, KubeRocketCI, Ingress, RBAC, GitHub Actions, …) stored as `{technology, frequency, confidence}`.
- **Command intelligence** — commands grouped by binary+subcommand with success/failure frequency and confidence; secret redaction (flag secrets, `token=`/`secret=` assignments, Bearer/JWT/AWS/GitHub/Slack credentials, opaque blobs); `cd <path>` prefixes stripped and trivial navigation commands excluded so no private local paths are stored.
- **Troubleshooting intelligence** — 14 recurring-issue detectors (ImagePullBackOff, CrashLoopBackOff, Helm timeout/conflict, RBAC forbidden, Terraform provider/state-lock, ArgoCD sync, ENOENT, EADDRINUSE, …) with observed same-session fixes plus canned fallbacks.
- **Data-driven proposals** — "Frequently Used Commands" and "Common Deployment Failures" SKILL.md sections generated from mined evidence (≥3 observations) into the existing review pipeline; SKILL.md is never modified automatically.
- **Enrichment impact** (`enrichment-impact.json`) — before/after acceptance/success/reuse deltas around each skill's first applied enrichment, from the adoption event log.
- **Staleness detection** — warns when a skill has ≥5 invocations, was used in the last 30 days, but SKILL.md is unchanged for 90+ days.
- **Recommendation boosting** — +15 for skills enriched in the last 30 days, −10 for stale content, applied in ranking with a 10s cache on the prompt hot path (success/reuse components remain owned by the adoption feedback loop to avoid double-weighting).
- **Dashboard panel** "Skill Enrichment Intelligence" — Skills Analyzed / Enriched / Pending / Stale tiles, Top Learning, Most Improved, Most Stale.

### Changed — Enrichment review workflow

- Command retitled **"Review Skill Enrichment Suggestions"** (`claudeSkills.showEnrichmentProposals`).
- New **Postpone** action (`claudeSkills.postponeEnrichmentProposal`) — 7-day snooze with automatic resurfacing and duplicate protection while snoozed; webview button added next to Approve/Reject.
- Pipeline command now runs telemetry mining, data-driven candidate generation, impact refresh, and staleness reporting alongside the static pattern library.

### Tests

- `skillAdoption.test.ts` (37 tests) and `enrichmentIntelligence.test.ts` (38 tests); both engines >90% statement coverage. Full suite: 738 tests green.

---

## [1.0.104] - 2026-06-26

**Summary:** Learning Dashboard — one-click live server toggle that serves `index.html` + `.claude/learning/` over a local HTTP server, embedded as a WebviewPanel with a pulsing status bar indicator.

**Theme:** Developer observability — the full telemetry review is now always one click away, live-updating every 30 seconds, with no external tooling required.

### Added — Learning Dashboard command (`claudeSkills.toggleLearningDashboard`)

- **`commandsLearningDashboard.ts`** (new file) — self-contained module for the dashboard server lifecycle:
  - `buildServer(workspaceRoot)` — Node.js `http.Server` serving the workspace root with MIME detection, `Cache-Control: no-store`, path-traversal guard, and `Access-Control-Allow-Origin: *` so `fetch()` in `index.html` works without CORS issues.
  - `findFreePort(3099)` — probes sequentially for a free port; never conflicts with other dev servers.
  - Toggle ON: starts server, opens a `WebviewPanel` beside the active editor showing an `<iframe>` pointed at `http://localhost:{port}`, reveals a pulsing status bar badge `$(broadcast) Dashboard ON :{port}`.
  - Toggle OFF: stops server, disposes panel. Also triggered by the **■ Stop Server** button inside the panel.
  - Panel toolbar buttons send `postMessage` to the extension — "Open in Browser" calls `vscode.env.openExternal`; "↻ Refresh" reloads the iframe.
  - Info toast on start offers **Open in Browser** / **Copy URL** shortcuts.

### Added — `index.html` live dashboard (project root)

- Fully self-contained HTML+JS dashboard that `fetch()`es all 18 `.claude/learning/` files on load and on every 30-second auto-refresh cycle.
- Sections: Executive Summary (computed grades), HACE trends, Skill Adoption, Prompt Intelligence, Cost Intelligence, Context Efficiency, Hook Health, Skill Enrichment, System State, Recommendations.
- Requires `npx serve .` or the extension's new toggle command — shows a clear `file://` error banner if opened directly.

### Fixed — `skill-profile.json` field mapping in dashboard

- `skill-stats.json` stores `totalTokens`; `skill-profile.json` stores `avgTokens` — the dashboard was reading `s.avgTokens` from the stats object (always `undefined`), showing "0K" for every skill.
  - `compute()` now enriches each active skill entry: `avgTokens = Math.round(totalTokens / runs)` (falling back to `skill-profile.avgTokens`); `qualityScore` pulled from `skill-profile.profiles[name]`.
  - `successRate` normalised: stats file stores 0–100 integer, profile stores 0–1 decimal — both display correctly as a percentage.

### Fixed — `recommendation-feedback.jsonl` duplicate event inflation

- Multiple `session_end` events fire per session (e.g. session `d5383429` fired 4 times with identical ignored-skill lists), inflating "times ignored" counts by 4–6×.
  - `compute()` now deduplicates feedback by `session_id + skill` before tallying; each skill is counted once per unique session.

### Changed — `package.json` contributes

- Added `claudeSkills.toggleLearningDashboard` to `contributes.commands` (`$(graph-line)` icon) and `view/item/context` menu under `3_usage` group alongside other dashboard commands.

---

## [1.0.103] - 2026-06-26

**Summary:** Telemetry quality audit — 6 bugs fixed across coaching decay, false-positive suppression, enrichment pipeline, context efficiency, and HACE documentation.

**Theme:** Internal telemetry correctness pass — every signal the system uses to self-improve now lands in the right place, at the right time, with accurate values.

### Fixed — Coaching decay loop

- **`coachingLearning.ts`** — `evaluateAdviceOutcome` was gated on `lastShownAt` (updated every prompt by `recordAdviceShown`), so the 1-hour guard always fired and `ignoredCount` never incremented.
  - Added `lastEvaluatedAt: string | null` to `MetricCoachingState` + `defaultMetricState()`.
  - Replaced the `hoursSinceShown < 1` guard with a 5-minute debounce on `lastEvaluatedAt`; coaching cooldowns now activate after ≥3 ignored pieces of advice as designed.

### Fixed — Rejection feedback staleness guard

- **`hookHandlers.ts`** — `onStopSession` read `task-skill-proposals.json` without checking age; stale proposals from previous sessions were logged as "ignored", inflating suppression counters.
  - Added the same 4-hour `generatedAt` staleness check that `recordSessionProposalOutcome` already uses; feedback is only recorded when proposals are fresh.

### Fixed — Skill Enrichment pipeline dormant for project skills

- **`skillEnrichment.ts`** — `DEVOPS_PATTERNS` had no entries matching actual project skill names (`vitest`, `skill-feedback-adaptation`, `self-learning`), so `MIN_PATTERN_OCCURRENCES = 3` was never reached and no enrichment proposals were ever generated.
  - Added 3 new patterns: `vscode-extension-test-run` (keywords: vitest/extension/test, affinity: vitest-extension-testing), `skill-feedback-workflow` (keywords: feedback/adaptation/skill), `self-learning-session` (keywords: self-learning/learning).
  - Extended `PatternCategory` type with `"vscode-extension" | "skill-meta"`.
  - After fix: `vitest-extension-testing` accumulates ≥3 occurrences → enrichment proposal generated on next session.

### Fixed — Context Efficiency normPath Windows drive-letter mismatch

- **`contextEfficiency.ts`** — `normPath` normalised backslashes but not drive-letter case; `C:/foo` and `c:/foo` mapped to different keys, double-counting hot files and inflating `totalWastedTokens`.
  - Added `.replace(/^[A-Z]:/, m => m.toLowerCase())` to canonicalise the drive letter.

### Fixed — Advisor log "followed" before "shown" ordering

- **`commandsContextEfficiency.ts`** — Auto-optimize path showed the notification before calling `recordAdvisorEvent("shown")`, so "followed" events landed before "shown" in `context-advisor-log.jsonl`, breaking follow-rate calculations.
  - Moved `recordAdvisorEvent("shown", …)` and `currentAdvisorEstimate`/`currentAdvisorReason` assignments to before `showInformationMessage` await; all events now log in correct order.

### Improved — HACE 2.0 formula documentation

- **`efficiencyMetrics.ts`** — Added authoritative docstring to `computeHaceMetrics` listing the live 6-component formula: `0.25×clarity + 0.20×velocity + 0.20×accuracy + 0.15×cli + 0.10×resolution + 0.10×leverage`.
- **`haceMetrics.ts`** — Added `@deprecated` JSDoc pointing to `efficiencyMetrics.ts`; eliminates confusion between the 4-component draft and the live engine.

---

## [1.0.102] - 2026-06-26

**Summary:** Coaching decay, fast FP suppression, HACE recovery, multi-goal hint, HACE on session-stop.

**Theme:** Telemetry reliability — signals that drive self-improvement now fire correctly and on time.

---

## [1.0.101] - 2026-06-26

**Summary:** Skill Enrichment Intelligence + Context Efficiency Intelligence.

**Theme:** Move from passive observability to active learning and optimization — the system now continuously enriches SKILL.md content from real-world usage patterns, and proactively reduces Claude token pressure before it becomes waste.

### Added — Skill Enrichment Intelligence (10-phase system)

- **`skillEnrichment.ts`** — Core enrichment engine:
  - **Phase 1** `detectSuccessfulRuns()` — identifies runs where `success=true AND (cost>0 OR tokens>0)` from `runs.jsonl`, producing typed `SkillSuccessEvent` records.
  - **Phase 2** `mineSuccessfulRunPatterns()` — mines DevOps/cloud patterns from run metadata using a keyword + affinity scoring model; writes `skill-learning.jsonl`.
  - **Phase 3** `computeProvenExamples()` — aggregates pattern occurrences per skill with per-pattern success rates.
  - **Phase 4** `buildSkillProfile()` / `refreshSkillProfiles()` — builds per-skill confidence profiles (invocations, success rate, avg tokens/cost, proven scenarios, quality score, quality delta) and writes `skill-profile.json`.
  - **Phase 5** `findEnrichmentCandidates()` — promotes patterns observed ≥3 times into typed `EnrichmentCandidate` objects.
  - **Phase 7** `computeQualityScore()` — 0-100 composite: Usage (20) + Success Rate (25) + Reuse (20) + Time Saved (15) + Knowledge Growth (20).
  - **Phase 8** `getSkillEvolution()` — returns top-N most-improved skills by `qualityDelta` for the dashboard.
  - **Phase 9** DevOps/cloud pattern library — 10 patterns covering ArgoCD sync failure, K3s cluster setup, AKS rollout, KubeRocketCI, Helm deployment, Terraform state lock, GitHub Actions failure, EKS, Kubernetes ingress, GKE; each with keyword list, affinity map, typical commands/files, and SKILL.md proposal template.

- **`skillEnrichmentProposal.ts`** — Safe review workflow (Phase 6):
  - `generateEnrichmentProposals()` — writes pending proposals to `skill-enrichment-proposals.jsonl`; idempotent (no duplicate active proposals per skill+pattern).
  - `approveEnrichmentProposal()` — marks approved; does **not** touch `SKILL.md`.
  - `rejectEnrichmentProposal()` — marks rejected with optional review note.
  - `applyEnrichmentProposal()` — the **only** function that writes to `SKILL.md`; requires `status="approved"` and an explicit user-confirmed VS Code dialog; appends provenance comment with session count and confidence %.
  - `formatEnrichmentProposalsHtml()` / `formatEnrichmentSummaryHtml()` — Approve / Reject / Apply to SKILL.md buttons; safety note that the system never auto-modifies skills.

- **`commandsEnrichment.ts`** — 5 new VS Code commands:
  - `claudeSkills.showEnrichmentProposals` — full enrichment webview with proposal review, Most Improved Skills, and Skill Confidence Profiles panels.
  - `claudeSkills.runEnrichmentPipeline` — mines patterns, refreshes profiles, generates proposals; logs summary to output channel.
  - `claudeSkills.approveEnrichmentProposal` / `claudeSkills.rejectEnrichmentProposal` — quick-pick command palette variants.
  - `claudeSkills.applyEnrichmentProposal` — confirmation dialog → appends enrichment to SKILL.md → opens file beside.

- **`costDashboard.ts` — `formatSkillEvolutionHtml()`** — "Most Improved Skills" panel in the main dashboard; shows quality delta badges and new proven patterns per skill; only renders when at least one skill has a positive `qualityDelta`.

### Added — Context Efficiency Intelligence (12-phase system)

- **`contextEfficiency.ts`** — Core engine; zero new telemetry (reads only from existing `mcp-usage.jsonl`):
  - **Phase 1** `computeContextPressure()` — composite 0-100 pressure score from MCP token count, wasted tokens, repeated read count, and excessive dir scan count; four levels: `low | medium | high | critical`.
  - **Phase 3** `detectHotFiles()` — identifies files read ≥2 times; computes `wastedReads`, `wastedTokens`, `sessionCount`; writes `hot-files.json`.
  - **Phase 5** `detectRepeatedReadsInWindow()` — sliding 30-minute window per file; flags ≥3 reads; generates file-specific recommendations (`search_in_file` for CHANGELOG/README; context-reference note for code files).
  - **Phase 6** `detectDirectoryScanWaste()` / `buildDirectoryCache()` — flags directories scanned ≥3 times; writes `directory-cache.json` with per-path scan counts, entry totals, and waste estimates.
  - **Phase 7** `computeContextEfficiencyScore()` — `usefulTokens / totalTokens × 100`; grades A–F; baseline ≈59%, target ≥80%.
  - **Phase 9** `recordAdvisorEvent()` / `computeAdvisorROI()` — appends `shown | followed | dismissed` events to `context-advisor-log.jsonl`; computes `followRate` and `estimatedTokensSaved` for Phase 9 ROI reporting.
  - `analyzeContextEfficiency()` — runs full pipeline in one call; writes both artifact files.

- **`contextAdvisor.ts`** — Advisor and coaching layer:
  - **Phase 2** `evaluateCompactAdvisor()` — triggers when MCP tokens >120k, wasted tokens >200k, or file read ≥5× in window; outputs `/compact` recommendation with estimated savings 15–30%, secondary caching/directory actions.
  - **Phase 8** `buildCoachingMessages()` — sorted by estimated savings (critical → high → medium): hot-file waste, repeated reads, compact, directory scans; each message includes a concrete `action` string.
  - `formatEfficiencyCoachHtml()` / `formatCompactAdvisorHtml()` — priority-coloured coaching rows; Compact Advisor banner with "Run /compact now" and "Dismiss" buttons; Phase 9 ROI history line.

- **`commandsContextEfficiency.ts`** — 4 new VS Code commands + full Phase 10 webview:
  - `claudeSkills.showContextEfficiency` — opens dedicated webview with score ring, Context Pressure pill, Compact Advisor banner, Efficiency Coach, Hot Files table, Repeated Reads panel, Directory Scan Waste panel, and Phase 9 ROI panel.
  - `claudeSkills.runContextAnalysis` — runs 24h analysis, logs full report to output channel, records advisor event if threshold exceeded.
  - `claudeSkills.followCompactAdvice` — copies `/compact` to clipboard; records `followed` event (Phase 9).
  - `claudeSkills.dismissCompactAdvice` — records `dismissed` event.

- **`costDashboard.ts` — `formatContextEfficiencyPanelHtml()`** — compact Context Efficiency card injected into the main dashboard (above Skill Health Card); shows score, pressure level, potential savings, compact opportunities, and top waste source; links to the full panel.

- **Phase 11 — Auto-Optimize toggle** — `claudeSkills.contextEfficiency.autoOptimize` setting (default off): when enabled, opening the Context Efficiency panel automatically surfaces the Compact Advisor if pressure is High/Critical. Never auto-executes any command.

### New data files

| File | Phase | Purpose |
|---|---|---|
| `.claude/learning/skill-learning.jsonl` | 2 | Mined pattern entries per successful run |
| `.claude/learning/skill-profile.json` | 4 | Per-skill confidence profiles with quality scores |
| `.claude/learning/skill-enrichment-proposals.jsonl` | 6 | Pending/approved/rejected/applied enrichment proposals |
| `.claude/learning/hot-files.json` | 3 | Hot file index (24h window) |
| `.claude/learning/directory-cache.json` | 6 | Directory scan cache |
| `.claude/learning/context-advisor-log.jsonl` | 9 | Compact advisor event log (ROI tracking) |

### Tests

- **`skillEnrichment.test.ts`** — 58 unit tests covering all enrichment phases.
- **`skill-enrichment-e2e.bench.test.ts`** — 12 E2E tasks: K3s cluster, KubeRocketCI, ArgoCD, Helm, AKS CrashLoopBackOff, Terraform state lock, GitHub Actions failure, multi-skill pipeline, quality score evolution.
- **`contextEfficiency.test.ts`** — 56 unit tests covering all context efficiency phases.
- **`context-efficiency-e2e.bench.test.ts`** — 10 E2E scenarios including baseline vs target comparison (59% → 75% at <700k waste), hot-file detection, repeated reads, dir scan waste, Compact Advisor trigger, Phase 9 ROI accumulation.
- **Total: 136 new tests, all passing** (70 enrichment + 66 context efficiency).

---

## [1.0.100] - 2026-06-26

**Summary:** Real-world productivity benchmark + Skill Health Card dashboard panel.

**Theme:** Measure what matters — validate that v1.0.98 fixes hold in production, surface the health state at a glance, and fix the two `SKILL_TASK_TYPES` gaps that caused legitimate prompts to be penalised.

### Added

- **`adoptionIntelligence.ts` — `formatSkillHealthCard(target)`** — Compact dashboard panel above the Adoption Coach showing three at-a-glance metrics: **Active Skills** (installed and not dormant), **Dormant Skills** (proposed ≥5× with <5% acceptance, currently suppressed), and **Avg Prompt Quality** (14-day rolling average from `prompt-intelligence.jsonl`). Uses `roi-high`/`roi-low` colour classes to make degraded state immediately visible. Includes a plain-English dormancy note when `dormantCount > 0`.

- **`adoptionIntelligence.ts` — `computeSkillHealthSnapshot(target)`** — Data layer behind the card: reads the installed skills directory, crosses against `getDormantSkills()`, and reads `computePromptMetrics()`. Returns `{ activeCount, dormantCount, avgPromptQuality, hasPromptData }`.

- **`costDashboard.ts`** — Wired `formatSkillHealthCard()` into the Adoption Intelligence section, rendered above `formatAdoptionCoachHtml()`.

- **`skillHealthCard.test.ts`** — 13 unit tests covering both `computeSkillHealthSnapshot` and `formatSkillHealthCard`: empty workspace zeros, 3-skill active set, 1-of-3 dormant split, all-dormant, below-threshold boundary, missing-skills-dir grace, HTML label presence, dormant warning note, CSS class assertions.

- **`benchmark-runner.test.ts`** — Real-world productivity benchmark suite (11 tests) run against the live workspace and installed skills. Validates scoring for Tasks 1–9 against actual `~/.claude/learning/` data. Benchmark results committed in the run body:
  - Acceptance 5% (target ≥5% — **ACHIEVED**)
  - Precision 18% (target ≥15% — **ACHIEVED**)
  - F1 28%
  - Dormant: `deployment-practical`, `github-actions-ci`, `vscode-extension-publishing` — all correctly suppressed
  - Rising: `skill-feedback-adaptation`, `vitest-extension-testing`

### Fixed

- **`taskSkillProposals.ts` — `SKILL_TASK_TYPES["github-actions-ci"]`** — Added `"code"` to the allowed task types. Prompts containing `implement`/`create` (code-type verbs) were receiving a 0.65× task-type penalty when paired with a CI skill, dropping confidence below the 70-point threshold. Implementing a GitHub Actions workflow *is* a code task.

- **`taskSkillProposals.ts` — `SKILL_TASK_TYPES["deployment-practical"]`** — Same fix: added `"code"` type. Creating deployment scripts is a development task, not purely a deploy operation.

### Tests

- 573 tests passing (519 pre-existing + 43 E2E validation + 11 benchmark; all green).

---

## [1.0.99] - 2026-06-25

**Summary:** Adoption Intelligence hardening — dormancy-aware freshness gate and 30 unit tests for the dormancy/penalty pipeline.

**Theme:** Make the learning loop provably correct — close the stale-proposals gap and establish a test foundation for the dormancy pipeline.

### Fixed

- **`taskSkillProposals.ts` — `areTaskSkillProposalsFresh()` ignores dormancy state** — The 24 h TTL freshness check could serve a cached proposals file that listed skills which had since become dormant (dormancy threshold can be crossed in minutes with rapid session cycling). `areTaskSkillProposalsFresh()` now calls `getDormantSkills()` after the age gate and returns `false` if any listed proposal is currently dormant, forcing an immediate recompute. `getDormantSkills` was already imported; no new dependencies added.

### Tests

- **Added `proposalOutcome.test.ts` — 30 unit tests across 4 suites** — First dedicated coverage for the core dormancy and penalty functions:
  - `isDormantSkill` (6 tests): no history, below threshold, at threshold (5 sessions), above threshold, single invocation clears dormancy, multi-skill isolation.
  - `getDormantSkills` (6 tests): empty set, dormant detection, threshold boundary (< 5 excluded), acceptance-rate gate (≥ 5% excluded), exactly-5% boundary, mixed dormant/non-dormant skills.
  - `confidenceCalibration` (7 tests): no data → 1.0; sessions < 3 → 1.0; sessions 3–4 at 0% → 0.5; sessions ≥ 5 at 0% → 0.0; sessions ≥ 5 at < 5% → 0.0; exactly 5% boundary → 0.5; ≥ 10% → 1.0.
  - `computeAllSkillPenalties` (11 tests): empty, +10 per not-invoked session, MAX cap at 40, −20 decay on invocation, floor at 0, independent skill tracking, feedback extra at 3/6/15 records, no extra below count 3, combined cap held at 40.

---

## [1.0.98] - 2026-06-25

**Summary:** Adoption Intelligence v1 — prompt signal gating, keyword inflation prevention, feedback penalty engine, and dormancy suppression pipeline.

**Theme:** Raise recommendation precision from 9% toward 15%+ by gating proposals on independent evidence and suppressing chronically ignored skills.

### Added

- **`taskSkillProposals.ts` — `LOW_SIGNAL_TASK_TOKENS` stop-word set** — Tokens that appear in virtually every skill description (common English stop words, domain-generic words, hook-injected warning phrases) are filtered before scoring, preventing false-positive proposals from repeated hook banner text such as "Long session (warn) — tighten skill set".

- **`taskSkillProposals.ts` — `stripHookWarnings()` prompt pre-processor** — Strips cost-control hook warning banners (`Long session (warn)`, `Daily budget warning`) from `promptExcerpt` before tokenisation so they cannot inflate any skill's score.

- **`taskSkillProposals.ts` — `SKILL_TASK_TYPES` + `classifyTaskType()`** — Task-type classification (code / deploy / write / analyze / debug / test / unknown) from prompt tokens. Skills whose allowed task types do not match the classified type receive a 0.65 confidence multiplier, preventing CI/CD skills from appearing on pure analytics or documentation prompts.

- **`taskSkillProposals.ts` — Priority-chain token scoring** — Each token now scores a skill at most once via an exclusive priority chain: keyword-hint match (+50) → name match (+25) → description match (+15). Prevents a single keyword from triple-dipping and inflating confidence.

- **`taskSkillProposals.ts` — Signal-count gate** — Proposals below 70 confidence require ≥ 3 independent signal types (or ≥ 2 with at least one concrete task token). Reduces false proposals by ~60% vs the prior 2-signal threshold.

- **`taskSkillProposals.ts` — `computeAffinityAdoptionWeight()`** — Scales the repo-affinity boost by a skill's historical acceptance rate. Skills proposed ≥ 5 times with 0 invocations receive an adoption weight of 0.0, nullifying their static repo-fingerprint boost entirely so real usage history overrides passive detection.

- **`proposalOutcome.ts` — `recordSessionRejectionFeedback()`** — Writes a `recommendation-feedback.jsonl` record for every not-invoked skill at session end, feeding the penalty engine with a higher-frequency signal than session-level outcomes alone.

- **`proposalOutcome.ts` — `computeAllSkillPenalties()` — rejection feedback layer** — After computing session-level penalties (±10/−20 per outcome), applies extra penalty for skills with ≥ 3 rejection feedback records (`min(10, ⌊count/3⌋ × 2)`), giving higher-frequency rejecters measurably lower confidence.

- **`proposalOutcome.ts` — `getDormantSkills()` + `confidenceCalibration()`** — Two complementary dormancy gates: `getDormantSkills` builds a Set of skills with ≥ 5 proposal sessions and < 5% acceptance for use in the proposal loop; `confidenceCalibration` returns 0.5 at 3–4 sessions with < 10% acceptance and 0.0 (full suppression) at ≥ 5 sessions with < 5% acceptance.

- **`adoptionIntelligence.ts` — `isDormantSkill()`** — Hook-level dormancy guard: returns `true` when `proposedCount ≥ 5` and `invokedCount === 0`, allowing hook handlers to skip stale recommendations without recomputing the full proposal set.

---

## [1.0.97] - 2026-06-25

**Summary:** Two dashboard buttons made functional — "Apply auto-fixes to hints" and "Export Telemetry CSV".

**Theme:** Dead UI → working UI. Both buttons were wired up to their backing commands with no behavioral changes elsewhere.

### Fixed

- **`costDashboard.ts` — "Apply auto-fixes to hints" button missing from HTML** — The `claudeSkills.applyMcpAutoFixes` command, `onDidReceiveMessage` handler, and JS listener all existed; the `<button id="btn-apply-mcp-autofixes">` element was simply never added to the "Telemetry & Export" panel template.

- **`costDashboard.ts` — "Export Telemetry CSV" button had no postMessage listener** — The HTML button existed but clicking it did nothing. Added `btn-export-telemetry` listener that posts `{ command: "exportTelemetry" }`.

### Added

- **`commandsDashboard.ts` — `claudeSkills.exportTelemetryCsv` command** — Reads all `EnrichedRunRecord` rows from `runs.jsonl` via `readCachedEnrichedRuns()`, serializes to CSV (15 columns: ts, skill, action, agent, tokens, cost_usd, success, rc, session_id, project, branch, model, cost_method, invoked, proposed), and saves via `vscode.window.showSaveDialog`. Default filename: `claude-skills-telemetry-YYYY-MM-DD.csv`.

- **`commandsDashboard.ts` — `csvEsc()` helper** — Local CSV value escaper: wraps values containing commas, quotes, or newlines in double-quotes with internal quotes doubled.

- **`commandsDashboard.ts` — `"exportTelemetry"` message handler** — Wires the webview postMessage to `claudeSkills.exportTelemetryCsv`.

---

## [1.0.96] - 2026-06-25

**Summary:** Code quality audit — 6 feedback-driven fixes: negation-aware opportunity detection, session coach opt-out, `handlePromptContext` complexity reduced 22→10, MCP constraint documented, hook handler integration tests, and plain-text dormancy report.

**Theme:** Make the extension trustworthy — stop false positives, stop paternalistic hints, make the learning loop visible.

### Fixed

- **`hookHandlers.ts` — `handlePromptContext` complexity 22→10** — Extracted `_detectOpportunity(cwd, promptText, sessionId, proposedCount)` helper shared by both `handleSkillOpportunity` and `handlePromptContext`. Eliminated a 33-line inline IIFE that duplicated the full opportunity detection loop; both paths now delegate to the single helper.

- **`hookHandlers.ts` — OPPORTUNITY_SIGNALS negation blindness** — Added `signalIsNegated(text, signal)` (exported). Detects negation context ("don't use terraform", "avoid kubectl") by extracting the sentence containing the matched keyword and checking for negation words. Previously "I don't want to use terraform" would fire the terraform skill hint.

- **`hookHandlers.ts` — `handleMcpForce` section undocumented** — Added rationale comment: the filesystem MCP server provides path-scoped access control; direct tools (Read/Write/Edit/Bash) bypass the workspace sandbox; MCP-only mode ensures all file operations are auditable and scoped to the configured allow-list.

### Added

- **`coachConfig.ts`** — New config module following the `contextFocusConfig` pattern. Exports `readCoachConfig()`, `writeCoachConfig()`, `syncCoachConfigToDisk()`. Stored at `~/.claude/learning/coach.json`. Defaults: `{ enabled: true, maxHintsPerSession: 3 }`.

- **`package.json` — `claudeSkills.sessionCoach.*` settings** — Two new VS Code configuration properties: `enabled` (boolean, default `true`) and `maxHintsPerSession` (number, default 3, range 0–10). Setting `enabled: false` suppresses coaching hints while still recording prompt quality metrics for the dashboard.

- **`hookHandlers.ts` — `handleSessionCoach` respects coach config** — Reads `readCoachConfig()` after recording prompt quality. When `enabled: false`, returns `""` immediately (hints suppressed). Replaces hardcoded `SESSION_COACH_MAX_HINTS = 3` with `coachCfg.maxHintsPerSession` for the per-session cap.

- **`adoptionIntelligence.ts` — `formatDormancySummary(target)`** — Plain-text export alongside the existing HTML formatters. Returns a 4–6 line summary: acceptance rate, F1, total minutes saved, dormant skills, rising skills, top adopted. Enables `console.log(formatDormancySummary(cwd))` from any CLI or test harness without a VS Code webview.

### Tests

- Added `extension/src/hookHandlers.test.ts` — 13 new Vitest integration tests covering: `signalIsNegated` unit tests × 8 (including sentence-boundary check), `handleHookRequest` dispatch (unknown hook → `{}`), opportunity detection with real temp workspace × 3 (hint fires, negation suppresses, uninstalled skill skipped), and coach-disabled path × 1.

---

## [1.0.95] - 2026-06-25

**Summary:** Code health — all SonarQube S3776 violations resolved, OPPORTUNITY_SIGNALS deduplicated, 49 regression tests added.

**Theme:** Zero cognitive-complexity findings before release; every refactored helper covered by tests.

### Fixed

- **`runs_cost.py` — `extract_usage_breakdown` (16→3)** — extracted `_parse_usage_dict` + `_build_usage_candidates`.
- **`runs_cost.py` — `compute_run_cost_with_transcript` (22→14)** — extracted `_resolve_transcript_path`; transcript path resolution is now independently testable.
- **`runs_cost.py` — `summarize_skill_costs` (33→13)** — extracted `_compute_cutoff`, `_is_before_cutoff`, `_classify_run_row`, `_process_run_row`, `_check_collector_dedup`; all branches verified by regression tests.
- **`runs_cost.py` — `lookup_tool_use_usage` (22→12)** — extracted `_scan_follow_lines`.
- **`runs_cost.py` — `enrich_hook_rows_from_transcripts` (20→9)** — extracted `_try_enrich_row`.
- **`hookHandlers.ts`** — `OPPORTUNITY_SIGNALS` defined twice identically; extracted to single module-level `ReadonlyArray` constant, eliminating silent divergence risk.
- **`proposalOutcome.ts`** — `getDormantSkills` JSDoc said "≥10 sessions"; corrected to "≥5 sessions".

### Tests

- Added `tests/test_runs_cost_refactor.py` — 49 new tests covering every extracted helper and 10 behavioral-equivalence cases for `summarize_skill_costs`.

---

## [1.0.94] - 2026-06-25

**Summary:** Skill Adoption System v2 — dormancy suppression, trust repair, Adoption Coach panel, and one-click invoke cards targeting Acceptance 2%→15%, Skill Leverage 3%→20%.

**Theme:** Turn existing recommendations into actual invocations — stop the noise loop, rebuild trust, coach the behaviour change.

### Added

- **`adoptionIntelligence.ts` — `formatAdoptionCoachHtml()`** — Personalized behavioral coaching panel rendered above the Adoption Intelligence section in the dashboard. Generates 2–4 targeted messages from real session data: persistently-ignored skills with estimated minutes saved, skill breadth coaching ("only 1 adopted skill"), zero-adoption encouragement, and HACE-Velocity coaching tied to current Skill Leverage score. Includes a concrete `/skill-name` invocation example.

- **`adoptionIntelligence.ts` — `isDormantSkill(target, skillName)`** — Exported helper that returns `true` when a skill has been proposed ≥5 times with 0 invocations. Used by hook handlers to gate stale recommendations at the source.

### Fixed

- **`adoptionIntelligence.ts` — `enrichProposal()` whyText trust repair** — Previously displayed `"0% acceptance"` for every new skill, which actively discouraged users before they had tried it. Now hides acceptance rate until ≥5 proposals exist; shows `"collecting data"` for 1–4 proposals and `"not yet invoked"` when the rate is confirmed zero at adequate sample size.

- **`adoptionIntelligence.ts` — rejected skill rows** — Changed label from `"0% acceptance"` to `"never invoked"`. Added inline invocation hint: `To try it: type /skill-name at the start of a relevant session`. Removed misleading acceptance-rate framing for zero-data skills.

- **`hookHandlers.ts` — dormancy gate on `[Skill Opportunity]` hints** — Both skill-opportunity surfacing paths now call `isDormantSkill()` and skip any skill already suppressed by dormancy. Stops the three same skills (`deployment-practical`, `github-actions-ci`, `vscode-extension-publishing`) from appearing in every session hook message after 11 consecutive ignores.

### Wired

- **`costDashboard.ts`** — `formatAdoptionCoachHtml(target)` injected into the Learning section, immediately before `formatAdoptionDashboardHtml`. Coach panel only renders when there is enough session history (≥3 sessions).

### Adoption Funnel Analysis (root cause)

| Stage | Count | Drop-off |
|-------|-------|----------|
| Proposed | 37 total across 11 sessions | — |
| Invoked | 1 (vitest-extension-testing) | **97.3% drop** |
| Succeeded | 1 | 100% of invoked |
| Reused | 0 | — |

**Top 3 blockers identified and addressed:**
1. **Noise loop** — same 3 skills proposed every session due to persistent glob matches → fixed by dormancy suppression
2. **Trust destruction** — "0% acceptance" label on new skills → fixed by whyText repair
3. **No invocation path** — proposal panel showed text only, no invoke action → fixed by one-click copy hint + Adoption Coach

---

## [1.0.93] - 2026-06-25

**Summary:** Prompt Intelligence runtime unblocked — inline prompt fallback in `handlePromptContext` ensures `prompt-intelligence.jsonl`, `coaching-events.jsonl`, and `coaching-state.json` are written on every session regardless of `transcript_path` availability.

**Theme:** Closing the last gap between code-complete and data-live — all Prompt Intelligence, Session Coach, and Coaching Learning Loop storage now confirmed populated end-to-end.

### Fixed

- **`hookHandlers.ts` — `handlePromptContext` inline prompt fallback** — When `transcript_path` was absent or JSONL extraction yielded empty text, `promptText` stayed `""`, `handleSessionCoach` returned early, and `appendPromptRecord` was never called — silently blocking all three storage files. Added a fallback that reads the prompt directly from the hook body (`body.message / body.prompt / body.content / body.input`) in string, flat-array, and nested-object forms, covering all known Claude Code hook body variants.

### Validated (runtime)

Full 12-phase E2E validation run on 2026-06-25 — all PASS:

| Phase | System | Result |
|-------|--------|--------|
| 1 | Prompt Collection | PASS — `prompt-intelligence.jsonl` written, 4 records |
| 2 | Prompt Scoring | PASS — B(17) < A(37) < C(72) |
| 3 | Anti-pattern Detection | PASS — `multi_goal` · `no_error_evidence` · `no_success_criteria` · `missing_logs` |
| 4 | Session Coach | PASS — `[HACE Coach]` + `[Prompt Coach]` hints fire |
| 5 | Rate Limiting | PASS — 3/3 hints across 10 weak prompts |
| 6 | Coaching Event Storage | PASS — `advice_shown` event written |
| 7 | Coaching State Storage | PASS — `adaptedMultiplier` · `ignoredCount` · `cooldownUntil` present |
| 8 | Dashboard Population | PASS — `hasData: true`, avgScore: 33, anti-pattern breakdown populated |
| 9 | Learning Loop | PASS — `evaluateAdviceOutcome` wired, events recorded |
| 10 | Prompt Rewriter | PASS — concise / troubleshooting / expert all generated |
| 11 | Template Library | PASS — all 7 required templates present |
| 12 | HACE Impact | PASS — 4 critical rules active, projected +18 pts (33 → 51) |

---

## [1.0.92] - 2026-06-25

**Summary:** HACE Coaching System + 10 bug fixes + outcome pipeline unblocked — transforms HACE from a measurement dashboard into an active coaching engine; fixes session-stop coverage, metric formula bugs, TTR inflation, velocity target calibration, and affinity cache staleness.

**Theme:** Measure → Coach. Every weak HACE score now generates prioritised advice, estimated improvement, and adaptive learning that rewards followed recommendations and suppresses ignored ones.

### Added

- **`promptIntelligence.ts`** — Prompt Quality Engine (Phases 1, 2, 4)
  - `analyzePrompt()`: 9-dimension scoring (goal clarity, error evidence, environment, constraints, success criteria, logs, expected output, context, scope) → `score 0–100`
  - Anti-pattern detector: multi-goal, vague requests, missing error evidence, mixed architecture+debugging, excessive length, no success criteria
  - Prompt Rewriter: generates 3 structured rewrites (concise / troubleshooting / expert) without any API call
  - `computePromptMetrics()` + `formatPromptIntelligencePanelHtml()`: quality trend chart, dimension breakdown, top anti-patterns — all from `prompt-intelligence.jsonl`

- **`haceCoaching.ts`** — HACE Coaching Engine (Phases 3, 9)
  - `buildCoachingRules()`: per-metric rules with threshold-aware grades (critical/poor/fair), multi-point WHY list, concrete advice steps, estimated HACE point gain
  - `buildCoachingReport()`: assembles all active rules + behavior insights from prompt history
  - `formatCoachingReportHtml()`: collapsible coaching panel injected directly below the HACE Efficiency panel
  - `getSessionCoachHints()`: returns ≤2 in-session coaching strings targeted at the weakest active metric
  - **Productivity Impact Simulation**: "Following the top 3 recommendations could improve HACE by +N points (X → Y/100)"

- **`promptTemplates.ts`** — Prompt Template Library (Phase 5)
  - 10 structured domain templates: Kubernetes Troubleshooting, DevOps Investigation, AWS Incident Response, Azure Troubleshooting, GitHub Actions Failure, Terraform Deployment, VS Code Extension Dev, Architecture Review, Feature Implementation, Root Cause Analysis
  - Each template enforces all 6 quality dimensions and targets ≥80/100 prompt quality score
  - Collapsible panel added to dashboard under "Prompt Template Library" section

- **`coachingLearning.ts`** — Adaptive Learning Loop (Phase 10)
  - `recordAdviceShown()`: persists coaching interactions to `coaching-events.jsonl`; checks cooldown before surfacing
  - `evaluateAdviceOutcome()`: called in pipeline analyze phase; awards improvement credit when score rises >3pts after advice, increments ignore counter otherwise
  - Adaptive frequency: `adaptedMultiplier` ranges 0.25–2.0; advice ignored 3× enters exponential cooldown (24–72h)
  - `formatLearningLoopHtml()`: improvement rate, active cooldowns, per-metric adaptation state

- **Session Coach in `hookHandlers.ts`** (Phase 7)
  - `handleSessionCoach()`: fires on every `UserPromptSubmit`; skips prompt 1 and scores ≥65; enforces 3-hint-per-session cap; checks `shouldShowAdvice()` before injecting
  - Prefix: `[HACE Coach]` for metric-targeted hints, `[Prompt Coach]` for structural quality hints
  - Every prompt is analyzed and persisted to `prompt-intelligence.jsonl` unconditionally (for dashboard), independent of whether a hint fires

- **`costDashboard.ts`** — 3 new panels injected into the Learning section
  - Prompt Intelligence Panel (quality trend sparkbars, dimension breakdown, top anti-patterns)
  - Coaching Learning Loop Panel (improvement rate, active cooldowns, per-metric state)
  - Prompt Template Library Panel (10 templates, collapsible, copyable)
  - HACE Coaching Report Panel (injected below Efficiency panel, shows only when HACE data exists)

- **`confidenceTrend.ts`** — Confidence Trend Engine
  - `appendConfidenceSnapshots()`: persists per-skill confidence to `confidence-history.jsonl` on every proposal refresh
  - `computeConfidenceTrends()`: groups by day, computes 7d and 30d delta, direction (rising/falling/stable)
  - `formatConfidenceTrendHtml()`: sparkline bars (▁▂▄▇) per skill, top improving and declining sections

### Fixed (10 bugs)

- **Bug 1 — runs.jsonl dedup** (`hookHandlers.ts`): skill-invoke dedup key `sessionId|skill|na` collapsed all session invocations of the same skill to one record. Fixed: use `toolUseId` when present; fall back to 10-second time bucket so genuine re-invocations are captured while Pre+Post double-writes are still suppressed.
- **Bug 2+5 — rejection feedback** (`proposalOutcome.ts`): `recordSessionRejectionFeedback` was writing `accepted: true` skills as rejected with `reason: "ignored"`, polluting the confidence decay signal. Fixed: skip accepted skills entirely; only genuinely not-invoked skills get a feedback record.
- **Bug 3 — precisionPct === acceptanceRatePct** (`adoptionIntelligence.ts`): both metrics computed `totalInvoked/totalProposed` — identical numbers shown as separate KPIs. Fixed: Precision now measures skill-level uniqueness (`uniqueSkillsInvoked / uniqueSkillsProposed`), making it genuinely distinct from the session-aggregate Acceptance Rate.
- **Bug 4 — funnel totalSucceeded cross-source** (`proposalOutcome.ts`): `computeProposalFunnel` sourced Invoked from `proposalOutcome.jsonl` but Succeeded from all `runs.jsonl` — making `successRate > 100%` possible. Fixed: Succeeded now filtered to only sessions tracked in proposal outcomes.
- **Bug 6 — HACE wall-clock TTR** (`efficiencyMetrics.ts`): session duration included overnight gaps, inflating `avgSessionMinutes` from ~15 real minutes to 113 min wall-clock and rendering Resolution Velocity 0% permanently. Fixed: `activeWorkMinutes()` strips inter-turn gaps >30 min; only active work intervals count.
- **Bug 7 — adaptation-log double-writes** (`adaptationLog.ts`): dedup only checked the last line; process restarts allowed duplicate entries. Fixed: scans all entries within the last 24 hours for matching `type+description`.
- **Bug 8 — VELOCITY_TARGET=2.0 uncalibrated** (`efficiencyMetrics.ts`): 2.0 turns/min rendered every coding session as 2% Task Velocity regardless of actual pace. Fixed: calibrated to 0.5 turns/min (1 turn per 2 minutes) — the realistic target for focused coding sessions. Display updated to "target ≥ 0.5".
- **Bug 9 — repo-affinity cache stale on branch switch** (`repoAffinity.ts`): 24-hour disk cache never invalidated after `git checkout`. Fixed: `.git/HEAD` mtime checked against cache epoch; if HEAD moved after cache was written, cache is dropped and recomputed immediately.
- **Bug 10 — totalCost null when cost=0** (`usageStats.ts`): hook-measured runs with `cost: 0` (zero-token skill reads) showed `totalCost: null` in `skill-stats.json` because the guard was `cost > 0`. Fixed: any numeric cost (including 0) is now counted as measured; zero-cost runs correctly show `$0.00`.
- **Bug — Stop hook missing** (`.claude/settings.json`): `handleSessionStop` existed and was routed but no `Stop` hook was registered, leaving 98% of sessions without proposal outcome records. Fixed: `Stop` event now registered with 10s timeout.

### Changed

- **`efficiencyMetrics.ts`** — HACE TTR labels updated throughout: "TTR" → "Active TTR", tooltip clarifies idle gaps excluded
- **`haceMetrics.ts`** — Also updated with `activeWorkMinutes()` and `avgSessionActiveMinutes` field; `IDLE_GAP_MS = 30 min` constant added
- **`taskSkillProposals.ts`** — `writeTaskSkillProposals()` now calls `appendConfidenceSnapshots()` on every proposal refresh
- **`adoptionIntelligence.ts`** — `EnrichedProposal` extended: `reuseRate`, `reuseCount`, `totalMinutesSaved`, `invokedCount`; `whyText` now surfaces success%, reuse count, and total time saved
- **`taskSkillProposals.ts`** — `computeAffinityAdoptionWeight()` added: adoption-weighted affinity scoring caps static repo signal contribution when acceptance rate is low (0% acceptance → 0.3× multiplier); prevents `.kiro` dir from permanently overriding rejection evidence

### Storage

| New file | Purpose |
|----------|---------|
| `.claude/learning/prompt-intelligence.jsonl` | Per-prompt quality records (max 500) |
| `.claude/learning/coaching-events.jsonl` | Coaching interaction log for learning loop |
| `.claude/learning/coaching-state.json` | Per-metric adaptive frequency state |
| `.claude/learning/confidence-history.jsonl` | Daily confidence snapshots per skill for trend engine |

---

## [1.0.91] - 2026-06-24

**Summary:** Adoption Intelligence System + full QA audit remediation — session-stop hook, AQI honesty, HACE transcript parser, artifact cleanup, and dynamic skill scoring to drive acceptance from 6% toward 15%+.

**Theme:** From measurement to adoption — telemetry, HACE, and the learning loop now all work; recommendations are now explainable and dynamically scored.

### Added

- **`adoptionIntelligence.ts`** — New module with 7 exports:
  - `computeAdoptionMetrics`: acceptance/precision/recall/F1, top adopted/rejected skills, dormant list, user affinity areas, time-saved totals.
  - `computeSkillAdoptionStats`: per-skill composite adoption score (`acceptance×50% + success×30% + reuse×20%`) with trend detection (rising/stable/declining/dormant/new).
  - `enrichProposal`: generates explainability string per proposal — e.g. `"detected: **/mcpCli.ts · 0% acceptance · ~25min saved"`.
  - `estimateBenefitMinutes`: 35-skill benefit map (8–25 min per invocation).
  - `buildAffinityAreas`: maps invoked skills to work areas (Infrastructure / CI-CD / Azure / Testing / etc.).
  - `shouldSurfaceProposals`: smart timing — fires on `kubectl`, `terraform`, `pipeline`, `error`, `ADX`, `publish` signals; 3/session cooldown otherwise.
  - `formatAdoptionDashboardHtml`: Skill Adoption Intelligence panel with funnel, top adopted/rejected, dormant skills, user affinity, and progress-toward-targets table (30d/60d/90d).
- **Proposal explainability** (`taskSkillProposals.ts`) — `TaskSkillProposal` extended with `whyText`, `estimatedMinutes`, `acceptanceRate`, `successRate`, `successScore`, `trend`.
- **Rejection tracking** (`proposalOutcome.ts`) — `recommendation-feedback.jsonl` written at each session end via `recordSessionRejectionFeedback`. Every proposed-but-not-invoked skill is recorded as `accepted: false, reason: "ignored"`.
- **Skill Adoption Intelligence dashboard panel** (`costDashboard.ts`) — Inside the Learning section; shows acceptance/precision/recall/F1 grid, recommendation funnel, top adopted, top rejected, dormant list, user affinity, and target table.
- **`haceMetrics.ts`** — Source file restored to version control; HACE computation extracted from compiled-only binary.

### Fixed

- **HACE session parser** (`efficiencyMetrics.ts`) — `message.content` in Claude Code transcripts is a plain string for user turns, not an array. Calling `.some()` on a string threw `TypeError`, propagated to the catch block, and hardcoded `cliEfficiencyScore: 0`. Fixed: `RawEntry.message.content` typed as `string | Array<ContentBlock>`; `isMeta: true` system entries skipped; exception fallback now passes `cliKpi.overallSuccessRate`.
- **Session-stop hook never wired** (`hookHandlers.ts`) — `recordSessionProposalOutcome` was imported but never called. Added `handleSessionStop()` + `case "session-stop"` dispatch. Every session end now writes a `proposalOutcome.jsonl` record including zero-invocation sessions. `recordSessionRejectionFeedback` also called at stop.
- **AQI empty-state inflation** (`agentPerformanceIndex.ts`) — `taskCompletionScore`, `humanCorrectionScore`, and `skillEfficiencyScore` all returned inflated defaults (100/100/50) when no data existed. All three now return `NO_DATA = -1`, excluded from the composite with proportional weight redistribution.
- **`adx-schema-check` false positive** (`manifest.json`) — Globs `**/adx*` and `**/*adx*` matched the extension's own source files. Replaced with `["**/*.kql", "**/adx/**", "**/*kusto*", "**/adx-schema*"]`.
- **`pdf` false positive** (`manifest.json`) — `**/*.pdf` fired on any PDF in the repo. Replaced with workflow-specific patterns requiring PDF processing code.
- **Transcript artifact names** (`skillPathUtils.ts`) — `nnpm`, `npm`, `npx`, `pnpm`, `yarn`, `bun`, `node`, `deno`, `pip`, and 8 others added to `DENYLIST`. Retroactive cleanup of stored `cost-attribution.json`.
- **Backup file accumulation** (`learningPrune.ts`, `costAttribution.ts`) — `pruneBackupFiles` now expires files >7 days old; global `~/.claude/learning/` directory also pruned on reset.
- **HACE panel invisible** (`efficiencyMetrics.ts`) — `buildHacePanelHtml` returned `""` on `noData`. Now renders CLI Efficiency score + placeholders with activation guidance.
- **Dormancy threshold** (`proposalOutcome.ts`) — Reduced from ≥10 sessions to ≥5; confidence decay starts at ≥3 sessions (was ≥5).

### Changed

- **Glob-only proposal confidence** (`taskSkillProposals.ts`) — Replaces hardcoded 55% floor. New formula: `(40/30 base) + specificityScore + affinityBoost + historyBoost + acceptanceBoost - penalty`. Deeply-specific globs score ~70%; shallow extension globs score ~40-50%.
- **AQI grade on zero data** — Fresh install now correctly scores F (previously inflated to D by default 100% sub-scores).

### Before / After

| Metric | v1.0.90 | v1.0.91 |
|--------|---------|---------|
| Attribution confidence | 35% (broken) | 94% (reliable) |
| AQI on zero data | 40/D (inflated) | ~15/F (honest) |
| Proposal explainability | Signal name only | Signal + acceptance% + time estimate |
| Glob-only confidence | Flat 55% | 30–80% dynamic |
| HACE CLI Efficiency | 0% (exception fallback) | Actual CLI success rate |
| HACE session data | Not parsed (format mismatch) | 11 turns/session from real transcripts |
| Rejection tracking | Not stored | `recommendation-feedback.jsonl` |
| Adoption dashboard | Not present | Full panel with funnel + targets |
| `nnpm` false optimisation | "$616/mo savings" displayed | Removed |

---

## [1.0.90] - 2026-06-24

**Summary:** Complete audit remediation — 10 logic bugs fixed, precision engine overhauled, HACE 2.0 with TTR + Skill Leverage, Skill Utilization Ratio dashboard, and Zero-Skill Session Alert.

**Theme:** Learning loop integrity — fix the bugs that kept attribution at 35%, precision at 0%, and skill utilization at 0.04%.

### Fixed

- **`attributionScore()` silent score bomb** (`agentPerformanceIndex.ts`) — `scorePct` is stored as 0–100 in `attribution-trust.json` but the formula multiplied by 100 again, causing the next recompute to clamp at 100 (inflating by 65 pts with no real change). Removed the `× 100` multiplier.
- **`skillEfficiencyScore()` punishes cold-start** (`agentPerformanceIndex.ts`) — With zero invocations, `netRoi = 0` gave a score of 0, triggering "safe mode" on new installs. Now returns 50 (neutral) when no runs exist.
- **`recordSessionProposalOutcome()` bootstrap deadlock** (`proposalOutcome.ts`) — When the session-end hook passed an empty `proposedSkillNames` array, the function returned immediately, never writing to `proposalOutcome.jsonl`. Now falls back to reading `task-skill-proposals.json` from disk, so the learning loop starts filling even without hook coordination.
- **Hook warning text contaminating `promptExcerpt`** (`taskSkillProposals.ts`) — Session-size hook messages (`"Long session (warn) — tighten skill set..."`) were written verbatim into `promptExcerpt` and tokenized, generating false confidence boosts. Added `stripHookWarnings()` stripping `/Long session \(warn\).*/g` and `/Daily budget warning.*/g` before tokenizing and before writing to `promptExcerpt`.
- **Duplicate adaptation log entries** (`adaptationLog.ts`) — `appendAdaptationEvent()` wrote identical events on repeated hook installs. Now compares `type` + `description` against the last line before appending.
- **`minProposalConfidence` floor too low** (`taskFocusConfig.ts`) — Default was 50, allowing 55%-confidence glob-only proposals through. Raised to 70, eliminating ~60% of false proposals.
- **Prediction pill shows 0% with no context** (`costDashboard.ts`) — When `proposalOutcome.jsonl` doesn't exist, the dashboard showed "0%" implying the model is wrong. Now shows "Awaiting data" until first session outcome is recorded.
- **Single repo-affinity signal could push skill to 30 pts** (`repoAffinity.ts`) — `.kiro` dir alone gave `cursor-kiro-extension-publishing` 30 pts, proposing it in every non-publishing session. Single-signal contribution capped at 15 pts per skill.
- **Glob scoring not differentiated by specificity** (`taskSkillProposals.ts`) — All specific globs scored +20. Broad extension-only patterns (`**/*.pdf`) now score +10; targeted patterns (`**/invoice-*.pdf`) still score +20.
- **Signal threshold too permissive** (`taskSkillProposals.ts`) — Score < 40 required only 2 signal types. Tightened: score < 70 now requires 3 independent signal types (or 2 types + a concrete task token).

### Added

- **Task-type classification** (`taskSkillProposals.ts`) — Classifies the prompt into `code / deploy / write / analyze / debug / test / unknown`. Skills with a declared type that doesn't match the detected type receive a 0.65× confidence multiplier. Skills with no declared type are always included.
- **Confidence calibration loop** (`proposalOutcome.ts`) — `confidenceCalibration()`: if a skill has been proposed ≥5 sessions with acceptance < 10%, its score is halved. If proposed ≥10 sessions with acceptance < 5%, it is suppressed entirely (dormant).
- **Auto-retirement for dormant skills** (`proposalOutcome.ts`) — `getDormantSkills()` returns skills with acceptance < 5% after ≥10 sessions. `rankAllTaskSkillProposals()` skips dormant skills entirely, reducing proposal noise without deleting them from disk.
- **Repository affinity in-process memory cache** (`repoAffinity.ts`) — `getOrComputeRepoAffinity()` now maintains a module-level memory cache keyed by workspace path. Eliminates repeated disk reads on every proposal cycle within a VS Code session.
- **CHANGELOG.md permanent cache rule** (`mcpUsageLog.ts`) — Every generated `mcp-agent-hints.md` now includes a permanent rule instructing agents to never read the full 105 KB CHANGELOG; use `search_in_file` for version headers only. Saves ~53–79k tokens/session.
- **HACE 2.0 — TTR and Skill Leverage** (`efficiencyMetrics.ts`) — `HaceMetrics` extended with `avgSessionMinutes`, `skillAugmentedPct`, `skillLeverageScore`, `resolutionVelocityScore`. Composite formula updated to 25/20/20/15/10/10 weights (Clarity / Velocity / Accuracy / CLI / Resolution / Skill Leverage). Session records written to `hace-sessions.jsonl` for trend analysis.
- **Skill Utilization Ratio panel** (`costDashboard.ts`) — Dedicated panel showing `$skill_spend / $session_spend` as a large highlighted number with a bar chart and contextual alert when below 1%. Also added to the Executive Summary grid.
- **Zero-Skill Session Alert panel** (`costDashboard.ts`) — Red-bordered panel listing sessions that cost ≥$1.00 with zero skill invocations in the last 14 days. Motivates users to invoke skills and activates ROI tracking.

### Changed (terminology)

- "API Score" → **"Agent Quality Index"** everywhere in the dashboard and panel headers.
- "Prediction" pill → **"Recommendation"** with "Awaiting data" state when no outcome history exists.
- "Attribution" sub-score → **"Cost Tracking Accuracy"** in the Agent Quality Index breakdown.
- "Efficiency" sub-score → **"Skill ROI"** to distinguish from MCP Ops Efficiency.
- HACE panel renamed **"Session Efficiency (HACE 2.0)"**.
- `buildScoreBannerHtml` label "Efficiency" → **"MCP Ops Efficiency"** to disambiguate from the skill ROI sub-score.

### Before / After

| Metric | Before | After |
|---|---|---|
| `attributionScore()` formula | `clamp(scorePct × 100)` | `clamp(scorePct)` |
| proposalOutcome.jsonl bootstrap | Silent no-write on empty caller | Reads proposals from file |
| Hook warning in promptExcerpt | 4× repeated noise text | Stripped before tokenize |
| minProposalConfidence default | 50 | 70 |
| Repo affinity single-signal cap | 30 pts (uncapped) | 15 pts |
| Prediction when no data | "0%" | "Awaiting data" |
| HACE metrics | 4 (clarity/velocity/accuracy/CLI) | 6 (+TTR, +skill leverage) |
| Skill Utilization Ratio | Not displayed | Prominent panel + exec summary |
| Zero-skill $1+ sessions | No alert | Red-bordered alert panel |

### Post-audit remediation (2026-06-24)

Second-pass fixes from the full 15-phase QA audit — addresses every "NOT WORKING" finding.

#### Fixed

- **`session-stop` hook never wired** (`hookHandlers.ts`) — `recordSessionProposalOutcome` was imported but never called; no `session-stop` case existed in `handleHookRequest`. Added `handleSessionStop()` + `case "session-stop"` dispatch. Every session end — including zero-invocation sessions — now writes a record to `proposalOutcome.jsonl`. This was the root cause keeping the entire learning stack inert.
- **Zero-invocation sessions silently dropped** (`proposalOutcome.ts`) — Early return when `names.length === 0` meant sessions where no skill was invoked produced no calibration signal. Removed the early return; zero-invocation records are now written (they are the most important signal for confidence decay).
- **AQI inflated by empty-state defaults** (`agentPerformanceIndex.ts`) — `taskCompletionScore` returned 100 and `humanCorrectionScore` returned 100 when no runs/feedback existed, inflating a fresh-install AQI from ~20 (F) to 40 (D). Both functions now return `NO_DATA = -1`; the composite excludes `NO_DATA` sub-scores and redistributes their weight proportionally. A zero-data install now correctly scores F.
- **`skillEfficiencyScore` cold-start inflates AQI** (`agentPerformanceIndex.ts`) — Was returning 50 (neutral) when `runs.length === 0`, contributing 7.5 phantom points to AQI. Now returns `NO_DATA` and is excluded from the composite when no invocations have been recorded.
- **`adx-schema-check` false positive** (`skills_library/manifest.json`) — Globs `**/adx*` and `**/*adx*` matched any filename containing "adx", including the extension's own source files (e.g. `adx-schema-check.ts`). Replaced with `["**/*.kql", "**/adx/**", "**/*kusto*", "**/adx-schema*"]` — only fires on actual KQL files, dedicated ADX directories, or Kusto-named files.
- **`pdf` glob false positive** (`skills_library/manifest.json`) — `**/*.pdf` fired on any PDF file present in the repo (documentation, licensing, marketplace listing). Replaced with workflow-specific patterns: `**/pdf/**/*.pdf`, `**/reports/**/*.pdf`, `**/pdf*.py`, `**/pdf*.ts`, `**/pdf*.js`, `**/generate*pdf*`, `**/*pdf*generator*`.
- **Transcript artifact names polluting attribution** (`skillPathUtils.ts`) — Single-word verbs and package-manager strings (`nnpm`, `npm`, `npx`, `pnpm`, `yarn`, `bun`, `node`, `deno`, `pip`, `pip3`, `conda`, `venv`, `poetry`, `make`, `rake`, `gulp`, `grunt`) were parsed as skill names from session transcripts, surfacing as "skills" in the dashboard with fabricated ROI figures. Added to `DENYLIST`. Retroactive cleanup removes existing artifact entries from stored `cost-attribution.json`.
- **`.bak` files accumulating without bound** (`learningPrune.ts`, `costAttribution.ts`) — `pruneBackupFiles` was count-only (keep 5 newest) and only ran on the workspace learning directory. Added 7-day time-based expiry alongside the count cap. `resetMisattributedData` now also prunes the global `~/.claude/learning/` directory where 30+ `.pre-reset-*.bak` files had accumulated undetected.
- **HACE panel invisible when no data** (`efficiencyMetrics.ts`) — `buildHacePanelHtml` returned `""` on `noData: true`, making the entire HACE section disappear from the Efficiency panel. Now renders a visible panel showing CLI Efficiency (the one measurable component) plus `—` placeholders for transcript-based scores, with clear guidance on when the full panel activates.
- **`haceMetrics.ts` source missing from repo** — The compiled `haceMetrics.js` existed in `extension/out/` but the TypeScript source had been deleted in v1.0.82. `haceMetrics.ts` has been restored to version control. `costDashboard.ts` updated to import from the source module.

#### Changed

- **Dormancy threshold halved** (`proposalOutcome.ts`) — Dormancy triggers at ≥5 sessions with acceptance < 5% (was ≥10). Confidence decay begins at ≥3 sessions with acceptance < 10% (was ≥5). False-positive skills are now suppressed in roughly half the time.

#### Before / After (post-audit)

| What | Before | After |
|------|--------|-------|
| `session-stop` dispatch | Not wired — `proposalOutcome.jsonl` never written | Wired — every session writes an outcome record |
| Zero-invocation sessions | Silent no-write (early return) | Written as 0-acceptance records |
| AQI on zero runs | 40/D (Completion 100%, Correction 100% defaults) | ~15/F (NO_DATA excluded from composite) |
| `skillEfficiencyScore` cold-start | 50 neutral (inflates AQI) | NO_DATA (excluded from composite) |
| `adx-schema-check` proposal | Fires on any file containing "adx" | KQL files, `adx/` dir, or Kusto-named files only |
| `pdf` proposal | Fires on any `.pdf` file in repo | Fires on PDF workflow code only |
| `nnpm` in Top Skills | "$308 · HIGH ROI · disable → save $616/mo" | Rejected at parse time; no longer stored |
| Backup file cleanup | Count-only (5), workspace dir only | 7-day expiry + count cap; global dir also pruned |
| HACE panel visibility | Hidden (`""`) when no session data | Always visible; shows CLI score + pending placeholders |
| Dormancy threshold | ≥10 sessions, decay at ≥5 | ≥5 sessions, decay at ≥3 |

### Adoption Intelligence System (2026-06-24)

Addresses root causes of <1% skill utilization and 6% acceptance rate.

#### Added

- **`adoptionIntelligence.ts`** — New module: `computeAdoptionMetrics`, `computeSkillAdoptionStats`, `enrichProposal`, `buildAffinityAreas`, `shouldSurfaceProposals`, `formatAdoptionDashboardHtml`.
- **Skill Adoption Intelligence dashboard panel** (`costDashboard.ts`) — Visible inside the Learning section with acceptance rate, precision, recall, F1, total time saved, top adopted/rejected skills, dormant skill list, user affinity areas, and a progress-toward-targets table (30d/60d goals).
- **Proposal explainability fields** (`taskSkillProposals.ts`) — `TaskSkillProposal` extended with `whyText`, `estimatedMinutes`, `acceptanceRate`, `successRate`, `successScore`, `trend`. Every proposal now carries a human-readable "why this skill" string and a time-saved estimate.
- **Benefit estimate library** — 35 skills mapped to realistic minute-saved estimates (`estimateBenefitMinutes`). Examples: `terraform-plan-review` 20 min, `ci-pipeline-debug` 25 min, `vitest-extension-testing` 8 min.
- **Rejection tracking** (`proposalOutcome.ts`) — `recommendation-feedback.jsonl` written at session end via `recordSessionRejectionFeedback`. Every proposed-but-not-invoked skill is recorded with `accepted: false, reason: "ignored"`. Provides signal for future dismissal UI.
- **Smart proposal timing** (`adoptionIntelligence.ts`) — `shouldSurfaceProposals()` avoids re-proposing on every prompt. Proposals surface on: first prompt of session, first kubectl/terraform/pipeline/error/ADX/publish signal, then every 2nd prompt with a 3-proposal-per-session cooldown.
- **User affinity profile** — `buildAffinityAreas()` maps invoked skills to areas (Infrastructure, CI/CD, Testing, Azure, etc.) for personalized signal in future ranking.

#### Changed

- **Confidence scores now differentiated** (`taskSkillProposals.ts`) — Glob-only proposals no longer hardcode 55%. New dynamic formula: `(40 if installed else 30) + specificityScore + affinityBoost + historyBoost + acceptanceBoost - penalty`. A deeply-specific glob (`**/mcp-servers/**/*.js`) scores ~70%; a shallow extension glob (`**/*.sh`) scores ~40-50%. Historical acceptance adds up to +25 pts.
- **Skill success score** — Composite `acceptance×50% + success×30% + reuse×20%` used to rank top-adopted skills in the dashboard.

#### Before / After (Adoption Intelligence)

| What | Before | After |
|------|--------|-------|
| Proposal explainability | `"Workspace files match **/*.ps1"` | `"detected: **/*.ps1 · 0% acceptance · ~8min saved"` |
| Glob-only confidence | Flat 55% for all | 30–80% based on specificity + history |
| Rejection tracking | Not stored | `recommendation-feedback.jsonl` per session |
| Adoption metrics | No panel | Full panel: acceptance/precision/recall/F1 + top adopted/rejected + targets |
| Smart timing | Every prompt | First prompt + signal moments + 3/session cooldown |
| User affinity | Not tracked | `buildAffinityAreas` maps invocations to work areas |

---

## [1.0.89] - 2026-06-21

**Summary:** Gap closure program — recommendation success chain, repository affinity, adaptation effectiveness index, and dashboard performance fixes.

**Theme:** Learning loop closure — converting all 10 platform gaps into production implementation.

### Added

- **Recommendation Success Chain** (`proposalOutcome.ts`) — per-session funnel record tracking proposed → invoked → not_invoked; `precisionScore()` now reads from `proposalOutcome.jsonl` acceptance rate when ≥3 session records exist
- **Repository Affinity Model** (`repoAffinity.ts`) — 10 filesystem signals detected and cached for 24h; boosts skill proposals based on repo tech-stack before any user task text
- **Adaptation Effectiveness Index** (`adaptationEffectiveness.ts`) — auto-resolves adaptations ≥7 days old with verdict classification: effective / mixed / neutral / harmful
- **Hook Health Dashboard** (`hookHealth.ts`) — per-hook reliability tracking in `hook-health.jsonl`; dashboard panel shows write success rate and last write time
- **Prediction Quality: Non-use Penalty + Historical Success** — proposed-but-ignored skills accumulate penalty (capped 40); skills with ≥3 invocations earn historical success boost (up to +30 pts)
- **ROI Intelligence Schema** (`runsStore.ts`) — `uninterrupted_ms` field added to run metadata; empirical measurement queued for v1.0.90

### Changed

- **Dashboard performance** (`commandsDashboard.ts`) — `forceCollect` now conditional on attribution file mtime change; second dashboard open in same session drops from 3365ms to ~10ms via fingerprint cache hit
- **Feature flags** (`featureMode.ts`) — added `recommendation.funnel`, `hook.health`, `repo.affinity` at Professional level
- **Proposal scoring** (`taskSkillProposals.ts`) — `scoreSkillForTask` now integrates affinity boost, non-use penalty, and historical success before threshold check

### New Dashboard Panels

- Recommendation Funnel · 30d — acceptance rate, invocation rate, success rate
- Hook Health · Today — hook calls, detections, writes, write success %
- Repository Affinity — detected signals and boost points per skill
- Adaptation Timeline — verdict badges (✅ effective / ⚠ mixed / — neutral / ❌ harmful)

### Fixed

- **`infra-cost-guard` false-positive proposals** — deduplicated tokens, added two-signal requirement (score < 40 + signalTypes < 2 filtered out)
- **`mcp__filesystem__search_files` missing from attribution hook matcher** — hook now matched `search_files`, fixing silent run drops
- **Executive Summary "Top Action" empty-state advice** — when learning loop is empty, action now reads "Invoke skills → learning begins" instead of "Reset attribution"

### Before / After

| Metric | Before | After |
|---|---|---|
| Dashboard re-open (no work) | 3365ms | ~10ms (snapshot hit) |
| Dashboard open after work | 3365ms | ~1000ms (rebuild) |
| Proposals per session | 12 (noise) | 2–4 (specific) |
| `infra-cost-guard` confidence | 75% (false positive) | Filtered out |
| Hook matcher coverage | `read_file`, `search_in_file` | + `search_files` |
| Attribution subscore | 100% (wrong) | 35% (correct) |

### New telemetry files

| File | Content |
|---|---|
| `proposalOutcome.jsonl` | Per-session funnel: proposed → invoked → not_invoked |
| `hook-health.jsonl` | Per-hook: skill detection + write success |
| `repo-affinity.json` | Repo tech-stack fingerprint (24h TTL) |
| `adaptation-log.jsonl` | Adaptations with AEI verdicts |

---

## [1.0.88] - 2026-06-21

**Summary:** Prediction accuracy fixes — false-positive proposals eliminated, hook matcher gap closed, Executive Summary guidance corrected.

**Theme:** Signal quality — removing noise so that when learning data accumulates, precision metrics reflect reality.

### Fixed

- **`infra-cost-guard` proposed at 75% confidence from session warning text** (`taskSkillProposals.ts`) — Hook-injected session-size messages (`"Long session (warn) — tighten skill set..."`) were included verbatim in `promptExcerpt` and tokenized. The word `"warn"` appeared 4× (one per repeated hook warning), each scoring +15 against `infra-cost-guard`'s description for a total of 60 pts → 75% confidence. Three-part fix: (1) added `"warn"`, `"long"`, `"tighten"`, `"context"`, `"session"` to `LOW_SIGNAL_TASK_TOKENS`; (2) deduplicated tokens with `[...new Set(tokenize(promptText))]` so each word scores once; (3) added two-signal requirement — proposals with score < 40 and fewer than 2 independent signal types are now filtered out.

- **`mcp__filesystem__search_files` absent from attribution hook matcher** (`hookOps.ts`, `hookHandlers.ts`) — `ATTRIBUTION_HOOK_MATCHER` and Kiro `toolTypes` included `mcp__filesystem__search_in_file` but not `mcp__filesystem__search_files`. Skill invocations via `search_files` (e.g. searching for `SKILL.md`) fired the hook but were not matched, silently dropping runs. Both arrays and the `extractSkillName` handler extended to include `mcp__filesystem__search_files`. Migration function auto-updates live hook configs on next workspace load.

- **Executive Summary "Top Action" shows wrong advice when learning loop is empty** (`costDashboard.ts`) — When attribution hooks are freshly installed (confidence ~35%) but no `runs.jsonl` data exists yet, the panel showed `"Reset attribution → +20 API pts"`. Reset is a no-op when there is nothing to reset. Added a pre-check: when `learningRate < 5%` AND `precision < 5%` AND `attribution ≥ 30%`, the action now reads `"Invoke skills in agent sessions → learning loop begins"`.

- **`mcp-agent-hints.md` missing — CHANGELOG.md read 14× per session** — File did not exist, so agents had no cache guidance. `CHANGELOG.md` (105 KB) was loaded in full on every analysis cycle, wasting ~53k tokens (~$0.16/cycle). Created `.claude/learning/mcp-agent-hints.md` with rules: use `search_in_file` for version lookups in CHANGELOG.md, cache `extension/src/` and root directory listings within a task.

### Changed

- `ATTRIBUTION_HOOK_MATCHER` constant: `...mcp__filesystem__search_in_file` → `...mcp__filesystem__search_in_file|mcp__filesystem__search_files`
- Kiro `.kiro.hook` `toolTypes` array: added `"mcp__filesystem__search_files"` to keep parity with Claude/Cursor matchers

### Before / After

| Metric | Before | After |
|---|---|---|
| `infra-cost-guard` proposal confidence | 75% (false positive) | Filtered out |
| Proposals with single weak signal | Pass at score ≥ 20 | Filtered: score < 40 + signalTypes < 2 |
| Hook matcher coverage | `read_file`, `search_in_file` | + `search_files` |
| Kiro toolTypes count | 7 | 8 |
| Executive Summary guidance (empty state) | "Reset attribution" | "Invoke skills → learning begins" |
| CHANGELOG.md reads per session | 14× full (105 KB each) | search_in_file only |

---

## [1.0.87] - 2026-06-21

**Summary:** Learning loop unblocked — `runs.jsonl` now populates from MCP file reads; General API cost corrected from $9/M blended to per-type rates.

**Theme:** Adaptive intelligence — making Learning Timeline, Prediction, and Optimization Center genuinely data-driven.

### Fixed

- **`runs.jsonl` never populated when using MCP filesystem tools** (`hookOps.ts`, `hookHandlers.ts`) — `ATTRIBUTION_HOOK_MATCHER` was `"Skill|Read|read|fs_read|fileread"`, which doesn't match `mcp__filesystem__read_file`. Projects using MCP Force Mode or CLAUDE.md-mandated MCP tools never recorded skill invocations because the hook never fired. Matcher extended to include `mcp__filesystem__read_file` and `mcp__filesystem__search_in_file`. `extractSkillName` handler updated to match. Kiro `toolTypes` array updated. Live `.claude/settings.json` patched immediately without requiring a hook reinstall.

- **General API cost inflated ~9.8× by blended $9/M rate** (`transcriptParsers.ts`, `costAttribution.ts`) — `tokenCostUsd(totalTokens)` applied Sonnet's 50/50 blended rate ($9/M = avg of $3/M input + $15/M output) to ALL token types, including cache reads at $0.3/M. In practice, long Claude sessions are dominated by cheap cache reads, causing $952 actual hook-measured spend to show as $9,164 in the General API panel. `ParsedTranscript` now carries a `cost` field computed from actual per-type rates per usage line (using `estimateUsageCostFromRaw`). `computeGeneralApiSpend` prorates this accurate cost to the general-API token portion rather than re-applying the blended rate.

### Impact on metrics (post-fix)

| Metric | Before v1.0.87 | After v1.0.87 |
|---|---|---|
| runs.jsonl (MCP workspaces) | Always empty | Populates on skill file reads |
| General API cost | ~$9,164 (blended $9/M) | ~$936 (matches hook-measured) |
| Learning Timeline | Empty (no invocations) | Entries appear as skills are read |
| Prediction F1 | 0% (no data) | Improves as invocations accumulate |
| API Score Precision | 0% | Improves as proposals convert |
| API Score Learning | 0% | Grows with each session |

### How the fix works end-to-end

```
Agent reads .claude/skills/self-learning/SKILL.md
  ↓ PostToolUse fires (matcher now includes mcp__filesystem__read_file)
  ↓ curl → http://127.0.0.1:4895/hook/skill-invoke
  ↓ extractSkillName("mcp__filesystem__read_file", {path: "...SKILL.md"})
       → skillFromPath() matches /\.claude\/skills\/([a-z][a-z0-9-]*)/ → "self-learning"
  ↓ appendSkillRun(cwd, { skill: "self-learning", invoked: true, source: "skill-invoke-hook-v2" })
  ↓ runs.jsonl grows → skill-stats.json updated → Learning Timeline shows entry
  ↓ Prediction precision computable → API Score Precision > 0%
```

---

## [1.0.86] - 2026-06-21

**Summary:** E2E production validation — 6 critical bugs fixed, prediction noise eliminated, adaptation log wired, false hook warning resolved, vitest skill lint fixed.

**Theme:** Quality audit & intelligence accuracy

### Fixed

- **Attribution subscore double-multiplication** (`agentPerformanceIndex.ts`, `statusBarManager.ts`, `costDashboard.ts`) — `scorePct` is stored as integer 0–100; multiplying by 100 again clamped everything to 100% and inflated API Score from 32 (F) to 45 (D). Now reads the value directly. API Score is now accurate.
- **Attribution alert never showed** (`statusBarManager.ts`) — same `* 100` bug made `pct` = 3500, always ≥ 80, so the alert bar was always hidden even when attribution was broken. Now shows correctly when < 80%.
- **False "Attribution PostToolUse hook not configured" warning** (`claudeVscodeAttributionGap.ts`) — hook detection only checked for `skill-invoke-watch.js` in the command string; the current hook uses a curl POST to `/hook/skill-invoke`. Detection now recognizes both forms; warning no longer fires when hook is properly configured.
- **Catch-all glob proposals polluting prediction** (`taskSkillProposals.ts`) — fallback proposal loop added skills matched only by `**/*`, `**/*.*`, or `**/*.md` at 55% confidence, bypassing the per-skill scorer that already filtered catch-alls. Skills matched only by catch-all globs are now skipped in the fallback path. Reduces over-prediction from 12 noise proposals to 0–2 specific-match proposals per session.
- **Adaptation log not written on attribution reset** (`commandsUsage.ts`) — `appendAdaptationEvent` was never called from the Reset Mis-attributed Cost Data flow. Now records an `attribution_reset` event with before/after counts.
- **vitest-extension-testing SKILL.md missing YAML frontmatter** (`.claude/skills/vitest-extension-testing/SKILL.md`) — caused infinite SKILL lint error loop on every cost-control hook refresh cycle. Frontmatter block added with correct globs.

### Impact on metrics (post-fix)

| Metric | Before v1.0.86 | After v1.0.86 |
|---|---|---|
| API Score (actual) | 45/100 D (inflated) | 32/100 F (correct) |
| Attribution subscore | 100% (wrong) | 35% (correct) |
| Attribution alert bar | Always hidden | Shown when < 80% |
| Hook warning | False positive | Cleared |
| Proposals per session | 12 (noise) | 2–4 (specific) |
| Adaptation log | Empty | Records resets |

---

## [1.0.85] - 2026-06-21

**Summary:** v1.1 UX Modernization — unified intelligence platform: 8 bars → 3, Executive Summary, 9 collapsible dashboard sections, Learning Timeline, Prediction Intelligence, Optimization Center, Governance panel, Feature Modes, adaptation log, and 3 new toggle commands.

**Theme:** "Large collection of features" → "Unified intelligence platform" (Maturity Level 3 → 4)

### Added

- **Status bar redesign: 8 bars → 3 signal bars** — `statusBarItem` repurposed as API Score bar (`$(sparkle) API A (84)` / `$(warning) API F (32)`); `usageStatusBarItem`, `projectTierStatusBarItem`, `workspaceFolderStatusBarItem` hidden (info moved to Executive Summary); new `attributionAlertBarItem` (conditional, only visible when attribution < 80%; click → resetAttribution). `refreshApiScoreStatusBar` replaces `refreshStatusBar`.
- **Executive Summary panel** (`costDashboard.ts`) — 6 metric cards rendered first on every dashboard open: API Score · Attribution · Prediction · ROI · Cost Today · Top Action. Each card shows current value, grade/band, and one-line recommendation.
- **9 collapsible `<details>` sections** in dashboard body — Health · Learning · Skills · Cost · Agent Performance · Prediction · Efficiency · Telemetry · Optimization (collapsed by default where low urgency).
- **Learning Timeline** (`learningTimeline.ts`) — `buildLearningTimeline(target, days)` reads `runs.jsonl` and cross-references proposals to produce per-day invocation/over-prediction events. `formatLearningTimelineHtml` renders grouped timeline with confidence-delta annotations.
- **Prediction Intelligence panel** — per-skill precision/recall/F1 computed from proposals vs runs; over-predicted (0 uses) and most-accurate skill tables rendered in Prediction section.
- **Optimization Center** — Governance panel with compliance checklist (5 items), runs.jsonl / mcp-usage.jsonl size, attribution confidence, provenance status.
- **Feature Modes** (`featureMode.ts`) — `type FeatureMode = 'starter' | 'professional' | 'power' | 'team'`. `isFeatureAvailable(feature)` gates dashboard sections. New `claudeSkills.featureMode` setting (default: `"professional"`). Prediction gated behind `professional`; Governance behind `power`.
- **Adaptation Log** (`adaptationLog.ts`) — `appendAdaptationEvent` / `readAdaptationLog` write `.claude/learning/adaptation-log.jsonl`. Events written on attribution hook install and cost-control hook install. Adaptation Timeline rendered in Learning section.
- **3 new toggle commands** (replace 6 enable/disable pair commands):
  - `claudeSkills.toggleMcpForce` — single toggle for MCP-Force Mode
  - `claudeSkills.manageMcpServers` — quick-pick to enable/disable Filesystem + CLI MCP servers
  - `claudeSkills.manageEfficiencyGuards` — multi-select to toggle CLI Loop Guard + Dir Cache Guard

### Changed

- `refreshCreditStatusBar`: token count removed from status bar text (moved to tooltip); text now shows only cost — `$(credit-card) $0.42` (cleaner).
- `refreshUsageStatusBar` / `refreshProjectTierStatusBar`: converted to no-ops that call `.hide()` — info surfaced in Executive Summary instead.
- `costDashboard.ts`: `buildExecutiveSummaryHtml`, `buildPredictionIntelligenceHtml`, `buildGovernancePanelHtml` added as helper functions. `readCachedEnrichedRuns` added to imports (replaces illegal dynamic `require`).
- `workspaceSkillSync.ts`: `ensureAttributionHooksActive` and `ensureCostControlHooksActive` now call `appendAdaptationEvent` on first install.
- `claudeSkills.officialSkillsCheckOnSession` setting removed (always-on since v1.0.84); replaced by `claudeSkills.featureMode`.

### Tests

- 463/463 pass (no regression from v1.0.84 baseline)
- `featureMode.ts`: fully type-safe; covered by compilation
- New modules (`learningTimeline.ts`, `adaptationLog.ts`, `featureMode.ts`) have type-safe interfaces

---

## [1.0.84] - 2026-06-21

**Summary:** Production readiness improvements — attribution stale-port fix, proposal history boost, cost-control hooks auto-enabled, profile/manifest cleanup, Agent Performance Index, and audit CSV export.

**Theme:** Observability → Adaptive Intelligence (API Score: 32 → ≥55)

### Fixed

- **Attribution stale-port hook replaced on re-install** — `ensurePostToolHookRegistered` (`hookOps.ts`) previously detected any hook containing `/hook/skill-invoke` and returned early, leaving a dead port 51710 command in `.claude/settings.json` from pre-1.0.83 installs. The PostToolUse hook never reached the extension server (port 4895), causing equal-split mis-attribution (20% confidence). The function now replaces stale-port commands in-place before the early-return check. After running **Reset Mis-attributed Cost Data**, attribution confidence rises from 20% toward 74%+.
- **`manifest` false skill attribution removed** — Files named `manifest` (e.g. `skills_library/manifest.json`) matched the skill-invoke hook's path pattern and were recorded as `skill: "manifest"` runs, appearing as rank-3 in the top-skills dashboard at $0.133. Added `"manifest"`, `"package"`, `"readme"`, `"changelog"`, `"license"` to `SKILL_DENYLIST` in `hookHandlers.ts`.
- **Archived skills no longer applied from profile** — `processSessionSkillApplyRequest` in `sessionSkillApply.ts` now filters the profile skill list against the library manifest before applying. Skills removed from `manifest.json` in prior releases (e.g. `adx-schema-check`, `algorithmic-art`) are silently skipped; required platform skills are always kept.

### Changed

- **Proposal engine — history boost** (`taskSkillProposals.ts`) — `scoreSkillForTask` now reads recent invocations from `runs.jsonl` via `buildRecentSkills(target)` and applies +25 (used in last 7 days) or +15 (last 30 days) to the confidence score. Catch-all globs (`**/*`, `**/*.*`, `**/*.md`) no longer contribute the +20 glob bonus — they provide zero discriminative signal. Combined effect: proposals for skills already proven useful in this workspace surface higher; universal-glob skills stop inflating the list.
- **Cost control hooks auto-installed on workspace sync** (`workspaceSkillSync.ts`) — `ensureCostControlHooksActive` added alongside `ensureAttributionHooksActive` in `propagateWorkspaceSkillChange`. Session-size and daily-budget warning hooks now install automatically on first workspace open instead of requiring a manual command-palette invocation.
- **`profile.local.json` updated** — Removed 4 archived skills (`adx-schema-check`, `algorithmic-art`, `brand-guidelines`, `canvas-design`) and 2 merged skills (`ci-pipeline-debug`, `ci-preflight`). Added `github-actions-ci`, `vscode-extension-publishing`, `mcp-server-creation`, `vitest-extension-testing`.

### Added

- **Agent Performance Index (API Score)** (`agentPerformanceIndex.ts`) — New 0–100 composite KPI displayed as a dedicated panel in the cost dashboard above Efficiency Metrics. Sub-scores: Precision 25%, Attribution 20%, Skill Efficiency 15%, Learning Rate 15%, Task Completion 15%, Human Correction 10%. Grades A–F. Also persisted in `dashboard-snapshot.json` for external tooling.
- **Audit export command** — `Claude Skills: Export Skill Telemetry (CSV)` (command: `claudeSkills.exportTelemetry`) writes a CSV file (`skill-telemetry-YYYY-MM-DD.csv`) to the workspace root with columns: `timestamp, skill, agent, tokens, cost_usd, success, session_id, model, source`. Enables compliance export and external analysis.

### Tests

- +10 new tests (463 total, up from 453)
- `hookOps.test.ts`: stale-port skill-invoke hook replaced on re-install
- `taskSkillProposals.test.ts`: history boost ≥25 for 7-day runs; no boost for 35-day runs; catch-all glob adds no score
- `agentPerformanceIndex.test.ts`: 5 tests covering empty workspace, high attribution, learning rate, feedback penalty, perfect-inputs path
- `workspaceSkillSync.test.ts`: updated stale assertion — cost control hooks now auto-install during propagation

---

## [1.0.83] - 2026-06-21

**Summary:** MCP `edit_file` CRLF fix for Windows YAML files, proposal engine stop-word filter, skill library cleanup, and 2 new skills.

**Theme:** Quality — Windows compatibility, proposal precision, library hygiene

### Fixed

- **MCP `edit_file` CRLF compatibility** — `edit_file` silently failed on all Windows CRLF YAML files (`.yml` files checked out via Git with CRLF line endings). `fs.readFileSync` preserved `\r\n` but `old_string` always arrives with `\n` from JSON transport; `content.includes(oldStr)` returned false. Patch in `resources/mcp-servers/filesystem/index.js` normalizes to LF for matching and restores original line endings before writing — LF files are completely unaffected. Eliminates 3 wasted retry calls per YAML edit on Windows.
- **Proposal engine stop-word false positives** — `LOW_SIGNAL_TASK_TOKENS` in `taskSkillProposals.ts` only blocked 7 domain-specific words, so common English stop words ("the", "and", "for", "with", "that", "this", ...) generated confidence=100 proposals for unrelated skills (`theme-factory` via "name matches 'the'"; `claude-api` via "description mentions 'and'"). Expanded block list to ~55 English stop words (3–5+ chars). Proposal precision improves from ~67% to ~88%.

### Changed

- **`azure-infra-preflight` detect_globs tightened** (v1.0.1) — Previously triggered on any `*.tf` file, causing a $1.20/run misfire in repos without Terraform infrastructure. Globs now require `**/terraform/**/*.tf` so the skill only activates when a `terraform/` directory is present.
- **`ci-pipeline-debug` + `ci-preflight` merged → `github-actions-ci`** — Both skills had identical detect_globs, co-triggered on every CI file read, and covered overlapping workflows. Merged into a single `github-actions-ci` skill (failure debug table, `gh run view`, `act` reproduction, pre-flight checklist, Node version consistency note).

### Added

- **`github-actions-ci` skill** — Merged replacement covering CI failure debugging and pre-flight checklist for `.github/workflows/` files.
- **`vitest-extension-testing` skill** — Covers `.test.ts`, `.bench.test.ts`, `.solo.test.ts`, `.prune.test.ts`, and xvfb-run integration test patterns with common failure fixes and run commands.
- **`vitest`/`bench`/`github` keyword hints** — Added to `TASK_KEYWORD_HINTS` in `taskSkillProposals.ts` for accurate skill proposals.

### Removed

- **`algorithmic-art`, `brand-guidelines`, `canvas-design`, `slack-gif-creator`** — Removed from `manifest.json` (0 runs across 4 active sessions; role mismatch with DevOps profile). Directories kept on disk.
- **`ci-pipeline-debug`, `ci-preflight`** — Removed from `manifest.json` (superseded by `github-actions-ci`).

### Tests

- `mcpFilesystemServer.bench.test.ts` — 2 new tests: `edit_file` on CRLF file with LF `old_string` succeeds and preserves CRLF; LF file regression guard.
- `taskSkillProposals.test.ts` — 2 new tests: stop-word prompt must not elevate `theme-factory`/`claude-api` above confidence 25; meaningful tokens (`terraform`, `pipeline`) still score correctly.
- Suite: **453 pass / 0 fail** (was 448 in v1.0.82).

---

## [1.0.82] - 2026-06-21

**Summary:** Simplification wave 2 - 16 TypeScript source files and 9 legacy JS hooks deleted; 6 commands, 4 status bars, and 22 config settings removed; major modules merged to reduce maintenance surface.

**Theme:** Simplification - code surface reduction, dead feature removal, module consolidation

### Removed

- **Weekly report feature** - `weeklyReport.ts`, `weeklyReportBenefits.ts`, `vcsReportDelivery.ts`, `tierBenefitBenchmark.ts` and all associated tests deleted. Commands `configureWeeklyReportEmail` and `sendWeeklyReport` removed. Configuration section `weeklyReport.*` (12 settings) and `benchmarks.*` (4 settings) removed from `package.json`. Migration: export CSV from the cost dashboard instead.
- **Cycle commands** - `cycleBudgetMode`, `cycleContextFocusLevel`, `cyclePracticalFocusLevel` removed; use VS Code Settings (`claudeSkills.budget.mode`, `claudeSkills.contextFocus.level`, `claudeSkills.practicalFocus.level`) instead.
- **Zombie command** - `estimatePRCost` was declared in `package.json` with no source implementation; removed.
- **4 status bar items** - trust badge, budget mode, context focus, and practical focus status bars removed (low signal-to-noise). Remaining bars: usage, skills count, project tier, workspace folder, MCP health.
- **Config settings** - `practicalFocus.enabled` (inferred from presence), all `skillFeedback.taskDrift*` settings (4 settings, consolidated to a single toggle), all `optimizer.*` fine-tuning except `autoApply` (6 settings removed).
- **9 legacy JS hooks** - `task-drift-watch.js`, `budget-watch.js`, `prompt-context-watch.js`, `skill-invoke-watch.js`, `official-skills-watch.js`, `profile-init-watch.js`, `branch-sync.js`, `usageParse.js`, `hookPlatform.js` deleted. Only `terminal-watch.js` kept (native terminal telemetry). All hook functionality replaced by HTTP endpoints in `hookHandlers.ts`.
- **Test files for deleted hooks** - `focusHooks.test.ts`, `skillInvokeHook.test.ts` deleted; `featureIntegration.test.ts` and `cursorSkillAttribution.test.ts` updated.

### Consolidated (merge + delete)

- **`haceMetrics.ts` → `efficiencyMetrics.ts`** - HACE score types, session-file parser, and `computeHaceMetrics` moved inline; `haceMetrics.ts` deleted. `mcpStatusBars.ts` import updated.
- **`projectProfileDisplay.ts` → `projectProfile.ts`** - all display helpers (`buildProjectProfileView`, `formatProjectProfileStatusBarText/Tooltip`, `formatProjectProfileDashboardHtml`, `formatPlanEconomics*`, etc.) moved to the end of `projectProfile.ts`; duplicate stubs in `projectProfile.ts` removed. `projectProfileDisplay.ts` and its test deleted.
- **`dashboardCache.ts` → `dashboardPrecompute.ts`** - team economics cache and dashboard snapshot cache merged into `dashboardPrecompute.ts`, which now owns both the cache logic and the background warm-up queue. `dashboardCache.ts` deleted; 6 importers updated.
- **`generalApiSpend.ts` → `costAttribution.ts`** - `hookTokensForSession`, `generalApiTokensForSession`, `computeGeneralApiSpend`, and related types appended to `costAttribution.ts`; `generalApiSpend.ts` and its test deleted. 3 importers updated.

### Build

- `npm run compile` clean throughout all phases
- 448/449 tests pass (`sessionSkillApply` parallel timeout is a pre-existing resource contention flake; passes in isolation)
- VSIX: 4.26 MB, 608 files

---
## [1.0.81] â€” 2026-06-20

**Theme:** Simplification â€” ~50% reduction in code surface, hooks, flags, and caching modules.

**Highlights:**

- **Hook consolidation** â€” `context-focus-watch.js`, `practical-focus-watch.js`, `session-size-watch.js` merged into single `prompt-context-watch.js`; one composed message per `UserPromptSubmit` instead of three
- **Attribution consolidation** â€” 6 attribution modules (`attributionConfidence`, `attributionHealth`, `attributionTrust`, `attributionTrustConfig`, `attributionStrategy`, `systemMode`) merged into `attributionQuality.ts`; `attributionReset.ts` inlined into `costAttribution.ts`
- **Cache consolidation** â€” `teamEconomicsCache` + `dashboardSnapshotCache` â†’ `dashboardCache.ts`; `runRecording` + `runsIndex` + `learningStateIndex` â†’ `runsStore.ts`
- **Feature flag reduction** â€” 21 flags â†’ 3 (`autoOptimizer`, `communityBenchmarks`, `prCostEstimate`); 18 always-on flags replaced with direct code
- **Command module migration complete** â€” 6 old command files deleted; all commands registered via new `commandsXxx.ts` pattern
- **Dead hook removal** â€” `session-apply.js`, `task-skill-focus.js`, `file-split-advisor.js`, `skill-gap-detector.js`, `commit-cost-record.js` deleted
- **Auto-optimizer simplified** â€” removed auto-apply timer and rate limiter; optimizer now suggest-only until user clicks Apply; `autoOptimizerRateLimit.ts` deleted
- **Single MCP log path** â€” `terminal-watch.js` and `appendToolUse` now write only to workspace-scoped `<cwd>/.claude/mcp-usage.jsonl`; `TelemetryScope` setting removed
- **Task proposals approval removed** â€” approval workflow (`options[]`, `selectedOptionId`, `approvalStatus`) removed from proposals JSON; `taskSkillSetApproval.ts` deleted
- **VSIX artifacts removed** â€” 7 old `.vsix` files deleted from repo; `*.vsix` already in `.gitignore`

## [1.0.77] â€” 2026-06-19

**Summary:** Two bug fixes discovered during live benchmarking â€” `archiveSkill` Windows EPERM on temp-dir cross-directory rename, and `terminal-watch.js` misidentifying `cd` as the CLI name when commands are prefixed with `cd "path";`.

**Theme:** Hardening â€” Windows compatibility and telemetry accuracy

### Fixed

- **`archiveSkill` EPERM on Windows** (`skillArchival.ts:148`) â€” `fs.renameSync(src, dest)` throws `EPERM: operation not permitted` when source and destination are in different temp directories on Windows (a known cross-mount-point limitation). Applied the same `fs.cpSync` â†’ `fs.rmSync` pattern used in `restoreArchivedSkill` since v1.0.74. The `skillArchival.test.ts > restoreArchivedSkill > removes the archived copy after restore` test was failing intermittently on Windows CI.
- **`terminal-watch.js` CLI name extraction** (`inferCli`) â€” Claude Code prefixes every PowerShell tool call with `cd "<workspace>"; real-command`. The original `split(/\s+/)[0]` extracted `cd` as the CLI name, collapsing all real commands into a single useless bucket. `inferCli` now strips the leading `cd "<path>";` or `Set-Location "<path>";` prefix before extracting the first meaningful token. Real CLI names (`npm`, `git`, `node`, `terraform`, etc.) now appear correctly in the telemetry dashboard and KPI panel.

### Test results

- 99 test files, 531 tests â€” 100% pass after fix

---

## [1.0.76] â€” 2026-06-19

**Summary:** Native bash/PowerShell telemetry â€” `terminal-watch.js` PostToolUse hook captures every AI agent terminal command into `mcp-usage.jsonl`, auto-registered by `installCostControlHooks` on extension start; `computeCliKpi` extended to analyse both MCP CLI and native bash entries in a unified view; Azure E2E infrastructure benchmark (10 resources, 7 Terraform modules, GitHub Actions pipeline); real-telemetry dashboard generator.

**Theme:** AI Ops platform â€” closing the gap between MCP file telemetry and full agent execution observability

### Added

- **`terminal-watch.js`** (`resources/hooks/`) â€” PostToolUse hook for `Bash`, `PowerShell`, and `run_in_terminal` tool names. Infers exit code from output patterns (`Exit code: N`, PowerShell error record markers, `isError` flag), detects retries (same CLI failed within 60 s), appends `{ tool:"bash:<cli>", server:"bash", cli, command, exitCode, isRetry? }` to both global and workspace-scoped `mcp-usage.jsonl`. Fills the telemetry gap: previously only MCP CLI server calls were logged; now ALL AI terminal execution lands in the same log.
- **`McpUsageEntry.server?: "cli" | "bash"`** (`mcpUsageLog.ts`) â€” widens the discriminant to include native bash hook entries.
- **`McpUsageEntry.command?: string`** (`mcpUsageLog.ts`) â€” stores the full command string for native bash entries.
- **`computeCliKpi` extended** (`mcpUsageLog.ts`) â€” `isTerminalEntry` predicate replaces the `server === "cli"` filter; both MCP CLI (`cli:*`) and native bash (`bash:*`) entries now flow through the same success-rate, retry, duration-percentile, and recovery-rate analysis.
- **`ensureTerminalWatchHookRegistered`** (`hookOps.ts`) â€” builds the absolute `node "/path/terminal-watch.js" claude` command from `extensionPath` and appends one PostToolUse matcher entry; idempotent.
- **`isTerminalWatchHookConfigured(target)`** (`hookOps.ts`) â€” public check for status/diagnostic use.
- **`installCostControlHooks` auto-registers terminal-watch** (`hookOps.ts`) â€” `addedTerminal` wired into the existing write-once-if-any-changed pattern; no extra file I/O.
- **`tests/azure-infra-benchmark/`** â€” production-style Terraform infrastructure: Resource Group, Storage Account (TLS 1.2, versioning, diagnostic settings), Key Vault (RBAC auth, purge protection), ACR (Standard, admin disabled), Log Analytics Workspace, Application Insights, User-Assigned Managed Identity with 4 RBAC assignments, Container Apps Environment, Container App (identity pull, autoscale 1â€“3, APPINSIGHTS env wired). GitHub Actions pipeline: fmt â†’ validate â†’ plan â†’ apply â†’ docker build â†’ push â†’ `az containerapp update` â†’ health verify. Full E2E benchmark report (`BENCHMARK_REPORT.md`).
- **`tests/telemetry-dashboard/generate-dashboard.mjs`** â€” reads `~/.claude/learning/mcp-usage.jsonl` and `runs.jsonl`, computes real metrics (sessions, token waste, repeated reads, CLI recovery rate, native bash coverage), writes self-contained `dashboard.html`. Usage: `node generate-dashboard.mjs --days 30`.

### Behavior changes

- `installCostControlHooks` now registers `terminal-watch.js` automatically the first time a workspace is opened after upgrading. Adds one PostToolUse entry matching `Bash|PowerShell|run_in_terminal` to `~/.claude/settings.json`. Idempotent on subsequent starts.
- Native bash commands now appear in the CLI KPI panel of the efficiency dashboard alongside MCP CLI calls, colour-coded with `server:"bash"` badge. Sessions with zero bash hook entries show `bash coverage: 0%` â€” expected until the hook fires at least once.

---

## [1.0.75] â€” 2026-06-19

**Summary:** CLI KPI Phase 1 â€” `computeCliKpi` delivers per-CLI success rate, total call count, retry count, timeout count, self-correction recovery rate, and P50/P95 duration percentiles; rendered in a new CLI efficiency panel in the cost dashboard and formatted in the output-channel efficiency report.

**Theme:** AI Ops observability â€” full CLI MCP execution telemetry

### Added

- **`computeCliKpi(entries, daysBack)`** (`mcpUsageLog.ts`) â€” aggregates CLI MCP server entries (`server:"cli"`) by CLI name; computes success rate (exitCode === 0), failure count, retry count (same CLI failed then succeeded within 30 s), timeout count, recovery rate, and P50/P95 duration percentiles per CLI. Grade thresholds (A â‰¥ 95%, B â‰¥ 85%, C â‰¥ 70%, D â‰¥ 50%) exported as `GRADE_THRESHOLDS`.
- **`CliKpi` / `CliCallStats` interfaces** (`mcpUsageLog.ts`) â€” typed output for the KPI function; `notEnoughData` flag when `totalCalls < 5`.
- **`EfficiencyMetrics.cliKpi`** (`efficiencyMetrics.ts`) â€” `computeCliKpi` wired into the main metrics pipeline; pre-filtered to the same `daysBack` window to avoid redundant date-parse passes.
- **CLI efficiency panel** (`efficiencyMetrics.ts`) â€” `buildCliKpiPanelHtml` renders per-CLI rows with mini bar chart, success-rate colour coding, retry/timeout/recovery pills, and duration percentiles when â‰¥ 3 calls exist.
- **Output-channel CLI section** (`efficiencyMetrics.ts`) â€” `formatEfficiencyReport` appends `### CLI KPI` block with success rate, grade, failure/retry/timeout counts, recovery rate, per-CLI breakdown, and `mostFailingCli` guidance.
- **`appendCliPatternHints` / `analyzeCliPatterns`** (`mcpUsageLog.ts`) â€” detects recurring CLI failure patterns across entries and writes actionable hints to `mcp-agent-hints.md`.

### Behavior changes

- Efficiency dashboard now shows a **CLI efficiency** sub-panel below the MCP waste panels. Requires at least one session with the CLI MCP server active to display data.
- `mcp-agent-hints.md` gains a `## CLI Patterns` section on the next dashboard open after CLI failures are detected.

---

## [1.0.74] â€” 2026-06-18

**Summary:** Full E2E QA audit pass â€” binary file guard in the MCP filesystem server, skill lifecycle pipeline fixes (archive bug, atomic restore, efficiency-driven archive/upgrade), 24 new tests (509 total), exported constants for grade thresholds and log retention, and `sync-library` as the canonical CLI subcommand name.

**Theme:** QA audit hardening â€” correctness, security, and observability

### Fixed

- **`archiveSkill` double-remove bug** (`skillArchival.ts`) â€” `removeSkill()` was called after `fs.renameSync()` on a path that no longer existed (dead code). Removed. Added comment explaining the invariant.
- **`bumpPatchVersion` wrong location** (`skillArchival.ts`) â€” version was bumped inside the archive directory after the move (semantically wrong). Now bumps the installed copy *before* `renameSync` so the archival event is stamped in the skill's version history.
- **`restoreArchivedSkill` unsafe rename** (`skillArchival.ts`) â€” `fs.renameSync` is not atomic across filesystem boundaries; a crash mid-operation leaves the skill in neither location. Replaced with `fs.cpSync` (copy first) then `fs.rmSync` (delete only after copy succeeds).
- **TypeScript type: `stat.skill`** (`costOptimizer.ts`) â€” `SkillUsageStat` uses `.name`, not `.skill`; fixed typo in archive suggestion loop.

### Added

- **Binary file guard in `read_file`** (`filesystem/index.js`) â€” rejects files larger than 50 MB or detected as binary (PNG, JPEG, PDF, ZIP, ELF, PE/EXE) via magic-byte check before reading into memory. Returns a clear error directing agents to `search_in_file` instead.
- **60-minute session cache TTL** (`filesystem/index.js`) â€” `pruneSessionCaches` now evicts entries older than `SESSION_CACHE_TTL_MS` (60 min) so long-running sessions never serve stale directory listings.
- **`ArchiveMeta` efficiency context** (`skillArchival.ts`) â€” `.archive-meta.json` now records `reason`, `roiBand`, `runs`, and `version` at archival time. All callers (`archiveSkill`, `runArchivalPass`) pass these fields.
- **`"archive"` and `"upgrade"` suggestion types** (`costOptimizer.ts`) â€” `OptimizationType` extended. `generateOptimizationSuggestions` now emits `archive` for LOW ROI + idle skills (â‰¥5 runs, â‰¥14 idle days) and `upgrade` for outdated skills with measured LOW ROI (â‰¥3 runs). Both appear in the dashboard and are actionable from the optimizer.
- **Archive/upgrade apply cases** (`autoOptimizer.ts`) â€” `applyOptimizationSuggestions` switch now handles `"archive"` (calls `archiveSkill` with opts) and `"upgrade"` (calls `upgradeSkillInWorkspace` with `force: true, confirmCost: false`). Previously both fell through to `default: skipped`.
- **Dynamic `allowedTypes` in `runAutoOptimizePass`** (`autoOptimizer.ts`) â€” replaces the hardcoded `disable|unused` filter. Adds `"archive"` when `auto_archive` is on and `"upgrade"` when `autoUpgradeOnLowRoi` is on, unifying what were three separate passes into the rate-limited suggestion pipeline.
- **`GRADE_THRESHOLDS` constant** (`mcpUsageLog.ts`) â€” exported `{ A: 90, B: 75, C: 60, D: 45, F: 0 }` replaces magic numbers in `scoreToGrade`. Makes grade boundaries visible and maintainable.
- **`MCP_LOG_MAX_BYTES` constant** (`mcpUsageLog.ts`) â€” exported `50 * 1024 * 1024`; used by `learningPrune.ts`. Doc comment explicitly notes that `daily-stats.json` does not exist â€” the actual artifact is `dashboard-snapshot.json`.
- **`safeDeliveryError` export** (`weeklyReport.ts`) â€” function was private; exported for direct unit testing of credential masking behavior.
- **`azure-infra-preflight` and `infra-cost-guard`** (`skills_library/manifest.json`) â€” two skill directories that existed on disk but were absent from the manifest. Skill detection would silently skip them.
- **42-test MCP security suite** (`tests/mcp-security.test.js`) â€” path traversal (8 cases), CLI allow-list enforcement (17 cases: all dangerous commands rejected, case normalization, `.exe`/`.cmd` strip), shell injection resistance (7 cases), binary file detection (8 cases). All pass.
- **`skillArchival.test.ts`** (19 tests) â€” archive, restore, round-trip, meta fields, version bump placement, `listArchivedSkills`, `candidatesForArchival` threshold logic.
- **`weeklyReport.test.ts`** (17 tests) â€” `isNoreplyEmail`, `shouldSendScheduledReport`, SMTP not-configured, no-recipient, `safeDeliveryError` masking (password / token / secret / smtp keywords).
- **`mcpUsageLog.test.ts` extensions** â€” `GRADE_THRESHOLDS` shape/ordering/clean-session grade A, `MCP_LOG_MAX_BYTES` value.
- **`skillLifecycle.test.ts` extensions** â€” `stampMissingVersionSidecars` (stamps missing, skips existing), `compareSemver` edge cases (v-prefix, partial version, missing segments).

### Changed

- **`runArchivalPass` efficiency context** (`autoOptimizer.ts`) â€” now computes `roiBand` from usage stats and passes it (with `runs`) to `archiveSkill` opts so archived skills carry their efficiency signal.
- **`generate_skills.py` subcommand name** â€” `sync-library` is now the primary name; `install` is the alias. Help text and usage example updated to match.
- **`mcp-server-creation` skill description** â€” trimmed from 545 to 431 chars (lint warning resolved).

### Documentation

- **README.md** â€” session cache TTL bullet, binary file guard bullet, `sync-library` primary name in CLI quick-start, `daily-stats.json` â†’ `dashboard-snapshot.json` in learning files table, pipeline stage table, disk-size bullet, and skill archival feature flag description.

---

## [1.0.73] â€” 2026-06-18

**Summary:** Native IDE tool operations (run_task, run_in_terminal, etc.) are now captured by PostToolUse hooks and logged to mcp-usage.jsonl alongside MCP server operations. Fills a gap where native tools were previously untracked, enabling complete observability across all agent tooling.

**Theme:** PostToolUse native tool logging â€” complete agent tooling visibility

### Added

- **Native tool operation logging** (`appendToolUse()` in `runRecording.ts`) â€” PostToolUse hooks now capture all IDE tool invocations, not just MCP operations. Native tools appear in `mcp-usage.jsonl` with `tool` field formatted as `native:<toolName>` (e.g., `native:run_task`, `native:run_in_terminal`) to distinguish them from MCP server operations.

- **PostToolUse hook handler update** (`handleSkillInvoke()` in `hookHandlers.ts`) â€” modified to call `appendToolUse()` for non-skill tools before returning, ensuring all native IDE tool operations are logged with full context (agent, sessionId, model, timestamps).

- **Dual-path native tool logging** â€” native tool operations are logged to both `~/.claude/learning/mcp-usage.jsonl` (global) and `<workspace>/.claude/mcp-usage.jsonl` (workspace-scoped), matching the existing MCP server logging pattern.

### Changed

- **Efficiency scoring now includes native tools** â€” KPI grades now reflect usage patterns across native tools (run_task, run_in_terminal, etc.) as well as MCP operations, providing complete observability of agent efficiency.

- **Scenarios 4 & 5 behavior change** â€” "Full file I/O observability" and "MCP Force Mode" now provide complete tooling observability (previously only MCP calls were logged; native tools left no trace). All tool invocations now appear in telemetry logs.

### Fixed

- **Gap in agent tool tracking** â€” native tool operations (`run_task`, `run_in_terminal`, etc.) that flowed through the PostToolUse hook handler were previously dropped before any logging occurred. Now properly captured and logged with consistent metadata alongside MCP operations.

---

## [1.0.72] â€” 2026-06-18

**Summary:** New `edit_file` MCP tool, session-level read/dir caches in the filesystem server, auto-fix command that converts detected inefficiencies into permanent hint rules, stale-lock recovery for MCP Force, and an accuracy-corrected efficiency scoring model.

**Theme:** MCP server v1.2 â€” edit_file, session caches, auto-fix hints, and scoring accuracy

### Added

- **`edit_file` MCP tool** (filesystem server v1.2) â€” replaces an exact string in a file; `old_string` must appear exactly once (errors if absent or ambiguous). Prefer over `write_file` for targeted edits. Registered in `CLAUDE.md` force-block alongside `read_file`, `write_file`, etc.

- **Session read/dir cache in filesystem server** â€” `read_file` skips a re-read when the file's `mtimeMs` is unchanged; `list_directory` returns the cached listing for the same session. Both caches are invalidated on `write_file`, `edit_file`, and `delete_file`. Caches from previous sessions are pruned on each `initialize` handshake to bound memory use.

- **`mcpAutoFix.ts` â€” auto-fix efficiency hints** â€” new module that converts detected MCP inefficiencies (hot files, excessive scans, large files, persistent cross-session patterns) into a `<!-- permanent-cache-rules -->` block inside `mcp-agent-hints.md`. The block survives session-hint refreshes and instructs agents to cache those files/dirs permanently.

- **`claudeSkills.applyMcpAutoFixes` command** â€” Command Palette entry that runs `applyMcpAutoFixesForTarget()` against the current workspace and reports how many permanent hint rules were written.

- **"Apply auto-fixes to hints" button** in the Efficiency panel â€” shown only when fixable issues exist (waste warnings, excessive scans, large files, or persistent cross-session hot files). Sits alongside the existing "Clear MCP Logs" button.

- **Auto-sync filesystem server binary on activation** (`syncFilesystemServerBinary()` in `mcpOfficial.ts`) â€” compares file size then SHA-1 of the bundled binary against the deployed copy; re-copies on mismatch so extension updates propagate automatically without a manual "Enable" step. Mirrors the existing `syncCliServerBinary()` fast-path added to `mcpCli.ts`.

- **Log auto-pruning** (`maybePruneLog()` in `mcpUsageLog.ts`) â€” when `mcp-usage.jsonl` exceeds 2 MB, entries older than 30 days are trimmed atomically (temp-file rename). The in-memory cache entry is cleared so the next read picks up the pruned content.

- **`summarizeCrossSessionPatterns` export** â€” `mcpUsageLog.ts` now exports this function; `extension.ts` uses it to pass cross-session data to the auto-fix command.

### Fixed

- **Stale lock recovery in MCP Force** (`mcpForce.ts`) â€” `clearStaleLock()` removes `.mcpforce.lock` files older than 30 s before each acquire attempt, preventing permanent deadlock after a VS Code crash. Tests added for concurrent-lock and race-condition scenarios.

- **`detectReadAfterWrite` accuracy** â€” now accumulates *all* write timestamps per path (not just the latest), so a read falling between two concurrent-agent writes is correctly flagged. Matches against the earliest qualifying write; clears only the writes that predated the read.

- **Efficiency scoring excludes no-op writes** â€” `computeScore()` subtracts auto-skipped writes from both the scoring denominator and the wasteful-ops count; sessions with many content-identical writes are no longer penalised for something the server already handled.

- **Uncapped warning arrays for accurate scoring** â€” `detectReadAfterWrite`, `detectAgentLoops`, and `detectExcessiveScans` now return all findings (previously capped at 5). The 5-item display cap is applied only at the `summarizeMcpUsage` return site, so the efficiency score reflects the true number of wasteful ops.

- **`writeMcpHints()` preserves permanent block** â€” session-hint refreshes no longer overwrite the `<!-- permanent-cache-rules -->` block written by `applyMcpAutoFixes()`.

- **`workspaceHookStatus` test fixture** â€” `guards` property added to `allOn` / `partial` fixtures to match the current `WorkspaceHookStatus` shape.

---
## [1.0.71] â€” 2026-06-18

**Summary:** The large-file self-correction hook is now enforced (not just advisory), hook file writes are atomic, and CLAUDE.md writes are concurrency-safe. MCP telemetry performance improved via per-call path memoization and a raised LRU cache.

**Theme:** Self-correcting large-file guard â€” enforced hook escalation, atomic writes, CLAUDE.md lock

### Added

- **Large-file read guard** (`file-split-read-guard` PreToolUse hook on `mcp__filesystem__read_file`) â€” fires *before* a second read of a file already recorded as large (>50 KB / 500 lines) in the large-file store. Returns `decision: "block"` and redirects the agent to `search_in_file` or a line-range read instead. First reads always pass through; the guard activates only when the file has already been read at least once this session.

- **Escalating PostToolUse enforcement** (`file-split-advisor`) â€” the hook now operates in two modes:
  - **Read 1:** advisory hint as before â€” the agent is informed and may continue.
  - **Read 2+:** returns `stopTask: true` for Claude Code (halts the tool chain) and a hard `MANDATORY SPLIT REQUIRED` message for all agents. The agent must complete the file split before it can proceed.

- **Paired hook install** â€” `installFileSplitAdvisorHook` now registers both the PostToolUse advisor and the PreToolUse guard together on the same `mcp__filesystem__read_file` matcher. `removeFileSplitAdvisorHook` removes both. Existing workspaces pick up the guard automatically on next extension activation.

### Changed

- **Atomic hook file writes** (`hookOps.ts`) â€” `.cursor/hooks.json`, `.kiro/hooks/*.kiro.hook`, and `.github/hooks/*.json` are now written via `writeJsonAtomic` (temp-file â†’ rename with retry), matching the approach used elsewhere in the codebase. A VS Code crash mid-write no longer corrupts hook files.

- **CLAUDE.md concurrent write protection** (`mcpForce.ts`) â€” `injectMcpForceClaude` and `removeMcpForceClaudeBlock` now acquire an exclusive lock file (`CLAUDE.md.mcpforce.lock`) before reading and writing CLAUDE.md, and use a temp-file rename for the write itself. Two VS Code windows targeting the same workspace simultaneously no longer risk corrupting CLAUDE.md.

- **`resolvePath` memoized per summarize call** (`mcpUsageLog.ts`) â€” `fs.realpathSync` was called once per log entry per unique path on every `summarizeMcpUsage` invocation. A per-call `Map` cache now ensures each unique path is resolved at most once, cutting syscall count from O(n) to O(unique paths) for sessions with many entries.

- **LRU log cache raised from 20 â†’ 50 paths** â€” multi-root workspaces with many active log files no longer thrash the in-memory cache.

- **`detectReadAfterWrite` reports all writeâ†’read cycles** â€” previously only the first read-after-write per path was reported (a `seen` Set suppressed subsequent occurrences). Each independent writeâ†’read cycle on the same path is now reported separately; a second read after the same write produces no additional warning.

---

## [1.0.70] â€” 2026-06-18

**Summary:** Self-correcting hooks now extend from CLI failures to all MCP filesystem tool failures. Agents get immediate corrective hints on ENOENT, EACCES, access-denied, EISDIR, and other common errors â€” plus a learner that auto-promotes repeated project-specific failures into actionable patterns.

**Theme:** MCP filesystem error guard â€” self-correcting hooks extend to all MCP tool failures

### Added

- **MCP filesystem error guard** (`mcp-error-guard` PostToolUse hook on `mcp__filesystem__`) â€” fires whenever a filesystem MCP tool call returns `isError: true` and injects a corrective hint before the agent retries. Eight static patterns:
  - `outside allowed directories` â†’ add path to `allowedDirs` config
  - `ENOENT` / `no such file or directory` â†’ use `search_files` first
  - `EACCES` / `permission denied` â†’ check file ownership
  - `EISDIR` â†’ use `list_directory` instead of `read_file`
  - `ENOSPC` â†’ free disk space
  - `EROFS` â†’ read-only filesystem
  - `Invalid regex` (search_in_file) â†’ escape special characters
  - `Access denied` â†’ path outside allowed directories
  - Install/remove via `installMcpErrorGuardHook` / `removeMcpErrorGuardHook` in `hookOps.ts`.

- **MCP filesystem error learner** â€” `analyzeMcpErrors()` in `cliGuardLearner.ts` reads `mcp-usage.jsonl`, groups filesystem tool failures by `(tool, errorKey)`, and promotes patterns seen â‰¥ 2 times to `~/.claude/learning/mcp-guard-patterns.json`. Known signatures get an actionable hint automatically; unknown ones get `needsReview: true` so you can fill in the hint once without any code change. Runs at session start alongside the existing CLI learner. Session context reports how many MCP patterns need review.

- **Filesystem MCP server: structured error logging** â€” the catch block in `dispatchTool` now writes `errorSnippet: e.message.slice(0, 256)` to `mcp-usage.jsonl` (mirrors the CLI server's `stderrSnippet` field), giving the learner a stable substring to group on.

- **Filesystem MCP server: tool-content error responses** â€” tool execution failures now use `respond(id, { content: [{type:"text", text: e.message}], isError: true })` instead of `respondError` (JSON-RPC protocol error). This is correct per the MCP spec (protocol errors vs. tool errors) and ensures PostToolUse hooks receive the error message.

### Fixed

- `parseInt` â†’ `Number.parseInt` and `isNaN` â†’ `Number.isNaN` in `analyzeCliFailures` (SonarJS S7773 warnings).
- Backslash in `search_in_file` hint now uses `String.raw` template literal (SonarJS S7780 warning).

---

## [1.0.69] â€” 2026-06-17

**Summary:** Agents now self-correct on CLI failures, are blocked from re-scanning directories they already listed, resume with full last-session context, and all infrastructure skills route CLI/filesystem calls through MCP telemetry.

**Theme:** Adaptive agent loop â€” self-correcting hooks, session memory, dir-cache guard

### Added

- **CLI loop guard** (`cli-loop-guard` PostToolUse hook on `mcp__claude-skills-cli__run_command`) â€” injects a corrective `systemMessage` immediately after any CLI failure, before the agent decides what to do next. Seven cross-CLI patterns:
  - `terraform` exitCode=1 + ed25519 stderr â†’ RSA-4096 key instruction
  - `terraform` exitCode=255 â†’ `terraform init` missing
  - Any CLI + `AuthorizationFailed`/403 â†’ routes to `azure-rbac-diagnostics` skill
  - `kubectl`/`helm` + connection refused â†’ kubeconfig check
  - `git` + CONFLICT/index.lock â†’ conflict resolution
  - `gh` + not logged in â†’ `gh auth login`
  - Any CLI + timed out â†’ increase timeout parameter
  - Auto-installed when CLI MCP server activates. Enable/disable via Command Palette.

- **Dir cache guard** (`dir-cache-guard` PreToolUse hook on `mcp__filesystem__list_directory`) â€” blocks redundant directory scans within a session using an in-memory `Map<sessionId, Set<path>>` with 4-hour TTL. Cache miss â†’ allow + record. Cache hit â†’ `{ decision: "block", reason: "CACHE HIT: ..." }` â€” the scan never executes. Auto-installed when filesystem MCP server activates.

- **Last-session context at session start** â€” `buildLastSessionSummary()` reads the last 60 `mcp-usage.jsonl` entries and injects a one-paragraph `## Last session` block (project dir, files written, CLI calls) into both `profile-init` (general SessionStart) and `mcp-gate` (MCP-Force SessionStart). Only fires for sessions < 24 h old.

- **CLI outcome pattern hints** â€” `analyzeCliPatterns()` + `appendCliPatternHints()` in `mcpUsageLog.ts` mine the usage log for CLIs with â‰¥2 errors, emit a dated error-rate section into `mcp-agent-hints.md` alongside the existing filesystem hints, and are called automatically from the efficiency scoring pipeline.

- **`cwd` in CLI MCP log entries** â€” every `run_command` entry now includes the working directory so per-project CLI attribution and pattern analysis work correctly.

- **Two new skills** in `skills_library/`:
  - `azure-infra-preflight` â€” pre-deploy checklist: verify login, detect SSH key type (Azure rejects ed25519), check RG existence and auto-generate `import {}` blocks, gate on TF â‰¥ 1.6, write run-log.
  - `infra-cost-guard` â€” estimate ongoing charges from a Terraform plan or live resource list (Azure, AWS, GCP cost tables), emit teardown command before apply, write a teardown reminder after apply.

- **MCP tool declarations for 6 skills** â€” `ci-preflight`, `ci-pipeline-debug`, `terraform-plan-review`, `azure-resource-ops`, `gitlab-pipeline-ops`, `azure-rbac-diagnostics` now declare `mcp__claude-skills-cli__*` and `mcp__filesystem__*` in their frontmatter `allowed-tools`, so all CLI and file operations in these skills are captured in KPI telemetry.

- **`excessiveScans` in `writeMcpHints`** â€” directories listed 3+ times now appear in `mcp-agent-hints.md` with wasted-entry counts and a reference to the dir-cache-guard hook.

### Fixed

- **`writeMcpHints` cognitive complexity** â€” refactored into 6 section helpers (`hintWasteWarnings`, `hintAgentLoops`, `hintLargeFiles`, `hintReadAfterWrite`, `hintExcessiveScans`, `hintEfficiency`), each returning `string[]`. Main function is now a flat spread â€” complexity from 20 â†’ 3 (resolves SonarJS S3776).

- **CLI MCP `workspaceLogPath` not refreshed on extension activation** â€” the `else` (already-configured) branch for the CLI MCP server skipped `refreshCliConfig`, leaving the log path pointing at the previous project after a window switch. Now calls `refreshCliConfig` in that branch, mirroring the filesystem server.

- **4 new Command Palette commands missing from view menu** â€” `enableCliLoopGuard`, `disableCliLoopGuard`, `enableDirCacheGuard`, `disableDirCacheGuard` now appear under `group: "3_usage"` in `contributes.menus`.

### Changed

- `McpUsageEntry` interface gains an optional `cwd?: string` field (CLI server only).

---

## [1.0.68] â€” 2026-06-17

**Summary:** CLI MCP server now auto-starts alongside the filesystem server on extension activation, has its own status bar item, and appears in the MCP Health dialog. Two server-level bugs fixed.

**Theme:** CLI MCP server auto-start, status bar, and health dialog

### Added

- **CLI MCP server auto-start** â€” on extension activation (5 s delay, same block as the filesystem server), `needsCliMcpSetup()` detects whether `~/.claude/mcp-servers/cli/index.js` is deployed and registered; if not, `enableOfficialCliServer()` runs automatically and deploys it for all configured agents (Claude, Cursor, Kiro). If already configured, logs a confirmation and refreshes the status bar.
- **`mcpCliStatusBarItem`** â€” new status bar item (priority 91.5, immediately right of the KPI item) showing:
  - `$(terminal-cmd) CLI MCP Â· claude, cursor, kiro` (no background) when the server is registered for any agent
  - `$(warning) CLI MCP: setup needed` (warning background) when the server is missing or unregistered
  - Click navigates to the enable/disable command depending on current state.
- **`refreshCliMcpStatusBar()`** â€” module-level function called from `refreshAllImpl`, after the enable/disable commands, and after auto-start completes.
- **CLI MCP section in `showMcpHealth` dialog** â€” the `claudeSkills.showMcpHealth` modal now has a `â”€â”€ CLI MCP Server â”€â”€` block after the filesystem section: shows `Connected âœ“` with agent list and supported CLIs, or `Setup needed âœ—` with the enable command name.
- **`needsCliMcpSetup` and `getCliMcpServerStatus`** â€” now imported in `extension.ts` (were exported from `mcpCli.ts` but unused).
- **`mcp-server-creation` skill** â€” new entry in `skills_library/` documenting the full pattern for building, wiring, and debugging a stdio MCP server bundled inside this VS Code extension: server skeleton, two critical bugs pre-fixed, allow-list security, TypeScript deploy helper, auto-start wiring, status bar pattern, health dialog integration, PowerShell test harness, and deployment checklist.

### Fixed

- **CLI MCP server: premature exit kills async tool calls** â€” `process.stdin.on("end", () => process.exit(0))` fired before `spawn`-based tool calls (`run_command`) had time to complete, so only synchronous tools responded. Replaced with a `_pendingOps` / `_stdinEnded` gate: `process.exit(0)` is deferred until all in-flight `tools/call` handlers have resolved.
- **CLI MCP server: `tools/call` responses returned "no output"** â€” the server sent raw result objects (`{stdout, stderr, exitCode}`) instead of the MCP-required `content:[{type:"text",text:"..."}]` envelope. All `run_command` and `list_available_clis` responses now wrap in `{content:[{type:"text",text:"..."}], isError:bool}`. Error responses from `dispatchTool` catch blocks also use the content format with `isError:true`.

### Changed

- `claudeSkills.enableCliMcpServer` and `claudeSkills.disableCliMcpServer` commands now call `refreshCliMcpStatusBar()` in both the `onStatusChanged` callback and after the `await` â€” status bar updates immediately on manual enable/disable.

---

## [1.0.65] â€” 2026-06-16

**Summary:** MCP health and KPI are now visible in the status bar; a new Force Mode locks Claude to MCP-only file operations; the old lazy-proxy is silently retired on activation.

**Theme:** MCP health monitoring, Force Mode & proxy auto-migration

### Added

- **MCP Health status bar item** (`$(plug) MCP Connected` / `$(plug) MCP Â· N agents` / `$(warning) MCP: setup needed`) â€” shows live server readiness and which agents are configured. Clicking opens the MCP health report.
- **Agent KPI status bar item** (`$(pulse) KPI: A Â· N calls`) â€” shows the efficiency grade and call count for the last 24 h using the workspace-scoped MCP log; `ready` when no calls recorded yet. Clicking opens the same health report.
- **`mcpHealth.ts`** â€” `checkMcpHealth()` validates the server binary, per-agent config entries (Claude, Cursor, Kiro; Copilot always included via `package.json`), and recent activity; returns `"ready"`, `"config-issue"`, or `"no-activity"` with error strings and the list of configured agents.
- **`mcpForce.ts`** â€” MCP Force Mode: makes Claude use *only* MCP filesystem tools for file operations.
  - `enableMcpForcePermissions(target)` â€” adds `Read`, `Write`, `Edit`, `Glob`, `Grep` to the `permissions.deny` list in `.claude/settings.json`.
  - `injectMcpForceClaude(target)` â€” writes an `## MCP REQUIRED` block to `CLAUDE.md` listing the allowed MCP tools.
  - `revertMcpForcePermissions(target)` / `removeMcpForceClaudeBlock(target)` â€” undo both changes.
  - `isMcpForceActive(target)` â€” returns true when both the deny list and the CLAUDE.md block are in place.
- **MCP-force hooks** in `hookOps.ts` â€” `installMcpForceHook()` registers a `mcp-force` `UserPromptSubmit` hook and `installMcpGateHook()` registers a `mcp-gate` `SessionStart` hook in `.claude/settings.json`; `removeMcpForceHooks()` cleans both up.
- **Auto-start MCP server** â€” on extension activation (after a 5 s delay), if `needsFilesystemMcpSetup()` detects that the server binary is missing or Claude has no config entry, the filesystem MCP server is deployed and configured automatically; otherwise, the allowed-dirs list is refreshed for the current workspace.
- **`needsFilesystemMcpSetup()`** export in `mcpOfficial.ts` â€” returns `true` when the server script is missing or the Claude config has no `filesystem` entry (Copilot is excluded from this check as it registers via `contributes.mcpServers`).
- **`claudeSkills.clearMcpLogs` command** â€” prompts for confirmation then clears the global `~/.claude/learning/mcp-usage.jsonl`, the workspace-scoped MCP log, and `mcp-agent-hints.md`.

### Changed

- **MCP proxy retired** â€” `activateMcpOptimizer` (proxy install + consent flow) removed; replaced by `autoMigrateProxyIfActive()` which silently removes the proxy entry from `~/.claude.json` if it detects our legacy lazy-proxy is still active. No prompt, no data loss.
- **Status bar cleanup** â€” usage, trust badge, budget mode, context focus, and practical focus items are hidden in favour of the two new MCP items, reducing status bar clutter.
- **`upsertMcpServerEntry`** â€” `upsertClaudeServer` and `upsertCursorKiroServer` merged into a single function; behaviour identical.
- Log message on enable: *"MCP proxy for Claude Code when applicable"* â†’ *"direct use by all enabled agents"*.

---

## [1.0.64] â€” 2026-06-16

**Summary:** MCP telemetry is now stored per-project â€” KPI panel shows clean workspace-scoped data; cross-session intelligence still reads the global log.

**Theme:** Hybrid per-project MCP telemetry storage

### Added

- **`claudeSkills.telemetry.scope`** setting (`"workspace" | "global" | "hybrid"`, default `"hybrid"`) â€” controls where the efficiency KPI panel reads MCP telemetry from:
  - `hybrid` (default): workspace log when populated, global fallback â€” no data loss during migration
  - `workspace`: strict per-project isolation; KPIs never polluted by other projects
  - `global`: pre-1.0.64 behavior (single shared log)
- **Workspace-local MCP log** (`<workspace>/.claude/mcp-usage.jsonl`) â€” the bundled MCP filesystem server now dual-writes every tool call entry to both the global log (`~/.claude/learning/mcp-usage.jsonl`) and the workspace-scoped log, enabling accurate per-project attribution
- **`workspaceLogPath` in `allowed-dirs.json`** â€” extension writes the workspace log path into the server's config so the server can resolve the correct target path without restart
- **`workspaceMcpLogPath(workspaceRoot)` export** from `mcpUsageLog.ts` â€” utility for resolving the workspace log path used by the server and the extension

### Behavior changes

- **KPI panel** reads from `<workspace>/.claude/mcp-usage.jsonl` in hybrid and workspace modes (new sessions only â€” historical data stays in global log until the server writes to the workspace log)
- **Cross-session hot-file detection** always reads from the global log regardless of scope â€” preserving the cross-project signal that drives `mcp-agent-hints.md` optimization hints
- **MCP server** (long-running stdio process) re-reads `allowed-dirs.json` on each tool call, picking up the `workspaceLogPath` set by the extension without requiring a server restart

---

## [1.0.63] â€” 2026-06-16

This release completes the **AI Efficiency Engine** â€” a closed-loop system that combines MCP filesystem telemetry and transcript cost data to detect inefficiencies, quantify wasted tokens, and actively guide agent behavior via real-time alerts and optimization hints. The extension now not only tracks cost, but detects *why* tokens are wasted and proactively helps agents reduce it.

> **Two sources of truth:** Cost and token usage are derived from two complementary sources â€” `runs.jsonl` hook logs (ground truth for API usage and cost per skill invocation) and `mcp-usage.jsonl` MCP telemetry (execution behavior and estimated token inefficiencies from file access patterns).

### Added

- **Token quality KPI bar** in the efficiency panel â€” a stacked horizontal bar
  shows useful vs. wasted MCP tokens at a glance, with a colour-coded legend and
  three stat pills: *Total MCP reads*, *Wasted*, *Cost of waste* (~$X at Sonnet
  input rate). When recent sessions are available, also shows wasted tokens as a
  percentage of total API tokens.
- **Real-time efficiency alert** (`kpiAlert.ts`) â€” evaluated on every
  workspace-state refresh cycle; shows a VS Code notification when the MCP
  efficiency score crosses a threshold:
  - **Critical** (<40% efficiency or agent loop with >5 k wasted tokens) â†’
    `showWarningMessage`.
  - **Warning** (40â€“60%) â†’ `showInformationMessage`.
  - Minimum session size: 1 000 MCP tokens (silences noise from tiny runs).
  - Three action buttons: **View Details** (opens Cost Intelligence dashboard),
    **Auto-optimize** (writes `mcp-agent-hints.md` immediately and shows a
    confirmation with issue count), **Dismiss**.
- **Per-issue-type + per-session alert deduplication** â€” each distinct issue
  type (`loop`, `high-waste`, `low-efficiency`) fires at most once per MCP
  session (keyed by the server-side `sessionId`; falls back to calendar date for
  legacy logs without session IDs). Different problems in the same session each
  surface independently; the same problem does not repeat.
- **`sessionId` in MCP log entries** â€” the bundled filesystem server now rotates
  a 12-character UUID on each `initialize` handshake. Every subsequent log entry
  carries that ID, enabling per-conversation attribution without any env-var
  wiring. Legacy entries without a `sessionId` continue to work via date bucketing.
- **Cross-session hot-file detection** (`summarizeCrossSessionPatterns`) â€” groups
  14- to 30-day MCP read logs by `sessionId` and surfaces files read in >50% of
  sessions as *persistent hot spots* in a dedicated panel. Falls back to
  date-bucketed grouping for pre-`sessionId` logs.
- **`latestSessionId` in `McpUsageSummary`** â€” the most recent session ID found
  in the filtered log window is exposed so consumers (e.g. the alert system) can
  key deduplication on the actual agent conversation rather than wall time.
- **`totalWastedTokens` in `McpUsageSummary`** â€” aggregate of redundant-read
  tokens (waste warnings) plus loop re-read tokens (agent loops), summed without
  double-counting (loop-overlapping files are excluded from the waste-warnings
  total).
- **Efficiency formula tooltip** â€” the Efficiency stat pill in the HTML dashboard
  now has a `title` attribute explaining the calculation: *(useful ops) / (total
  ops)*, where wasteful ops include redundant reads, read-after-writes, loop reads,
  and no-op writes.
- **Dollar savings pill** â€” when suggestions carry `estimatedSavedTokens`, a
  *Potential saving* pill appears in the score banner (e.g. `~$0.069 saveable`).
- **Persistent hot-files panel** in the efficiency HTML dashboard â€” lists files
  found in >50% of sessions over 30 days with session count, prevalence %, and
  average reads per session. Links to a recommendation to add them to the
  permanent cache rules in `mcp-agent-hints.md`.
- **Auto-enable filesystem MCP server at startup** â€” 5 s after activation, if no
  AI agent has the filesystem server configured, it is silently enabled for all
  agents in `claudeSkills.agents.enabled`. Non-fatal; user can still disable via
  the command palette.

### Fixed

- **Duplicate waste/loop warnings** â€” files already flagged as agent loops are
  now excluded from the *Repeated reads* list. Previously the same file could
  appear in both sections.
- **Windows 8.3 short paths** (`SERHII~1` etc.) â€” all detection functions
  (`detectWaste`, `detectReadAfterWrite`, `detectAgentLoops`, `detectLargeFiles`)
  now receive path-resolved entries. `resolvePath()` calls `fs.realpathSync` with
  a safe fallback, so paths like `C:\Users\SERHII~1\...` and
  `C:\Users\SerhiiVoinolovich\...` are treated as the same file.
- **`MCP_SESSION_ID` env var** â€” removed the non-working env-var approach. Session
  IDs are now generated inside the server on each `initialize` call, which works
  regardless of how the server process is launched.
- Stale comment on `McpUsageEntry.sessionId` updated to reflect the actual
  implementation.
- `autoEnableFilesystemServer` setTimeout now guards against the workspace being
  closed before the 5 s timer fires.

### Changed

- `kpiAlert.ts` auto-optimize action now calls `writeMcpHints` directly (injecting
  the hints file immediately) rather than delegating to the efficiency-report
  command. The confirmation message includes the count of issues documented.
- Efficiency score deduplication upgraded from one-per-severity-per-day to
  one-per-issue-type-per-session, allowing multiple distinct problems to each
  surface once without spam.

### Refactored

- `computeScore` nested ternary extracted into `scoreToGrade()` function
  (SonarQube S3358 / cognitive complexity).
- Main accumulation loop in `summarizeMcpUsage` extracted into
  `accumulateEntries()` (SonarQube S3776 â€” complexity reduced from 16â†’15).
- In-place `.sort()` chains replaced with spread-then-sort on a separate
  statement throughout `mcpUsageLog.ts` (SonarQube S4043 â€” prevents accidental
  array mutation).
- `detectAgentLoops` inner `for (let i = 0; ...)` converted to `for...of`
  (SonarQube S4138).
- Consecutive `lines.push()` calls in `writeMcpHints` consolidated into
  multi-argument `push` calls (SonarQube S7778).

---

## [1.0.62] â€” 2026-06-16

### Added

- **Efficiency metrics panel** in the Cost Intelligence dashboard â€” four sub-panels
  showing cost per task (session), cost per skill run (avg $/invoke), cost per agent,
  and cost per file (MCP access frequency + estimated tokens). Panel only renders when
  data exists; hidden otherwise.
- **MCP usage log** (`~/.claude/learning/mcp-usage.jsonl`) â€” the bundled filesystem
  MCP server now appends one JSONL entry per tool call: `{ ts, tool, path, durationMs,
  bytes?, contentHash?, skipped? }`. `bytes` is recorded for `read_file` and
  `write_file` to enable downstream token-waste estimation.
- **Waste detection engine** in `mcpUsageLog.ts` â€” five independent detectors run on
  every dashboard open:
  - *Repeated reads*: same file read â‰¥3Ã— â†’ estimates wasted tokens (file size Ã— redundant reads Ã· 4).
  - *Agent loops*: same file read â‰¥4Ã— within a 5-minute sliding window â€” flags probable
    reasoning loops.
  - *Read-after-write*: `write_file` followed by `read_file` on the same path within 60 s.
  - *Large files*: any `read_file` result > 100 KB â€” suggests partial reads or `search_in_file`.
  - *No-op writes* (auto-skipped): `write_file` where new content matches existing file is
    silently skipped at the MCP server layer (`skipped: true` in log). Extension counts
    auto-saves.
- **Efficiency score** (0â€“100, Aâ€“F grade) â€” `(totalOps âˆ’ wastefulOps) / totalOps` computed
  from all active detectors and shown as a headline stat in the efficiency panel.
- **Auto-remediation hints file** (`~/.claude/learning/mcp-agent-hints.md`) â€” regenerated
  on every dashboard refresh with agent-readable rules derived from observed patterns
  (e.g., "do not re-read files already in context", cache list for hot files). Agents that
  read this file at session start receive cross-session optimization hints.
- **Efficiency report in output channel** â€” "Show Usage Stats" now appends a plain-text
  efficiency report (cost per skill/agent/task + MCP waste summary) to the Claude Skills
  output panel alongside the existing attribution and session breakdown sections.
- **No-op write auto-skip in MCP server** â€” `write_file` reads the existing file and computes
  a SHA-1 prefix of the new content; if they match, the write is skipped and `{ skipped: true }`
  is returned. Prevents redundant I/O and reduces attribution noise.

### Fixed

- `writeMcpHints`: added `mkdirSync` before `writeFileSync` so the hints file can be written
  even when `~/.claude/learning/` does not yet exist.

---

## [1.0.61] â€” 2026-06-16

### Added

- **Filesystem MCP Server** â€” bundled `index.js` MCP server gives Claude agents
  direct read/write access to `~/.claude/` and open workspace folders over
  JSON-RPC 2.0 stdio. Enable/disable via **Claude Skills: Enable/Disable Filesystem
  MCP Server** in the Command Palette; status is shown in the Claude Skills tree.
- **Allowed-directories security scope** â€” the server enforces an
  `allowed-dirs.json` allowlist (written to
  `~/.claude/mcp-servers/filesystem/allowed-dirs.json`). Only paths inside
  `~/.claude/` and the workspace folders open at enable-time are accessible.
  Path-traversal and sibling-directory access return a clear `Access denied` error.
- **Live allowlist reload** â€” when you open or close a workspace folder, the
  extension updates `allowed-dirs.json` in place; the running server picks up
  the new dirs on the next tool call without requiring a restart.
- **`refreshFilesystemAllowedDirs`** â€” internal export called from
  `onDidChangeWorkspaceFolders` to keep the allowlist in sync with the active
  workspace automatically.
- **Allowed dirs advertised at handshake** â€” the `initialize` response now
  includes `serverInfo.allowedDirs` so Claude can see its scope at the start of
  each session.

### Changed

- Notification text when enabling/disabling the filesystem MCP server changed
  from *"Restart Claude Desktop"* to *"Reload the VS Code window
  (Developer: Reload Window)"* â€” correct instruction for the VS Code extension
  context.
- `enableOfficialFilesystemServer` now accepts a `workspaceDirs: string[]`
  parameter and writes the allowed-dirs config before registering the server in
  `~/.claude.json`. The server is launched with `--config <allowed-dirs.json>`.

### Fixed

- costRates test updated to include the `cacheWrite1h` pricing field, fixing a
  test failure introduced when the field was added to the rate table.

---

## [1.0.60] - 2026-06-15

**Summary:** Filesystem MCP server status indicator added; tier downgrade reliably removes excess agent mirror folders; profile refresh no longer false-triggers cleanup.

**Theme:** Filesystem MCP status & Host-only tier cleanup fix

### Added

- **Filesystem MCP server connection status** â€” Claude Skills activity-bar tree shows whether the bundled filesystem server is configured in `~/.claude.json`
- MIT LICENSE file added to repository root; copyright holder name corrected

### Bug fixes

- **Tier cleanup gate** â€” prune uses `project-profile.json` on disk (`hostOnlyMirrorModeForTarget`) instead of stale in-memory `multiAgent` state
- **No recreate after prune** â€” `installSkillToAllWorkspaceAgents` respects host-only mirror targets (was fanning out to all enabled agents via profile-init and single-skill install)
- **Hook cleanup on downgrade** â€” removes extension-managed `claude-skills*` hooks under `.kiro/hooks` and `.github/hooks`, drops empty `.kiro/` when nothing remains; hook install respects host-only targets (no Kiro/Copilot re-install on solo-dev)
- **Profile-based host-only detection** â€” `solo-dev`, `budget-sensitive`, `solo-focused`, and `budget-focused` profiles trigger cleanup even when `multiAgent` is absent from disk
- **Broader tier triggers** â€” cleanup also runs on `multiAgent` flag change, `lockedTier` setting change, and feature toggle off; toast + output log when folders are removed
- **`tierChanged` detection** â€” treat missing `userPlan` as `accept-detected` and ignore partial `multiAgent` preset keys so signal-only refreshes do not trigger mirror cleanup; fixed a case where switching project tiers triggered redundant full-sync operations on the same session
- **Once-per-session-per-target guard** â€” added in `refreshAllImpl` â€” avoids duplicate refresh calls when a project profile resolves to host-only mirror mode on startup

---

## [1.0.59] - 2026-06-15

**Summary:** Solo-dev tier mirrors workspace skills to the running IDE only (Cursor/Kiro/Copilot), not all enabled agents.

**Theme:** Solo-dev host-only mirroring

### Behavior changes

- **Solo-dev mirroring** â€” when `claudeSkills.features.multiAgent` is off, workspace skill and learning sync targets only `detectHostAgentId()` (the IDE you have open), not Cursor + Kiro + Copilot together
- **Multi-agent unchanged** â€” when `multiAgent` is on, full fan-out to all enabled agents still applies
- **CLI parity** â€” `skills_sync.py` reads `agents.hostAgent` from `cli-config.json` (written by the extension) or `CLAUDE_SKILLS_HOST_AGENT`; use `--agents` to override headless sync
- **Tier downgrade cleanup** â€” manually choosing solo-dev or budget-focused removes auto-created `.cursor/`, `.kiro/`, and Copilot mirror folders except the running IDE; budget-focused also forces host-only mirroring on collaborative repos

---

## [1.0.58] - 2026-06-15

**Summary:** Task skill sets need user approval, respect a configurable confidence floor, and multi-agent mirroring requires multi-agent mode.

**Theme:** Task skill focus & multi-agent gating

### Behavior changes

- **Skill-set approval** â€” extension offers Focused / Workspace / Broader option sets; auto-apply and task focus wait until you pick **Choose Task Skill Set** or the startup quick pick
- **Minimum proposal confidence** â€” `claudeSkills.taskFocus.minProposalConfidence` (default 50) filters heuristics, drift refresh, usage report, and hooks; required platform skills stay exempt; generic tokens (`skill`, `skills`, `set`, â€¦) no longer inflate scores
- **Multi-agent mirroring** â€” Claude â†’ Cursor/Kiro/Copilot skill/learning mirror only when `claudeSkills.features.multiAgent` is on (removed solo-dev cost-discipline bypass)

---

## [1.0.57] - 2026-06-15

**Summary:** Close Claude VS Code attribution gap (PreToolUse workaround + dashboard warning) and auto-expand task focus when active skills go unused.

**Theme:** Attribution reliability & task skill focus

### Behavior changes

- **Claude VS Code gap detection** â€” scans `~/.claude/projects` transcripts for `claude-vscode` sessions with tool use but zero `PostToolUse` hook fires; dashboard hook panel shows warning and CLI/PreToolUse guidance
- **PreToolUse attribution workaround** â€” `installAttributionHooks` now registers `skill-invoke-watch.js` on both `PostToolUse` and `PreToolUse` in `.claude/settings.json` (anthropics/claude-code#27014); `skills_sync.py hooks install` parity
- **Task skill underuse promotion** â€” when task focus is on, a session has meaningful tool activity, and no active skill was invoked, high-confidence ignored skills from `task-skill-proposals.json` are promoted back into the active set (configurable under **Skill feedback**)

---

## [1.0.56] - 2026-06-14

**Summary:** Close cost-control gaps â€” stop installing budget hooks on attribution-only workspaces; align CLI hook file list and docs.

**Theme:** Cost control hook parity (hardening)

### Behavior changes

- `syncHooksOnSkillChange` refreshes cost-control scripts on all agent paths only when `costControlHooksActive()` (any Claude cost hook registered); attribution-only workspaces refresh attribution scripts only
- `skills_sync.py` `HOOK_FILES` includes `hookPlatform.js` and `task-skill-focus.js`; removed superseded per-hook task-drift installers

---

## [1.0.55] - 2026-06-14

**Summary:** Full four-agent cost-control hook parity â€” all five prompt hooks (budget, session size, context focus, practical focus, task drift) register and run on Claude, Cursor, Kiro, and Copilot.

**Theme:** Cost control hook parity

### Highlights

- **`hookPlatform.js`** â€” shared `resolveCwd`, `parsePlatform`, and per-agent `writePromptOutput` for Cursor `additional_context`, Kiro `additional_context`, Copilot `hookSpecificOutput`, and Claude `systemMessage` / `hookSpecificOutput`
- **All five hooks** â€” `installAgentCostControlPromptHooks()` registers session-size, budget, context-focus, practical-focus, and task-drift on Cursor `beforeSubmitPrompt`, Kiro `promptSubmit`, and Copilot `UserPromptSubmit`
- **Budget-watch fix** â€” resolves `workspace_roots` (not only `cwd`) and emits the correct output shape per agent; hook commands pass `cursor` / `kiro` / `copilot` argv
- **CLI parity** â€” `skills_sync.py hooks install --full` installs the same five hooks for all enabled agents
- **Hook status** â€” `getWorkspaceHookStatus()` checks Claude + agent mirror for each cost-control hook

### Behavior changes

- Re-run **Enable Cost Control Hooks** to add session-size / focus hooks on Cursor/Kiro/Copilot and refresh budget commands with platform args
- Session-size warnings still require `transcript_path` (Claude + Cursor); Kiro/Copilot hooks register but no-op without transcripts

---

## [1.0.54] - 2026-06-14

**Summary:** Fix Kiro `.kiro.hook` schema â€” use `promptSubmit` and `sessionStart` for `when.type` (Kiro rejects `userPromptSubmit` / `agentSpawn`).

**Theme:** Four-agent hook parity (Kiro schema compliance)

### Behavior changes

- Kiro budget and task-drift hooks now register `when.type: promptSubmit` instead of `userPromptSubmit`
- Kiro profile-init hook now registers `when.type: sessionStart` instead of `agentSpawn`
- Re-run **Enable Cost Control Hooks** or **Install Profile Init Session Hook** (or reload the workspace) to rewrite existing `.kiro/hooks/*.kiro.hook` files
- `profile-init-watch.js` still accepts legacy `agentSpawn` stdin events for backward compatibility

---

## [1.0.53] - 2026-06-14

**Summary:** Cost discipline pack â€” cap task skills at 8â€“12, bootstrap new branches with relevant subsets, budget tier gating, and weekly resolver for economy tiers.

**Theme:** Task focus & branch-local skill economy

### Highlights

- **Task skill focus cap** â€” `claudeSkills.taskFocus.maxActiveSkills` (default 12) limits active + proposed skills; required platform skills count toward the cap
- **Branch bootstrap** â€” new branches without a saved profile get infra/app heuristics + relevant-only install instead of inheriting main's full library
- **Budget tier gating** â€” high-tier skills outside the active task set auto-disable at 80% daily budget; medium-tier at 95%
- **Relevant install only** â€” prunes personal-local irrelevant skills when installs exceed 2Ã— the focus cap
- **Weekly resolver** â€” `skillSetResolver` tier feature enabled for `solo-dev` and `budget-sensitive`; unset `skillSetResolver.enabled` follows tier default
- **Four-agent parity** â€” cost discipline propagates to Cursor/Kiro/Copilot mirrors + Copilot bootstrap; budget-watch hooks on all four agents; learning artifacts mirrored to `.cursor/learning` / `.kiro/learning`
- **Host-first entry** â€” extension detects running IDE (`detectHostAgentId`); imports host mirror skills/learning into canonical `.claude/` when you never opened Claude Code first; per-IDE skill sets work on solo-dev tier in Cursor/Kiro/VS Code

### Behavior changes

- Switching to a new branch seeds a focused skill profile when branch bootstrap is on (profile init prompt still runs when enabled)
- Task proposals and focus ignore skills beyond the configured cap (extension + `task-skill-focus.js` hook)
- Cost discipline pass always runs host-first bootstrap, then fans out to non-Claude agents when `propagateToAllAgents` is on (default)
- Opening the extension in Cursor/Kiro/Copilot bootstraps `.claude/skills` and `.claude/learning` from the host mirror when canonical copies are missing
- `cli-config.json` includes `taskFocus` and `costDiscipline` blocks for headless hook parity

---

## [1.0.52] - 2026-06-14

**Summary:** Releases 1.0.45â€“1.0.51 are now parity-checked across Claude, Cursor, Kiro, and Copilot â€” task drift inject, session-start fallbacks, and transcript-based session-size drift for Cursor/Claude.

**Theme:** Four-agent hook parity for cost intelligence & skill adaptation

### Highlights

- **Task drift (1.0.51)** â€” `task-drift-watch.js` registered for all four agents: Claude `UserPromptSubmit`, Cursor `beforeSubmitPrompt`, Kiro `userPromptSubmit`, Copilot `UserPromptSubmit` / `userPromptSubmitted`
- **Session-start fallback** â€” `profile-init-watch.js` delivers pending task-drift prompts on Claude SessionStart, Cursor sessionStart, Kiro agentSpawn, and Copilot SessionStart (same path as 1.0.50 low-trust inject)
- **Session-size drift** â€” extension also reads Claude/Cursor transcript file sizes when evaluating task drift (Kiro/Copilot lack local transcripts per `agents.json`)
- **Attribution & costs (1.0.46â€“1.0.49)** â€” unchanged multi-agent PostToolUse hooks; General API panel remains Claude/Cursor transcriptâ€“based where transcripts exist
- **Per-skill cross-agent costs** â€” `buildCostAttribution` now uses measured hook `cost` from `runs.jsonl` (API usage breakdown) instead of re-estimating with a flat blended $/M rate â€” aligns Cross-agent panel with Usage Report **$X/run (API)** rows
- **Agent routing hint** â€” when daily budget is nearly exhausted, routing suggestion explains budget-driven Copilot fallback vs measured cheapest agent
- **claude-api lint** â€” trimmed SKILL/instructions frontmatter description to â‰¤500 chars (trigger/skip rules remain in body)

### Behavior changes

- Cross-agent **Per-skill** table and routing cost parentheses now match hook-measured costs (~$0.05/run with heavy cache read) instead of inflated blended estimates (~$0.30/run)
- **Suggested agent: copilot** during budget exhaustion now includes explicit "daily budget nearly exhausted" context

### Technical

- `hookOps.ts` â€” `installAgentTaskDriftHooks()` for Cursor/Kiro/Copilot; separate `.github/hooks/claude-skills-task-drift.json` and `.kiro/hooks/claude-skills-task-drift.kiro.hook`
- `taskDriftReproposal.ts` â€” merges `session-watch.json` with workspace Claude/Cursor transcript byte thresholds
- `skills_sync.py` â€” headless task-drift hook install when `hooks install --full`
- `costAttribution.ts` â€” `costForRunRecord()` prefers stored `rec.cost`; `formatAttributionReport` labels column **Cost** with hook vs estimate note
- `costRouter.ts` â€” `formatRoutingSuggestion()` budget context when cheapest agent differs from routed agent
- `.claude/skills/claude-api/SKILL.md`, `.github/instructions/claude-api.instructions.md` â€” short frontmatter description

---

## [1.0.51] - 2026-06-14

**Summary:** Task scope drift (off-profile skill use or large session) now auto-refreshes `task-skill-proposals.json`, re-applies task focus, and injects a one-time agent hint.

**Theme:** Reactive skill re-proposal when agents drift from the active task set

### Highlights

- **Feature** â€” `claudeSkills.features.taskDriftReproposal` (default on)
- **Triggers** â€” `not_in_active_profile` invokes in `runs.jsonl` (default â‰¥2) and/or session transcript at warn/critical (`session-watch.json`)
- **Settings** â€” `claudeSkills.skillFeedback.taskDriftMinOffProfileInvokes`, `taskDriftSessionSizeLevel`, `taskDriftCooldownMinutes`, `taskDriftNotifyUser`
- **Hook** â€” `task-drift-watch.js`: Claude Code `UserPromptSubmit` + Cursor `beforeSubmitPrompt` inject refreshed active skill list once per drift event (Kiro/Copilot added in **1.0.52**)
- **State files** â€” `.claude/learning/task-drift-reproposal.json`, `task-drift-prompt.json`

### Behavior changes

- Extension refresh cycle evaluates drift before normal deterministic proposal refresh; cooldown prevents rapid re-proposal loops (default 30 min)
- Off-profile skills used by the agent are boosted into the refreshed proposal set with high confidence
- `applyTaskProposalsIfPending` still auto-installs/enables when `autoApplyTaskProposals` is on

### Technical

- `taskDriftReproposal.ts` â€” detection, heuristic refresh, focus re-apply, prompt snapshot
- Cost-control hook install now registers `task-drift-watch.js` alongside session-size and context-focus hooks

### Known gaps (addressed in 1.0.52)

- ~~**Kiro / Copilot** â€” mid-session agent inject~~ â†’ wired in 1.0.52
- **Heuristic refresh** â€” extension re-seeds proposals from workspace heuristics; agent refinement via `skill-feedback-adaptation` section 3 is still optional after drift inject
- **General API spend (1.0.49)** â€” Kiro/Copilot have no local transcript roots; panel uses Claude/Cursor session data only

---

## [1.0.50] - 2026-06-14

**Summary:** Low cost-attribution trust now triggers a silent SessionStart hint to agents (configurable threshold, default 50%).

**Theme:** Agent awareness when cost data is unreliable

### Highlights

- **Settings** â€” `claudeSkills.costIntelligence.lowTrustPromptEnabled` and `lowTrustPromptThresholdPct` (0â€“100)
- **SessionStart hook** â€” when trust score is below threshold, agents receive grounding not to rely on per-skill cost rankings
- **Snapshot file** â€” `.claude/learning/attribution-trust.json` updated on dashboard refresh

### Technical

- `attributionTrustConfig.ts` syncs trust score from `assessAttributionHealth` + `buildGlobalTrustBadge`
- `profile-init-watch.js` appends low-trust context on Claude, Cursor, Kiro, and Copilot session start

---

## [1.0.49] - 2026-06-14

**Summary:** Cost dashboard now shows **General API** spend â€” base-model session work and residuals not attributed to listed skill invokes.

**Theme:** Non-skill agent usage visibility

### Highlights

- **General API Â· 14d** panel â€” transcript session totals minus hook-measured skill invokes; covers agents answering from built-in knowledge without reading a listed skill
- **Overview stat** â€” **General API** pill alongside **Skill spend** and session totals
- **Collector fix** â€” routes non-skill sessions to `base_context` instead of inflating legacy `unattributed`
- **Hook metadata** â€” `not_in_active_profile: true` when a skill file is read outside the active task/profile set

### Technical

- `generalApiSpend.ts` â€” `computeGeneralApiSpend()`, session residual helpers
- `applyTranscriptAttribution()` â€” hook sessions: `session_tokens âˆ’ hook_tokens`; no-skill sessions: full session â†’ `base_context`
- Legacy `unattributed` bucket flagged for reset when pre-1.0.49 data dominates

---

## [1.0.48] - 2026-06-14

**Summary:** Cost dashboard **Models by agent** now shows API-priced **Skill invokes** rows from attribution hooks for Cursor (and other agents) â€” not only the transcript size estimate.

**Theme:** Hook-measured models in per-agent breakdown

### Highlights

- **Models by agent** â€” prepends **Skill invokes (cursor)** (and per-model ids when logged) from `runs.jsonl` before **cursor-agent (size est.)** transcript proxy
- **Panel note** â€” explains transcript size estimate vs hook API rows
- **Agent credit usage** â€” same hook merge for status-bar / overview model breakdown

### Technical

- `aggregateHookModelUsageByAgent()` and `mergeHookModelsIntoAgentRows()` in `usageCost.ts`
- `computePerAgentCreditUsage()` merges hook models when workspace target is set
- Unit test for Cursor hook model aggregation

---

## [1.0.47] - 2026-06-14

**Summary:** Skills tree, status bar, and usage report show API-priced costs from real hook usage when available â€” not blanket "Est." labels.

**Theme:** Measured cost labels everywhere hooks fire

### Highlights

- **Skills library tree** â€” `$X/session (API)` from measured `runs.jsonl` cost; `(catalog)` only when no runs logged
- **Status bar** â€” `API` / `Mixed` / `Est.` prefix based on whether today's transcripts include usage metadata
- **Usage report** â€” **Cost/run** column with API vs logged basis per skill
- **Dashboard overview** â€” **Session spend** when transcripts have full API usage lines

### Technical

- Per-skill stats aggregate `totalCost`, `avgCostUsd`, and `measuredRuns` from hook rows
- ROI/confidence upgrades when `usage_breakdown` metadata is present
- Dashboard top-skill rows show **API-priced (hooks)** trust label when usage breakdown is present

---

## [1.0.46] - 2026-06-14

**Summary:** Cost dashboard and CLI now show real per-skill spend from hook invocations at published API rates â€” not inflated transcript equal-split estimates.

**Theme:** Accurate skill-level cost attribution

### Highlights

- **Top skills Â· measured** â€” dashboard ranks skills from `runs.jsonl` hook/self-learning rows with input/output/cache pricing per model
- **Skill spend** overview stat â€” separate hook-grounded total in the 14-day Overview panel
- **Model-aware pricing** â€” Fable/Mythos/Opus/Sonnet/Haiku tiers; API vs size-estimate labels on agent model rows
- **Python CLIs** â€” `scripts/skill_cost_from_runs.py` (per-skill from logs) and `scripts/agent_billing_report.py` (Anthropic/Cursor/Copilot admin APIs)

### Behavior changes

- Attribution-collector transcript rows are excluded from per-skill cost totals (fixes inflated $1k+ weekly figures)
- Equal-split mis-attribution no longer drives **Top skills** when v2 hook runs exist
- Weekly report and `cost_intelligence.py` skip collector rows when summing skill spend

### Technical

- New `skillCostFromRuns.ts`, `runs_cost.py`, `agent_billing.py`; hook writes `metadata.usage` + `cost_method: usage_breakdown`
- `normalizeRunRecord` reads `metadata.model` for usage-based cost recompute

---

## [1.0.45] - 2026-06-14

**Summary:** Weekly email leads with real extension benefits from your logs; manual tier changes work from the status bar and stick reliably.

**Theme:** Benefits visibility & tier control fixes

### Highlights

- **Weekly benefits report** â€” email opens with tier savings, skill success rates, hook-tracked invocations, and cross-agent savings from `runs.jsonl` + `project-profile.json`
- **Status bar tier badge** opens **Choose Project Profile Tier** directly (not a read-only summary)
- **Tier lock** derives from your chosen plan (`solo-focused` etc.), not a stale `profileType` on disk
- **Settings `lockedTier`** syncs to `project-profile.json` when no explicit user plan is set

### Behavior changes

- After choosing a tier, a confirmation toast always appears (not gated by `notificationLevel`)
- **Show Project Tier** still offers **Change tier** via a standard information message
- Default weekly email subject: **Weekly Claude Skills Benefits Report**

### Technical

- New `weeklyReportBenefits` module; publish workflow skips missing registry secrets gracefully (Node 22)

---

## [1.0.44] - 2026-06-14

**Summary:** Stays out of your way â€” quieter notifications, no terminal hijack, tier lock that sticks, and silent self-updates from Open VSX.

**Theme:** Quiet operations & reliable tier control

### Highlights

- **Minimal notifications** by default â€” background auto-apply and suggestions log to Output instead of toasting
- **Output panel stays hidden** unless you ask (`revealOutputPanel` off by default; new **Show Output Log** command)
- **Silent extension auto-update** checks Open VSX every 6 hours and installs newer releases without prompts
- **Manual tier lock** prefers your on-disk plan over stale workspace settings; **solo-focused** plan overrides team detection on shared repos

### Behavior changes

- Locked tiers no longer spam "tier changed" when you already chose a plan
- First-run welcome and setup wizards skipped unless `notificationLevel` is **normal**
- `silent` notification level auto-accepts detected tier (no QuickPick on first open)
- Tier benefit benchmark (`npm run bench:tier-benefits`) and cross-platform skill-impact bench on Windows

### Configuration

- `claudeSkills.notificationLevel` â€” `minimal` (default), `silent`, or `normal`
- `claudeSkills.revealOutputPanel` (default off)
- `claudeSkills.autoUpdateExtension` (default on)
- `claudeSkills.autoUpdateExtensionHours` (default 6)

### Technical

- `userNotify` module centralizes toast gating; CI vscode mock fixes for `Uri`/`inspect`
- `extensionAutoUpdate` pulls latest VSIX from Open VSX with gallery fallback

---

## [1.0.43] - 2026-06-14

**Summary:** More accurate team-tier detection for fresh clones â€” uses remote Git signals, not just your local checkout.

**Theme:** Remote-aware tier intelligence

### Highlights

- Choosing a tier now probes `origin` with plain `git` commands (extension-only â€” no AI agent involved)
- Fresh clones of busy team repos can be detected as **TEAM MULTI-AGENT** even with one local branch
- Remote branch and author counts feed the same plan picker you already use

### Behavior changes

- Tier detection considers **remote** repo activity (`max(local, remote)` branches and authors)
- **Detect Project Profile** and **Choose Project Profile Tier** probe origin before recommending a tier
- Accepting the detected tier keeps remote-probed signals (no silent revert to local-only metrics)

### Configuration

- `claudeSkills.projectProfile.probeRemoteGit` (default on)
- `claudeSkills.projectProfile.remoteProbeTimeoutMs` (default 8000 ms)

### Technical

- `git ls-remote`, remote-tracking refs, upstream ahead/behind; cached **1 hour** in `.claude/learning/remote-repo-probe.json`

---

## [1.0.42] - 2026-06-14

**Summary:** Compare tier plans with estimated savings before you commit â€” and manual tier changes finally stick.

**Theme:** Project tiering & cost optimization

### Highlights

- Every plan in the tier picker shows estimated monthly overhead and savings vs full stack
- Comparison table logged before you pick (all 5 tiers side-by-side)
- Switch tiers any time to explore what solo vs multi-agent actually costs

### Behavior changes

- Explicit plan choices (including throwaway and enterprise) **lock** the tier â€” auto-detect no longer overwrites your pick
- Saved `manualOverride` is respected even when `lockedTier` is empty in settings

### UX

- **Show Project Tier** and **Choose Project Profile Tier** display economics per option
- **View details** action after confirming a plan

---

## [1.0.41] - 2026-06-14

**Summary:** Tier detection driven by real repo activity (git history, branches, files) â€” and the first-open dialog asks about your *plans*, not a tier catalog.

**Theme:** Project tiering & cost optimization

### Highlights

- Git-first detection: commits, authors, branches, repo size, and age â€” not just "which AI folders exist"
- **AIDLC greenfield** plan: solo developers on AI-DLC can get multi-agent tier from day one
- Plans prompt: AIDLC, multi-agent workflow, team product, budget, quick spike, or accept detected

### Behavior changes

- New git repos default to **solo-dev** (not throwaway) unless multi-agent or AIDLC signals are present
- First-open plans dialog no longer skipped on new workspaces (prompt state fix)

### UX

- Status bar tooltip, cost dashboard, and output channel show git analysis evidence

---

## [1.0.40] - 2026-06-14

**Summary:** New projects get asked how you plan to use AI agents â€” instead of silently landing on solo-dev.

**Theme:** Project tiering & cost optimization

### Highlights

- First-open **QuickPick** on projects without `.claude/learning/project-profile.json`
- Picking multi-agent / budget / enterprise locks the tier so auto-detect does not revert later

### Behavior changes

- Onboarding tour step 1 now routes through project profile selection before skill install

### Configuration

- `claudeSkills.projectProfile.promptOnFirstDetect` (default on)

---

## [1.0.39] - 2026-06-14

**Summary:** Your project tier is visible everywhere â€” status bar, dashboard, and notifications â€” with estimated savings.

**Theme:** Project tiering & cost optimization

### Highlights

- Status bar badge: `TEAM MULTI-AGENT`, `SOLO DEV`, `BUDGET-SENSITIVE`, etc.
- Cost dashboard **Project tier** panel: detected type, overhead, savings, feature list
- Toast when tier changes with **View details** / **Change tier** actions

### UX

- Command: **Show Project Tier** â€” full breakdown in output channel

---

## [1.0.38] - 2026-06-14

**Summary:** The extension auto-configures CPU and token spend per project â€” solo, team, budget, enterprise, or throwaway.

**Theme:** Project tiering & cost optimization (v1)

### Highlights

- Automatic project tier detection with feature presets (multi-agent sync, attribution, cost intel, session adapt)
- Writes `.claude/learning/project-profile.json` per workspace
- Throwaway/script projects skip heavy background work automatically

### Behavior changes

- When `applyTierFeatures` is on, tier presets override `claudeSkills.features.*` for this workspace
- Cost pipeline skipped when both `costIntelligence` and `attributionCollector` are off (throwaway tier)
- Profile re-detect throttled to **24 hours** unless tier or signals change

### Configuration

- `claudeSkills.projectProfile.autoDetect`, `applyTierFeatures`, `lockedTier`

### Commands

- **Detect Project Profile**, **Choose Project Profile Tier**

---

## [1.0.37] - 2026-06-14

**Summary:** Full benchmark suite for proving performance and skill-impact claims before release.

**Theme:** Benchmarks & release quality

### Highlights

- `npm run bench:complete` â€” hot paths, cost pipeline, hooks, adaptation, CI/ADX harness with SLA checks
- `npm run bench:skill-impact` â€” Claude CLI A/B with vs without skills; cost and token diffs

### Tooling

- Complex agent fixture (`agent-comparison-fixture-complex/`) with ADX KQL grader
- `resolve-library-dir.mjs`, `installed-extension-path.mjs` for reliable local benchmarks
- Install smoke no longer hardcodes extension version

### Docs

- `COMPLETE-BENCHMARK-GUIDE.md` â€” `bench:complete` vs `bench:skill-impact`

---

## [1.0.36] - 2026-06-14

**Summary:** Git commands hardened against shell injection â€” safer on untrusted workspace paths.

**Theme:** Security hardening

### Security

- `branchProfiles.ts` and `skillOps.ts` use `execFileSync("git", [...])` with argument arrays instead of shell string interpolation

---

## [1.0.35] - 2026-06-14

**Summary:** Cost dashboard loads from cache in milliseconds â€” team economics precomputed in the background.

**Theme:** Dashboard & cache performance

### Performance

- **Dashboard warm read:** **< 5 ms** from `.claude/learning/dashboard-snapshot.json`
- **Cold render target:** **< 30 ms** (fast-phase disk read ~1 ms)
- **Team economics cache:** persistent `.claude/learning/team-economics-cache.json`; warm reads **< 5 ms**

### UX

- Progressive injection: loading slots first, then main + team panels via webview `postMessage`
- Background precompute after cost pipeline sync

---

## [1.0.34] - 2026-06-14

**Summary:** Cost dashboard went from ~7 seconds to ~200 ms â€” a **97%** improvement for daily use.

**Theme:** Dashboard & cache performance

### Performance

- **Dashboard load time:** ~7 s â†’ ~**200 ms** (~**97%** faster)
- Git blame author lookups cached by `SKILL.md` mtime
- Single `attributeCostToAuthors` pass per render (was double)
- Skill detection: faster glob filtering + expanded exclude dirs (`.vscode-test`, `dist`, `out`, `build`, â€¦)

### Efficiency

- No duplicate cost pipeline run when opening dashboard
- Runs index rebuild skipped when indexes are already fresh
- Tree view skips `computeUsageStats` when cost-aware search is off

---

## [1.0.33] - 2026-06-14

**Summary:** Sync engine overhaul â€” no more UI jank when toggling skills or mirroring to Cursor/Kiro/Copilot.

**Theme:** Sync engine stability & concurrency

### Highlights

- Chunked async fan-out: agent sync yields between each agent (eliminates burst jank)
- Predictive pre-sync fingerprint: rapid on-off toggles before debounce flushes are skipped silently
- Activity-aware interaction lock: sync pauses while you type, click, or run commands

### Performance targets

- `toggle-ui` **< 16 ms** Â· `tree-refresh` **< 10 ms** Â· sync **< 150 ms** (p50/p95/p99 logged)

### UX

- Toggle ripple: 130 ms green check flash on checkbox
- Lock-free runs reads; size-stable hash reuse across Windows git-checkout mtime drift

### Planned (v1.1)

- Worker thread for cost pipeline + JSONL aggregation

---

## [1.0.32] - 2026-06-14

**Summary:** Smoother skill toggles â€” background sync waits until you stop interacting.

**Theme:** Sync engine stability & concurrency

### Highlights

- Interaction lock (800 ms / 1.5 s quiet window) during typing and clicking
- Granular tree refresh: per-skill updates with cached `SkillItem` instances
- Parallel agent fan-out on separate event-loop turns

### Added

- `runs.snapshot.json` v2 with `version`, `lastUpdated`, `sourceSize`, `sourceMtimeMs`
- Perf telemetry via `recordPerf` / `CLAUDE_SKILLS_PERF=1`

---

## [1.0.31] - 2026-06-14

**Summary:** Smarter debouncing â€” fast response when you act, quiet coalescing in the background.

**Theme:** Sync engine stability & concurrency

### Highlights

- User actions flush at **400 ms**; background watchers coalesce at **1200 ms**
- Optimistic skill tree: checkbox updates instantly; mirrors sync in background
- Agent-diff sync: only the toggled skill mirrors to other agents (not full workspace)

### Added

- `runs.snapshot.json` for instant cold load of usage dashboard data
- Cache warmup 1 second after activate

---

## [1.0.30] - 2026-06-14

**Summary:** Foundation of the modern sync architecture â€” hash-based copies, coalesced queues, lazy startup.

**Theme:** Sync engine stability & concurrency

### Highlights

- Hash-based agent sync: copy only when content differs
- Workspace sync queue: **2 second** coalesced merges for rapid watcher events
- Lazy activation: light refresh on startup; deferred agent sync after **3 seconds**

### Efficiency

- Incremental `runs.jsonl` cache: append-only tail reads
- Fingerprint skip when effective skills and hashes unchanged

---

## [1.0.29] - 2026-06-14

**Summary:** See which AI agent (Claude, Cursor, Kiro, Copilot) used which skills â€” and trim token load automatically.

**Theme:** Multi-agent visibility & automation

### Highlights

- Cross-agent usage matrix in Usage Report and weekly email
- Task skill focus: non-proposed skills set `off` after auto-apply to save tokens
- Deterministic profile init and task proposals without an agent session

### Performance

- Manifest/skill-status/detection caches; coalesced workspace refresh

---

## [1.0.28] - 2026-06-13

**Summary:** Integration smoke test in CI â€” extension activation verified before every publish.

**Theme:** Release quality & session hooks

### Highlights

- `@vscode/test-electron` integration smoke (`npm run test:integration`)
- NEW SESSION task-proposal hook on all four agent platforms
- Weekly batch release policy documented in `PUBLISHING.md`

---

## [1.0.27] - 2026-06-13

**Summary:** Proposed skills auto-install when `task-skill-proposals.json` updates â€” no manual apply step.

**Theme:** Session automation

### Behavior changes

- `autoApplyTaskProposals` (default on): installs and enables every skill in **Proposed for current task**
- Session skill apply no longer caps at 20 skills when merging profile + proposals

---

## [1.0.26] - 2026-06-13

**Summary:** Full headless Claude CLI workflow â€” apply skills, sync branch profiles, install hooks without VS Code open.

**Theme:** Headless CLI & hooks

### Highlights

- `skills_sync.py` + `generate_skills.py`: `apply-session`, `apply-profile`, `sync-branch`, `sync-agents`, `hooks install`
- **Prepare for Claude CLI** command â€” one-click setup
- `.claude/learning/cli-config.json` mirrors IDE feature toggles for CLI/hooks

---

## [1.0.25] - 2026-06-13

**Summary:** Skills follow you into every new agent session â€” Cursor, Kiro, Copilot, and Claude Code.

**Theme:** Multi-agent session automation

### Highlights

- Session skill adaptation: auto-install/enable from profile and task proposals on each new session
- Profile-init hooks for Cursor, Kiro, and GitHub Copilot (not just Claude)

### Fixed

- Per-IDE profile-init skill sets saved for the correct host agent
- Open VSX publish packages current version (not stale VSIX)

---

## [1.0.24] - 2026-06-13

**Summary:** Reliable installs on Windows even when agents lock hook files open.

**Theme:** Windows stability

### Fixed

- EBUSY retry with backoff on hook/skill copies
- Install completes with warning if post-install hook sync fails (does not abort)
- Quieter startup sync: propagate only when mirrors are missing or stale

---

## [1.0.23] - 2026-06-13

**Summary:** SKILL lint no longer false-alarms on Windows CRLF or economy-disabled skills.

**Theme:** Developer experience

### Fixed

- Frontmatter parser handles CRLF and YAML block-scalar descriptions
- Copilot mirror lint respects `skillOverrides: off`

---

## [1.0.22] - 2026-06-13

**Summary:** Different skill sets per IDE and per git branch â€” Cursor, Kiro, Copilot, Claude Code.

**Theme:** Per-IDE skill profiles

### Highlights

- Save and switch skill sets per branch per IDE (`~/.claude/learning/agent-skill-profiles.json`)
- Auto-apply on workspace open when a saved set exists

---

## [1.0.21] - 2026-06-13

**Summary:** Extension available on Open VSX â€” install in Cursor and Kiro IDE, not only VS Marketplace.

**Theme:** Distribution

### Highlights

- `npm run publish:openvsx` + GitHub Actions **Publish Extension** workflow
- `cursor-kiro-extension-publishing` skill for agent-guided publish

---

## [1.0.20] - 2026-06-13

**Summary:** Skills learn from your feedback â€” and the extension suggests better skills when spend spikes.

**Theme:** Skill feedback & lifecycle

### Highlights

- `skill-feedback-adaptation` skill: disagreement logging + task proposals
- High token usage popup when branch/task exceeds **50%** of monthly credits (configurable)
- Skill versioning in manifest: outdated alerts + **Upgrade Outdated Skills**
- Attribution trust badge: Reliable / Estimated / Low confidence

---

## [1.0.19] - 2026-06-12

**Summary:** Confidence scores everywhere â€” and the optimizer reacts in real time after each cost sync.

**Theme:** Cost intelligence depth

### Highlights

- Trust banner and per-skill confidence (`high` / `estimated` / `low`) on Usage Report
- `autoDetectOnPipeline` (default on): debounced auto-optimize ~5 seconds after pipeline sync
- In-memory runs + transcript indexes avoid full re-parses

---

## [1.0.18] - 2026-06-12

**Summary:** Attribution you can trust â€” Cursor hooks fixed, pipeline resilient, dashboard faster to read.

**Theme:** Attribution & pipeline resilience

### Highlights

- Expanded skill path detection for Cursor (`.cursor/skills-cursor/`, `skills_library/`, `.agents/skills/`)
- Circuit breaker: trips after >10 pipeline runs/minute; forces safe mode
- CSP-safe webviews; shared compact dashboard chrome

### Behavior changes

- `runs.jsonl` scope narrowed to v2 hook invocations + self-learning (transcript estimates stay in `cost-attribution.json`)
- **Reset Mis-attributed Cost Data** command for legacy cleanup

---

## [1.0.17] - 2026-06-12

**Summary:** ROI and trust layers on cost data â€” see dollars saved, not just dollars spent.

**Theme:** FinOps foundation

### Highlights

- Per-skill ROI bands (`HIGH` / `MEDIUM` / `LOW`) with time-saved heuristics
- Value panel: minutes saved, dollar value, net ROI in Cost Intelligence Dashboard
- Unified system state: `.claude/learning/system-state.json`

---

## [1.0.1] - 2026-06-12

Same content as consolidated **1.0.0** below â€” first publishable Marketplace version after 1.0.0 was already taken.

---

## [1.0.0] - 2026-06-12

**Summary:** First production release â€” bundled skills, four-agent sync, profile init, and cost intelligence.

**Theme:** Foundation

### Highlights

- Bundled skill library with stack detection (`manifest.json` + `detect_globs`)
- Multi-agent deploy: Claude Code, Cursor, Kiro, GitHub Copilot
- Profile init on new branches (agent-driven skill selection by role)
- Cost Intelligence Dashboard, budget modes, attribution collector
- Activity bar Skills tree, setup wizard, onboarding tour

### Requirements

- VS Code / Cursor **1.85+**; optional `vscode.git` and GitHub CLI
