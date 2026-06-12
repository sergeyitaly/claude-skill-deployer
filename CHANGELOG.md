# Changelog

All notable changes to **Claude Skills Manager** (VS Code extension) are documented here.

Consolidated release line starts at **1.0.1** (2026-06-12). **1.0.19** is the current Marketplace publish target.

## [Unreleased]

### Skill feedback adaptation

- **`skill-feedback-adaptation` skill** — records user disagreement in `skill-feedback.jsonl`; writes `task-skill-proposals.json` when a new task starts.
- **Usage Report** — **Inefficient skills** panel (heat-colored inefficiency % + update suggestions); **Proposed for current task** panel; **Feedback** column in skills detail table; status bar shows inefficient count.
- **High token usage notification** — when a branch or task exceeds `claudeSkills.skillFeedback.monthlyCreditThresholdPercent` (default 50%) of monthly credits, popup offers to install suggested skills.
- **CLI** — `record_feedback.py` appends feedback rows.
- **Command** — `Claude Skills: Apply Suggested Skills for Current Task`.
- **Settings** — `claudeSkills.skillFeedback.promptOnHighUsage`, `monthlyCreditThresholdPercent`, `monthlyCreditsUsd`.
- **Profile init required skills** — every branch profile auto-includes platform skills (`self-learning`, `skill-creator`, `skill-usage-insights`, etc.); configurable via `claudeSkills.profileInit.requiredSkills`.
- **Required skill auto-recovery** — on a new git branch (no saved profile) or first workspace open when required skills are missing, the extension reinstalls them from the library; toggle via `claudeSkills.profileInit.recoverRequiredSkillsOnNewBranch`.
- **Skill lifecycle versioning** — `manifest.json` skills support `version`, `changelog`, and `deprecation`; outdated alerts and **Upgrade Outdated Skills** command.
- **Attribution trust messaging** — global status bar badge (Reliable / Estimated / Low confidence) and per-skill ROI + confidence % in usage and cost dashboards.

## [1.0.19] - 2026-06-12

Pipeline index, confidence propagation, and real-time optimizer.

### In-memory index

- **Runs cache** — derived v2 hook counts and session ids alongside cached `runs.jsonl` parse; `countV2HookRuns` / `sessionHasV2HookRuns` use cache.
- **Transcript cache** — `transcriptUsageIndex.ts` fingerprints transcript mtimes; `computeEnabledAgentsCreditUsage` avoids full re-read when unchanged.
- **Invalidation** — collector, prune, and reset clear transcript + runs caches together.

### Confidence on every layer

- **Usage Report** — trust banner and per-skill confidence column (`high` / `estimated` / `low`).
- **Predictive alerts** — include confidence %; suppress trend-only alerts when confidence is `low`.
- **Weekly report** — attribution confidence line.
- **Cost Dashboard** — pipeline trace shows confidence alongside stage timings.

### Real-time optimizer

- **`autoDetectOnPipeline`** (default on) — debounced (~5s) auto-apply after each cost pipeline sync when `autoApply` is enabled.
- **30-minute timer** — uses shared `runAutoOptimizePass` (no duplicate pipeline run).

## [1.0.18] - 2026-06-12

Attribution, pipeline resilience, and dashboard UX release.

### Cursor skill attribution

- **Expanded skill path detection** — hooks and transcript parsers now recognize `.cursor/skills-cursor/`, `skills_library/`, and `.agents/skills/` in addition to `.claude/skills/` and `.cursor/skills/`.
- **Cursor hook session fallbacks** — `skill-invoke-watch.js` resolves sessions from `conversation_id`, `generation_id`, or `tool_use_id` + workspace root when `conversation_id` is missing.
- **Model capture** — Cursor hook runs record model id when present in tool output.

### Cost pipeline & system mode

- **Pipeline tracing** — each sync cycle records stage timings and errors in the dashboard System panel.
- **Circuit breaker** — trips after >10 pipeline runs per minute; skips further sync until the window clears and forces **safe mode** (auto-optimize disabled).
- **Scheduler coordination** — attribution collect can skip re-scheduling the pipeline to avoid double-sync loops.

### Dashboard & reports

- **Shared compact UI** — `dashboardStyles.ts` unifies Cost Intelligence, Usage Report, and Setup wizard chrome (stat pills, tighter panels, pill hook badges).
- **Models by agent** — dashboard panel shows per-model spend and tokens for Claude and Cursor (14d window).
- **CSP-safe webviews** — nonce-based script listeners replace inline `onclick` in setup wizard and cost dashboard.

### Usage report & attribution accuracy

- **`runs.jsonl` scope** — Attribution v2 hook invocations and self-learning records only; background collector no longer writes equal-split transcript rows into `runs.jsonl` (transcript estimates stay in `cost-attribution.json`).
- **Skills detail table** — Usage Report runs/tokens count hook + self-learning rows only; **Credits · 14d** still reflects session transcript spend for the workspace.
- **Reset Mis-attributed Cost Data** — removes legacy collector transcript rows from `runs.jsonl`, clears `transcriptSkills`, refreshes the pipeline index; re-collection no longer repopulates bad per-skill run counts.

### Predictive cost alerts

- **Workspace-scoped** — trend and budget warnings use enabled-agent transcripts for the **current workspace**, not all of `~/.claude/projects/`.
- **Sanitized math** — WoW % requires a meaningful prior week (minimum spend + active days); capped at ±200%; projection continues last week’s pace instead of compounding absurd percentages.

### Pipeline roadmap (documented)

Implemented in **v1.0.19**:

- **Confidence on every layer** — Usage Report trust banner and per-skill confidence column; weekly report, predictive alerts, and pipeline trace include workspace confidence.
- **In-memory index** — `learningStateIndex` derived v2 stats; `transcriptUsageIndex` caches transcript credit usage by mtime fingerprint.
- **Real-time optimizer** — `claudeSkills.optimizer.autoDetectOnPipeline` (default on) debounces detect → auto-adjust after each pipeline sync when `autoApply` is enabled.

## [1.0.17] - 2026-06-12

FinOps and platform-hardening release — extends consolidated **1.0.0** with ROI, explicit system state, and faster cost indexing.

### Cost intelligence & ROI

- **ROI model** — per-skill time-saved heuristics (e.g. `deployment-practical` ~20 min), bands `HIGH` / `MEDIUM` / `LOW`, skills-tree sort and dashboard labels.
- **Attribution confidence** — graded `high` / `estimated` / `low` per skill and workspace (0–1 score); dashboard trust banner and per-row badges.
- **Value panel** — estimated minutes saved, dollar value (@ configurable hourly rate), net ROI in Cost Intelligence Dashboard.
- **Financial optimizer** — suggestions show **monthly savings** (e.g. `Disable "X" → save ~$12/month`, agent-switch % savings).
- **Team economics (foundation)** — cost by repo and by skill owner (git blame proxy) in dashboard when attribution is reliable.

### System architecture

- **Unified system state** — `.claude/learning/system-state.json` (`profileInit`, `attribution`, `hooks`, agent capabilities).
- **Write coordination** — atomic JSON writes + `.claude/learning/write-locks.json` for profile-init files; extension lock on apply.
- **Runs indexing** — `skill-stats.json` and `daily-stats.json` refreshed on extension refresh (avoids full `runs.jsonl` rescans).
- **In-memory runs cache** — mtime/size keyed cache invalidated on append and token enrichment.
- **Agent capability map** — deterministic hooks/tokens/transcripts support per agent for fallback debugging.
- **Attribution strategy** — formal fallback chain: hooks → transcripts → heuristics (shown in dashboard).

### Pricing & audit path

- **Manual pricing overrides** — `.claude/learning/pricing-overrides.json` for model $/M tokens and default hourly rate (ROI); workspace-scoped via extension refresh.

### Marketplace & tooling

- Extension version **1.0.17** supersedes live **1.0.16** on Marketplace.
- `scripts/unpublish-marketplace-versions.ps1` — per-version delete via Gallery REST API (not `vsce unpublish @version`).

## [1.0.1] - 2026-06-12

Same content as the consolidated 1.0.0 release below — publishable Marketplace version after 1.0.0 was already taken.

## [1.0.0] - 2026-06-12

First consolidated production release.

### Skills & detection

- Bundled skill library in `skills_library/` with `manifest.json` (`detect_globs`, cost tiers).
- CLI (`generate_skills.py`) and extension: install globally, per workspace, preview detection.
- Project-local skills in `.claude/skills/`; never auto-removed by resolver.

### Multi-agent

- Deploy to **Claude Code**, **Cursor**, **Kiro**, and **GitHub Copilot** (`.claude/`, `.cursor/`, `.kiro/`, `.github/instructions/`).
- Sync effective skill set (respects `skillOverrides`) across agents; Copilot bootstrap index.
- Attribution v2 PostToolUse hooks for all enabled agents → `.claude/learning/runs.jsonl`.

### Profile init (role + branch)

- **Agent-driven** skill setup on new git branches — no fixed role→skills map.
- Position saved locally: `.claude/position.local.json`.
- Extension writes `.claude/learning/skills-catalog.json` and `.claude/learning/profile-init-request.json`.
- **`profile-init` skill** — agent picks skills from catalog; writes `.claude/profile.local.json` (gitignored).
- **SessionStart hook** (`profile-init-watch.js`) auto-injects profile-init on new AI sessions when init is pending.
- Auto-apply installed skills + branch profile save; syncs `profile-init` to all enabled agents.
- Commands: Set Your Position, Init Profile for Current Branch, Refresh Skill Catalog, Apply Local Profile.
- Settings: `claudeSkills.profileInit.*` (`enabled`, `promptOnNewBranch`, `autoApplyProfileFile`, `autoStartOnSession`).

### Branch & team profiles

- Personal per-branch layouts in `~/.claude/learning/branch-profiles.json`.
- Optional team profiles in git: `.claude/skills-profile.json`.
- Local-only toggles via `.claude/settings.local.json` (`skillOverrides`).

### Cost intelligence

- Cost Intelligence Dashboard, usage reports, budget modes (Economy / Normal / Unlimited).
- Attribution collector, emergency cutoff, optimization suggestions, weekly email report (opt-in).
- Context focus and practical/deployment focus hooks.
- Skill set resolver (weekly install/remove by relevance and usage).

### Developer experience

- Activity bar Skills tree, setup wizard, onboarding tour, feature toggles.
- SKILL.md lint (advisory), error recovery, migration from v0.7.x.
- GitHub Actions CI: compile + vitest.

### Requirements

- VS Code / Cursor 1.85+; optional `vscode.git` (CLI fallback for branch profiles).
- Git optional; GitHub CLI optional (PR cost estimates).
