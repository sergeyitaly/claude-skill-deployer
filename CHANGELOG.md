# Changelog

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
