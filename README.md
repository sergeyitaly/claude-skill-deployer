# claude-skills-deployer

Personal tool: detects which [Claude Code](https://docs.claude.com/claude-code)
skills are relevant to a project (based on which files are present) and
installs the matching `SKILL.md` files into `<project>/.claude/skills/`.

Skills are deployed via a personal global library at `~/.claude/skills/`,
seeded from `skills_library/` in this repo.

Two ways to use this:

- **CLI** (`generate_skills.py`, below) — works anywhere, no install.
- **VS Code extension** ([`extension/`](extension/)) — adds an activity-bar
  view of the skill library with install/preview commands and per-workspace
  status. See [`extension/README.md`](extension/README.md) for the full
  usage guide.

### Using the VS Code extension

The extension can be installed into any project at any time, including ones
that already have skills under `.claude/skills/` — those project-local
skills show up in the "Claude Skills" view alongside the bundled library
(marked *project-only*), so nothing already in the project gets hidden or
overwritten.

Typical flow: open the **Claude Skills** activity-bar view -> "Install Skill
Library to ~/.claude/skills" (one-time) -> "Install Relevant Skills for
Workspace" (or preview first with the dry-run command) -> use the per-skill
checkboxes to fine-tune what's enabled for this workspace. See
[`extension/README.md`](extension/README.md) for the full command list,
the usage/KPI report, and the session-size notification hook.

## One-time setup

```
py generate_skills.py install
```

Copies every skill in `skills_library/` into `~/.claude/skills/` (creating
the directory if needed). Re-run anytime to pick up new/updated bundled
skills — by default it won't overwrite a skill that already exists in
`~/.claude/skills/` (use `--force` to overwrite, `--dry-run` to preview).

## Per-project usage

```
py generate_skills.py list --target <path>            # see what's relevant, no writes
py generate_skills.py generate --target <path>         # install matching skills
py generate_skills.py generate --target <path> --all   # install everything in the library
py generate_skills.py generate --target <path> --dry-run  # preview only
py generate_skills.py generate --target <path> --force # overwrite existing skills in target
```

`--target` defaults to the current directory, so from VS Code it can be run
against `${workspaceFolder}`.

## VS Code integration

```
py generate_skills.py setup-task --target <path>
```

Adds a "Generate Claude Skills" task to `<path>/.vscode/tasks.json`. Run it
from VS Code via Ctrl+Shift+P -> "Run Task" -> "Generate Claude Skills".

If `<path>/.vscode/tasks.json` already has comments (JSONC), `setup-task`
will fail to parse it — add this snippet to its `tasks` array manually
instead:

```jsonc
{
  "label": "Generate Claude Skills",
  "type": "shell",
  "command": "py",
  "args": [
    "C:\\Users\\SerhiiVoinolovich\\claude-skills-deployer\\generate_skills.py",
    "generate",
    "--target", "${workspaceFolder}"
  ],
  "problemMatcher": [],
  "presentation": { "reveal": "always", "panel": "shared" }
}
```

## Adding a new skill to the library

1. Create `skills_library/<skill-name>/SKILL.md`.
2. Add a `"<skill-name>": {"description": ..., "detect_globs": [...]}` entry
   to `skills_library/manifest.json`.
3. Run `py generate_skills.py install` to push it to `~/.claude/skills/`.
4. If you also use the VS Code extension, run `npm run sync-skills` inside
   `extension/` to refresh its bundled copy.

## Skill library contents

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
| `aidlc-doc-writer` | AI-DLC document generation (inception/construction/operations/verification) |
| `self-learning` | Project-local accumulated-experience store: records run outcomes and learned fixes |
| `gitlab-pipeline-ops` | Navigate and operate GitLab CI/CD pipeline projects (`.gitlab-ci.yml` + `.gitlab/ci/*.yml`, manual gates, `glab` CLI) |
| `cross-platform-scripting` | OS detection (Windows/macOS/Linux) and PowerShell version detection/adaptation for `.ps1`/shell scripts |
| `file-style-conventions` | No emoji outside Markdown files, and trailing newline at end of YAML files |
| `skill-usage-insights` | Skill usage and KPI report from `.claude/learning/runs.jsonl` — what to keep, fix, add, or remove |
| `drawio-diagrams` | Create/edit architecture diagrams as `.drawio` files via the draw.io MCP server, including Azure diagrams using the official Azure icon set |
| `vscode-extension-publishing` | Build, package, and publish a VS Code extension via `@vscode/vsce` — manifest fields, `.vscodeignore`, Extension Development Host testing, version bumps, publisher/PAT setup, common publish errors |
| `skill-official-updater` | Check `github.com/anthropics/skills` for new/updated official Anthropic skills and offer to add or update them in `skills_library/` |

## What this tool does NOT do

- No parsing/validation of `SKILL.md` frontmatter — files are copied as
  opaque files.
- No syncing of `~/.claude/settings.json`, hooks, or statusline.
- No automatic git operations.
- No JSONC (comments) support for `tasks.json`.
