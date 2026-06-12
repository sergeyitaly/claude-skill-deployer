# Changelog

All notable changes to **Claude Skills Manager** (VS Code extension) are documented here.

Consolidated release line starts at **1.0.1** (2026-06-12): Marketplace already had **1.0.0** published — VS Code does not allow republishing the same version number. Unpublish obsolete patch releases (1.0.2–1.0.16) manually in the [publisher portal](https://marketplace.visualstudio.com/manage) if desired.

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
