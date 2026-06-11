# Changelog

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
