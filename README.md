# claude-skills-deployer

Personal tool to detect which AI agent skills are relevant to a project
(based on which files are present) and install matching instructions from a
shared library — starting with [Claude Code](https://docs.claude.com/claude-code)
and extending to **Cursor**, **Kiro**, and **GitHub Copilot**.

Skills live in `skills_library/` (source of truth). Deploy globally to your
machine, per workspace, per git branch, and across multiple AI agents from
one manifest.

## How it works

The extension detects your project context, lets an AI agent choose the best
development skills, synchronizes them across tools like Cursor and Copilot,
tracks how those skills are actually used, calculates cost and value, and
continuously optimizes your setup based on real usage.

## Do you need Claude Code?

**No.** The VS Code extension works in **VS Code or Cursor** without the [Claude Code](https://docs.claude.com/claude-code) app or CLI installed.

Paths like `.claude/skills/` and `.claude/learning/` are a **shared layout convention** — the extension **creates them** on install. They are not proof that Claude Code is on your machine. With `multiAgent` on (default), skills also deploy to `.cursor/skills/`, `.kiro/skills/`, and `.github/instructions/` for the agents you enable.

| You primarily use… | Works without Claude Code? | What you get |
|---|---|---|
| **Cursor** | Yes | Skill tree, detection, branch profiles, `.cursor/skills/` sync, Cursor attribution hooks, Cursor transcript cost estimates |
| **GitHub Copilot / Kiro** | Yes | Per-skill instruction files; attribution hooks when enabled |
| **Claude Code** | Full set | Everything above plus Claude session transcripts, budget/session/focus hooks, SessionStart profile-init |

**Needs Claude Code specifically** (otherwise skipped or empty — no crash):

- **Cost control hooks** (budget, session size, context/practical focus) — installed into `.claude/settings.json` for Claude Code to run
- **Claude transcript spend** in the status bar and usage report — shows *“No recorded Claude Code token usage”* when `~/.claude/projects/` is absent
- **SessionStart hooks** for profile-init and official Anthropic skill checks — Claude Code uses `.claude/settings.json`; Cursor/Kiro/Copilot use their agent hook formats (see [Profile init](#profile-init-role--branch-agent-driven))

**Cursor-only tip:** set `claudeSkills.agents.enabled` to `["cursor"]` (Settings) if you do not want global/workspace installs under Claude paths. Workspace skills still use `.claude/skills/` as the git-tracked source of truth; the extension mirrors from there to your enabled agents.

See [`extension/README.md`](extension/README.md) for the full extension guide.

## Install — pick your editor’s registry

Same extension, two galleries. Each link goes to the **extension listing** (install page):

| Editor | Primary listing | Also on |
|--------|-----------------|---------|
| **VS Code** | [**Claude Skills Manager** — Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=SerhiiVoinolovych.claude-skill-deployer&ssr=false#version-history) | [Open VSX ↗](https://open-vsx.org/extension/serhiivoinolovych/claude-skill-deployer) |
| **Cursor** | [**Claude Skills Manager** — Open VSX](https://open-vsx.org/extension/serhiivoinolovych/claude-skill-deployer) | [VS Marketplace ↗](https://marketplace.visualstudio.com/items?itemName=SerhiiVoinolovych.claude-skill-deployer&ssr=false#version-history) |
| **Kiro IDE** | [**Claude Skills Manager** — Open VSX](https://open-vsx.org/extension/serhiivoinolovych/claude-skill-deployer) | [VS Marketplace ↗](https://marketplace.visualstudio.com/items?itemName=SerhiiVoinolovych.claude-skill-deployer&ssr=false#version-history) ([Kiro uses Open VSX by default](https://kiro.dev/docs/editor/extension-registry/)) |

Distribution diagram: [diagram/00-extension-registries.md](diagram/00-extension-registries.md) · Publishing: [extension/PUBLISHING.md](extension/PUBLISHING.md)

## Two ways to use this

| Surface | Best for |
|---|---|
| **CLI** (`generate_skills.py`) | Scripts, CI, **Claude CLI**, headless apply/sync — no VS Code |
| **VS Code extension** ([`extension/`](extension/)) | Activity-bar UI, budget controls, cost intelligence, branch profiles, multi-agent sync |

## Quick start (extension)

1. Install **Claude Skills Manager** from the [install table above](#install--pick-your-editors-registry) (or a `.vsix` from `extension/`).
2. Open a workspace folder.
3. **Claude Skills** activity bar → **Install Skill Library to ~/.claude/skills** (one-time).
   With `multiAgent` on (default), this also seeds `~/.cursor/skills/`, `~/.kiro/skills/`, and Copilot global instructions when those agents are enabled.
4. **Install Relevant Skills for Workspace** (or **Preview** first).
   By default, detected skills are copied to **all enabled agent paths** in the workspace (`.claude/skills/`, `.cursor/skills/`, `.kiro/skills/`, `.github/instructions/`).
5. Optional: **Enable Cost Control Hooks**, open **Cost Intelligence Dashboard**, configure **Budget** and **Feature Toggles**.

The extension never hides skills already in `<workspace>/.claude/skills/` —
project-local skills show as *project-only* in the tree. `.claude/skills/` remains the git-tracked source of truth; other agent paths are mirrored automatically.

## Docs & diagrams

| Topic | Doc |
|-------|-----|
| **Install listings** | [VS Marketplace](https://marketplace.visualstudio.com/items?itemName=SerhiiVoinolovych.claude-skill-deployer&ssr=false#version-history) · [Open VSX](https://open-vsx.org/extension/serhiivoinolovych/claude-skill-deployer) · [diagram/00-extension-registries.md](diagram/00-extension-registries.md) |
| Extension user guide | [extension/README.md](extension/README.md) |
| Publish releases | [extension/PUBLISHING.md](extension/PUBLISHING.md) |
| Runtime architecture (Mermaid) | [diagram/README.md](diagram/README.md) |
| IDE / agent skill profiles (Mermaid + draw.io) | [diagram/06-ide-agent-skill-profiles.md](diagram/06-ide-agent-skill-profiles.md) |

## Quick start (CLI)

```bash
py generate_skills.py install
py generate_skills.py list --target .
py generate_skills.py generate --target .
py generate_skills.py generate --target . --dry-run
py generate_skills.py cost-report --target .
py generate_skills.py cost-report --weekly
py record_feedback.py <skill-name> --signal "no" --context "what went wrong"
```

### Headless apply/sync (Claude CLI — no VS Code required)

Use the IDE extension **once** to bootstrap, then work only in **`claude` CLI**:

**In Cursor / Kiro / VS Code:** Command Palette → **Claude Skills: Prepare for Claude CLI (headless)**

Or from the repo CLI:

```bash
# One-time per repo: copy hooks + register SessionStart / PostToolUse in .claude/settings.json
py generate_skills.py hooks install --target .

# Optional: budget/session/focus hooks too
py generate_skills.py hooks install --target . --full

# After profile-init or SessionStart hook writes request files:
py generate_skills.py apply-session --target .   # session-skill-apply-request.json
py generate_skills.py apply-profile --target .   # profile.local.json (agent pending → applied)
py generate_skills.py sync-branch --target .     # saved branch profile on git switch
py generate_skills.py sync-agents --target .     # mirror to .cursor/, .kiro/, .github/instructions/

# All of the above in one shot:
py generate_skills.py sync --target .
```

**Automatic session apply:** the SessionStart hook runs `session-apply.js` inline (no VS Code). Install hooks once with `hooks install`.

**Git branch switch** (optional `.git/hooks/post-checkout`):

```bash
py generate_skills.py sync-branch --target "$(git rev-parse --show-toplevel)"
```

**CLI feature toggles** — optional `.claude/learning/cli-config.json` (mirrors extension defaults when absent):

```json
{
  "features": {
    "sessionSkillAdaptation": true,
    "branchProfiles": true,
    "multiAgent": true
  },
  "agents": {
    "enabled": ["claude", "cursor", "kiro", "copilot"]
  }
}
```

Text-only cost reports: `py generate_skills.py cost-report` (no webview dashboard).

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
| `predictiveAlerts` | on | Workspace spend vs weekly budget; sane WoW trend (not global all-projects) |
| `communityBenchmarks` | off | Opt-in community cost benchmarks |
| `teamCostSharing` | on | Git author attribution on shared skills |
| `skillArchival` | on | Archive idle skills (restore available) |
| `emergencyCutoff` | on | Hard daily spend limit ($10 default) |
| `prCostEstimate` | off | PR cost comment via `gh` CLI |
| `costAwareSearch` | on | ROI/cost labels and sort in skills tree |
| `sessionSkillAdaptation` | on | Auto install/enable proposed skills on new agent session or window |
| `autoApplyTaskProposals` | on | Auto-install all **Proposed for current task** skills (+ required platform skills) locally |

## Cost intelligence

Estimates where no usage data exists — hook/API-priced where hooks logged usage. Per-skill data is **best-effort**; confidence labels say how much to trust each row.

### Dashboard & ROI

- **Cost Intelligence Dashboard** — agent-level spend for **this workspace** (last 14 days); **General API** panel for base-model / non-skill session work (transcript residual minus hook invokes); **Models by agent** shows API-priced **Skill invokes** from hooks plus transcript estimates where ids are missing; **Top skills · measured** from hook invocations at published API rates; **Skill spend** overview stat separate from transcript estimates; per-skill costs with **ROI band** and **confidence**; **Value & ROI** summary; **System state** panel; cost by repo and skill owner; cross-agent savings; CSP-hardened webview
- **ROI in skills tree** — each skill shows **`$X/session (API)`** when hooks logged usage, **`(logged)`** from token totals, or **`~$X/session (catalog)`** before first invoke; sort via `Cycle Skill Sort (ROI / Cost)`
- **Status bar (today)** — **`API` / `Mixed` / `Est.`** prefix from transcript usage metadata (not a flat estimate label)
- **Graded trust** — workspace confidence score (0–100%) and per-skill `high` / `estimated` / `low`; optimizer runs when confidence ≥ 45% (not only when fully `reliable`)

### Attribution & data

- **Attribution collector** — parses session transcripts into `cost-attribution.json` (`transcriptSkills`, unattributed). Does **not** duplicate estimates into `runs.jsonl`.
- **Attribution v2 hooks** — PostToolUse hooks for **Claude, Cursor, Kiro, Copilot** → `.claude/learning/runs.jsonl` (auto-installed on workspace open)
- **Usage Report split** — **Skills detail** (runs, **Cost/run**, tokens, ratings) from `runs.jsonl` hooks + self-learning; **Credits · 14d** from session transcripts (`API` / `Mixed` / `Est.` basis); **Inefficient skills** from user feedback; **Proposed for current task** from `task-skill-proposals.json`
- **Fallback chain** — hooks → session transcripts → install-tier heuristics (documented in dashboard)
- **Stale data guard** — auto-purges equal-split `transcriptSkills`; **Top skills** uses hook-measured costs when v2 runs exist (even if transcript attribution is stale)
- **Indexed stats** — `skill-stats.json` + `daily-stats.json` updated on refresh (reduces full `runs.jsonl` scans); in-memory cache on mtime/size

### Controls & optimization

- **Optimization suggestions** — disable expensive low-use skills, agent-switch hints with **estimated $/month** savings
- **Apply optimizations** — interactive or `claudeSkills.optimizer.autoApply` (max **3 applies per 30 minutes** when auto)
- **Pricing overrides** — optional `.claude/learning/pricing-overrides.json` for model $/M tokens and ROI hourly rate (audit-friendly vs built-in tiers)
- **Predictive alerts** — workspace last-7-day spend vs weekly budget (`claudeSkills.features.predictiveAlerts`); sane WoW % when prior week has enough data
- **Emergency cutoff**, **skill archival**, **PR cost estimate**, **commit cost hook** — unchanged from 1.0.x
- **Community benchmarks** — opt-in via `~/.claude/learning/community-benchmarks.json`

### Skill feedback & adaptation

When users disagree with agent output (`no`, `wrong`, `stop`, etc.), the **`skill-feedback-adaptation`** skill records reactions in `.claude/learning/skill-feedback.jsonl`. The Usage Report shows **inefficiency %** per skill (deeper red = more negative feedback) with update suggestions.

On a **new task**, the same skill analyzes the prompt and repo and writes `.claude/learning/task-skill-proposals.json` — a ranked set of skills from the library that should help.

When a **branch or task** exceeds a configurable share of monthly credits (default **50%**), the extension prompts to **Apply suggested skills** (`claudeSkills.skillFeedback.*` settings).

CLI helpers (from repo root):

```bash
py record_feedback.py <skill> --signal "no" --context "what went wrong"
py record_runs.py <skill> --tokens 12000 --fail   # existing run log
py scripts/skill_cost_from_runs.py --target .      # per-skill cost from runs.jsonl (hook-grounded)
py scripts/agent_billing_report.py                 # org billing via admin APIs (optional keys)
```

Install **`skill-feedback-adaptation`**, **`self-learning`**, and **`skill-usage-insights`** together for the full feedback loop.

### Learning files (workspace)

| File | Purpose |
|---|---|
| `.claude/learning/runs.jsonl` | Hook invocations + self-learning run log (not transcript cost estimates) |
| `.claude/learning/skill-feedback.jsonl` | User negative/correction feedback per skill (machine-local) |
| `.claude/learning/task-skill-proposals.json` | Latest task-scoped skill proposal set (machine-local) |
| `.claude/learning/skill-proposal-alert-state.json` | Dedup state for high-usage skill proposal notifications |
| `.claude/learning/cost-attribution.json` | Transcript-based per-skill estimates (`transcriptSkills`) and unattributed totals |
| `.claude/learning/skill-stats.json` | Aggregated per-skill stats index (hook/self-learning runs) |
| `.claude/learning/daily-stats.json` | Cost/tokens/runs by day |
| `.claude/learning/system-state.json` | Unified `profileInit` / attribution / hooks / capabilities snapshot |
| `.claude/learning/write-locks.json` | Coordinated write versions for profile-init files |
| `.claude/learning/pricing-overrides.json` | Optional manual model pricing + hourly rate |

- **Reset Mis-attributed Cost Data** — removes legacy collector transcript rows from `runs.jsonl`, clears `transcriptSkills`, resets collector state; reopen Usage Report after reset

### Cost pipeline

Background sync runs **collect → index → analyze** on a schedule and after hooks append to `runs.jsonl`:

| Stage | What it does |
|---|---|
| **Collect** | Parse session transcripts into `cost-attribution.json`; refresh attribution health |
| **Index** | Aggregate hook/self-learning runs into `skill-stats.json` and `daily-stats.json` |
| **Analyze** | ROI bands, optimization suggestions, system-state snapshot, predictive alerts |

Stage timings and errors appear in the Cost Dashboard **System** panel. A circuit breaker trips after more than 10 pipeline runs per minute and forces safe mode (auto-optimize off) until the window clears.

**Pipeline roadmap** (v1.0.20):

| Direction | Status |
|---|---|
| **Confidence on every layer** | Usage Report trust banner + per-skill confidence column; weekly report + predictive alerts + pipeline trace show workspace confidence |
| **In-memory index** | Unified `runs.jsonl` cache with derived v2 stats; transcript mtime fingerprint cache for credit usage (`transcriptUsageIndex.ts`) |
| **Real-time optimizer** | `autoDetectOnPipeline` (default on): debounced auto-apply after each pipeline sync when `autoApply` is enabled |

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
4. Agent writes `.claude/profile.local.json` → extension auto-installs (always includes **required platform skills**: `self-learning`, `skill-creator`, `skill-usage-insights`, `skill-feedback-adaptation`, etc.) and saves branch profile.

**Local-only files:** `position.local.json`, `skills-catalog.json`, `profile-init-request.json`, `profile.local.json`.

**Settings:** `claudeSkills.profileInit.*` — see [`extension/README.md`](extension/README.md).

### Multi-agent

Profile init is **agent-agnostic** for apply/catalog. **`profile-init`** syncs to Cursor, Kiro, and Copilot. Claude Code uses a **SessionStart hook**; other agents rely on the synced skill + pending request file at session start.

| Agent | Skill copy |
|---|---|
| Claude | `.claude/skills/profile-init/SKILL.md` + SessionStart hook |
| Cursor | `.cursor/skills/profile-init/SKILL.md` |
| Kiro | `.kiro/skills/profile-init/SKILL.md` + `agentSpawn` hook (`.kiro/hooks/*.kiro.hook`) |
| Copilot | `.github/instructions/profile-init.instructions.md` + `SessionStart` hook (`.github/hooks/*.json`) |

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

Current extension version: **1.0.18** (`serhiivoinolovych`). See [CHANGELOG.md](CHANGELOG.md) for release notes.

## Performance impact

- **CPU**: under 1% idle; 2–5% during attribution collection (5-minute intervals)
- **Memory**: ~50 MB baseline; +20 MB when the dashboard WebView is open
- **Disk**: ~500 KB–2 MB per project under `<workspace>/.claude/learning/` (`runs.jsonl`, indexes, attribution store); `skill-stats.json` / `daily-stats.json` limit full-log rescans
- **Startup**: under 200 ms added to VS Code activation

Tuned for workspaces with fewer than 100 skills and fewer than 10K transcript lines. `runs.jsonl` is pruned to 90 days on attribution reset.

## Compatibility

| Component | Required? | Version / notes |
|---|---|---|
| VS Code or Cursor | Yes | 1.85+ |
| Claude Code | No | 0.2+ for Claude-only hooks and Claude transcript spend |
| Node.js | For hooks | 18+ |
| OS | | Windows 10+, macOS 11+, Linux (glibc 2.28+) |

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
- **Cost figures are estimates** — not Anthropic/Cursor invoices; per-skill attribution is best-effort with **confidence labels**. Strongest with Attribution v2 hooks across Claude, Cursor, Kiro, and Copilot. Override model rates via `.claude/learning/pricing-overrides.json` for audit alignment.
- Community benchmark upload requires you to configure endpoints (no default public server).
- PR comments require GitHub CLI and explicit feature enable.
- Copilot clones are instruction files, not native Copilot skills.
