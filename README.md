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
| `profileInit` | on | Role + branch agent-driven profile init (`claudeSkills.profileInit.*`) |
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

- **Cost Intelligence Dashboard** — agent-level spend for **this workspace** (last 14 days, transcript estimate); per-skill breakdown when attribution is reliable; cross-agent savings; team attribution; CSP-hardened webview
- **Attribution collector** — parses session transcripts; attributes tokens only to **invoked** skills (not the full skill catalog). Sessions with no detected invocation go to `unattributed`.
- **Stale data guard** — auto-purges equal-split `transcriptSkills` on load; if many skills still share the same cost, per-skill rankings stay hidden until you run **Reset Mis-attributed Cost Data**. Workspace-scoped agent totals remain valid.
- **Reset Mis-attributed Cost Data** — clears bad collector rows and `transcriptSkills` for re-collection (`scripts/reset_attribution.py` or `py scripts/check_cost_data.py` to diagnose)
- **Enable Attribution Hooks (v2)** — PostToolUse hooks log Skill invocations (and Copilot instruction reads) to `runs.jsonl` for **Claude, Cursor, Kiro, and Copilot** (auto-installed when the extension opens a workspace)
- **Optimization suggestions** — disable expensive low-use skills, agent-switch hints (thresholds: `claudeSkills.optimizer.disableCostPerUseUsd`, `disableMaxRuns`, `unusedIdleDays`, …)
- **Apply optimizations** — interactive or `claudeSkills.optimizer.autoApply` (max **3 applies per 30 minutes** when auto; keep `false` until attribution looks sane)
- **Community benchmarks** — `~/.claude/learning/community-benchmarks.json` (opt-in upload/download URLs)
- **Emergency cutoff** — when daily spend exceeds `claudeSkills.emergency.hardLimitUsd`, disables skills over `perSkillLimitUsd` attributed cost; **Reset Emergency Cutoff** restores your prior manual overrides
- **Skill archival** — moves idle skills to `.claude/skills-archived/` (**Restore Archived Skill**; falls back to `skills_library/` if needed)
- **PR cost estimate** — `Claude Skills: Estimate PR Review Cost` (needs `gh`, feature on)
- **Commit cost hook** — post-commit line in terminal + `commit-costs.jsonl`

### Official Anthropic skills (repos with `skills_library/`)

- **SessionStart hook** — on new Claude Code sessions, checks [anthropics/skills](https://github.com/anthropics/skills) and injects context for the `skill-official-updater` skill
- **Check Official Anthropic Skill Updates** — manual check from Command Palette
- Setting: `claudeSkills.officialSkillsCheckOnSession` (default on)

### Weekly AI usage report (extension)

Default: **every Monday at 9:00** (local time) while Cursor/VS Code is open, the extension emails an AI usage summary to your inbox.

- One-time setup: **Configure Weekly Report Email** (recommended)
- Manual test: **Claude Skills: Send Weekly AI Usage Report**
- Schedule settings: `claudeSkills.weeklyReport.enabled`, `dayOfWeek`, `hour`, `emailSubject`

#### What credentials you need (two parts)

The extension does **not** send mail through GitHub/GitLab. A git token only **looks up the inbox** linked to your account. Something else must **deliver** the email.

| Credential | Purpose | Where to store |
|---|---|---|
| **GitHub or GitLab personal access token (PAT)** | Read your git account profile and primary email | VS Code Secret Storage via **Configure Weekly Report Email** (not `settings.json`) |
| **SMTP username + password** | Send the weekly usage email to that inbox | Same wizard (secrets), or `claudeSkills.weeklyReport.smtp*` / `CLAUDE_SKILLS_SMTP_*` env vars |

Do **not** put PATs or SMTP passwords in committed settings files. The wizard stores them in VS Code Secret Storage. For SMTP, env vars are safer than plain `settings.json` values.

#### GitHub token (if `origin` is GitHub)

**Token type:** [GitHub personal access token](https://github.com/settings/tokens) — **fine-grained** or **classic (legacy)**.

**Minimum scopes (classic PAT):**

| Scope | Why |
|---|---|
| `read:user` | Read your GitHub username and public profile |
| `user:email` | Read your real inbox address (skips `*@users.noreply.github.com`) |

`repo` is **not** required for weekly email reports (only identity/email lookup).

**Fine-grained PAT (alternative):** create a token with **Account** permissions only:

- **Email addresses** → Read
- **Profile** → Read (or Metadata read, depending on GitHub UI)

**How to insert it in the extension:**

1. Open a workspace whose `git remote get-url origin` points to GitHub.
2. Command Palette → **Claude Skills: Configure Weekly Report Email**.
3. Choose **Paste GitHub personal access token** (or **Use existing GitHub CLI session** if you already ran `gh auth login` with `user:email`).
4. Complete the SMTP step (Gmail app password, Microsoft 365, or company SMTP).
5. Choose **Send test email now** to verify.

**CLI alternative (no pasted PAT):** `gh auth login`, then refresh email scope if needed:

```bash
gh auth refresh -h github.com -s user,read:user
```

#### GitLab token (if `origin` is GitLab)

**Token type:** [GitLab personal access token](https://gitlab.com/-/user_settings/personal_access_tokens) (or your self-hosted GitLab **User Settings → Access Tokens**).

**Minimum scopes:**

| Scope | Why |
|---|---|
| `read_user` | Read your username and email on file |

`api` is broader than needed; `read_user` is enough for email discovery.

**How to insert it in the extension:**

1. Open a workspace whose `origin` is GitLab.
2. Command Palette → **Claude Skills: Configure Weekly Report Email**.
3. Choose **Paste GitLab personal access token** (or set `GITLAB_TOKEN` / `GLAB_TOKEN` in the environment and pick **Use existing GitLab CLI session**).
4. Complete SMTP and send a test email.

#### SMTP (required to actually receive the email)

The git PAT **cannot** replace SMTP. Pick one:

| Provider | SMTP host | Port | Password |
|---|---|---|---|
| Gmail | `smtp.gmail.com` | `587` | [Google App Password](https://myaccount.google.com/apppasswords) (not your login password) |
| Microsoft 365 / Outlook | `smtp.office365.com` | `587` | Your work Microsoft account password (or app password if MFA requires it) |
| Company / other | Your IT host | Usually `587` or `465` | From your mail admin |

The wizard stores SMTP in Secret Storage. Advanced override via settings or env:

```json
"claudeSkills.weeklyReport.emailTo": "you@company.com"
```

```powershell
$env:CLAUDE_SKILLS_SMTP_HOST = "smtp.gmail.com"
$env:CLAUDE_SKILLS_SMTP_PORT = "587"
$env:CLAUDE_SKILLS_SMTP_USER = "you@gmail.com"
$env:CLAUDE_SKILLS_SMTP_PASSWORD = "your-app-password"
$env:CLAUDE_SKILLS_REPORT_TO = "you@gmail.com"
```

#### Extension settings reference (`claudeSkills.weeklyReport.*`)

| Setting | Used for token? | Notes |
|---|---|---|
| `emailTo` | No (recipient override) | Leave empty to use email discovered from the PAT |
| `smtpHost`, `smtpPort`, `smtpUser`, `smtpPassword` | No (mail delivery) | Optional if configured via wizard or env vars |
| `enabled`, `dayOfWeek`, `hour`, `minute`, `emailSubject` | No | Schedule and subject only |

There is **no** `weeklyReport.githubToken` setting — the PAT is entered once in the **Configure Weekly Report Email** command and saved to VS Code secrets.

CLI helpers (automation outside the IDE):

```bash
py scripts/send_weekly_report.py --target .
py scripts/send_weekly_report.py --email          # needs CLAUDE_SKILLS_SMTP_* env vars
py scripts/test_skill_cost.py terraform-plan-review --write-manifest
```

## Multi-agent support

See `skills_library/agents.json`.

| Setting | Default | Effect |
|---|---|---|
| `claudeSkills.agents.enabled` | `claude`, `cursor`, `kiro`, `copilot` | Which agents receive clones |
| `claudeSkills.agents.syncWorkspaceToAll` | `true` | Workspace installs fan out to all enabled paths (requires `multiAgent` feature) |
| `claudeSkills.agents.syncGlobalToAll` | `true` | Global library install fans out to all enabled agents |
| `claudeSkills.agents.syncHooksOnSkillChange` | `true` | After any workspace skill change, install or refresh cost-control hooks when `budgetControls` is on (or hooks already exist) |

Adding, removing, or editing skills under `.claude/skills/` automatically propagates to Cursor, Kiro, and Copilot paths when `syncWorkspaceToAll` is on. The same path runs on checkbox toggles, branch profile apply, generate/install commands, and file watchers (create, change, delete). With `syncHooksOnSkillChange` (default on), cost-control hook scripts in `.claude/hooks/` are refreshed when skills change.

**Local-only skills:** unchecking a branch-committed skill disables it for you via `.claude/settings.local.json` (`skillOverrides`) without deleting shared files. Checking a skill not on the branch installs it as personal-only (`.git/info/exclude`). Other agents mirror your **effective** enabled set, not the raw folder listing.

## Per-branch skill profiles & local-only skills

`~/.claude/learning/branch-profiles.json` — personal layouts per git branch.
Committed `.claude/skills/` remains team source of truth. Optional team layout in
`.claude/skills-profile.json` applies **before** your personal profile on branch switch.

**Your personal skill set (not the same as the branch):**

| Action | What happens | Git impact |
|---|---|---|
| Uncheck skill **on the branch** | `skillOverrides: { "skill": "off" }` in `.claude/settings.local.json` | None |
| Check skill **not on the branch** | Installed under `.claude/skills/` + listed in `.git/info/exclude` | None (personal-only) |
| Uncheck **personal-only** skill | Directory removed from your workspace | None |
| Branch switch | Saved profile restores your effective set (overrides + personal adds) | None |

Setting: `claudeSkills.preferLocalSkillOverrides` (default `true`).

- **Branch profiles** section at the top of the Skills tree (current branch + saved profiles)
- Toolbar icons: show / save / apply branch profile (git repos only)
- Auto-save on skill install/remove; optional auto-apply on branch switch

## Profile init (role + branch, agent-driven)

When you land on a **new git branch** with no saved personal profile:

1. Extension saves your **position** → `.claude/position.local.json` (gitignored).
2. On init, writes `.claude/learning/skills-catalog.json` and `.claude/learning/profile-init-request.json` (includes `agentInstructions`).
3. **SessionStart hook** + synced **`profile-init` skill** auto-run on the **next AI agent session** — no manual prompt copy.
4. Agent writes `.claude/profile.local.json` → extension auto-installs and saves branch profile.

**Local-only files:** `position.local.json`, `skills-catalog.json`, `profile-init-request.json`, `profile.local.json`.

**Settings:** `claudeSkills.profileInit.*` — see [`extension/README.md`](extension/README.md).

### Multi-agent

Profile init is **agent-agnostic** for apply/catalog. **`profile-init`** syncs to Cursor, Kiro, and Copilot. Claude Code uses a **SessionStart hook**; other agents rely on the synced skill + pending request file at session start.

| Agent | Skill copy |
|---|---|
| Claude | `.claude/skills/profile-init/SKILL.md` + SessionStart hook |
| Cursor | `.cursor/skills/profile-init/SKILL.md` |
| Kiro | `.kiro/skills/profile-init/SKILL.md` |
| Copilot | `.github/instructions/profile-init.instructions.md` |

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

Current extension version: **1.0.17** (`serhiivoinolovych`). See [CHANGELOG.md](CHANGELOG.md) for release notes.

## Performance impact

- **CPU**: under 1% idle; 2–5% during attribution collection (5-minute intervals)
- **Memory**: ~50 MB baseline; +20 MB when the dashboard WebView is open
- **Disk**: ~500 KB per project for `runs.jsonl` and `cost-attribution.json` under `<workspace>/.claude/learning/`
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

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## What this tool does NOT do

- **SKILL.md lint is advisory** — sync-time checks on `.claude/skills` plus Cursor/Kiro SKILL.md mirrors and Copilot `.instructions.md` existence checks; set `claudeSkills.lint.blockSyncOnError` to hard-block multi-agent sync only (hooks and branch profiles still run).
- **Cost figures are estimates** — not Anthropic/Cursor invoices; per-skill attribution is strongest with Attribution v2 hooks across Claude, Cursor, Kiro, and Copilot.
- Community benchmark upload requires you to configure endpoints (no default public server).
- PR comments require GitHub CLI and explicit feature enable.
- Copilot clones are instruction files, not native Copilot skills.
