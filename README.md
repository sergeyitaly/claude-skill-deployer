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
| **VS Code extension** ([`extension/`](extension/)) | Activity-bar UI, budget controls, branch profiles, multi-agent sync, usage reports |

See [`extension/README.md`](extension/README.md) for the full extension guide
(commands, settings, hooks, status bar).

## Quick start (extension)

1. Install **Claude Skills Manager** from the Marketplace (or a `.vsix` from
   `extension/`).
2. Open a workspace folder.
3. **Claude Skills** activity bar → **Install Skill Library to
   ~/.claude/skills** (one-time).
4. **Install Relevant Skills for Workspace** (or **Preview** first).
5. Optional: **Enable Cost Control Hooks**, configure **Budget** settings,
   enable extra agents under `claudeSkills.agents.enabled`.

The extension never hides skills already in `<workspace>/.claude/skills/` —
project-local skills show as *project-only* in the tree.

## Quick start (CLI)

```bash
py generate_skills.py install                              # global ~/.claude/skills
py generate_skills.py list --target .                      # dry-run detection
py generate_skills.py generate --target .                  # install relevant skills
py generate_skills.py generate --target . --dry-run          # preview only
py generate_skills.py generate --target . --all --force    # full library, overwrite
```

`--target` defaults to the current directory.

## Library layout

```
skills_library/
  manifest.json       # skill metadata, detect_globs, cost_estimate tiers
  agents.json         # deploy paths per AI agent (Claude, Cursor, Kiro, Copilot)
  <skill-name>/
    SKILL.md          # Agent Skills-format instructions
```

### Adding a skill

1. Create `skills_library/<skill-name>/SKILL.md`.
2. Add an entry to `skills_library/manifest.json` (`description`,
   `detect_globs`, optional `cost_estimate`: `low` | `medium` | `high`).
3. CLI: `py generate_skills.py install`
4. Extension: `npm run sync-skills` in `extension/` (bundles into the `.vsix`).

## Multi-agent support

`skills_library/agents.json` defines where clones are written:

| Agent | Global | Workspace | Format |
|---|---|---|---|
| Claude Code | `~/.claude/skills/` | `.claude/skills/` | `SKILL.md` folders |
| Cursor | `~/.cursor/skills/` | `.cursor/skills/` | `SKILL.md` folders |
| Kiro | `~/.kiro/skills/` | `.kiro/skills/` | `SKILL.md` folders |
| GitHub Copilot | `~/.copilot/instructions/` | `.github/instructions/` | `*.instructions.md` (from `SKILL.md` + `applyTo`) |

Extension settings:

- `claudeSkills.agents.enabled` — default `claude`, `cursor`, `kiro`
- `claudeSkills.agents.syncGlobalToAll` — fan out global install
- `claudeSkills.agents.syncWorkspaceToAll` — fan out workspace install

Command: **Install Skill Library to All Enabled AI Agents**.

Usage reports aggregate **Claude + Cursor** session transcripts when both are
enabled. Learning artifacts under `.claude/learning/` are mirrored to
`.cursor/learning/` and `.kiro/learning/` in the workspace.

## Cost & credit controls (extension)

- **Daily budget** — estimated spend from session transcripts; warn at 80%,
  auto-disable high-tier skills at 100% (configurable).
- **Budget modes** — Economy (disable expensive skills), Normal, Unlimited.
- **Session-size hook** — nudge toward `/compact` with token/cost estimate.
- **Install preview** — dry-run shows estimated context cost from
  `cost_estimate` tiers.

Config: VS Code **Settings → Claude Skills → Budget**. Hooks sync to
`~/.claude/learning/budget.json`.

## Per-branch skill profiles (extension)

Each git branch can have a personal skill layout in
`~/.claude/learning/branch-profiles.json` (not committed). The extension
auto-saves on skill changes; on branch switch it restores the profile for the
new branch. Committed `.claude/skills/` remains the team source of truth
after `git commit`.

Settings: `claudeSkills.branchProfiles.*`

## Skill library (bundled)

| Skill | Purpose |
|---|---|
| `terraform-plan-review` | Terraform plan/apply review and drift triage |
| `azure-rbac-diagnostics` | Azure RBAC 403/AuthorizationFailed diagnostics |
| `adx-schema-check` | ADX/Kusto schema vs. code cross-check |
| `ci-pipeline-debug` | CI pipeline failure debugging (GitLab/GitHub/Azure DevOps) |
| `ci-preflight` | Reproduce CI lint/test/validate stages locally before pushing |
| `terraform-module-ops` | Terraform module map, state backend, safe-change workflow |
| `azure-resource-ops` | Azure CLI resource quick-reference and live diagnostics |
| `aidlc-tracker` | AI-DLC methodology phase/stage tracking |
| `aidlc-doc-writer` | AI-DLC document generation |
| `self-learning` | Project-local accumulated-experience store |
| `gitlab-pipeline-ops` | GitLab CI/CD pipeline navigation and `glab` CLI |
| `cross-platform-scripting` | OS/PowerShell detection for `.ps1`/shell scripts |
| `file-style-conventions` | No emoji outside Markdown; YAML trailing newline |
| `skill-usage-insights` | Skill usage KPI report from `runs.jsonl` |
| `drawio-diagrams` | Architecture diagrams via draw.io MCP (incl. Azure icons) |
| `vscode-extension-publishing` | Package and publish VS Code extensions via `vsce` |
| `skill-official-updater` | Sync from `github.com/anthropics/skills` |

## VS Code task (CLI integration)

```bash
py generate_skills.py setup-task --target <path>
```

Adds a **Generate Claude Skills** task to `.vscode/tasks.json`. If the file
uses JSONC comments, add the task snippet manually (see prior docs in git
history).

## Packaging & publishing the extension

```powershell
cd extension
npm install
npm run package    # sync-skills + vsce package → .vsix
npx vsce publish   # Marketplace (requires publisher PAT)
```

Current extension version: **0.7.0** (`serhiivoinolovych`).

## What this tool does NOT do

- No validation of `SKILL.md` frontmatter — files are copied as opaque text.
- No syncing of `~/.claude/settings.json` or statusline (hooks are
  workspace-local via the extension).
- No automatic git commit/push of skill changes.
- Copilot clones are instruction files, not native Copilot “skills”.
- Kiro usage transcripts are not aggregated yet.
