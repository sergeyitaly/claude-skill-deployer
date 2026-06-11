# claude-skills-deployer

Personal tool to detect which AI agent skills are relevant to a project
(based on which files are present) and install matching instructions from a
shared library — starting with [Claude Code](https://docs.claude.com/claude-code)
and extending to **Cursor**, **Kiro**, and **GitHub Copilot**.

Skills live in `skills_library/` (source of truth). Deploy globally to your
machine, per workspace, per git branch, and across multiple AI agents from
one manifest.

## Two ways to use this

| Surface | Best for |
|---|---|
| **CLI** (`generate_skills.py`) | Scripts, CI, any editor, no VS Code install |
| **VS Code extension** ([`extension/`](extension/)) | Activity-bar UI, budget controls, cost intelligence, branch profiles, multi-agent sync |

See [`extension/README.md`](extension/README.md) for the full extension guide.

## Quick start (extension)

1. Install **Claude Skills Manager** from the Marketplace (or a `.vsix` from `extension/`).
2. Open a workspace folder.
3. **Claude Skills** activity bar → **Install Skill Library to ~/.claude/skills** (one-time).
   With `multiAgent` on (default), this also seeds `~/.cursor/skills/`, `~/.kiro/skills/`, and Copilot global instructions when those agents are enabled.
4. **Install Relevant Skills for Workspace** (or **Preview** first).
   By default, detected skills are copied to **all enabled agent paths** in the workspace (`.claude/skills/`, `.cursor/skills/`, `.kiro/skills/`, `.github/instructions/`).
5. Optional: **Enable Cost Control Hooks**, open **Cost Intelligence Dashboard**, configure **Budget** and **Feature Toggles**.

The extension never hides skills already in `<workspace>/.claude/skills/` —
project-local skills show as *project-only* in the tree. `.claude/skills/` remains the git-tracked source of truth; other agent paths are mirrored automatically.

## Quick start (CLI)

```bash
py generate_skills.py install
py generate_skills.py list --target .
py generate_skills.py generate --target .
py generate_skills.py generate --target . --dry-run
py generate_skills.py cost-report --target .
py generate_skills.py cost-report --weekly
```

## Feature toggles (extension)

Toggle major capabilities without uninstalling the extension:

**Command Palette → Claude Skills: Manage Feature Toggles**

Or Settings → `claudeSkills.features.*`:

| Feature | Default | Purpose |
|---|---|---|
| `budgetControls` | on | Daily budget, economy mode, hooks |
| `branchProfiles` | on | Per-branch skill layouts |
| `multiAgent` | on | Cursor / Kiro / Copilot deploy |
| `attributionCollector` | on | Background transcript attribution |
| `costIntelligence` | on | Dashboard, suggestions, export |
| `autoOptimizer` | on | Scheduled safe auto-optimizations |
| `predictiveAlerts` | on | Weekly trend warnings |
| `communityBenchmarks` | off | Opt-in community cost benchmarks |
| `teamCostSharing` | on | Git author attribution on shared skills |
| `skillArchival` | on | Archive idle skills (restore available) |
| `emergencyCutoff` | on | Hard daily spend limit ($10 default) |
| `prCostEstimate` | off | PR cost comment via `gh` CLI |
| `costAwareSearch` | on | ROI/cost labels and sort in skills tree |

## Cost intelligence

- **Cost Intelligence Dashboard** — top expensive skills, cross-agent savings, team attribution
- **Attribution collector** — parses session transcripts; attributes tokens only to **invoked** skills (not the full skill catalog). Sessions with no detected invocation go to `unattributed`.
- **Reset Mis-attributed Cost Data** — clears bad collector rows and `transcriptSkills` for re-collection (`scripts/reset_attribution.py` CLI equivalent)
- **Optimization suggestions** — disable expensive low-use skills, agent-switch hints
- **Apply optimizations** — interactive or `claudeSkills.optimizer.autoApply` (keep `false` until attribution data looks sane)
- **Community benchmarks** — `~/.claude/learning/community-benchmarks.json` (opt-in upload/download URLs)
- **Emergency cutoff** — disables all workspace skills above `claudeSkills.emergency.hardLimitUsd`; reset via command
- **Skill archival** — moves idle skills to `.claude/skills-archived/` (restore command)
- **PR cost estimate** — `Claude Skills: Estimate PR Review Cost` (needs `gh`, feature on)
- **Commit cost hook** — post-commit line in terminal + `commit-costs.jsonl`

CLI helpers:

```bash
py scripts/send_weekly_report.py --target .
py scripts/send_weekly_report.py --create-issue   # gh issue
py scripts/test_skill_cost.py terraform-plan-review --write-manifest
```

## Multi-agent support

See `skills_library/agents.json`.

| Setting | Default | Effect |
|---|---|---|
| `claudeSkills.agents.enabled` | `claude`, `cursor`, `kiro` | Which agents receive clones |
| `claudeSkills.agents.syncWorkspaceToAll` | `true` | Workspace installs fan out to all enabled paths (requires `multiAgent` feature) |
| `claudeSkills.agents.syncGlobalToAll` | `true` | Global library install fans out to all enabled agents |

Checkbox install/remove, branch profile apply, and changes under `.claude/skills/` also sync to other agents when `syncWorkspaceToAll` is on.

## Per-branch skill profiles

`~/.claude/learning/branch-profiles.json` — personal layouts per git branch.
Committed `.claude/skills/` remains team source of truth.

- **Branch profiles** section at the top of the Skills tree (current branch + saved profiles)
- Toolbar icons: show / save / apply branch profile (git repos only)
- Auto-save on skill install/remove; optional auto-apply on branch switch

## Library layout

```
skills_library/
  manifest.json       # detect_globs, cost_estimate, optional empirical_cost
  agents.json
  <skill-name>/SKILL.md
```

## Packaging & publishing

```powershell
cd extension
npm install
npm run package
npx vsce publish
```

Current extension version: **1.0.1** (`serhiivoinolovych`).

## Performance impact

- **CPU**: under 1% idle; 2–5% during attribution collection (5-minute intervals)
- **Memory**: ~50 MB baseline; +20 MB when the dashboard WebView is open
- **Disk**: ~500 KB per project for `runs.jsonl`; ~100 KB for attribution data
- **Startup**: under 200 ms added to VS Code activation

Tuned for workspaces with fewer than 100 skills and fewer than 10K transcript lines.

## Compatibility

| Component | Version |
|---|---|
| VS Code | 1.85+ |
| Claude Code | 0.2+ |
| Node.js | 18+ (for hooks) |
| OS | Windows 10+, macOS 11+, Linux (glibc 2.28+) |

Git integration is optional (branch profiles, team attribution). GitHub CLI is optional (PR cost estimates).

## Pre-publish validation

```bash
node scripts/validate-release.mjs
```

## v1.0.x onboarding & recovery

First launch shows **Get Started** → onboarding tour. Migration backs up v0.7 learning data to `.claude/backup-v0.7/`.

| Command | Purpose |
|---|---|
| `Claude Skills: Start Onboarding Tour` | Guided setup |
| `Claude Skills: Repair Claude Skills Data` | Fix corrupted JSON/JSONL |
| `Claude Skills: Reset Mis-attributed Cost Data` | Clear bad cost attribution after v1.0.0 collector bug |

See [CHANGELOG.md](CHANGELOG.md) for v1.0.1 attribution, branch-profile, and multi-agent sync fixes.

## What this tool does NOT do

- No validation of `SKILL.md` frontmatter.
- Community benchmark upload requires you to configure endpoints (no default public server).
- PR comments require GitHub CLI and explicit feature enable.
- Copilot clones are instruction files, not native Copilot skills.
