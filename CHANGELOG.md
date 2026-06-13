# Changelog

All notable changes to **Claude Skills Manager** (VS Code extension) are documented here.

Consolidated release line starts at **1.0.1** (2026-06-12). **1.0.29** is the current Marketplace publish target.

## [Unreleased]

## [1.0.29] - 2026-06-14

### Added

- **Cross-agent skill usage** — Usage Report and weekly email show per-agent totals (Claude Code, Cursor, Kiro, Copilot) and a matrix for skills invoked across multiple agents on the same workspace.
- **Task skill focus** — after auto-apply, non-proposed installed skills are set `skillOverrides: off` to reduce agent token load (re-enable via Skills tree).
- **Deterministic automation** — extension can apply profile init and refresh task proposals without an agent session (`deterministicApply`, `deterministicTaskProposals` settings, default on).

### Changed

- **Extension performance** — manifest/skill-status/detection caches, coalesced workspace refresh, lighter tree updates when sidebar hidden.
- **Session hooks** — slimmer `profile-init-watch` when proposals are fresh; `session-apply` bugfix; `task-skill-focus` hook.
- **`skill-usage-insights`** and **`skill-feedback-adaptation`** — document per-agent usage and skip redundant agent work when auto-apply is on.

### Fixed

- **TypeScript compile** — `readSkillStatsIndex` import path, `initBy: "extension"` type, debounced git callback arity, cross-agent `agentRuns` optional typing.

## [1.0.28] - 2026-06-13

### Added

- **NEW SESSION task-proposal hook** — `profile-init-watch.js` injects skill-feedback-adaptation guidance on every new session for Claude, Cursor, Kiro, and Copilot (after profile-init completes).
- **VS Code integration smoke test** — `@vscode/test-electron` activates the extension, runs `claudeSkills.refresh`, and verifies bundled skills load (`npm run test:integration`). Uses `CLAUDE_SKILLS_INTEGRATION_TEST=1` to skip first-run modals and heavy startup sync.
- **Release cadence policy** — weekly batch releases documented in `PUBLISHING.md`; Open VSX namespace ownership checklist added.

### Changed

- **`skill-feedback-adaptation`** — AUTO-START section for new sessions/tasks; stronger frontmatter description.
- **Publish workflow** — runs unit tests and integration smoke before packaging/upload.
- **CI** — split unit and integration jobs; integration uses `xvfb-run` on Ubuntu.

### Fixed

- **`profileInit` unit tests** — 30s timeout on slow file-copy tests (Windows CI flake).

## [1.0.27] - 2026-06-13

### Added

- **`autoApplyTaskProposals` toggle (default on)** — auto-install and locally enable every skill in **Proposed for current task**, plus required platform skills (`self-learning`, `skill-creator`, etc.), for this workspace only.
- **Task proposals file watcher** — applies when `task-skill-proposals.json` is created or updated (deduped by `generatedAt`).
- Hooks and CLI merge required platform skills into session apply requests.

### Changed

- **Session skill apply** no longer caps at 20 skills when merging profile + proposals + required set.
- **Apply Suggested Skills for Current Task** installs the full proposal list (with required skills merged), not only uninstalled rows.

## [1.0.26] - 2026-06-13

### Added

- **Headless Claude CLI apply/sync** — `skills_sync.py` + `generate_skills.py` subcommands: `apply-session`, `apply-profile`, `sync-branch`, `sync-agents`, `sync`, and `hooks install` (works without VS Code running).
- **`session-apply.js` hook** — SessionStart auto-installs/enables proposed skills from profile and task proposals (no extension process required).
- **`branch-sync.js` + git post-checkout hook** — applies saved branch skill profiles on `git checkout` when using Claude CLI only.
- **`cli-config.json` sync** — extension writes `.claude/learning/cli-config.json` from feature toggles so CLI/hooks match IDE settings when the IDE is closed.
- **Prepare for Claude CLI** command — one-click setup: global library, workspace skills, cost/profile hooks, CLI config, and git branch hook.

### Changed

- Extension `refreshAll` keeps `cli-config.json` in sync with current feature toggles and enabled agents.

## [1.0.25] - 2026-06-13

### Added

- **Session skill adaptation** — on each new agent session/window, install and locally enable skills from `profile.local.json` and/or `task-skill-proposals.json`. Toggle via `claudeSkills.features.sessionSkillAdaptation` (default on) or **Manage Feature Toggles**.
- **Multi-agent profile-init hooks** — SessionStart / sessionStart hooks for **Cursor** (`.cursor/hooks.json`), **Kiro** (`.kiro/hooks/`), and **GitHub Copilot** (`.github/hooks/`); `profile-init-watch.js` accepts `cursor`, `kiro`, and `copilot` platform args.

### Fixed

- **Per-IDE profile-init skill sets** — after profile-init applies, the host IDE skill set (Cursor, Kiro, or VS Code/Copilot) is saved via `detectHostAgentId()`, not only the shared branch profile. Logs show the correct mirror path (`.cursor/skills/`, `.kiro/skills/`, `.github/instructions/`).
- **Profile-init deploy noise** — pending profile-init deploys only the `profile-init` skill (latched once per workspace), not a full force-sync of every skill on each refresh.
- **Open VSX publish after Marketplace** — `publish:openvsx` runs `npm run package` when the versioned VSIX is missing (instead of falling back to an older `.vsix`). `publish:all` now packages between Marketplace and Open VSX steps.
- **Copilot attribution hook constant** — restore `COPILOT_SKILL_INVOKE_COMMAND` after profile-init hook work so Copilot skill-invoke hooks install correctly.

## [1.0.24] - 2026-06-13

### Fixed

- **Windows EBUSY on hook copy** — hook and skill file copies retry with backoff and skip unchanged files, avoiding `resource busy or locked` failures when Kiro/Cursor agents hold `skill-invoke-watch.js` open during install.
- **Install survives hook lock** — `installSkillToWorkspace` completes with a warning if post-install hook sync fails instead of aborting the command.
- **Quieter startup sync** — debounce routine workspace propagate on activate; only run multi-agent mirror sync when mirrors are missing or stale; log propagation only when files are actually written.
- **`claude-api` lint warning** — move long TRIGGER/SKIP rules from frontmatter into the skill body so description stays under the 500-char lint cap.

### Changed

- **`claude-api` skill** — shorter frontmatter description; trigger/skip guidance in a **When to use** section in the body.

## [1.0.23] - 2026-06-13

### Fixed

- **SKILL lint false positives on Windows** — frontmatter parser handles CRLF line endings and YAML block-scalar descriptions (`description: |-`). Fixes spurious `Frontmatter description is required` / `name field recommended` errors for valid skills.
- **Copilot mirror lint for disabled skills** — mirror lint only checks skills that are effectively enabled (`skillOverrides` not `"off"`), so economy-mode / personally disabled skills no longer warn about missing `.github/instructions/*.instructions.md`.

## [1.0.22] - 2026-06-13

### IDE / agent skill sets

- **Per-IDE skill layouts** — save and switch skill sets per git branch for **Cursor**, **Kiro**, **VS Code (Copilot)**, and **Claude Code** (`~/.claude/learning/agent-skill-profiles.json`).
- **Auto-detect host IDE** from editor name (Cursor/Kiro) or `claudeSkills.agentProfiles.vscodeAgent` for plain VS Code.
- **Commands** — Save Skill Set for Current IDE, Switch IDE / Agent Skill Set, Show IDE / Agent Skill Sets.
- **Auto-apply on workspace open** when a saved set exists for the current IDE + branch (`claudeSkills.agentProfiles.autoApplyOnActivate`).
- Diagram: [diagram/06-ide-agent-skill-profiles.md](diagram/06-ide-agent-skill-profiles.md) · [draw.io](docs/diagrams/skill-profiles-ide-branch-flow.drawio)

## [1.0.21] - 2026-06-13

### Distribution

- **Open VSX publishing** — `npm run publish:openvsx`, GitHub Actions workflow `Publish Extension`, and [extension/PUBLISHING.md](extension/PUBLISHING.md). Covers **Cursor** and **Kiro IDE** (both use [Open VSX](https://open-vsx.org/) as their extension gallery). Registry map: [diagram/00-extension-registries.md](diagram/00-extension-registries.md).
- **Direct install links** — README, diagrams, and publishing docs link to extension listing pages on [VS Marketplace](https://marketplace.visualstudio.com/items?itemName=SerhiiVoinolovych.claude-skill-deployer&ssr=false#version-history) and [Open VSX](https://open-vsx.org/extension/serhiivoinolovych/claude-skill-deployer).
- **`cursor-kiro-extension-publishing` skill** — agent guidance for Open VSX / Cursor / Kiro publish flow alongside `vscode-extension-publishing`.

## [1.0.20] - 2026-06-13

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
