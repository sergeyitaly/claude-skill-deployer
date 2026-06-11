# Changelog

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
