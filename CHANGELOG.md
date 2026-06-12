# Changelog

## [1.0.16] - 2026-06-12

### Added

- **Profile init** — agent-driven skill setup for new git branches: extension writes `.claude/learning/skills-catalog.json`; the agent picks skills from the live catalog (no fixed role map) via **`profile-init`**; output in gitignored `.claude/profile.local.json`; auto-install and branch profile save.
- **Position** — `.claude/position.local.json` stores team role (DevOps, QA, AQA, Backend, Frontend, BA, Resource Manager, Team Lead) locally, not in git.
- **Commands** — Set Your Position, Refresh Skill Catalog for Agent, Init Profile for Current Branch, Apply Local Profile.
- **Settings** — `claudeSkills.profileInit.enabled`, `promptOnNewBranch`, `autoApplyProfileFile`.
- **Multi-agent** — `profile-init` syncs to Cursor (`.cursor/skills/`), Kiro (`.kiro/skills/`), and Copilot (`.github/instructions/`); catalog/apply/branch restore remain extension-side and agent-agnostic.

### Documentation

- Root and extension README: profile init flow, local file contract, and using Cursor/Kiro/Copilot with the same `.claude/` paths.

## [1.0.15] - 2026-06-12

### Added

- **Context focus** — toggle and `context-focus-watch.js` hook to balance local workspace grounding vs general LLM knowledge (Knowledge-forward → Strict local); auto-tightens on large sessions; status bar cycle command.
- **Practical / deployment focus** — toggle and `practical-focus-watch.js` hook for architecture-first and deploy-ready guidance (exact commands, validation, rollback) instead of theoretical advice.
- **`deployment-practical` skill** — first-try deployment checklist bundled in `skills_library/`; auto-detected on Terraform/CI/Docker repos.
- **Skill set resolver** — weekly scheduled install/remove of relevant skills with usage-based rules (sessions, tokens, cost, idle days); Preview and Run Now commands.
- **Hook integration tests** — spawn `context-focus-watch.js` and `practical-focus-watch.js` with isolated config paths (`CLAUDE_SKILLS_*_CONFIG` env vars).

### Fixed

- **Feature toggles** — `contextFocus` and `practicalFocus` appear in Manage Feature Toggles; disabling a feature syncs `enabled: false` to hook config on disk.
- **Focus cycle commands** — cycling past the strictest level disables focus (instead of wrapping silently).
- **Workspace hook status** — dashboard/onboarding report context-focus and practical-focus hook state.

## [1.0.14] - 2026-06-12

### Added

- **Feature toggle descriptions** — **Manage Feature Toggles** QuickPick shows a detail line per feature (e.g. budget controls, cost intelligence) via `FEATURE_DESCRIPTIONS` in `featureFlags.ts`, matching Extension Settings wording.
- **Multi-agent Attribution v2** — PostToolUse hooks for Claude, Cursor, Kiro, and GitHub Copilot log skill invokes to `runs.jsonl`; Kiro `USER_PROMPT` and Copilot `.github/instructions/*.instructions.md` reads supported.
- **`claudeSkills.agents.autoInstallAttributionHooks`** (default on) — installs attribution hooks on extension activate / workspace skill changes.
- **Workspace hooks status** — Cost Intelligence dashboard and Usage Report show attribution and session/budget hook state per agent.
- **Official Anthropic skills** — bundled in `skills_library/` (docx, pdf, pptx, xlsx, mcp-builder, webapp-testing, and related skills from anthropics/skills).
- **Tests** — hook install, skill-invoke hook script, workspace hook status, budget ops, workspace skill sync, and live-workspace feature integration coverage.

### Fixed

- **`autoOptimizer` default** — runtime default now matches `package.json` schema (`false` until attribution is trustworthy).
- **Cursor v2 token enrichment** — transcript backfill scans Cursor roots and `conversationId` session ids.
- **Transcript skill detection** — `.kiro/skills/` and Copilot instruction paths in `parseActiveSkills`.
- **Learning artifact mirror** — skips `cost-attribution.json`, `runs.jsonl`, and related attribution state (avoids stale `.cursor/learning/` copies).

### Changed

- **`.gitignore`** — ignore `.cursor/`, `.kiro/`, and `.vscode/` workspace agent folders (`.github/` remains tracked for CI).

## [1.0.13] - 2026-06-12

### Fixed

- **Cursor usage missing in Cost Intelligence** — Cursor stores project folders as `c-Users-...` (single dash after drive) under `~/.cursor/projects`, not Claude's `c--Users-...` encoding; workspace matching now accepts both. Cursor `agent-transcripts/*.jsonl` files are token-estimated from content (no Claude-style `usage` lines).

## [1.0.12] - 2026-06-11

### Fixed

- **Extension Settings page empty** — `contributes.configuration` is now an array with unique `id` fields and a default category titled **Claude Skills Manager** (matches `displayName`), so settings appear under Extensions → Claude Skills Manager → Extension Settings in VS Code and Cursor.
- **Open Extension Settings** — new command and Skills Library toolbar gear opens `@ext:serhiivoinolovych.claude-skill-deployer` filtered settings.
- **CI unit tests** — `pretest` runs `sync-skills` before `vitest` so Linux CI has `extension/skills_library/manifest.json` (that folder is gitignored and copied from repo-root `skills_library/`).

## [1.0.10] - 2026-06-11

### Added

- **Unit tests** — 66 Vitest cases covering `costRates`, `usageCost`, `learningPrune`, `autoOptimizerRateLimit`, `budgetConfig`, `skillCost`, `localDate`, and expanded attribution/transcript helpers.

### Fixed

- **Workspace transcript path encoding** — Windows (`C:\...`) and POSIX (`/home/...`) absolutes encode literally on all platforms (fixes Linux CI and cross-OS matching under `~/.claude/projects`).
- **`workspaceFromTranscriptFile`** — decode without `path.resolve` so Linux runners and paths with hyphens in folder names behave predictably.

## [1.0.9] - 2026-06-11

### Added

- **Official skills session check** — `SessionStart` hook (`official-skills-watch.js`) when `skills_library/` exists; compares `anthropics/skills` HEAD and prompts `skill-official-updater`. Commands: **Check Official Anthropic Skill Updates**, **Enable Official Skills Session Check**. Setting: `claudeSkills.officialSkillsCheckOnSession` (default on).
- **Optimizer thresholds** — `claudeSkills.optimizer.disableCostPerUseUsd`, `disableMaxRuns`, `agentSavingsRatio`, `unusedIdleDays`, `unusedMinCostUsd`.
- **Emergency per-skill limit** — `claudeSkills.emergency.perSkillLimitUsd` (default $3).

### Fixed

- **Stale $579.51 equal-split warning** — auto-purges bad `transcriptSkills` on load; banner suppressed when only stale transcript data (not runs) caused the cluster; stale cluster no longer returns empty per-skill map.
- **Agent totals inflated** — Claude/Cursor spend scoped to **this workspace folder** (encoded project path under `~/.claude/projects`).
- Legacy attribution migration strips equal-split `transcriptSkills` before copying to per-workspace file.
- **skillLint** — always lint Cursor/Kiro/Copilot mirrors; lint blocks multi-agent sync only (hooks and branch profiles still run).
- **emergencyCutoff** — disables over-threshold skills (not all skills); reset restores prior `skillOverrides`.
- **autoOptimizer** — max 3 auto-applies per 30 minutes.
- **skillArchival** — sanitize skill names; restore from archive or `skills_library` source.
- **Shell safety** — `prCostEstimate`, `teamCostSharing`, `weeklyReport` use `execFileSync`; scrubbed SMTP error text; scheduled send failures surface in UI.
- **Local “today”** — `usageCost`, `todayCostSnapshot`, `costPredictor` use local calendar date (not UTC midnight).
- **Unbounded growth** — prune collector state maps, `runs.jsonl`, and reset backup files.
- **attributionCollector** — single transcript read per file.
- **v2TokenEnrichment** — structured `sessionId` matching (no substring false positives).
- **costDashboard** — CSP nonce on webview scripts.
- **extension.ts** — dispose git listeners; log previously swallowed errors.
- **migration** — mark complete only after backup succeeds.
- **skillOps / agentOps** — guarded `manifest.json` / `agents.json` parse.
- **costRates** — single pricing source for usage estimates.
- **skillRoi** — zero-guard in `best_value` sort.
- **copilotTransform** — shared frontmatter parser + YAML escaping.
- Dead code removed: unused `isGitRepo`, unreachable `create-learning-dir` repair branch.

## [1.0.8] - 2026-06-11

### Fixed

- **Per-workspace cost profiles** — `cost-profile.json` under `<workspace>/.claude/learning/` (legacy global file migrates on first read).
- **AttributionCollector** — one instance per workspace path; periodic collection follows the active folder instead of mutating a singleton target.
- **skill-invoke-state.json** — prunes entries older than 30 days and caps at 3000 keys.

### Changed

- README limitations updated for SKILL.md lint and estimate-only cost intelligence.

## [1.0.7] - 2026-06-11

### Added

- **Per-workspace collector state** — `attribution-collector-state.json` under `<workspace>/.claude/learning/` (legacy global file migrates on first use).
- **Multi-root workspaces** — active editor's workspace folder is used; status bar picker + **Pick Active Workspace Folder** when multiple roots are open.
- **SKILL.md lint** on sync — validates name, description, frontmatter, and size (`claudeSkills.lint.*`).
- **Team profiles tree section** — git `.claude/skills-profile.json` branches appear above personal branch profiles.
- **Dashboard per-suggestion Apply** — disable/switch-agent suggestions apply in one click (sets `skillOverrides` or agent preference).
- **Model-aware estimate disclaimer** — shared `costRates` module; dashboard banner clarifies estimates vs invoices.
- **GitHub Actions CI** — `npm run compile` + `npm test` on push/PR.
- Marketplace capture helper script (`scripts/capture-marketplace-assets.ps1`).

### Changed

- Cost attribution and runs use `costRates.tokenCostUsd()` with optional model hint when available.

## [1.0.6] - 2026-06-11

### Added

- **Per-workspace cost attribution** — `cost-attribution.json` lives under `<workspace>/.claude/learning/` (legacy global file migrates on first read).
- **v2 token backfill** — collector enriches hook rows with zero tokens by matching `tool_use_id` to Claude transcript usage.
- **attributionHealth** and **v2TokenEnrichment** unit tests; `validate-release.mjs` runs `npm test`.

### Fixed

- **Branch profile order** — team git profile (`.claude/skills-profile.json`) applies first; personal profile applies on top.
- Attribution v2 hook matcher narrowed to **Skill** only (no passive `Read` of `SKILL.md`).

### Changed

- `syncHooksOnSkillChange` auto-installs/updates Attribution v2 hooks when workspace skills exist.

## [1.0.5] - 2026-06-11

### Added

- **Attribution v2** — `Enable Attribution Hooks (v2)` installs a PostToolUse hook that logs each Skill/Read invoke to `runs.jsonl` (`metadata.source: skill-invoke-hook-v2`). Cost dashboard prefers hook-based attribution and skips equal-split transcript merge when v2 data exists.
- **Copilot bootstrap** — sync writes `.github/copilot-instructions.md` index plus per-skill `.github/instructions/*.instructions.md` with frontmatter.
- **Team branch profiles in git** — export/apply `.claude/skills-profile.json` per branch (`Export Team Branch Profile to Git`, auto-apply on branch switch).
- **Unit tests** — vitest coverage for transcript parsers, copilot transform, and attribution display logic.
- **Marketplace gallery** — screenshot assets for skills tree, cost dashboard, and setup wizard.

### Changed

- Setup wizard step 3 includes attribution hooks alongside budget/cost hooks.

## [1.0.4] - 2026-06-11

### Added

- **Setup wizard** WebView (`Open Setup Wizard`) with verified global + workspace install steps before optional cost features.
- **Attribution health gate** (`assessAttributionHealth`) — blocks optimizer and hides per-skill dashboard sections until data is reliable.
- Dashboard **per-skill setup checklist** when attribution is incomplete.

### Fixed

- Onboarding no longer marks complete on Skip/Later; tour requires explicit confirmation.
- Skill checkbox no longer auto-installs cost hooks — only refreshes scripts if hooks were already enabled.
- ROI/cost labels prefixed with **Est.**; cross-agent “potential” savings relabeled as speculative heuristic.
- Community benchmark lines hidden until benchmark URLs are configured.
- Weekly report and auto-optimizer feature **off by default**.
- Release smoke-test/validate scripts no longer pin a hardcoded version.

### Changed

- File watcher narrowed to manifest-relevant paths (removed `**/*`).
- `Start Onboarding Tour` kept as separate step-prompt command.

## [1.0.3] - 2026-06-11

### Added

- **Workspace skill propagation** (`propagateWorkspaceSkillChange`): any change under `.claude/skills/` mirrors to Cursor, Kiro, and Copilot; optionally refreshes cost-control hooks (`claudeSkills.agents.syncHooksOnSkillChange`).
- **Local-only skill toggles**: disable branch skills via `skillOverrides` in `.claude/settings.local.json`; personal-only installs use `.git/info/exclude`.
- **Per-agent spend panel** on Cost Intelligence Dashboard (transcript-based, last 14 days).
- `scripts/check_cost_data.py` — diagnose inflated equal-split attribution vs real transcript totals.

### Fixed

- **Cost dashboard stale attribution**: detects equal-split mis-attribution (many skills at identical cost) and hides per-skill rankings, cross-agent savings, and disable suggestions until **Reset Mis-attributed Cost Data** is run. Agent-level totals remain accurate.
- Text/export cost reports show the same warning instead of bogus $579.51 disable hints.
- Multi-agent sync uses **effective** enabled skills (respects local overrides).

## [1.0.2] - 2026-06-11

### Added

- **Scheduled weekly AI usage report** in the extension (`claudeSkills.weeklyReport.*`): default Monday 9:00 local time, sends an informative email via SMTP. One-time **Configure Weekly Report Email** wizard stores a GitHub/GitLab PAT (email discovery) and SMTP credentials in VS Code Secret Storage.

## [1.0.1] - 2026-06-11

### Fixed

- **Multi-agent auto-sync**: workspace and global skill installs now fan out to all enabled agents by default (`.claude`, `.cursor`, `.kiro`, `.github/instructions`); checkbox install, branch profile apply, and `.claude/skills` file watcher also sync.
- **Branch skill profiles not visible**: git detection now falls back to `git` CLI when `vscode.git` is not ready; profiles appear as a **Branch profiles** section at the top of the Skills tree; toolbar icons added for show/save/apply.
- **Critical cost mis-attribution**: transcript parser no longer treats the full `skill_listing` catalog as invoked skills. Tokens are attributed only to skills with evidence of actual use (path reads, Skill tool, explicit markers).
- Conservative fallback: sessions with no detected invocations go to `unattributed` instead of being split evenly across all enabled skills.
- New command **Reset Mis-attributed Cost Data** clears bad collector rows and `transcriptSkills` for re-collection.
- Dashboard and usage report warn when unattributed token volume is significant.

### Changed

- `self-learning` run schema documents `metadata.invoked: true` for accurate per-skill attribution.

## [1.0.0] - 2026-06-11

### Major milestone

Production-ready cost intelligence after 0.7.x preview releases.

### Added

- Interactive onboarding tour (`Claude Skills: Start Onboarding Tour`)
- First-run "Get Started" prompt and friendly global library setup when `~/.claude/skills/` is missing
- Error recovery / self-healing for corrupted `runs.jsonl` and `budget.json`
- v0.7 → v1.0 migration backup at `<workspace>/.claude/backup-v0.7/`
- Opt-in local health metrics (`claudeSkills.telemetry.enabled`)
- Attribution deduplication (session + file mtime) to prevent double counting
- Git repo detection — branch profiles disabled silently when not in a git repo
- Release validation script (`scripts/validate-release.mjs`)

### Cost intelligence

- Real-time budget tracking with emergency cutoff
- Cross-agent attribution (Claude, Cursor)
- Predictive spend alerts and auto-optimization (opt-in)
- Cost Intelligence Dashboard, PR cost estimates (optional), team git author attribution

### Developer experience

- Feature toggles for all major capabilities
- Cost-aware skill tree sorting (ROI / lowest cost)
- Skill archival with restore

### Migration from v0.7.x

Automatic on first launch. Learning data copied to `.claude/backup-v0.7/learning/`.

## [0.7.1] - 2026-06-11

- Cost intelligence platform: attribution, dashboard, optimizations, feature toggles
- Team cost sharing, community benchmarks (opt-in), emergency cutoff
- CLI: `cost-report`, weekly report script

## [0.7.0] - 2026-06-11

- Budget controls, branch profiles, multi-agent skill sync
