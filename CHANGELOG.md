# Changelog

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
